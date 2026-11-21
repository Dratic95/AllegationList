// allegations.js - the numbered list of allegations, and the per-user cooldown.
//
// An allegation's number is its position among the allegations that still exist in
// the channel. guildData(id).allegations is that list, oldest first:
//   [{ id: <message id>, shown: <number currently written on the message> }, ...]
// Every change to the list (posting, deletions, the startup rebuild) goes through a
// per-server queue so they can't interleave. Fixing the numbers written on messages
// after a deletion is done by a background worker (see scheduleRenumber).

import { EmbedBuilder, RESTJSONErrorCodes } from 'discord.js';
import { guildData, trySave } from './storage.js';
import { getAllegationsChannel } from './channels.js';

export const COOLDOWN_SECONDS = 30; // one allegation per user per server every 30 s

const NO_MENTIONS = Object.freeze({ parse: [] });
const TITLE = /^Allegation #(\d+)$/;
const titleFor = (number) => `Allegation #${number}`;
// Embeds render [text](url) as a link whose address is hidden. Escaping the brackets
// shows it literally, so the public channel can't carry disguised (phishing) links;
// a bare address is still visible to everyone.
const withoutMaskedLinks = (text) => text.replace(/[[\]]/g, '\\$&');
// The startup rebuild reads at most this many pages of 100 messages. A channel with
// more history than that is left as it is rather than rebuilt from part of it.
const MAX_HISTORY_PAGES = 200;

// ---- Per-server queue -----------------------------------------------------

const queues = new Map(); // guildId -> tail of that server's queue

/**
 * Runs `task` after every earlier task for the same server has finished (whether it
 * succeeded or not). Returns the task's own result or error.
 */
function serial(guildId, task) {
  const result = (queues.get(guildId) ?? Promise.resolve()).then(task);
  const tail = result.catch(() => {}); // one failure mustn't block the tasks after it
  queues.set(guildId, tail);
  tail.then(() => {
    if (queues.get(guildId) === tail) queues.delete(guildId); // nothing else queued
  });
  return result;
}

// ---- Posting ----------------------------------------------------------------

/**
 * Posts an allegation to the server's allegations channel and returns its number.
 * Used both for allegations that pass automod and for ones a mod approves.
 *
 * Runs in the server's queue, so the number (list length + 1) can't be given to two
 * allegations at once. Nothing is added to the list unless the post succeeded.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ text: string, userId: string, avatarURL?: string | null }} allegation
 * @returns {Promise<{ number: number, channel: import('discord.js').TextChannel }>}
 */
export function postAllegation(guild, { text, userId, avatarURL = null }) {
  return serial(guild.id, async () => {
    // Fetch the channel first: if it had to be recreated, the list was reset with it.
    const channel = await getAllegationsChannel(guild);
    const number = guildData(guild.id).allegations.length + 1;

    const embed = new EmbedBuilder()
      .setColor(0xc0392b)
      .setTitle(titleFor(number))
      .setDescription(withoutMaskedLinks(text))
      .addFields({ name: 'Filed by', value: `<@${userId}>` })
      .setTimestamp();
    if (avatarURL) embed.setThumbnail(avatarURL);

    const message = await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
    // Re-read the list rather than holding it across the await, in case it was replaced.
    guildData(guild.id).allegations.push({ id: message.id, shown: number });
    // The allegation is posted either way; if this save fails, the startup rebuild
    // will find the message in the channel anyway.
    trySave('posting an allegation');
    return { number, channel };
  });
}

// ---- Deletions --------------------------------------------------------------

/**
 * Called for every deleted message the bot hears about. Ignores anything outside the
 * server's allegations channel; otherwise removes those allegations from the list and
 * starts renumbering the ones after them.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} channelId
 * @param {Iterable<string>} messageIds
 */
export function forgetAllegations(guild, channelId, messageIds) {
  if (channelId !== guildData(guild.id).channelId) return Promise.resolve();
  const ids = new Set(messageIds);
  return serial(guild.id, async () => {
    const g = guildData(guild.id);
    const kept = g.allegations.filter((entry) => !ids.has(entry.id));
    if (kept.length === g.allegations.length) return; // not an allegation (e.g. the intro)
    g.allegations = kept;
    trySave('removing deleted allegations');
    scheduleRenumber(guild);
  });
}

// ---- Startup rebuild ----------------------------------------------------------

