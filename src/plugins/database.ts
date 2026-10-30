import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Pool, type PoolConfig } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('Database configuration error: PGPASSWORD environment variable is required');
  }

  const rawPort = process.env.PGPORT ?? '5432';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Database configuration error: PGPORT must be an integer between 1 and 65535, received "${rawPort}"`
    );
  }

  const poolConfig: PoolConfig = {
    host: process.env.PGHOST ?? '127.0.0.1',
    port,
    database: process.env.PGDATABASE ?? 'lumen',
    user: process.env.PGUSER ?? 'lumen',
    password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  const pool = new Pool(poolConfig);

  let isClosed = false;
  const closePool = async (): Promise<void> => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    await pool.end();
  };

  // Handle unexpected errors on idle clients
  pool.on('error', (err) => {
    fastify.log.error(err, 'Unexpected error on idle PostgreSQL client');
  });

  // Verify connection pool on initialization
  try {
    const client = await pool.connect();
    client.release();
    fastify.log.info(
      {
        host: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        user: poolConfig.user,
      },
      'PostgreSQL connection pool established'
    );
  } catch (err) {
    try {
      await closePool();
    } catch {
      // Suppress cleanup error to preserve original connection error
    }
    fastify.log.error('Failed to connect to PostgreSQL during database plugin initialization');
    throw err;
  }

  // Register pool as Fastify decorator
  fastify.decorate('db', pool);

  // Gracefully close pool during server shutdown
  fastify.addHook('onClose', async (instance) => {
    instance.log.info('Closing PostgreSQL connection pool');
    await closePool();
  });
};

export const databasePlugin = fp(dbPlugin, {
  name: 'database',
});

export default databasePlugin;
