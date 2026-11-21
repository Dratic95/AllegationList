// commands.js - every slash command the bot registers.
//
// Each command is { data: SlashCommandBuilder, execute(interaction) }. index.js
// registers them with Discord and dispatches by name; to add a command, add an
// object to the `commands` array.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  InteractionContextType,
  ApplicationIntegrationType,
} from 'discord.js';
import { guildData, automodSettings, trySave, LIMITS } from './storage.js';
import { postAllegation, COOLDOWN_SECONDS, cooldownKey, cooldownLeft, startCooldown, clearCooldown } from './allegations.js';
import {
  screen,
  queueForReview,
  afterAutoReject,
  addTerm,
  addWouldUnallow,
  removeTerm,
  allowWord,
  unallowWord,
  listText,
  logToReviewChannel,
  pendingCounts,
  describeMatch,
  blockedFromTightening,
  TIMEOUT_PERMISSION_NEEDED,
} from './moderation.js';

const P = PermissionFlagsBits;
const PRIVATE = MessageFlags.Ephemeral;
const NO_MENTIONS = Object.freeze({ parse: [] });

// Server-only: no DMs, and no "user install" use in servers the bot isn't in.
const serverOnly = (builder) =>
  builder.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

// Mod commands are hidden from members without Manage Messages by default. Admins
// can change who sees them in Server Settings -> Integrations.
const modOnly = (builder) => serverOnly(builder).setDefaultMemberPermissions(P.ManageMessages);

const reply = (interaction, content) => interaction.reply({ content, flags: PRIVATE, allowedMentions: NO_MENTIONS });
const percent = (fraction) => `${Math.round(fraction * 100)}%`;

// ---- /new allegation ------------------------------------------------------

const newCommand = {
  // "/new allegation" = command "new" with subcommand "allegation"
  data: serverOnly(new SlashCommandBuilder().setName('new').setDescription('File something new')).addSubcommand((sub) =>
    sub
      .setName('allegation')
      .setDescription('File a new allegation against M*rtin')
      .addStringOption((o) => o.setName('allegation').setDescription('What did M*rtin do?').setRequired(true).setMaxLength(1000)),
  ),

  async execute(interaction) {
    // Backstop for the server-only registration: the bot must actually be in this server.
    if (!interaction.inCachedGuild()) return reply(interaction, 'The bot needs to be added to this server first.');

    // A whitespace-only allegation passes Discord's "required" check, so reject it here.
    const text = interaction.options.getString('allegation', true).trim();
    if (!text) return reply(interaction, "An allegation can't be empty.");

    // Admins can file as often as they like: no cooldown, before or after (automod still applies).
    const isAdmin = interaction.memberPermissions.has(P.Administrator);
    const key = cooldownKey(interaction.guildId, interaction.user.id);
    if (!isAdmin) {
      const wait = cooldownLeft(key);
      if (wait) return reply(interaction, `⏳ Slow down! You can file another allegation in ${wait}s.`);
      startCooldown(key, COOLDOWN_SECONDS); // set now so rapid double-submits are blocked too
    }

    let keepCooldown = false;
    try {
      // Acknowledge first so Discord's 3-second deadline can't expire during network work.
      await interaction.deferReply({ flags: PRIVATE });
      const result = screen(interaction.guildId, text);

      if (result.outcome === 'accept') {
        const { number, channel } = await postAllegation(interaction.guild, {
          text,
          userId: interaction.user.id,
          avatarURL: interaction.user.displayAvatarURL({ size: 128 }),
        });
        keepCooldown = true; // it's posted; a failed confirmation mustn't invite a duplicate
        await interaction.editReply(`✅ Allegation **#${number}** has been added to ${channel}.`);
        return;
      }

      if (result.outcome === 'review') {
        const queued = await queueForReview(interaction.guild, interaction.user, text, result);
        if (queued === 'member-limit') {
          await interaction.editReply('🕵️ You already have allegations waiting for the moderators. Please wait until they decide.');
          return;
        }
        if (queued === 'full') {
          await interaction.editReply('The moderators have too many allegations waiting for review. Please try again later.');
          return;
        }
        keepCooldown = true; // it's queued; same reasoning as above
        await interaction.editReply(
          "🕵️ Your allegation has been sent to the moderators for review. You'll get a DM when they decide (if your DMs are open).",
        );
        return;
      }

      // Rejected. The blocked word is deliberately not shown, so the filter can't be probed.
      keepCooldown = true;
      if (!isAdmin) startCooldown(key, automodSettings(interaction.guildId).rejectCooldownSeconds);
      try {
        await interaction.editReply(
          '❌ Your allegation was automatically rejected because it contains a blocked word or phrase. ' +
            'If you think this is a mistake, ask a moderator.',
        );
      } finally {
        // The log card and strike count must happen even if the reply couldn't be sent.
        await afterAutoReject(interaction.guild, interaction.user, text, result, { isAdmin });
      }
    } catch (err) {
      if (!keepCooldown) clearCooldown(key); // a failed attempt shouldn't lock the user out
      throw err; // the central handler tells the user
    }
  },
};

