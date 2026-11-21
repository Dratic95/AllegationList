// One-off: sets the bot's profile picture. Animated GIFs work too.
// Run with: node --env-file=.env set-avatar.js [picture]   (default: avatar.gif)
// Discord rate-limits avatar changes, so don't run this repeatedly.
import { REST, Routes } from 'discord.js';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Loop-1 fix D: clear message instead of a cryptic REST error when the token is missing.
if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Run with: node --env-file=.env set-avatar.js');
  process.exit(1);
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const file = process.argv[2] ?? new URL('./avatar.gif', import.meta.url);
const type = TYPES[extname(String(file)).toLowerCase()];
if (!type) {
  console.error('The picture must be a .png, .jpg or .gif file.');
  process.exit(1);
}

const image = readFileSync(file).toString('base64');
const rest = new REST().setToken(process.env.DISCORD_TOKEN);
try {
  const user = await rest.patch(Routes.user(), { body: { avatar: `data:${type};base64,${image}` } });
  const animated = user.avatar?.startsWith('a_') ? ' (animated)' : '';
  console.log(`Profile picture updated for ${user.username}${animated}.`);
} catch (err) {
  console.error('Failed to update the profile picture:', err.message);
  process.exit(1);
}
