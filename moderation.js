// moderation.js - the Discord side of automod.
//
//   * the per-server blacklist (shipped defaults + that server's changes), compiled
//     once and cached until a mod changes it
//   * screen(): runs the scorer with the server's settings
//   * review and rejection-log cards, and the buttons/modal that act on them
//   * strikes: repeated automatic rejections can time a member out
//
// The scoring itself lives in automod.js, which knows nothing about Discord.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
} from 'discord.js';
import { compileList, scan, termKey, allowKey } from './automod.js';
import { data, guildData, automodSettings, trySave, LIMITS } from './storage.js';
import { getReviewChannel, onReviewChannelCreated } from './channels.js';
import { postAllegation } from './allegations.js';

const REJECTED_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // "Override & post" stays possible for a week
const MAX_WAITING_PER_MEMBER = 3; // so one member can't fill the whole review queue
const NO_MENTIONS = Object.freeze({ parse: [] });
const COLORS = Object.freeze({ review: 0xf1c40f, rejected: 0xc0392b, approved: 0x2ecc71, dismissed: 0x95a5a6 });

// ---- Default blacklist ----------------------------------------------------

/**
 * Reads blacklist.default.json once at startup. A missing or broken file is logged
 * and treated as an empty list, so automod still works with each server's own words.
 */
