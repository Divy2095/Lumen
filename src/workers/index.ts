import { createMediaWorker, defaultWorkerLogger } from './worker.js';
import { MEDIA_PROCESSING_QUEUE } from './queue.js';
import { getRedisConfig } from '../config/redis.js';
import { createDatabasePool } from '../database/pool.js';

const SHUTDOWN_TIMEOUT_MS = 10000;

async function startWorker(): Promise<void> {
  const redisConfig = getRedisConfig();
  const logger = defaultWorkerLogger;

  logger.info(
    {
      queue: MEDIA_PROCESSING_QUEUE,
      redisHost: redisConfig.host,
      redisPort: redisConfig.port,
      pid: process.pid,
    },
    'Starting Lumen media processing worker'
  );

  const db = createDatabasePool();
  const worker = createMediaWorker({ db });

  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      logger.warn({ signal }, 'Worker shutdown already in progress; ignoring duplicate signal');
      return;
    }
    isShuttingDown = true;
    logger.info({ signal }, 'Received termination signal; starting graceful worker shutdown');

    const forceShutdownTimer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Worker graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceShutdownTimer.unref();

    try {
      await worker.close();
      await db.end();
      clearTimeout(forceShutdownTimer);
      logger.info({}, 'Worker gracefully stopped, database pool and Redis connections closed');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceShutdownTimer);
      logger.error({ err }, 'Error during worker graceful shutdown');
      process.exit(1);
    }
  };

  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  worker.on('ready', () => {
    logger.info(
      { queue: MEDIA_PROCESSING_QUEUE },
      'Lumen media processing worker is ready and waiting for jobs'
    );
  });
}

void startWorker();
