// Registers the /news slash command for the Arcade application on the
// allowed guild — one command only, never a bulk overwrite. Safe to re-run:
// an existing /news command is updated in place (PATCH), otherwise created
// (POST). Secrets are read from env and never printed.
// Usage: ARCADE_DISCORD_BOT_TOKEN=... ARCADE_DISCORD_CLIENT_ID=... \
//   node tooling/register-news-command.mjs
const token = process.env['ARCADE_DISCORD_BOT_TOKEN'];
const appId = process.env['ARCADE_DISCORD_CLIENT_ID'];
const guildId = process.env['ARCADE_ALLOWED_GUILD_ID'] || '1196165488565289012';
if (!token || !appId) {
  console.error('register-news-command: ARCADE_DISCORD_BOT_TOKEN and ARCADE_DISCORD_CLIENT_ID are required');
  process.exit(1);
}
const api = 'https://discord.com/api/v10';
const headers = { authorization: 'Bot ' + token, 'content-type': 'application/json' };

const definition = {
  name: 'news',
  description: 'Опубликовать новость r!z3 Arcade в этом канале',
  type: 1, // CHAT_INPUT
  default_member_permissions: '8', // ADMINISTRATOR — only guild admins see/use it
  integration_types: [0], // guild installs only
  contexts: [0], // GUILD
};

async function apiCall(method, path, body) {
  const response = await globalThis.fetch(api + path, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

// 1. Look up existing commands — never overwrite the whole list.
const list = await apiCall('GET', `/applications/${appId}/guilds/${guildId}/commands`);
if (!list.ok) {
  console.error(`register-news-command: failed to list guild commands (HTTP ${list.status})`, list.data?.message ?? '');
  process.exit(1);
}
const existing = Array.isArray(list.data) ? list.data.find(c => c.name === 'news') : null;

// 2. Update in place or create — exactly one /news command results.
const result = existing
  ? await apiCall('PATCH', `/applications/${appId}/guilds/${guildId}/commands/${existing.id}`, definition)
  : await apiCall('POST', `/applications/${appId}/guilds/${guildId}/commands`, definition);
if (!result.ok) {
  console.error(`register-news-command: ${existing ? 'update' : 'create'} failed (HTTP ${result.status})`, result.data?.message ?? '');
  process.exit(1);
}
console.log(`register-news-command: /news ${existing ? 'updated' : 'created'} (id ${result.data?.id}, guild ${guildId})`);

// 3. Verify via API that the command is actually registered.
const verify = await apiCall('GET', `/applications/${appId}/guilds/${guildId}/commands`);
const found = verify.ok && Array.isArray(verify.data) && verify.data.some(c => c.name === 'news');
if (!found) {
  console.error('register-news-command: verification failed — /news not visible via API');
  process.exit(1);
}
console.log('register-news-command: verified — /news is registered for this guild');
