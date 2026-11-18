import { Client } from 'pg';
import { Redis } from 'ioredis';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertTestEnvironment } from './test-environment.js';

const retryable = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', '57P03']);

export function readinessFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && retryable.has(code)) return code;
  if (code === '28P01' || code === '28000') return 'authentication_failed';
  // Driver timeout errors sometimes have no code; never print their raw message.
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) return 'timeout';
  return 'unexpected_client_failure';
}

export async function waitForService(name: string, probe: () => Promise<void>, timeoutMs = 45000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let failure = 'not_attempted';
  do {
    try {
      await probe();
      console.log(`${name}: authenticated client readiness PASS`);
      return;
    } catch (error) {
      failure = readinessFailure(error);
      if (failure === 'authentication_failed' || failure === 'unexpected_client_failure') {
        throw new Error(`${name}: readiness failed (${failure})`);
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(500, remaining));
  } while (performance.now() < deadline);
  throw new Error(`${name}: readiness deadline exceeded (${failure})`);
}

export async function waitForIntegrationServices(): Promise<void> {
  assertTestEnvironment();
  await waitForService('postgres-test:5432/lumen_test', async () => {
    const client = new Client({
      host: 'postgres-test', port: 5432, database: 'lumen_test', user: 'lumen_test_runner',
      password: process.env.PGPASSWORD!, connectionTimeoutMillis: 1500, query_timeout: 1500,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally { await client.end(); }
  });
  await waitForService('redis-test:6379/0', async () => {
    const redis = new Redis({
      host: 'redis-test', port: 6379, db: 0, password: process.env.REDIS_PASSWORD!,
      connectTimeout: 1500, commandTimeout: 1500, maxRetriesPerRequest: 0,
      retryStrategy: () => null, lazyConnect: true,
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      if (await redis.ping() !== 'PONG') throw new Error('Unexpected Redis response');
    } finally { redis.disconnect(); }
  });
}