// ---- /ping ----------------------------------------------------------------

const pingCommand = {
  data: serverOnly(new SlashCommandBuilder().setName('ping').setDescription('Check the bot is alive')),
  async execute(interaction) {
    if (!interaction.inCachedGuild()) return reply(interaction, 'The bot needs to be added to this server first.');
    await interaction.reply({ content: 'Pinging…', allowedMentions: NO_MENTIONS });
    const sent = await interaction.fetchReply();
    await interaction.editReply({ content: `🏓 Pong! ${sent.createdTimestamp - interaction.createdTimestamp}ms`, allowedMentions: NO_MENTIONS });
  },
};

// ---- /blacklist -----------------------------------------------------------

const termOption = (name, description) => (o) =>
  o.setName(name).setDescription(description).setRequired(true).setMinLength(2).setMaxLength(LIMITS.termLength);

const blacklistCommand = {
  data: modOnly(new SlashCommandBuilder().setName('blacklist').setDescription("Manage this server's automod word list"))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a word or phrase to the blacklist')
        .addStringOption(termOption('term', 'The word or phrase'))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What a match does (default: reject)')
            .addChoices({ name: 'reject automatically', value: 'reject' }, { name: 'send to mods for review', value: 'review' }),
        )
        .addStringOption((o) =>
          o
            .setName('match')
            .setDescription('How loosely to match (default: fuzzy for single words of 5+ letters, else strict)')
            .addChoices(
              { name: 'fuzzy - catch misspellings and the word inside longer words', value: 'fuzzy' },
              { name: 'strict - exact spellings only', value: 'strict' },
              { name: 'anywhere - also catch it inside longer words (for short words)', value: 'anywhere' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('remove').setDescription('Remove a word or phrase from the blacklist').addStringOption(termOption('term', 'The word or phrase')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('allow')
        .setDescription('Never flag this word (e.g. an innocent word that looks like a blocked one)')
        .addStringOption(termOption('word', 'The word')),
    )
    .addSubcommand((sub) =>
      sub.setName('unallow').setDescription('Remove a word from the allowlist').addStringOption(termOption('word', 'The word')),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Get the full blacklist and allowlist as a private file')),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) return reply(interaction, 'This only works inside a server.');
    const { guildId } = interaction;
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const file = new AttachmentBuilder(Buffer.from(listText(guildId), 'utf8'), { name: 'blacklist.txt' });
      return interaction.reply({ content: "Here's this server's automod list.", files: [file], flags: PRIVATE });
    }

    // Adding a reject word or removing an allowed word makes automod stricter. Adding a
    // review word does too when it takes that word off the allowlist (see addTerm).
    const tightens =
      sub === 'unallow' ||
      (sub === 'add' &&
        ((interaction.options.getString('action') ?? 'reject') === 'reject' ||
          addWouldUnallow(guildId, interaction.options.getString('term', true))));
    if (tightens && blockedFromTightening(interaction)) return reply(interaction, TIMEOUT_PERMISSION_NEEDED);

    let result;
    let logLine;
    if (sub === 'add') {
      const term = interaction.options.getString('term', true);
      result = addTerm(
        guildId,
        { term, action: interaction.options.getString('action') ?? 'reject', match: interaction.options.getString('match') ?? undefined },
        interaction.user.id,
      );
      logLine = `added a word to the blacklist: ${result.message}`;
    } else if (sub === 'remove') {
      result = removeTerm(guildId, interaction.options.getString('term', true));
      logLine = `changed the blacklist: ${result.message}`;
    } else if (sub === 'allow') {
      result = allowWord(guildId, interaction.options.getString('word', true));
      logLine = `changed the allowlist: ${result.message}`;
    } else {
      result = unallowWord(guildId, interaction.options.getString('word', true));
      logLine = `changed the allowlist: ${result.message}`;
    }

    await reply(interaction, `${result.ok ? '✅' : '⚠️'} ${result.message}`);
    // Keep the mod team informed of list changes (best effort).
    if (result.ok) await logToReviewChannel(interaction.guild, `📝 ${interaction.user} ${logLine}`);
  },
};

// ---- /automod -------------------------------------------------------------

const automodCommand = {
  data: modOnly(new SlashCommandBuilder().setName('automod').setDescription('Configure automatic allegation screening'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current automod settings'))
    .addSubcommand((sub) =>
      sub
        .setName('enable')
        .setDescription('Turn automod on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Screen new allegations?').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('thresholds')
        .setDescription('Set how certain automod must be to reject, or to send to review')
        .addIntegerOption((o) => o.setName('reject').setDescription('Reject at or above this certainty (%)').setMinValue(5).setMaxValue(100))
        .addIntegerOption((o) => o.setName('review').setDescription('Send to review at or above this certainty (%)').setMinValue(5).setMaxValue(100)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('review-channel')
        .setDescription('Where held and rejected allegations go (leave empty to use a private channel I create)')
        .addChannelOption((o) => o.setName('channel').setDescription('A mod-only text channel').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('log-rejections')
        .setDescription('Post automatic rejections in the review channel (with an override button)')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Log rejections?').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reject-cooldown')
        .setDescription('How long someone must wait after an automatic rejection')
        .addIntegerOption((o) =>
          o
            .setName('seconds')
            .setDescription('Seconds (at least 30, the normal cooldown)')
            .setRequired(true)
            .setMinValue(LIMITS.rejectCooldownSeconds.min)
            .setMaxValue(LIMITS.rejectCooldownSeconds.max),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('strikes')
        .setDescription('Time people out after repeated automatic rejections')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Use strikes?').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('limit').setDescription('Rejections before a timeout').setMinValue(LIMITS.strikeLimit.min).setMaxValue(LIMITS.strikeLimit.max),
        )
        .addIntegerOption((o) =>
          o
            .setName('window-minutes')
            .setDescription('Only count rejections within this many minutes')
            .setMinValue(LIMITS.strikeWindowMinutes.min)
            .setMaxValue(LIMITS.strikeWindowMinutes.max),
        )
        .addIntegerOption((o) =>
          o
            .setName('timeout-minutes')
            .setDescription('How long the timeout lasts')
            .setMinValue(LIMITS.timeoutMinutes.min)
            .setMaxValue(LIMITS.timeoutMinutes.max),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Check what automod would do with some text (nothing is filed)')
        .addStringOption((o) => o.setName('text').setDescription('Text to check').setRequired(true).setMaxLength(1000)),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) return reply(interaction, 'This only works inside a server.');
    const sub = interaction.options.getSubcommand();
    // Own properties only, so an unexpected name (e.g. a stale registration) can't reach
    // something inherited like "constructor".
    if (!Object.hasOwn(AUTOMOD_HANDLERS, sub)) return reply(interaction, 'That option is no longer available.');
    return AUTOMOD_HANDLERS[sub](interaction, automodSettings(interaction.guildId));
  },
};

/** Saves a settings change and confirms it privately. */
async function saved(interaction, message) {
  trySave('changing automod settings');
  await reply(interaction, `✅ ${message}`);
}

const AUTOMOD_HANDLERS = {
  async status(interaction, s) {
    const counts = pendingCounts(interaction.guildId);
    const k = s.strikes;
    const embed = new EmbedBuilder()
      .setColor(s.enabled ? 0x2ecc71 : 0x95a5a6)
      .setTitle(`Automod is ${s.enabled ? 'ON' : 'OFF'}`)
      .addFields(
        { name: 'Reject at', value: percent(s.thresholds.reject), inline: true },
        { name: 'Review at', value: percent(s.thresholds.review), inline: true },
        { name: 'Reject cooldown', value: `${s.rejectCooldownSeconds}s`, inline: true },
        { name: 'Review channel', value: s.reviewChannelId ? `<#${s.reviewChannelId}>` : 'Private #allegation-review (created when first needed)' },
        { name: 'Log rejections', value: s.logRejections ? 'Yes' : 'No', inline: true },
        { name: 'Waiting for review', value: String(counts.review), inline: true },
        { name: 'Rejection logs (7 days)', value: String(counts.rejected), inline: true },
        {
          name: 'Strikes',
          value: k.enabled
            ? `Timeout of ${k.timeoutMinutes} min after ${k.limit} rejection(s) within ${k.windowMinutes} min`
            : 'Off',
        },
        { name: 'List changes', value: `${s.added.length} added · ${s.removed.length} defaults removed · ${s.allowAdded.length} allowed` },
      );
    await interaction.reply({ embeds: [embed], flags: PRIVATE, allowedMentions: NO_MENTIONS });
  },

  async enable(interaction, s) {
    const enabled = interaction.options.getBoolean('enabled', true);
    if (enabled && !s.enabled && blockedFromTightening(interaction)) return reply(interaction, TIMEOUT_PERMISSION_NEEDED);
    s.enabled = enabled;
    await saved(interaction, `Automod is now **${s.enabled ? 'on' : 'off'}**.`);
  },

  async thresholds(interaction, s) {
    const reject = interaction.options.getInteger('reject');
    const review = interaction.options.getInteger('review');
    if (reject === null && review === null) return reply(interaction, 'Give a `reject` and/or `review` percentage.');
    const next = {
      reject: reject === null ? s.thresholds.reject : reject / 100,
      review: review === null ? s.thresholds.review : review / 100,
    };
    // Only a lower reject level means more rejections (and so more timeouts).
    if (next.reject < s.thresholds.reject && blockedFromTightening(interaction)) return reply(interaction, TIMEOUT_PERMISSION_NEEDED);
    if (!(next.review < next.reject)) {
      return reply(interaction, `⚠️ The review level (${percent(next.review)}) must be lower than the reject level (${percent(next.reject)}).`);
    }
    s.thresholds = next;
    await saved(interaction, `Reject at **${percent(next.reject)}**, review at **${percent(next.review)}**.`);
  },

  async 'review-channel'(interaction, s) {
    const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildText]);
    if (!channel) {
      s.reviewChannelId = null;
      return saved(interaction, 'Reviews will go to a private **#allegation-review** channel, created when first needed.');
    }
    if (channel.id === guildData(interaction.guildId).channelId) {
      return reply(interaction, "⚠️ The review channel can't be the public allegations channel.");
    }
    // Held and rejected allegations often contain slurs, so they must never be public.
    if (channel.permissionsFor(interaction.guild.roles.everyone)?.has(P.ViewChannel)) {
      return reply(interaction, `⚠️ Everyone can see ${channel}. Pick a channel only moderators can see.`);
    }
    // The bot's own member is always cached in a cached guild; no fetch, so the reply
    // can't miss Discord's 3-second deadline.
    const me = interaction.guild.members.me;
    const needed = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory];
    if (!me || !channel.permissionsFor(me)?.has(needed)) {
      return reply(interaction, `⚠️ I need View Channel, Send Messages, Embed Links and Read Message History in ${channel}.`);
    }
    s.reviewChannelId = channel.id;
    await saved(interaction, `Reviews will go to ${channel}.`);
  },

  async 'log-rejections'(interaction, s) {
    s.logRejections = interaction.options.getBoolean('enabled', true);
    await saved(interaction, `Automatic rejections will ${s.logRejections ? '' : 'no longer '}be logged in the review channel.`);
  },

  async 'reject-cooldown'(interaction, s) {
    s.rejectCooldownSeconds = interaction.options.getInteger('seconds', true);
    await saved(interaction, `After an automatic rejection people must wait **${s.rejectCooldownSeconds}s**.`);
  },

  async strikes(interaction, s) {
    const enabled = interaction.options.getBoolean('enabled', true);
    // Auto-timeouts act on members, so only mods who can time people out themselves
    // may switch them on or change them.
    if (enabled && !interaction.memberPermissions.has(P.ModerateMembers)) {
      return reply(interaction, '⚠️ You need the **Timeout Members** permission to set up automatic timeouts.');
    }
    const k = s.strikes;
    if (!enabled) {
      // Only "off" is stored, so nobody without Timeout Members can quietly set harsh
      // limits for whoever switches strikes on next.
      s.strikes = { ...k, enabled: false };
      const ignored = ['limit', 'window-minutes', 'timeout-minutes'].some((n) => interaction.options.getInteger(n) !== null);
      return saved(
        interaction,
        'Strikes are **off**. Nobody will be timed out automatically.' + (ignored ? ' (The other options are only used when turning strikes on.)' : ''),
      );
    }
    s.strikes = {
      enabled,
      limit: interaction.options.getInteger('limit') ?? k.limit,
      windowMinutes: interaction.options.getInteger('window-minutes') ?? k.windowMinutes,
      timeoutMinutes: interaction.options.getInteger('timeout-minutes') ?? k.timeoutMinutes,
    };

    const me = interaction.guild.members.me;
    const permissionWarning = me?.permissions.has(P.ModerateMembers)
      ? ''
      : "\n⚠️ I don't have the **Timeout Members** permission yet, so timeouts will fail until an admin grants it.";
    const n = s.strikes;
    await saved(
      interaction,
      `Strikes are **on**: ${n.limit} automatic rejection(s) within ${n.windowMinutes} min → ${n.timeoutMinutes} min timeout.` +
        permissionWarning,
    );
  },

  async test(interaction) {
    const result = screen(interaction.guildId, interaction.options.getString('text', true), { ignoreEnabled: true });
    const label = { accept: '✅ Would be accepted', review: '🕵️ Would be sent to review', reject: '❌ Would be rejected' }[result.outcome];
    await reply(interaction, `${label}\nCertainty: **${percent(result.score)}**\nClosest match: ${describeMatch(result.match)}`);
  },
};

export const commands = [newCommand, pingCommand, blacklistCommand, automodCommand];
