// channels.js - finds or creates the bot's two channels in a server:
//   allegations - public, read-only list of allegations
//   review      - private channel where mods review held allegations
//
// Both use the same self-healing logic: look the channel up by its saved id (so
// renaming it is safe), and only create a new one if Discord says it was deleted.

import { ChannelType, MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { guildData, automodSettings, trySave } from './storage.js';

const P = PermissionFlagsBits;

const KINDS = {
  allegations: {
    name: 'All Of M*rtins Allegations',
    fallbackName: 'all-of-mrtins-allegations', // used if Discord rejects the "*"
    topic: "The official, numbered record of M*rtin's crimes. Use /new allegation to file one.",
    getId: (guildId) => guildData(guildId).channelId,
    setId: (guildId, id) => {
      const g = guildData(guildId);
      g.channelId = id;
      // A new channel holds no allegations, so numbering starts again from #1.
      g.allegations = [];
    },
    // Everyone can read, nobody but the bot can type.
    overwrites: (guild, me) => [
      {
        id: guild.roles.everyone.id,
        allow: [P.ViewChannel, P.ReadMessageHistory],
        deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions],
      },
      { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
    ],
    intro: '📜 **The record is open.** Every allegation against M*rtin will be logged here. Use `/new allegation` to file one.',
  },
  review: {
    name: 'allegation-review',
    fallbackName: 'allegation-review',
    topic: 'Allegations held or rejected by automod. Use the buttons to approve or reject.',
    getId: (guildId) => automodSettings(guildId).reviewChannelId,
    setId: (guildId, id) => {
      automodSettings(guildId).reviewChannelId = id;
    },
    // Hidden from everyone; admins see it anyway, and an admin can let mods in.
    overwrites: (guild, me) => [
      { id: guild.roles.everyone.id, allow: [], deny: [P.ViewChannel] },
      { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] },
    ],
    intro:
      '🛡️ **Automod review channel.** Held and rejected allegations appear here. ' +
      'Only admins can see this channel until an admin gives mods access, ' +
      'or use `/automod review-channel` to pick a different channel.',
  },
};

// One in-flight lookup/creation per server and kind, so simultaneous callers
// (startup + a command, two commands) share it instead of each creating a channel.
const locks = new Map(); // `${kind}:${guildId}` -> Promise<TextChannel>

function getChannel(guild, kind) {
  const lockKey = `${kind}:${guild.id}`;
  let pending = locks.get(lockKey);
  if (!pending) {
    pending = findOrCreate(guild, KINDS[kind]).finally(() => locks.delete(lockKey));
    locks.set(lockKey, pending);
  }
  return pending;
}

export const getAllegationsChannel = (guild) => getChannel(guild, 'allegations');
export const getReviewChannel = (guild) => getChannel(guild, 'review');

/**
 * Registers a callback for when a review channel is created: (guild, channel, previousId),
 * where previousId is the deleted channel it replaces (null the first time). moderation.js
 * uses it to repost cards that were lost with the old channel. Kept as a hook so this
 * module doesn't depend on moderation.js.
 */
export function onReviewChannelCreated(callback) {
  KINDS.review.onCreate = callback;
}

async function findOrCreate(guild, spec) {
  const savedId = spec.getId(guild.id);
  if (savedId) {
    try {
      // Served from cache when possible, so normally no API call.
      const existing = await guild.channels.fetch(savedId);
      if (existing) return existing;
    } catch (err) {
      // Only a deleted channel (10003 Unknown Channel) is recreated. Anything else
      // (e.g. the bot lost access) means the channel still exists, and making another
      // would create a duplicate, so report the problem instead.
      if (err.code !== RESTJSONErrorCodes.UnknownChannel) throw err;
    }
  }

  const me = guild.members.me ?? (await guild.members.fetchMe());
  // Discord rejects the whole creation (50013) if an overwrite allows/denies a
  // permission the bot doesn't have itself, so keep only the ones it has. The invite
  // link requests all of them, so normally nothing is dropped.
  const own = (perms) => perms.filter((p) => me.permissions.has(p));
  const options = {
    type: ChannelType.GuildText,
    topic: spec.topic,
    permissionOverwrites: spec.overwrites(guild, me).map((o) => ({ id: o.id, allow: own(o.allow), deny: own(o.deny ?? []) })),
  };

  let channel;
  try {
    channel = await guild.channels.create({ name: spec.name, ...options });
  } catch (err) {
    // Only retry with the plain name if Discord rejected the form (50035); a
    // permissions error would just fail again.
    if (err.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType || spec.fallbackName === spec.name) throw err;
    channel = await guild.channels.create({ name: spec.fallbackName, ...options });
  }

  // The channel exists now, so a failed save mustn't fail this call: the id stays
  // in memory and is written by the next successful save.
  spec.setId(guild.id, channel.id);
  trySave('creating a channel');
  console.log(`Created #${channel.name} in ${guild.name}`);

  // The channel is usable even if the intro message fails, so don't fail the caller.
  // Sent silently: it's housekeeping, and shouldn't notify servers set to "All Messages".
  await channel
    .send({ content: spec.intro, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications })
    .catch((err) => console.warn(`Couldn't post the intro message in ${guild.name}: ${err.message}`));

  // After the intro, so reposted cards appear below it. Not awaited: the caller shouldn't
  // wait for them, and the hook must not ask for this channel through getChannel()
  // (that would wait on this very call).
  if (spec.onCreate) {
    Promise.resolve()
      .then(() => spec.onCreate(guild, channel, savedId ?? null))
      .catch((err) => console.warn(`After creating #${channel.name} in ${guild.name}: ${err.message}`));
  }
  return channel;
}

/** Startup / join hook: make sure the allegations channel exists, log any problem. */
export async function setUpGuild(guild) {
  try {
    await getAllegationsChannel(guild);
  } catch (err) {
    console.error(
      `Couldn't set up the allegations channel in "${guild.name}". ` +
        'Make sure the bot has the "Manage Channels" and "Manage Roles" permissions.\n',
      err.message,
    );
  }
}