function loadDefaultList() {
  try {
    const raw = JSON.parse(readFileSync(new URL('./blacklist.default.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
    const terms = Array.isArray(raw.terms) ? raw.terms.filter((t) => t && typeof t.term === 'string') : [];
    const allowlist = Array.isArray(raw.allowlist) ? raw.allowlist.filter((w) => typeof w === 'string') : [];
    return { terms, allowlist };
  } catch (err) {
    console.error(`Couldn't load blacklist.default.json (${err.message}); starting with an empty default list.`);
    return { terms: [], allowlist: [] };
  }
}

const defaults = loadDefaultList();
// Keys are worked out once here rather than on every recompile.
const defaultTerms = defaults.terms.map((entry) => ({ entry, key: termKey(entry.term) })).filter((t) => t.key);
const defaultTermKeys = new Set(defaultTerms.map((t) => t.key));
// `termKey` is kept too: it's how an allowed word is matched against blacklist entries.
const defaultAllow = defaults.allowlist.map((word) => ({ word, key: allowKey(word), termKey: termKey(word) })).filter((w) => w.key);
const defaultAllowKeys = new Set(defaultAllow.map((w) => w.key));

console.log(`Loaded ${defaultTerms.length} default blacklist terms and ${defaultAllow.length} allowlist words.`);

// ---- Per-server effective list -------------------------------------------

const compiledCache = new Map(); // guildId -> compiled list

/** The server's compiled list: defaults minus its removals, plus its additions. */
function compiledListFor(guildId) {
  let compiled = compiledCache.get(guildId);
  if (!compiled) {
    const s = automodSettings(guildId);
    const removed = new Set(s.removed);
    const allowRemoved = new Set(s.allowRemoved);
    compiled = compileList({
      // Server additions come last so they override a default with the same key.
      terms: [...defaultTerms.filter((t) => !removed.has(t.key)).map((t) => t.entry), ...s.added],
      allowlist: [...defaultAllow.filter((w) => !allowRemoved.has(w.key)).map((w) => w.word), ...s.allowAdded],
    });
    compiledCache.set(guildId, compiled);
  }
  return compiled;
}

const invalidateList = (guildId) => compiledCache.delete(guildId);

/**
 * Runs automod on `text` with the server's list and thresholds. When automod is
 * switched off everything is accepted, unless `ignoreEnabled` is set (for /automod test).
 */
export function screen(guildId, text, { ignoreEnabled = false } = {}) {
  const s = automodSettings(guildId);
  if (!s.enabled && !ignoreEnabled) return { outcome: 'accept', score: 0, match: null, disabled: true };
  return scan(text, compiledListFor(guildId), s.thresholds);
}

// ---- Who may make automod stricter -----------------------------------------

export const TIMEOUT_PERMISSION_NEEDED =
  '⚠️ Automatic timeouts are on, so making automod stricter needs the **Timeout Members** permission.';

/**
 * True when this member may NOT make automod stricter right now: strikes are on (so
 * more rejections mean more timeouts) and they can't time people out themselves.
 * Without this, a Manage-Messages-only mod could time members out indirectly.
 */
export function blockedFromTightening(interaction) {
  return automodSettings(interaction.guildId).strikes.enabled && !interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers);
}

// ---- Editing the blacklist ------------------------------------------------
// Each function returns { ok: true, message } or { ok: false, message } so the
// caller can show the message as-is.

const cleanInput = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const sameKey = (key) => (e) => termKey(e.term) === key;
const MATCH_MODES = new Set(['fuzzy', 'strict', 'anywhere']);

function commitListChange(guildId) {
  invalidateList(guildId);
  trySave('changing the blacklist');
}

// The blacklist and allowlist never hold the same word: adding to one takes it off the
// other. "Same word" means the same term key, so "Chicken" and "CH1CKEN" are one word.

/** What taking the word with this term key off the allowlist would change. */
function allowlistOverlap(s, key) {
  return {
    added: s.allowAdded.filter((w) => termKey(w) === key),
    defaults: defaultAllow.filter((w) => w.termKey === key && !s.allowRemoved.includes(w.key)).map((w) => w.key),
  };
}

/** What taking the word with this term key off the blacklist would change. */
function blacklistOverlap(s, key) {
  return {
    added: s.added.some(sameKey(key)),
    hideDefault: defaultTermKeys.has(key) && !s.removed.includes(key),
  };
}

/** True if `/blacklist add` of this term would take a word off the server's allowlist. */
export function addWouldUnallow(guildId, term) {
  const key = termKey(cleanInput(term));
  if (!key) return false;
  const overlap = allowlistOverlap(automodSettings(guildId), key);
  return overlap.added.length > 0 || overlap.defaults.length > 0;
}

export function addTerm(guildId, { term, action, match }, byUserId) {
  const clean = cleanInput(term);
  const key = clean.length <= LIMITS.termLength ? termKey(clean) : null;
  if (!key) return { ok: false, message: `That word needs at least two letters and at most ${LIMITS.termLength} characters.` };

  const s = automodSettings(guildId);
  const entry = { term: clean, action: action === 'review' ? 'review' : 'reject', by: byUserId, at: Date.now() };
  if (MATCH_MODES.has(match)) entry.match = match;

  // Work out the whole change before touching anything, so a refusal leaves no
  // half-applied (unsaved) edit behind.
  const index = s.added.findIndex(sameKey(key));
  const wasRemoved = s.removed.includes(key);
  const unallow = allowlistOverlap(s, key);
  if (index === -1 && s.added.length >= LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} added words. Remove some first.` };
  }
  if (s.allowRemoved.length + unallow.defaults.length > LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} removed allowlist words.` };
  }
  if (index === -1) s.added.push(entry);
  else s.added[index] = entry;
  s.removed = s.removed.filter((k) => k !== key);
  s.allowAdded = s.allowAdded.filter((w) => !unallow.added.includes(w));
  s.allowRemoved.push(...unallow.defaults);
  commitListChange(guildId);

  // "Re-enabled" only when a removed default comes back; re-adding a default that was
  // never removed just changes its options for this server.
  const verb = wasRemoved ? 'Re-enabled' : index !== -1 || defaultTermKeys.has(key) ? 'Updated' : 'Added';
  // Say what matching the word will really get: phrases and short words never get
  // misspellings, and phrases can't be found inside a word, whatever was asked for.
  const compiled = compileList({ terms: [entry] });
  const how = [compiled.fuzzy.length ? 'catches misspellings' : 'exact spellings only'];
  if (compiled.embedded.length) how.push('also inside longer words');
  const unallowed = unallow.added.length + unallow.defaults.length ? ' It was also taken off the allowlist.' : '';
  return { ok: true, message: `${verb} ||${escapeSpoiler(clean)}|| (${entry.action}, ${how.join(', ')}).${unallowed}` };
}

export function removeTerm(guildId, term) {
  const clean = cleanInput(term);
  const key = termKey(clean);
  if (!key) return { ok: false, message: "That isn't on the blacklist." };

  // Work out the whole change before touching anything, so a refusal leaves no
  // half-applied (unsaved) edit behind.
  const s = automodSettings(guildId);
  const inAdded = s.added.some(sameKey(key));
  const hideDefault = defaultTermKeys.has(key) && !s.removed.includes(key);
  if (!inAdded && !hideDefault) return { ok: false, message: "That isn't on the blacklist." };
  if (hideDefault && s.removed.length >= LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} removed default words.` };
  }
  if (inAdded) s.added = s.added.filter((e) => !sameKey(key)(e));
  if (hideDefault) s.removed.push(key);
  commitListChange(guildId);
  return { ok: true, message: `Removed ||${escapeSpoiler(clean)}|| from this server's blacklist.` };
}

