import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import { getDatabasePoolConfig } from '../database/pool.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const poolConfig = getDatabasePoolConfig();
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
