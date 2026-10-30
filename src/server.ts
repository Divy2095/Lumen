import { buildApp } from './app.js';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT configuration: must be an integer between 1 and 65535, received "${rawPort}"`);
}

const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({
  logger: true,
});

const SHUTDOWN_TIMEOUT_MS = 10000;

async function start(): Promise<void> {
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      app.log.warn({ signal }, 'Shutdown already in progress; ignoring duplicate signal');
      return;
    }
    isShuttingDown = true;
    app.log.info({ signal }, 'Received termination signal; starting graceful shutdown');

    const forceShutdownTimer = setTimeout(() => {
      app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceShutdownTimer.unref();

    try {
      await app.close();
      clearTimeout(forceShutdownTimer);
      app.log.info('Graceful shutdown completed successfully');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceShutdownTimer);
      app.log.error(err, 'Error occurred during graceful shutdown');
      process.exit(1);
    }
  };

  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