export function allowWord(guildId, word) {
  const key = allowKey(cleanInput(word));
  if (!key || key.length > LIMITS.termLength) return { ok: false, message: `Allowlist words need 2-${LIMITS.termLength} characters.` };

  const s = automodSettings(guildId);
  const isDefault = defaultAllowKeys.has(key);
  // A default word that this server switched off just gets switched back on.
  const reEnable = isDefault && s.allowRemoved.includes(key);
  const alreadyAllowed = !reEnable && (isDefault || s.allowAdded.includes(key));
  const tKey = termKey(key);
  const unlist = tKey ? blacklistOverlap(s, tKey) : { added: false, hideDefault: false };
  const unlists = unlist.added || unlist.hideDefault;

  // Allowing a word that's already allowed still clears it off the blacklist, which
  // tidies up any overlap left from before the two lists were kept apart.
  if (alreadyAllowed && !unlists) return { ok: false, message: 'That word is already allowed.' };
  if (!reEnable && !alreadyAllowed && s.allowAdded.length >= LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} allowlist words.` };
  }
  if (unlist.hideDefault && s.removed.length >= LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} removed default words.` };
  }
  if (reEnable) s.allowRemoved = s.allowRemoved.filter((k) => k !== key);
  else if (!alreadyAllowed) s.allowAdded.push(key);
  if (unlist.added) s.added = s.added.filter((e) => !sameKey(tKey)(e));
  if (unlist.hideDefault) s.removed.push(tKey);
  commitListChange(guildId);
  const shown = `"${escapeMarkdown(key)}"`;
  if (alreadyAllowed) return { ok: true, message: `${shown} was already allowed; it has now been taken off the blacklist too.` };
  const note = unlists ? ' It was also taken off the blacklist.' : '';
  return { ok: true, message: `${shown} is now allowed and will never be flagged.${note}` };
}

export function unallowWord(guildId, word) {
  const key = allowKey(cleanInput(word));
  const s = automodSettings(guildId);
  if (!key) return { ok: false, message: "That word isn't on the allowlist." };

  const inAdded = s.allowAdded.includes(key);
  const hideDefault = defaultAllowKeys.has(key) && !s.allowRemoved.includes(key);
  if (!inAdded && !hideDefault) return { ok: false, message: "That word isn't on the allowlist." };
  if (hideDefault && s.allowRemoved.length >= LIMITS.listEntries) {
    return { ok: false, message: `This server already has ${LIMITS.listEntries} removed allowlist words.` };
  }
  if (inAdded) s.allowAdded = s.allowAdded.filter((k) => k !== key);
  if (hideDefault) s.allowRemoved.push(key);
  commitListChange(guildId);
  return { ok: true, message: `"${escapeMarkdown(key)}" is no longer allowed.` };
}

/** Plain-text dump of the server's effective lists, for /blacklist list. */
export function listText(guildId) {
  const s = automodSettings(guildId);
  const removed = new Set(s.removed);
  const addedKeys = new Set(s.added.map((e) => termKey(e.term)));
  const describe = (e, source) => `${e.term}  [${e.action === 'review' ? 'review' : 'reject'}${e.match ? `, ${e.match}` : ''}] (${source})`;

  const terms = [
    ...defaultTerms.filter((t) => !removed.has(t.key) && !addedKeys.has(t.key)).map((t) => describe(t.entry, `default, ${t.entry.category ?? 'other'}`)),
    ...s.added.map((e) => describe(e, 'added by this server')),
  ].sort((a, b) => a.localeCompare(b));

  const allowRemoved = new Set(s.allowRemoved);
  const allow = [...defaultAllow.filter((w) => !allowRemoved.has(w.key)).map((w) => w.key), ...s.allowAdded].sort();

  return [
    `Blacklist (${terms.length})`,
    '='.repeat(40),
    ...terms,
    '',
    `Allowlist (${allow.length}) - never flagged`,
    '='.repeat(40),
    ...allow,
    '',
    `Removed default words: ${s.removed.length}`,
  ].join('\n');
}