/**
 * Rebuilds the server's list from the allegations channel itself: every "Allegation #N"
 * message the bot posted, oldest first. This catches deletions made while the bot was
 * offline, and migrates data files from before the list existed. Then renumbers.
 */
export function rebuildFromChannel(guild) {
  return serial(guild.id, async () => {
    const channel = await getAllegationsChannel(guild);
    const botId = guild.client.user.id;
    const found = [];
    let before;
    let complete = false;

    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
      for (const message of batch.values()) {
        const match = message.author?.id === botId ? TITLE.exec(message.embeds[0]?.title ?? '') : null;
        if (match) found.push({ id: message.id, shown: Number(match[1]) });
        if (before === undefined || BigInt(message.id) < BigInt(before)) before = message.id;
      }
      if (batch.size < 100) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      console.warn(`The allegations channel in ${guild.name} has too much history to rebuild; keeping the saved list.`);
      return;
    }

    // Message ids are snowflakes, which sort by creation time.
    found.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    guildData(guild.id).allegations = found;
    trySave('rebuilding the allegations list');
    scheduleRenumber(guild);
  });
}

// ---- Renumbering --------------------------------------------------------------

const renumbering = new Set(); // ids of servers whose worker is running

/**
 * Makes sure the server's renumber worker is running. Safe to call any number of
 * times: the running worker re-checks the whole list after every edit, so it also
 * picks up changes made while it's working.
 */
export function scheduleRenumber(guild) {
  if (renumbering.has(guild.id)) return;
  renumbering.add(guild.id);
  renumber(guild).catch((err) => {
    // Stop rather than hammer Discord; the next change or the hourly housekeeping retries.
    console.warn(`Renumbering allegations in ${guild.name} stopped: ${err.message}`);
  });
}

/** Retry hook for the hourly housekeeping: restarts any worker that stopped on an error. */
export function renumberAll(guilds) {
  for (const guild of guilds) scheduleRenumber(guild);
}

async function renumber(guild) {
  let edited = false;
  try {
    for (;;) {
      const list = guildData(guild.id).allegations;
      const index = list.findIndex((entry, i) => entry.shown !== i + 1);
      // Returning here clears the "running" flag in the same tick (finally runs
      // synchronously), so a change arriving afterwards always starts a fresh worker.
      if (index === -1) return;

      const entry = list[index];
      const number = index + 1;
      const channel = await getAllegationsChannel(guild);
      let message;
      try {
        message = await channel.messages.fetch({ message: entry.id, cache: false });
      } catch (err) {
        if (err.code !== RESTJSONErrorCodes.UnknownMessage) throw err;
        // Deleted without us hearing about it: drop it and carry on.
        await forgetAllegations(guild, channel.id, [entry.id]);
        // Guard against looping forever on the same entry if it somehow wasn't removed.
        if (guildData(guild.id).allegations.includes(entry)) throw new Error('a missing allegation could not be removed');
        continue;
      }

      const embed = message.embeds[0];
      if (embed) {
        await message.edit({ embeds: [EmbedBuilder.from(embed).setTitle(titleFor(number))], allowedMentions: NO_MENTIONS });
      }
      // Record what was actually written. If the list moved meanwhile, the next pass
      // sees the mismatch and edits this message again.
      entry.shown = number;
      edited = true;
    }
  } finally {
    renumbering.delete(guild.id);
    if (edited) trySave('renumbering allegations');
  }
}

// ---- Cooldowns ------------------------------------------------------------
// Stores when each user may file again, so different events can set different
// lengths (a normal filing vs an automatic rejection).

const cooldowns = new Map(); // `${guildId}:${userId}` -> time (ms) the cooldown ends

export const cooldownKey = (guildId, userId) => `${guildId}:${userId}`;

/** Seconds the user still has to wait, or 0 if they can file now. */
export function cooldownLeft(key) {
  const until = cooldowns.get(key);
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left <= 0) {
    cooldowns.delete(key);
    return 0;
  }
  return Math.ceil(left / 1000);
}

/** Starts (or replaces) a cooldown. 0 seconds clears it. */
export function startCooldown(key, seconds) {
  if (seconds > 0) cooldowns.set(key, Date.now() + seconds * 1000);
  else cooldowns.delete(key);
}

export const clearCooldown = (key) => cooldowns.delete(key);

/** Drops expired entries so the map can't grow forever. */
export function sweepCooldowns() {
  const now = Date.now();
  for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
}
