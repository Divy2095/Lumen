import { Pool, type PoolConfig } from 'pg';

/**
 * Parses and validates PostgreSQL connection configuration from environment variables.
 */
export function getDatabasePoolConfig(overrides?: Partial<PoolConfig>): PoolConfig {
  const password = overrides?.password ?? process.env.PGPASSWORD;
  if (!password) {
    throw new Error('Database configuration error: PGPASSWORD environment variable is required');
  }

  const rawPort = overrides?.port ? String(overrides.port) : process.env.PGPORT ?? '5432';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Database configuration error: PGPORT must be an integer between 1 and 65535, received "${rawPort}"`
    );
  }

  const host = overrides?.host ?? process.env.PGHOST ?? '127.0.0.1';
  const database = overrides?.database ?? process.env.PGDATABASE ?? 'lumen';
  const user = overrides?.user ?? process.env.PGUSER ?? 'lumen';

  return {
    host,
    port,
    database,
    user,
    password,
    max: overrides?.max ?? 10,
    idleTimeoutMillis: overrides?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: overrides?.connectionTimeoutMillis ?? 5000,
    ...overrides,
  };
}

/**
 * Creates a new PostgreSQL connection pool using application configuration.
 */
export function createDatabasePool(overrides?: Partial<PoolConfig>): Pool {
  const config = getDatabasePoolConfig(overrides);
  const pool = new Pool(config);

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });

  return pool;
}