// ---- Cards ---------------------------------------------------------------

/** Escapes text for use inside a ||spoiler||, so it can't close the spoiler early. */
function escapeSpoiler(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
const spoiler = (text, max = 1000) => `||${escapeSpoiler(String(text).slice(0, max))}||`;

function describeMatch(match) {
  if (!match) return 'Nothing';
  return `${spoiler(match.term, 100)} via ${match.how} (found ${spoiler(match.found, 100)})`;
}

function cardEmbed(record, { title, color, decision }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(spoiler(record.text))
    .addFields(
      { name: 'Filed by', value: `<@${record.userId}>`, inline: true },
      { name: 'Certainty', value: `${Math.round(record.score * 100)}%`, inline: true },
      { name: 'Matched', value: describeMatch(record.match) },
    )
    .setTimestamp(record.at);
  if (decision) embed.addFields({ name: 'Decision', value: decision });
  return embed;
}

const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function reviewCard(id, record) {
  return {
    embeds: [cardEmbed(record, { title: '🕵️ Held for review', color: COLORS.review })],
    components: [
      new ActionRowBuilder().addComponents(
        button(`am:approve:${id}`, 'Approve', ButtonStyle.Success),
        button(`am:reject:${id}`, 'Reject', ButtonStyle.Danger),
        button(`am:addterm:${id}`, 'Reject + add word', ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: NO_MENTIONS,
  };
}

function rejectedCard(id, record) {
  return {
    embeds: [cardEmbed(record, { title: '❌ Automatically rejected', color: COLORS.rejected })],
    components: [new ActionRowBuilder().addComponents(button(`am:override:${id}`, 'Override & post', ButtonStyle.Secondary))],
    allowedMentions: NO_MENTIONS,
    // A log entry, not a to-do: shows as unread but doesn't notify anyone.
    flags: MessageFlags.SuppressNotifications,
  };
}

/**
 * Best-effort note in the review channel (blacklist changes, timeouts). Sent silently,
 * so it never notifies anyone, even in servers set to "All Messages".
 */
export async function logToReviewChannel(guild, content) {
  try {
    const channel = await getReviewChannel(guild);
    await channel.send({ content, allowedMentions: NO_MENTIONS, flags: MessageFlags.SuppressNotifications });
  } catch (err) {
    console.warn(`Couldn't post to the review channel in ${guild.name}: ${err.message}`);
  }
}

// ---- Pending items -------------------------------------------------------

/**
 * Stores a pending item, making room by dropping the oldest rejection logs if the
 * server is at its limit. Returns the new id, or null if the queue is full of
 * items still waiting for a decision.
 */
function addPending(guildId, record) {
  const pending = guildData(guildId).pending;
  const ids = Object.keys(pending);
  if (ids.length >= LIMITS.pending) {
    // `?.` because a hand-edited file can hold junk until the next prune removes it.
    const oldestRejected = ids.filter((id) => pending[id]?.kind === 'rejected').sort((a, b) => pending[a].at - pending[b].at);
    for (const id of oldestRejected.slice(0, ids.length - LIMITS.pending + 1)) delete pending[id];
    if (Object.keys(pending).length >= LIMITS.pending) return null;
  }
  const id = randomUUID();
  pending[id] = record;
  return id;
}

function newRecord(kind, user, text, result) {
  const m = result.match;
  return {
    kind,
    text,
    userId: user.id,
    score: result.score,
    match: m ? { term: m.term, how: m.how, found: String(m.found).slice(0, 100) } : null,
    cardChannelId: null,
    cardMessageId: null,
    at: Date.now(),
  };
}

/** Posts a card for a new pending item, or removes the item again if that fails. */
async function postCard(guild, id, record, render) {
  const pending = guildData(guild.id).pending;
  try {
    const channel = await getReviewChannel(guild);
    const message = await channel.send(render(id, record));
    record.cardChannelId = channel.id;
    record.cardMessageId = message.id;
    trySave('posting a review card');
  } catch (err) {
    delete pending[id];
    trySave('removing an undelivered review card');
    throw err;
  }
}

/**
 * Holds an allegation for the mods. Returns 'queued', 'member-limit' (this member
 * already has MAX_WAITING_PER_MEMBER waiting) or 'full' (the server's queue is full).
 * Throws if the card couldn't be posted (nothing is left behind in that case).
 */
export async function queueForReview(guild, user, text, result) {
  const waiting = Object.values(guildData(guild.id).pending).filter((r) => r?.kind === 'review' && r.userId === user.id);
  if (waiting.length >= MAX_WAITING_PER_MEMBER) return 'member-limit';
  const record = newRecord('review', user, text, result);
  const id = addPending(guild.id, record);
  if (!id) return 'full';
  await postCard(guild, id, record, reviewCard);
  return 'queued';
}

/**
 * Everything that happens after an automatic rejection apart from replying to the
 * user: the log card (if enabled) and strikes. Never throws; problems are logged,
 * because the rejection itself has already happened.
 */
export async function afterAutoReject(guild, user, text, result, { isAdmin = false } = {}) {
  const s = automodSettings(guild.id);
  // Admins can't be timed out, so a strike would only produce "can't time out" noise.
  const strikeAt = s.strikes.enabled && !isAdmin ? Date.now() : null;
  if (s.logRejections) {
    const record = newRecord('rejected', user, text, result);
    // Remembered so "Override & post" can take this strike back.
    if (strikeAt) record.strikeAt = strikeAt;
    const id = addPending(guild.id, record);
    if (id) await postCard(guild, id, record, rejectedCard).catch((err) => console.warn(`Couldn't log a rejection in ${guild.name}: ${err.message}`));
  }
  if (strikeAt) await recordStrike(guild, user.id, s.strikes, strikeAt);
}

// ---- Strikes -------------------------------------------------------------

async function recordStrike(guild, userId, rules, now) {
  const g = guildData(guild.id);
  const windowMs = rules.windowMinutes * 60_000;
  const recent = (Array.isArray(g.strikes[userId]) ? g.strikes[userId] : []).filter((t) => typeof t === 'number' && now - t < windowMs);
  recent.push(now);

  if (recent.length < rules.limit) {
    g.strikes[userId] = recent.slice(-rules.limit); // only the newest ones can ever matter
    trySave('recording a strike');
    return;
  }

  delete g.strikes[userId];
  trySave('clearing strikes');
  const count = recent.length;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return; // they left the server
  if (!member.moderatable) {
    await logToReviewChannel(
      guild,
      `⚠️ <@${userId}> reached ${count} automatic rejection(s) but I can't time them out. ` +
        "Admins and the server owner can't be timed out; otherwise give me **Timeout Members** and put my role above theirs.",
    );
    return;
  }
  try {
    await member.timeout(rules.timeoutMinutes * 60_000, `Automod: ${count} automatic rejection(s) within ${rules.windowMinutes} min`);
    await logToReviewChannel(guild, `⏱️ <@${userId}> was timed out for ${rules.timeoutMinutes} min after ${count} automatic rejection(s).`);
  } catch (err) {
    console.warn(`Couldn't time out a member in ${guild.name}: ${err.message}`);
    await logToReviewChannel(guild, `⚠️ Couldn't time out <@${userId}>: ${escapeMarkdown(err.message)}`);
  }
}

/** Takes back the strike a rejection caused, if it's still counting. */
function removeStrike(guildId, userId, strikeAt) {
  const strikes = guildData(guildId).strikes;
  const times = Array.isArray(strikes[userId]) ? strikes[userId] : [];
  const index = times.indexOf(strikeAt);
  if (index === -1) return; // already expired, or used up by a timeout
  times.splice(index, 1);
  if (!times.length) delete strikes[userId];
}

// ---- Cards whose message or channel disappears ---------------------------

/**
 * Deleting a card (or purging the review channel) dismisses its item, so items can't
 * be left behind with no way to act on them. Called for every deleted message.
 */
export function forgetCards(guild, channelId, messageIds) {
  const ids = new Set(messageIds);
  const pending = guildData(guild.id).pending;
  let changed = false;
  for (const [id, record] of Object.entries(pending)) {
    if (record?.cardChannelId === channelId && ids.has(record.cardMessageId)) {
      delete pending[id];
      changed = true;
    }
  }
  if (changed) trySave('dismissing deleted review cards');
}

/** Posts fresh cards in `channel` for every item whose card was in `fromChannelId`. */
async function repostCards(guild, channel, fromChannelId) {
  const pending = guildData(guild.id).pending;
  let moved = 0;
  for (const [id, record] of Object.entries(pending)) {
    if (record?.cardChannelId !== fromChannelId) continue;
    try {
      const message = await channel.send((record.kind === 'review' ? reviewCard : rejectedCard)(id, record));
      record.cardChannelId = channel.id;
      record.cardMessageId = message.id;
      moved += 1;
    } catch (err) {
      console.warn(`Couldn't repost review cards in ${guild.name}: ${err.message}`);
      break; // the rest will be tried the next time the channel is recreated
    }
  }
  if (moved) trySave('reposting review cards');
}

// A recreated review channel gets the cards that were lost with the old one. The new
// channel is passed in directly: asking getReviewChannel() here would wait on itself.
onReviewChannelCreated((guild, channel, previousId) => (previousId ? repostCards(guild, channel, previousId) : undefined));

/**
 * If a channel holding cards for waiting items is deleted, put those cards somewhere
 * usable straight away (recreating the review channel if that's the one that went).
 */
export async function handleChannelDelete(channel) {
  if (!channel.guild) return;
  const { guild } = channel;
  const waiting = Object.values(guildData(guild.id).pending).some((r) => r?.kind === 'review' && r.cardChannelId === channel.id);
  if (!waiting) return;
  // Decide before awaiting: once the review channel is recreated its saved id changes.
  const wasReviewChannel = channel.id === automodSettings(guild.id).reviewChannelId;
  const target = await getReviewChannel(guild);
  // The review channel's recreation already reposts its cards through the hook above;
  // doing it here as well would post every card twice. An older channel needs it here.
  if (!wasReviewChannel) await repostCards(guild, target, channel.id);
}

/**
 * The bot was removed from a server: forget the held/rejected texts and strikes, which
 * are personal data with no further use. Settings and the word list are kept in case
 * the bot is added back.
 */
export function forgetServerData(guildId) {
  const g = data.guilds[guildId];
  if (!g) return;
  g.pending = {};
  g.strikes = {};
  trySave('leaving a server');
}

// ---- Buttons and the add-word modal --------------------------------------

const COMPONENT_ID = /^am:(approve|reject|override|addterm|addterm-modal):([0-9a-f-]{36})$/;

const replyPrivately = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });

/**
 * Handles automod buttons and the add-word modal. Returns false for anything that
 * isn't ours, so other handlers can try.
 */
export async function handleComponent(interaction) {
  const parsed = COMPONENT_ID.exec(interaction.customId ?? '');
  if (!parsed) return false;
  const [, action, id] = parsed;

  if (!interaction.inCachedGuild()) {
    await replyPrivately(interaction, 'This only works inside the server.');
    return true;
  }
  // Seeing the review channel isn't enough; the clicker must be a mod right now.
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
    await replyPrivately(interaction, 'You need the **Manage Messages** permission to do that.');
    return true;
  }

  const pending = guildData(interaction.guildId).pending;
  const record = pending[id];
  const expectedKind = action === 'override' ? 'rejected' : 'review';
  if (!record || record.kind !== expectedKind) {
    await replyPrivately(interaction, 'That has already been handled, or it has expired.');
    return true;
  }

  // Adding a word makes automod stricter, which needs Timeout Members while strikes are on.
  if ((action === 'addterm' || action === 'addterm-modal') && blockedFromTightening(interaction)) {
    await replyPrivately(interaction, TIMEOUT_PERMISSION_NEEDED);
    return true;
  }
  if (action === 'addterm') {
    await interaction.showModal(addWordModal(id));
    return true;
  }

  let note = '';
  if (action === 'addterm-modal') {
    const result = addTerm(interaction.guildId, { term: interaction.fields.getTextInputValue('term') }, interaction.user.id);
    if (!result.ok) {
      await replyPrivately(interaction, `${result.message} The allegation is still waiting for review.`);
      return true;
    }
    note = ' and added a word to the blacklist';
  }

  const verdict = action === 'approve' || action === 'override' ? 'approve' : 'reject';
  await decide(interaction, id, record, verdict, note);
  return true;
}

function addWordModal(id) {
  return new ModalBuilder()
    .setCustomId(`am:addterm-modal:${id}`)
    .setTitle('Reject and blacklist a word')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Word or phrase to add to the blacklist')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('term')
            .setStyle(TextInputStyle.Short)
            .setMinLength(2)
            .setMaxLength(LIMITS.termLength)
            .setRequired(true),
        ),
    );
}

