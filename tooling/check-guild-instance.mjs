// Diagnostics for the guild lockdown: prints the Discord Activity Instances
// API response shape (sanitized — never prints tokens or secrets).
// Usage: ARCADE_DISCORD_BOT_TOKEN=... ARCADE_DISCORD_CLIENT_ID=... \
//   node tooling/check-guild-instance.mjs <instance_id> [user_id]
const token = process.env['ARCADE_DISCORD_BOT_TOKEN'];
const appId = process.env['ARCADE_DISCORD_CLIENT_ID'];
const instanceId = process.argv[2];
const userId = process.argv[3];
if (!token || !appId || !instanceId) {
  console.error('Usage: ARCADE_DISCORD_BOT_TOKEN=... ARCADE_DISCORD_CLIENT_ID=... node tooling/check-guild-instance.mjs <instance_id> [user_id]');
  process.exit(1);
}
const headers = { authorization: 'Bot ' + token, accept: 'application/json' };
const me = await fetch('https://discord.com/api/v10/oauth2/applications/@me', { headers });
console.log('GET /oauth2/applications/@me ->', me.status);
if (me.ok) {
  const app = await me.json();
  console.log('  application id:', app.id, app.id === appId ? '(matches ARCADE_DISCORD_CLIENT_ID)' : '(MISMATCH!)');
} else { console.log('  body:', (await me.text()).slice(0, 300)); }
const res = await fetch(`https://discord.com/api/v10/applications/${appId}/activity-instances/${encodeURIComponent(instanceId)}`, { headers });
console.log('GET activity-instances ->', res.status);
const text = await res.text();
try {
  const body = JSON.parse(text);
  console.log(JSON.stringify({
    application_id: body.application_id, instance_id: body.instance_id,
    location: body.location, users_count: Array.isArray(body.users) ? body.users.length : null,
    user_present: userId && Array.isArray(body.users) ? body.users.includes(userId) : null,
    users_sample: Array.isArray(body.users) ? body.users.slice(0, 5) : body.users,
  }, null, 2));
} catch { console.log('  non-JSON body:', text.slice(0, 300)); }
