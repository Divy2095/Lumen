import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, QueryConfig } from 'pg';
import { JobLease, RetryProcessingError } from './job-lease.js';

function pool(query: (config: QueryConfig) => Promise<{ rowCount: number }>): Pool {
  return { query } as unknown as Pool;
}

it('renews beyond the initial lease and fences every renewal with database time', async () => {
  let renewals = 0;
  const lease = new JobLease(pool(async (config) => {
    assert.deepEqual(config.values, ['job', 'token', 300]);
    assert.match(config.text, /lease_token = \$2 AND status = 'processing'/);
    assert.match(config.text, /lease_expires_at > clock_timestamp\(\)/);
    assert.match(config.text, /FOR UPDATE SKIP LOCKED/);
    renewals++;
    return { rowCount: 1 };
  }), 'job', 'token', 300, performance.now());
  try {
    await sleep(750);
    lease.assertOwned();
    assert.ok(renewals >= 3);
    await lease.prepareCompletion();
    const stoppedAt = renewals;
    await sleep(150);
    assert.equal(renewals, stoppedAt);
    assert.equal(lease.signal.aborted, false);
  } finally { lease.stop(); }
});

for (const failure of ['revoked', 'database-error', 'hung-query'] as const) {
  it(`fails closed and cancels work on ${failure}`, async () => {
    const lease = new JobLease(pool(async () => {
      if (failure === 'database-error') throw new Error('offline');
      if (failure === 'hung-query') return await new Promise(() => {});
      return { rowCount: 0 };
    }), 'job', 'token', 120, performance.now());
    try {
      await sleep(200);
      assert.equal(lease.signal.aborted, true);
      assert.throws(() => lease.assertOwned(), RetryProcessingError);
      await assert.rejects(lease.prepareCompletion(), RetryProcessingError);
    } finally { lease.stop(); }
  });
}

it('an already expired claim cannot be revived', async () => {
  let queries = 0;
  const lease = new JobLease(pool(async () => { queries++; return { rowCount: 1 }; }),
    'job', 'token', 100, performance.now() - 200);
  try {
    assert.throws(() => lease.assertOwned(), RetryProcessingError);
    assert.equal(queries, 0);
  } finally { lease.stop(); }
});

it('a late renewal response cannot restart a stopped lease', async () => {
  let resolveQuery!: (result: { rowCount: number }) => void;
  const lease = new JobLease(pool(async () => await new Promise((resolve) => { resolveQuery = resolve; })),
    'job', 'token', 120, performance.now());
  await sleep(60);
  lease.stop();
  resolveQuery({ rowCount: 1 });
  await sleep(150);
  assert.equal(lease.signal.aborted, false);
});

it('BullMQ lock cancellation stops database renewal and cancels work', async () => {
  const parent = new AbortController();
  let queries = 0;
  const lease = new JobLease(pool(async () => { queries++; return { rowCount: 1 }; }),
    'job', 'token', 300, performance.now(), parent.signal);
  parent.abort();
  assert.equal(lease.signal.aborted, true);
  await sleep(150);
  assert.equal(queries, 0);
  assert.throws(() => lease.assertOwned(), RetryProcessingError);
});