/**
 * Approves or rejects a pending item. The item is removed before the first await,
 * so if two mods click at once only the first one gets here with it.
 */
async function decide(interaction, id, record, verdict, note) {
  const { guild } = interaction;
  const pending = guildData(guild.id).pending;
  delete pending[id];
  try {
    await interaction.deferUpdate();
  } catch (err) {
    // Discord didn't accept the click (e.g. it timed out), so nothing was decided:
    // put the item back before reporting the error, or it would silently vanish.
    pending[id] = record;
    throw err;
  }

  const by = `<@${interaction.user.id}>`;
  let card;
  let dm;
  if (verdict === 'approve') {
    let posted;
    try {
      const author = await interaction.client.users.fetch(record.userId).catch(() => null);
      posted = await postAllegation(guild, {
        text: record.text,
        userId: record.userId,
        avatarURL: author?.displayAvatarURL({ size: 128 }) ?? null,
      });
    } catch (err) {
      // Put it back so it can be tried again, and tell only the mod who clicked.
      pending[id] = record;
      trySave('restoring a pending item');
      console.error('Approving an allegation failed:', err);
      await interaction
        .followUp({
          content: "Couldn't post that allegation. Check my permissions in the allegations channel and try again.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_MENTIONS,
        })
        .catch(() => {});
      return;
    }
    const overridden = record.kind === 'rejected';
    // A mod ruled the rejection wrong, so it shouldn't count towards a timeout.
    if (overridden && record.strikeAt) {
      removeStrike(guild.id, record.userId, record.strikeAt);
      trySave('removing an overridden strike');
    }
    card = cardEmbed(record, {
      title: overridden ? '✅ Overridden and posted' : '✅ Approved',
      color: COLORS.approved,
      decision: `${overridden ? 'Overridden' : 'Approved'} by ${by}; posted as **#${posted.number}** in ${posted.channel}.`,
    });
    dm = `✅ Your allegation in **${escapeMarkdown(guild.name)}** was approved by the moderators and posted as #${posted.number}.`;
  } else {
    trySave('rejecting a pending item');
    card = cardEmbed(record, { title: '🚫 Rejected', color: COLORS.dismissed, decision: `Rejected by ${by}${note}.` });
    dm = `❌ Your allegation in **${escapeMarkdown(guild.name)}** was rejected by the moderators.`;
  }

  await interaction.editReply({ embeds: [card], components: [], allowedMentions: NO_MENTIONS }).catch((err) => {
    console.warn(`Couldn't update a review card in ${guild.name}: ${err.message}`);
  });
  // Best effort: the author may have DMs closed or have left the server.
  await interaction.client.users.send(record.userId, { content: dm, allowedMentions: NO_MENTIONS }).catch(() => {});
}

