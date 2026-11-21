// One-off: sets the bot's profile picture to avatar.png.
// Run with: node --env-file=.env set-avatar.js
// Discord rate-limits avatar changes, so don't run this repeatedly.
import { REST, Routes } from 'discord.js';
import { readFileSync } from 'node:fs';

// Loop-1 fix D: clear message instead of a cryptic REST error when the token is missing.
if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Run with: node --env-file=.env set-avatar.js');
  process.exit(1);
}

const image = readFileSync(new URL('./avatar.png', import.meta.url)).toString('base64');
const rest = new REST().setToken(process.env.DISCORD_TOKEN);
try {
  const user = await rest.patch(Routes.user(), { body: { avatar: `data:image/png;base64,${image}` } });
  console.log(`Profile picture updated for ${user.username}.`);
} catch (err) {
  console.error('Failed to update the profile picture:', err.message);
  process.exit(1);
}
