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
try {
  await app.listen({ port: config.PORT, host: config.ARCADE_HOST });
  app.log.info({ event: 'server_listening', port: config.PORT, host: config.ARCADE_HOST, authMode: config.ARCADE_AUTH_MODE }, 'Server listening');
}
catch (error) {
  const err = error as NodeJS.ErrnoException;
  app.log.error({
    event: 'server_start_failed',
    errorName: err?.name ?? 'UnknownError',
    errorCode: err?.code ?? 'UNKNOWN',
    errorMessage: err?.message ?? String(error),
    stack: err?.stack,
  }, 'Server could not start');
  process.exitCode = 1;
  await shutdown();
}
