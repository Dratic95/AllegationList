// index.js - entry point: checks config, registers commands, wires Discord events.
// The real work lives in the modules imported below; architecture.md has the map.

import { Client, GatewayIntentBits, Partials, Options, REST, Routes, MessageFlags, RESTJSONErrorCodes } from 'discord.js';
import { commands } from './commands.js';
import { handleComponent, pruneExpired, forgetCards, handleChannelDelete, forgetServerData } from './moderation.js';
import { setUpGuild } from './channels.js';
import { sweepCooldowns, forgetAllegations, rebuildFromChannel, renumberAll } from './allegations.js';

// ---- Config ---------------------------------------------------------------
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const PERMISSION_ERRORS = new Set([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions]);
const commandMap = new Map(commands.map((c) => [c.data.name, c]));

// ---- Register commands with Discord ---------------------------------------
async function registerCommands() {
  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());
  // Global commands work in every server the bot is in.
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${body.length} commands globally.`);
  // Older versions registered to one test server only; clear those so they don't show up twice.
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] }).catch(() => {});
}

// ---- Housekeeping timers ----------------------------------------------------
// unref() so these timers never keep the process alive on their own.
setInterval(sweepCooldowns, 5 * 60_000).unref();
setInterval(() => {
  pruneExpired();
  renumberAll(client.guilds.cache.values()); // restarts any renumber that stopped on an error
}, 60 * 60_000).unref();

// ---- Client ---------------------------------------------------------------
const client = new Client({
  // GuildMessages is only needed to hear about deleted allegations (not privileged:
  // no message content). Messages aren't cached, so the Message partial lets delete
  // events through for any message; only its id and channel are used.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message],
  makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
});

/** Makes sure the allegations channel exists, then lines the saved list up with it. */
async function syncGuild(guild) {
  // Queue the rebuild before anything awaits, so a /new arriving meanwhile waits behind
  // it instead of being numbered from the (possibly stale) saved list.
  const rebuilt = rebuildFromChannel(guild);
  await setUpGuild(guild);
  await rebuilt.catch((err) => {
    console.warn(`Couldn't read the allegations channel in ${guild.name} to check the numbering: ${err.message}`);
  });
}

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  pruneExpired();
  // Servers are independent, so set them up in parallel (discord.js handles rate limits).
  await Promise.all(c.guilds.cache.map(syncGuild));
});

// Bot added to a server -> make the allegations channel there too (or re-check it, if
// the bot is rejoining a server it was in before).
client.on('guildCreate', syncGuild);

// Bot removed from a server -> drop the held/rejected texts and strikes kept for it.
// An unavailable server is a Discord outage, not a removal, so nothing is deleted then.
client.on('guildDelete', (guild) => {
  if (guild.available) forgetServerData(guild.id);
});

// A message was deleted -> if it was an allegation, close the gap in the numbering; if it
// was a review card, dismiss its item.
const logDeleteError = (err) => console.warn('Handling a deleted message failed:', err.message);
function onMessagesDeleted(guild, channelId, ids) {
  forgetCards(guild, channelId, ids);
  forgetAllegations(guild, channelId, ids).catch(logDeleteError);
}
client.on('messageDelete', (message) => {
  if (message.guild) onMessagesDeleted(message.guild, message.channelId, [message.id]);
});
client.on('messageDeleteBulk', (messages, channel) => {
  if (channel.guild) onMessagesDeleted(channel.guild, channel.id, [...messages.keys()]);
});

// A channel holding review cards was deleted -> give the waiting items new cards.
client.on('channelDelete', (channel) => {
  handleChannelDelete(channel).catch((err) => console.warn('Reposting review cards failed:', err.message));
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commandMap.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isButton() || interaction.isModalSubmit()) {
      // Something the bot doesn't recognise (e.g. from an older version): answer anyway,
      // or Discord shows the clicker "This interaction failed".
      if (!(await handleComponent(interaction))) {
        await interaction.reply({ content: 'This is no longer active.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
    }
  } catch (err) {
    const name = interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId;
    console.error(`Error handling ${name}:`, err);
    await sendErrorReply(interaction, err);
  }
});

/** Tells the user something failed, in whichever way is still possible. */
async function sendErrorReply(interaction, err) {
  if (!interaction.isRepliable()) return;
  // `err?.` because anything can be thrown, not only Error objects.
  const content = PERMISSION_ERRORS.has(err?.code)
    ? "I'm missing permissions for one of my channels. Ask an admin to check my role can view and send messages there."
    : 'Something went wrong.';
  const options = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  // A deferred slash command shows its reply as the "thinking…" message, so edit that.
  // Buttons/modals are deferred with deferUpdate(); editing would overwrite the card,
  // so they get a separate private follow-up instead.
  if (interaction.deferred && interaction.isChatInputCommand()) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }
  else if (interaction.deferred || interaction.replied) await interaction.followUp(options).catch(() => {});
  else await interaction.reply(options).catch(() => {});
}

// Safety nets: log instead of crashing the whole bot.
client.on('error', (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));

// Clean shutdown for a service stop, a server reboot or Ctrl+C. Every change is saved as it
// happens, so there's nothing to flush; just leave Discord politely and exit successfully
// (systemd then doesn't treat the stop as a crash).
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down.`);
    await client.destroy().catch(() => {});
    process.exit(0);
  });
}

try {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
} catch (err) {
  console.error('Failed to start the bot. Check DISCORD_TOKEN and CLIENT_ID in .env.\n', err.message);
  process.exit(1);
}
