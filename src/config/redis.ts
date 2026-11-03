import { Redis, type RedisOptions } from 'ioredis';
import { type ConnectionOptions } from 'bullmq';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

/**
 * Parses and validates Redis configuration from environment variables.
 */
export function getRedisConfig(): RedisConfig {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';

  const rawPort = process.env.REDIS_PORT ?? '6379';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Redis configuration error: REDIS_PORT must be an integer between 1 and 65535, received "${rawPort}"`
    );
  }

  const password = process.env.REDIS_PASSWORD?.trim();

  let db: number | undefined;
  if (process.env.REDIS_DB !== undefined && process.env.REDIS_DB !== '') {
    const parsedDb = Number(process.env.REDIS_DB);
    if (!Number.isInteger(parsedDb) || parsedDb < 0) {
      throw new Error(
        `Redis configuration error: REDIS_DB must be a non-negative integer, received "${process.env.REDIS_DB}"`
      );
    }
    db = parsedDb;
  }

  const config: RedisConfig = {
    host,
    port,
  };

  if (password) {
    config.password = password;
  }
  if (db !== undefined) {
    config.db = db;
  }

  return config;
}

/**
 * Returns typed connection options suitable for BullMQ Queue and Worker instances.
 *
 * BullMQ requires:
 * 1. `maxRetriesPerRequest: null` — BullMQ coordinates retry lifecycles and blocking commands
 *    at the application layer. Failing commands fast during reconnections breaks queue state.
 * 2. `enableReadyCheck: false` — Avoids unnecessary INFO checks on connection startup.
 */
export function getRedisConnectionOptions(
  overrides?: Record<string, unknown>
): ConnectionOptions {
  const config = getRedisConfig();

  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...overrides,
  };

  if (config.password !== undefined) {
    options['password'] = config.password;
  }
  if (config.db !== undefined) {
    options['db'] = config.db;
  }

  return options as ConnectionOptions;
}

/**
 * Creates a dedicated ioredis client instance with safe default error handling.
 * Callers are responsible for calling client.quit() or client.disconnect() when done.
 */
export function createRedisConnection(
  overrides?: Record<string, unknown>
): Redis {
  const config = getRedisConfig();
  const options: Record<string, unknown> = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...overrides,
  };

  if (config.password !== undefined) {
    options['password'] = config.password;
  }
  if (config.db !== undefined) {
    options['db'] = config.db;
  }

  const client = new Redis(config.port, config.host, options as any);

  // Prevent uncaught error events from crashing the process when Redis reconnects
  client.on('error', () => {
    // Handled by caller logging if needed
  });

  return client;
}

/**
 * Safely closes an ioredis client connection, attempting graceful QUIT
 * before falling back to DISCONNECT.
 */
export async function closeRedisConnection(client: Redis): Promise<void> {
  if (client.status === 'end') {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
