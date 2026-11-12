import { Redis } from 'ioredis';
import { TestPool, assertTestDatabase } from './db-guard.js';
import { assertTestEnvironment, prepareTestStorage } from './test-environment.js';

export async function integrationPreflight(): Promise<void> {
  const token = assertTestEnvironment();
  const pool = new TestPool({ connectionTimeoutMillis: 3000 });
  try { await assertTestDatabase(pool); }
  finally { await pool.end(); }
  const redis = new Redis({ host: 'redis-test', port: 6379, db: 0, password: process.env.REDIS_PASSWORD!,
    connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
  redis.on('error', () => {});
  try {
    await redis.connect();
    if (await redis.get('lumen:test:disposable') !== token) throw new Error('Test safety: Redis marker mismatch');
  } finally { redis.disconnect(); }
  prepareTestStorage();
}
