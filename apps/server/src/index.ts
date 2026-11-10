import { buildApp } from './app';
import { loadConfig } from './config';
const config = loadConfig(process.env);
const { app } = await buildApp(config);
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({ port: config.PORT, host: config.ARCADE_HOST }); }
catch { app.log.error('Server could not start'); process.exitCode = 1; await shutdown(); }
