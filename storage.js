// storage.js - the bot's only database: one JSON file, rewritten atomically on change.
//
// data.json remembers, per server: the allegations channel, the list of posted
// allegations, automod settings, items waiting for review, and recent strikes.

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLDS } from './automod.js';

// Tests point this at a scratch file so they never touch the real data.
const DATA_FILE = process.env.ALLEGATIONS_DATA_FILE || fileURLToPath(new URL('./data.json', import.meta.url));
const TMP_FILE = `${DATA_FILE}.tmp`;

// Never refuse to start because of a damaged data file. Try data.json, then the temp
// file from an interrupted save; if data.json is unreadable, move it aside so it isn't
// overwritten and can be repaired by hand.
function loadData() {
  for (const file of [DATA_FILE, TMP_FILE]) {
    if (!existsSync(file)) continue;
    try {
      // Strip a UTF-8 BOM: editors and PowerShell often add one when the file is
      // hand-edited, and JSON.parse rejects it.
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (isPlainObject(parsed) && isPlainObject(parsed.guilds)) return parsed;
      throw new Error('unexpected format');
    } catch (err) {
      console.warn(`Couldn't read ${file}: ${err.message}`);
    }
  }
  if (existsSync(DATA_FILE)) {
    const aside = `${DATA_FILE}.corrupt-${Date.now()}`;
    // The move itself can fail (file locked); that mustn't stop startup either.
    try {
      renameSync(DATA_FILE, aside);
      console.warn(`Moved the unreadable data file to ${aside}.`);
    } catch (err) {
      console.warn(`Couldn't move the unreadable data file aside (${err.message}); it will be overwritten.`);
    }
    console.warn('Allegation numbers start again from #1.');
  }
  return { guilds: {} };
}

export const data = loadData();

/**
 * Atomic save: write a temp file, then rename it over data.json. A crash mid-write
 * can only damage the temp file, never data.json itself.
 */
export function saveData() {
  const json = JSON.stringify(data, null, 2);
  writeFileSync(TMP_FILE, json);
  try {
    renameSync(TMP_FILE, DATA_FILE);
  } catch {
    // Windows can briefly lock a file (antivirus, indexer). Fall back to a direct write,
    // then remove the temp file: left behind, loadData() could one day prefer this
    // (by then stale) copy over a damaged data.json.
    writeFileSync(DATA_FILE, json);
    try {
      rmSync(TMP_FILE, { force: true });
    } catch {
      // Still locked; harmless, it's identical to data.json right now.
    }
  }
}

/**
 * Saves, but logs instead of throwing. For places where the in-memory change has
 * already happened and must stand; the next successful save writes it to disk.
 */
export function trySave(context) {
  try {
    saveData();
    return true;
  } catch (err) {
    console.error(`Couldn't save data.json after ${context} (${err.message}); will retry on the next save.`);
    return false;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Discord ids are 17-20 digit "snowflakes". Anything else in the file is ignored.
const isSnowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isAllegationEntry = (e) => isPlainObject(e) && isSnowflake(e.id) && Number.isSafeInteger(e.shown);

/** Gets or creates a server's record, repairing the top-level fields if needed. */
export function guildData(guildId) {
  const g = (data.guilds[guildId] = isPlainObject(data.guilds[guildId]) ? data.guilds[guildId] : {});
  if (!isSnowflake(g.channelId)) g.channelId = null;
  // The posted allegations, oldest first (see allegations.js). Only replaced when
  // something is actually wrong, because callers may be holding the array.
  if (!Array.isArray(g.allegations)) g.allegations = [];
  else if (!g.allegations.every(isAllegationEntry)) g.allegations = g.allegations.filter(isAllegationEntry);
  // Old data files kept a bare counter instead; the startup rebuild replaces it.
  delete g.count;
  if (!isPlainObject(g.pending)) g.pending = {};
  if (!isPlainObject(g.strikes)) g.strikes = {};
  return g;
}

// ---- Automod settings -----------------------------------------------------

/** Limits shared by the settings repair below and the slash command options. */
export const LIMITS = Object.freeze({
  threshold: { min: 0.05, max: 1 },
  // Seconds between allegations from one member. The 5 s floor keeps one spammer from
  // pushing the bot into Discord's rate limits for everyone.
  cooldownSeconds: { min: 5, max: 86_400, default: 30 },
  // After an automatic rejection. The normal cooldown still applies if it's longer (see
  // /new allegation), so a rejection never lets anyone retry sooner.
  rejectCooldownSeconds: { min: 5, max: 86_400, default: 30 },
  strikeLimit: { min: 1, max: 50, default: 3 },
  strikeWindowMinutes: { min: 1, max: 43_200, default: 1_440 }, // up to 30 days
  timeoutMinutes: { min: 1, max: 40_320, default: 10 }, // Discord's timeout maximum is 28 days
  listEntries: 500, // per server: added terms, removed terms, allowlist changes
  pending: 500, // per server: review + rejected items
  termLength: 100,
});

const inRange = (value, { min, max }) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const intOr = (value, limits) => (Number.isInteger(value) && inRange(value, limits) ? value : limits.default);
const stringList = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length <= LIMITS.termLength).slice(0, LIMITS.listEntries) : [];

/**
 * A server's automod settings with every field present and valid. Missing or bad
 * values (old data files, hand edits) are replaced with defaults in place, so the
 * rest of the bot can trust the shape without checking.
 */
export function automodSettings(guildId) {
  const g = guildData(guildId);
  const s = (g.automod = isPlainObject(g.automod) ? g.automod : {});

  if (typeof s.enabled !== 'boolean') s.enabled = true;
  if (!isSnowflake(s.reviewChannelId)) s.reviewChannelId = null;
  if (typeof s.logRejections !== 'boolean') s.logRejections = true;
  s.cooldownSeconds = intOr(s.cooldownSeconds, LIMITS.cooldownSeconds);
  s.rejectCooldownSeconds = intOr(s.rejectCooldownSeconds, LIMITS.rejectCooldownSeconds);

  const t = isPlainObject(s.thresholds) ? s.thresholds : {};
  const valid = inRange(t.reject, LIMITS.threshold) && inRange(t.review, LIMITS.threshold) && t.review < t.reject;
  s.thresholds = valid ? { reject: t.reject, review: t.review } : { ...DEFAULT_THRESHOLDS };

  const k = isPlainObject(s.strikes) ? s.strikes : {};
  s.strikes = {
    enabled: typeof k.enabled === 'boolean' ? k.enabled : false,
    limit: intOr(k.limit, LIMITS.strikeLimit),
    windowMinutes: intOr(k.windowMinutes, LIMITS.strikeWindowMinutes),
    timeoutMinutes: intOr(k.timeoutMinutes, LIMITS.timeoutMinutes),
  };

  s.added = Array.isArray(s.added)
    ? s.added
        .filter((e) => isPlainObject(e) && typeof e.term === 'string' && e.term.length <= LIMITS.termLength)
        .slice(0, LIMITS.listEntries)
    : [];
  s.removed = stringList(s.removed);
  s.allowAdded = stringList(s.allowAdded);
  s.allowRemoved = stringList(s.allowRemoved);
  return s;
}
