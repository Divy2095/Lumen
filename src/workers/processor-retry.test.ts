import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DelayedError, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { processJob } from './processor.js';
import { processWithRedelivery } from './worker.js';
import { RetryProcessingError } from './job-lease.js';
import type { LumenJobPayload, LumenJobResult } from './queue.js';

function job(): Job<LumenJobPayload, LumenJobResult> {
  return { name: 'transcode', data: {
    jobId: 'job', projectId: 'project', mediaAssetId: 'asset', operation: 'transcode',
  } } as Job<LumenJobPayload, LumenJobResult>;
}

function unclaimed(status: string, attempts = 1, reaped = false): Pool {
  return { query: async (sql: string) => {
    if (sql.includes('RETURNING id, project_id')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT id, status')) return { rows: [{ status, current_attempt_number: attempts,
      lease_expires_at: new Date(Date.now() + 60000) }] };
    assert.match(sql, /project_id = \$2/);
    assert.match(sql, /lease_expires_at < clock_timestamp\(\)/);
    return { rowCount: reaped ? 1 : 0, rows: [] };
  } } as unknown as Pool;
}

for (const state of ['processing', 'queued', 'unknown']) {
  it(`never acknowledges an unfinished ${state} job`, async () => {
    await assert.rejects(processJob(job(), unclaimed(state)), RetryProcessingError);
  });
}

for (const [state, expected] of [['completed', 'already_completed'], ['failed', 'failed'], ['cancelled', 'cancelled']]) {
  it(`acknowledges confirmed terminal state ${state}`, async () => {
    const result = await processJob(job(), unclaimed(state!));
    assert.equal('status' in result && result.status, expected);
  });
}

it('does not acknowledge an exhausted job if atomic reaping loses a race', async () => {
  await assert.rejects(processJob(job(), unclaimed('processing', 3)), RetryProcessingError);
});

it('acknowledges failure only after an exhausted job is atomically reaped', async () => {
  const result = await processJob(job(), unclaimed('queued', 3, true));
  assert.equal('status' in result && result.status, 'failed');
});

it('moves unfinished deliveries to delayed with the BullMQ lock token', async () => {
  const delivery = job();
  let moves = 0;
  delivery.moveToDelayed = async (timestamp, token) => {
    assert.equal(token, 'bull-lock');
    assert.ok(timestamp > Date.now());
    moves++;
  };
  await assert.rejects(processWithRedelivery(delivery, 'bull-lock', unclaimed('processing')), DelayedError);
  assert.equal(moves, 1);
});

it('without a BullMQ lock token, retry uncertainty remains an error', async () => {
  await assert.rejects(processWithRedelivery(job(), undefined, unclaimed('processing')), RetryProcessingError);
});

it('a failed Redis delay is never reported as successful processing', async () => {
  const delivery = job();
  delivery.moveToDelayed = async () => { throw new Error('Redis offline'); };
  await assert.rejects(processWithRedelivery(delivery, 'bull-lock', unclaimed('processing')), /Redis offline/);
});

// This fake checks processor control flow; PostgreSQL locking still requires live integration tests.
function claimedDatabase() {
  const state = { expires: 0, token: '', renewals: 0, completed: false, rolledBack: false, revoked: false };
  const query = async (sql: string | { text: string; values: unknown[] }, values?: unknown[]) => {
    if (typeof sql !== 'string') {
      state.renewals++;
      if (state.revoked || performance.now() >= state.expires) return { rowCount: 0, rows: [] };
      assert.equal(sql.values[1], state.token);
      state.expires = performance.now() + Number(sql.values[2]);
      return { rowCount: 1, rows: [{ id: 'job' }] };
    }
    if (sql.includes('RETURNING id, project_id')) {
      state.token = String(values?.[2]);
      state.expires = performance.now() + Number(values?.[3]);
      return { rowCount: 1, rows: [{ id: 'job', current_attempt_number: 1 }] };
    }
    if (sql.includes('SELECT id, project_id, storage_key')) {
      return { rows: [{ storage_key: 'source.mp4', audio_codec: null, metadata: {} }] };
    }
    if (sql.includes('lease_token = $2')) {
      assert.equal(values?.[1], state.token);
      assert.match(sql, /status = 'processing'/);
      const valid = !state.revoked && performance.now() < state.expires;
      return { rowCount: valid ? 1 : 0, rows: valid ? [{ id: 'job' }] : [] };
    }
    if (sql.includes('MAX(version)')) return { rows: [{ next_version: '1' }] };
    if (sql === 'COMMIT') state.completed = true;
    if (sql === 'ROLLBACK') state.rolledBack = true;
    return { rowCount: 1, rows: [] };
  };
  return { state, db: { query, connect: async () => ({ query, release() {} }) } as unknown as Pool };
}

async function executeClaimed(
  fixture: ReturnType<typeof claimedDatabase>,
  run: (signal?: AbortSignal) => Promise<void>,
  hook?: () => Promise<void>,
) {
  const delivery = job();
  Object.assign(delivery.data, { parameters: { profile: '360p', targetWidth: 640, targetHeight: 360, bitrateKbps: 800 } });
  const storage = {
    resolvePath: (key: string) => key, fileExists: async () => true,
    createTempFilePath: () => 'temp.mp4', commitFile: async () => {}, unlinkFile: async () => true,
  };
  const transcoding = { transcodeVideo: async ({ signal }: { signal?: AbortSignal }) => {
    await run(signal);
    return { width: 640, height: 360, fileSizeBytes: 1234, mimeType: 'video/mp4',
      videoCodec: 'h264', durationSeconds: 1, audioCodec: null };
  } };
  return await processJob(delivery, fixture.db, {
    leaseDurationMs: 300,
    storageService: storage as unknown as import('../shared/storage/local-storage.service.js').StorageService,
    transcodingService: transcoding as unknown as import('../modules/media/transcoding.service.js').TranscodingService,
    onBeforeCompletionCommit: hook,
  });
}

it('processor renews during long transcoding and commits with its fencing token', async () => {
  const fixture = claimedDatabase();
  const result = await executeClaimed(fixture, async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
  assert.equal('status' in result && result.status, 'completed');
  assert.ok(fixture.state.renewals >= 3);
  assert.equal(fixture.state.completed, true);
  assert.equal(fixture.state.rolledBack, false);
});

it('processor cannot promote database output after renewal reports revocation', async () => {
  const fixture = claimedDatabase();
  await assert.rejects(executeClaimed(fixture, async (signal) => {
    fixture.state.revoked = true;
    await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  }), RetryProcessingError);
  assert.equal(fixture.state.completed, false);
});

it('completion expiry still rolls back after background renewal is stopped', async () => {
  const fixture = claimedDatabase();
  let renewalsAtCompletion = 0;
  await assert.rejects(executeClaimed(fixture, async () => {}, async () => {
    renewalsAtCompletion = fixture.state.renewals;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }), /Worker lease expired or was revoked/);
  assert.equal(fixture.state.renewals, renewalsAtCompletion);
  assert.equal(fixture.state.completed, false);
  assert.equal(fixture.state.rolledBack, true);
});
