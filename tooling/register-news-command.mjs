// Registers the /news slash command on the allowed guild for the Arcade
// application. Idempotent: PUT overwrites the guild command list, so re-running
// never creates duplicates. Run once after deploy:
//   ARCADE_DISCORD_BOT_TOKEN=... ARCADE_DISCORD_CLIENT_ID=... \
//   ARCADE_ALLOWED_GUILD_ID=1196165488565289012 \
//   node tooling/register-news-command.mjs
const token = process.env['ARCADE_DISCORD_BOT_TOKEN'];
const appId = process.env['ARCADE_DISCORD_CLIENT_ID'];
const guildId = process.env['ARCADE_ALLOWED_GUILD_ID'] || '1196165488565289012';
if (!token || !appId) {
  console.error('Usage: ARCADE_DISCORD_BOT_TOKEN=... ARCADE_DISCORD_CLIENT_ID=... node tooling/register-news-command.mjs');
  process.exit(1);
}
const commands = [{
  name: 'news',
  description: 'Опубликовать новость r!z3 Arcade в этом канале',
  type: 1, // CHAT_INPUT
  default_member_permissions: '8', // ADMINISTRATOR — only guild admins see it
  integration_types: [0], // guild installs only
  contexts: [0], // GUILD
}];
const response = await globalThis.fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!response.ok) {
  console.error('Registration failed:', response.status, await response.text());
  process.exit(1);
}
const registered = await response.json();
console.log('Registered commands:', registered.map(c => '/' + c.name).join(', '));