// ---- Housekeeping --------------------------------------------------------

/** Drops expired rejection logs and strikes in every server. Run at startup and hourly. */
export function pruneExpired() {
  const now = Date.now();
  let changed = false;
  for (const guildId of Object.keys(data.guilds)) {
    const g = guildData(guildId);
    for (const [id, record] of Object.entries(g.pending)) {
      // Anything malformed (hand edits, old versions) is dropped rather than shown on a card.
      const valid =
        record &&
        (record.kind === 'review' || record.kind === 'rejected') &&
        typeof record.text === 'string' &&
        /^\d{17,20}$/.test(record.userId) &&
        Number.isFinite(record.score) &&
        Number.isFinite(record.at);
      if (!valid || (record.kind === 'rejected' && !(now - record.at < REJECTED_LOG_TTL_MS))) {
        delete g.pending[id];
        changed = true;
      }
    }
    const windowMs = automodSettings(guildId).strikes.windowMinutes * 60_000;
    for (const [userId, times] of Object.entries(g.strikes)) {
      const recent = Array.isArray(times) ? times.filter((t) => typeof t === 'number' && now - t < windowMs) : [];
      if (recent.length === (Array.isArray(times) ? times.length : -1)) continue;
      if (recent.length) g.strikes[userId] = recent;
      else delete g.strikes[userId];
      changed = true;
    }
  }
  if (changed) trySave('pruning expired items');
}

/** Counts for /automod status. */
export function pendingCounts(guildId) {
  const counts = { review: 0, rejected: 0 };
  for (const record of Object.values(guildData(guildId).pending)) {
    if (Object.hasOwn(counts, record?.kind)) counts[record.kind] += 1;
  }
  return counts;
}

export { describeMatch };
