import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Queue, QueueEvents } from 'bullmq';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { assertTestDatabase } from '../test/db-guard.js';
import { createDatabasePool } from '../database/pool.js';
import {
  createRedisConnection,
  closeRedisConnection,
  getRedisConnectionOptions,
} from '../config/redis.js';
import { MediaService } from '../modules/media/media.service.js';
import { InvalidStateTransitionError } from '../modules/media/media.types.js';
import {
  createMediaQueue,
  type LumenJobPayload,
  type LumenJobResult,
  type ProcessingJobResult,
} from './queue.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { createMediaWorker, type WorkerLogger } from './worker.js';
import { processJob } from './processor.js';
import { defaultStorageService } from '../shared/storage/local-storage.service.js';

describe('Transactional Outbox Integration Suite (Milestone 3.2)', () => {
  let pool: Pool;
  let mediaService: MediaService;
  let redisAvailable = false;
  let testQueueName: string;
  let testQueue: Queue<LumenJobPayload, LumenJobResult>;
  let queueEvents: QueueEvents;

  const silentLogger: WorkerLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  before(async () => {
    pool = createDatabasePool({
      database: process.env.PGDATABASE ?? 'lumen_test',
    });
    await assertTestDatabase(pool);
    mediaService = new MediaService(pool);
    await pool.query('DELETE FROM outbox_events;');

    // Fast probe to determine Redis availability
    const probeClient = createRedisConnection({
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });

    try {
      await probeClient.connect();
      const reply = await probeClient.ping();
      if (reply === 'PONG') {
        redisAvailable = true;
      }
    } catch {
      redisAvailable = false;
    } finally {
      await closeRedisConnection(probeClient);
    }

    if (redisAvailable) {
      testQueueName = `outbox-test-queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      testQueue = createMediaQueue(testQueueName);
      queueEvents = new QueueEvents(testQueueName, {
        connection: getRedisConnectionOptions(),
      });
    }
  });

  after(async () => {
    if (testQueue) {
      await testQueue.obliterate({ force: true }).catch(() => {});
      await testQueue.close();
    }
    if (queueEvents) {
      await queueEvents.close();
    }
    await pool.end();
  });

  // Helper to create an isolated project and media asset for a test
  async function createTestProjectAndAsset(): Promise<{
    accountId: string;
    projectId: string;
    assetId: string;
    cleanup: () => Promise<void>;
  }> {
    const accountId = uuidv7();
    const projectId = uuidv7();
    const assetId = uuidv7();

    const storageKey = `media/${projectId}/${assetId}/original.mp4`;

    await pool.query(
      `WITH acc AS (
         INSERT INTO accounts (id, email) VALUES ($1, $2)
       ), proj AS (
         INSERT INTO projects (id, account_id, name) VALUES ($3, $1, 'Outbox Project')
       )
       INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
         storage_key, status
       ) VALUES ($4, $3, 'sample.mp4', 'video/mp4', 48796, 0, $5, 'uploading');`,
      [
        accountId,
        `outbox-${Date.now()}-${uuidv7()}@example.com`,
        projectId,
        assetId,
        storageKey,
      ]
    );

    // Place valid MP4 on disk for real processor execution
    const targetFilePath = defaultStorageService.resolvePath(storageKey);
    await mkdir(dirname(targetFilePath), { recursive: true });
    await copyFile(resolve('src/test/fixtures/valid_sample.mp4'), targetFilePath);

    const cleanup = async () => {
      await defaultStorageService.unlinkFile(storageKey).catch(() => {});
      await pool.query(`DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM processing_jobs WHERE media_asset_id = $1);`, [assetId]).catch(() => {});
      await pool.query(`DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE media_asset_id = $1);`, [assetId]).catch(() => {});
      await pool.query(`DELETE FROM processing_jobs WHERE media_asset_id = $1;`, [assetId]).catch(() => {});
      await pool.query(`DELETE FROM media_assets WHERE id = $1;`, [assetId]).catch(() => {});
      await pool.query(`DELETE FROM projects WHERE id = $1;`, [projectId]).catch(() => {});
      await pool.query(`DELETE FROM accounts WHERE id = $1;`, [accountId]).catch(() => {});
    };

    return { accountId, projectId, assetId, cleanup };
  }

  it('1. Media finalization creates jobs and outbox events atomically', async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();

    try {
      const finalizedAsset = await mediaService.finalizeUpload(assetId, 10000);
      assert.strictEqual(finalizedAsset.id, assetId);
      assert.strictEqual(finalizedAsset.status, 'ready');
      assert.strictEqual(finalizedAsset.uploaded_bytes, 10000);

      // Verify media_assets updated
      const assetRes = await pool.query<{ status: string; uploaded_bytes: string }>(
        `SELECT status, uploaded_bytes FROM media_assets WHERE id = $1;`,
        [assetId]
      );
      assert.strictEqual(assetRes.rows[0]?.status, 'ready');
      assert.strictEqual(Number(assetRes.rows[0]?.uploaded_bytes), 10000);

      // Verify processing_jobs created
      const jobsRes = await pool.query<{ id: string; operation: string; status: string; project_id: string }>(
        `SELECT id, operation, status, project_id FROM processing_jobs WHERE media_asset_id = $1 ORDER BY operation ASC;`,
        [assetId]
      );
      assert.strictEqual(jobsRes.rows.length, 2);
      assert.strictEqual(jobsRes.rows[0]?.operation, 'extract_metadata');
      assert.strictEqual(jobsRes.rows[0]?.status, 'queued');
      assert.strictEqual(jobsRes.rows[0]?.project_id, projectId);

      assert.strictEqual(jobsRes.rows[1]?.operation, 'generate_thumbnail');
      assert.strictEqual(jobsRes.rows[1]?.status, 'queued');
      assert.strictEqual(jobsRes.rows[1]?.project_id, projectId);

      // Verify outbox_events created
      const outboxRes = await pool.query<{
        id: string;
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload: any;
        published_at: Date | null;
      }>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, published_at
         FROM outbox_events
         WHERE aggregate_id IN ($1, $2)
         ORDER BY created_at ASC;`,
        [jobsRes.rows[0]!.id, jobsRes.rows[1]!.id]
      );
      assert.strictEqual(outboxRes.rows.length, 2);
      for (const evt of outboxRes.rows) {
        assert.strictEqual(evt.aggregate_type, 'processing_job');
        assert.strictEqual(evt.event_type, 'processing_job.created');
        assert.strictEqual(evt.published_at, null);

        const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
        assert.strictEqual(payload.projectId, projectId);
        assert.strictEqual(payload.mediaAssetId, assetId);
        assert.ok(payload.jobId);
        assert.ok(['extract_metadata', 'generate_thumbnail'].includes(payload.operation));
      }
    } finally {
      await cleanup();
    }
  });

  it('2. Transaction rollback leaves no partially created jobs or events', async () => {
    const { assetId, cleanup } = await createTestProjectAndAsset();

    try {
      // Set asset to 'failed' to induce state transition error
      await pool.query(`UPDATE media_assets SET status = 'failed' WHERE id = $1;`, [assetId]);

      await assert.rejects(
        async () => await mediaService.finalizeUpload(assetId, 10000),
        InvalidStateTransitionError
      );

      // Verify no jobs were created
      const jobsRes = await pool.query(`SELECT count(*) AS count FROM processing_jobs WHERE media_asset_id = $1;`, [assetId]);
      assert.strictEqual(Number(jobsRes.rows[0]?.count), 0);

      // Verify no outbox events exist for this asset's jobs
      const outboxRes = await pool.query(
        `SELECT count(*) AS count FROM outbox_events WHERE payload->>'mediaAssetId' = $1;`,
        [assetId]
      );
      assert.strictEqual(Number(outboxRes.rows[0]?.count), 0);
    } finally {
      await cleanup();
    }
  });

  it('3. Publisher successfully dispatches pending events', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { assetId, cleanup } = await createTestProjectAndAsset();

    try {
      await mediaService.finalizeUpload(assetId, 10000);

      const publisher = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
        batchSize: 10,
      });

      const publishedCount = await publisher.pollOnce();
      assert.ok(publishedCount >= 2);

      // Verify outbox events for this asset are marked as published in PostgreSQL
      const outboxRes = await pool.query<{ published_at: Date | null; locked_by: string | null }>(
        `SELECT published_at, locked_by FROM outbox_events WHERE payload->>'mediaAssetId' = $1;`,
        [assetId]
      );
      assert.strictEqual(outboxRes.rows.length, 2);
      for (const row of outboxRes.rows) {
        assert.ok(row.published_at !== null);
        assert.strictEqual(row.locked_by, null);
      }
    } finally {
      await cleanup();
    }
  });

  it('4. Multiple publishers safely claim different events concurrently', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { assetId: asset1, cleanup: cleanup1 } = await createTestProjectAndAsset();
    const { assetId: asset2, cleanup: cleanup2 } = await createTestProjectAndAsset();

    try {
      await mediaService.finalizeUpload(asset1, 10000);
      await mediaService.finalizeUpload(asset2, 10000);

      const publisher1 = new OutboxPublisher(pool, testQueue, {
        publisherId: 'publisher-alpha',
        batchSize: 2,
        logger: silentLogger,
      });

      const publisher2 = new OutboxPublisher(pool, testQueue, {
        publisherId: 'publisher-beta',
        batchSize: 2,
        logger: silentLogger,
      });

      // Run both concurrently
      const [count1, count2] = await Promise.all([
        publisher1.pollOnce(),
        publisher2.pollOnce(),
      ]);

      assert.ok(count1 + count2 >= 4);

      // Verify all outbox events for these assets are published and none remained locked
      const outboxRes = await pool.query<{ published_at: Date | null }>(
        `SELECT published_at FROM outbox_events
         WHERE payload->>'mediaAssetId' IN ($1, $2) AND published_at IS NOT NULL;`,
        [asset1, asset2]
      );
      assert.strictEqual(outboxRes.rows.length, 4);
    } finally {
      await cleanup1();
      await cleanup2();
    }
  });

  it('5. Expired leases can be recovered and published', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    const jobId = uuidv7();
    const eventId = uuidv7();

    try {
      await pool.query(
        `INSERT INTO processing_jobs (id, project_id, media_asset_id, operation, parameters, status)
         VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued');`,
        [jobId, projectId, assetId]
      );

      // Insert an expired lease from a crashed publisher (locked in past)
      await pool.query(
        `INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, event_type, payload,
          published_at, locked_by, locked_until, attempts_count
        ) VALUES ($1, 'processing_job', $2, 'processing_job.created', $3, NULL, 'crashed-worker', NOW() - INTERVAL '1 minute', 1);`,
        [
          eventId,
          jobId,
          JSON.stringify({
            jobId,
            projectId,
            mediaAssetId: assetId,
            operation: 'extract_metadata',
          }),
        ]
      );

      const publisher = new OutboxPublisher(pool, testQueue, {
        publisherId: 'recovery-publisher',
        logger: silentLogger,
      });

      const count = await publisher.pollOnce();
      assert.ok(count >= 1);

      const checkRes = await pool.query<{ published_at: Date | null; attempts_count: number }>(
        `SELECT published_at, attempts_count FROM outbox_events WHERE id = $1;`,
        [eventId]
      );
      assert.ok(checkRes.rows[0]?.published_at !== null);
      assert.strictEqual(checkRes.rows[0]?.attempts_count, 2);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [eventId]).catch(() => {});
      await cleanup();
    }
  });

  it('6. Failed Redis publication does not mark an event as published', async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    const jobId = uuidv7();
    const eventId = uuidv7();

    try {
      await pool.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'processing_job', $2, 'processing_job.created', $3);`,
        [
          eventId,
          jobId,
          JSON.stringify({
            jobId,
            projectId,
            mediaAssetId: assetId,
            operation: 'extract_metadata',
          }),
        ]
      );

      // Mock Queue that fails on add()
      const mockFailingQueue = {
        add: async () => {
          throw new Error('Redis connection timed out');
        },
      } as unknown as Queue<LumenJobPayload, LumenJobResult>;

      const publisher = new OutboxPublisher(pool, mockFailingQueue, {
        logger: silentLogger,
      });

      const publishedCount = await publisher.pollOnce();
      assert.strictEqual(publishedCount, 0);

      const checkRes = await pool.query<{
        published_at: Date | null;
        locked_by: string | null;
        last_error: string | null;
      }>(`SELECT published_at, locked_by, last_error FROM outbox_events WHERE id = $1;`, [eventId]);

      assert.strictEqual(checkRes.rows[0]?.published_at, null);
      assert.strictEqual(checkRes.rows[0]?.locked_by, null); // lock released for retry
      assert.match(checkRes.rows[0]?.last_error ?? '', /Redis connection timed out/);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [eventId]).catch(() => {});
      await cleanup();
    }
  });

  it('7. Duplicate publication uses a stable BullMQ job ID', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    const jobId = uuidv7();
    const eventId = uuidv7();

    try {
      await pool.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'processing_job', $2, 'processing_job.created', $3);`,
        [
          eventId,
          jobId,
          JSON.stringify({
            jobId,
            projectId,
            mediaAssetId: assetId,
            operation: 'extract_metadata',
          }),
        ]
      );

      const publisher = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
      });

      await publisher.pollOnce();

      // Verify BullMQ job has deterministic custom jobId
      const expectedJobId = `outbox-${eventId}`;
      const job = await testQueue.getJob(expectedJobId);
      assert.ok(job);
      assert.strictEqual(job.id, expectedJobId);

      // Simulate event retried: reset published_at
      await pool.query(`UPDATE outbox_events SET published_at = NULL WHERE id = $1;`, [eventId]);

      // Poll again
      await publisher.pollOnce();

      // Should still resolve to the same job without creating duplicate logical queue entry
      const recheckedJob = await testQueue.getJob(expectedJobId);
      assert.ok(recheckedJob);
      assert.strictEqual(recheckedJob.id, expectedJobId);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [eventId]).catch(() => {});
      await cleanup();
    }
  });

  it('8. Publisher restart recovers unpublished events', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { assetId, cleanup } = await createTestProjectAndAsset();

    try {
      await mediaService.finalizeUpload(assetId, 10000);

      // Initial publisher is stopped
      const publisher1 = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
      });
      await publisher1.stop();

      // New publisher restarts and processes pending events
      const publisher2 = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
      });
      const count = await publisher2.pollOnce();
      assert.ok(count >= 2);

      const unpublished = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND published_at IS NULL;`,
        [assetId]
      );
      assert.strictEqual(Number(unpublished.rows[0]?.count), 0);
    } finally {
      await cleanup();
    }
  });

  it('9. Invalid event payloads are handled safely without crashing', async () => {
    const corruptedEventId = uuidv7();

    try {
      // Insert corrupted payload
      await pool.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'processing_job', $2, 'processing_job.created', $3);`,
        [corruptedEventId, uuidv7(), JSON.stringify({ corrupted: true })]
      );

      const publisher = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
      });

      await publisher.pollOnce();

      const checkRes = await pool.query<{
        published_at: Date | null;
        locked_by: string | null;
        last_error: string | null;
      }>(`SELECT published_at, locked_by, last_error FROM outbox_events WHERE id = $1;`, [corruptedEventId]);

      assert.strictEqual(checkRes.rows[0]?.published_at, null);
      assert.strictEqual(checkRes.rows[0]?.locked_by, null);
      assert.match(checkRes.rows[0]?.last_error ?? '', /missing required fields/);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [corruptedEventId]).catch(() => {});
    }
  });

  it('10. End-to-end: Finalization -> Outbox dispatch -> Worker execution with idempotency', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis is not available');
      return;
    }

    const { assetId, cleanup } = await createTestProjectAndAsset();

    try {
      await mediaService.finalizeUpload(assetId, 10000);

      const publisher = new OutboxPublisher(pool, testQueue, {
        logger: silentLogger,
      });
      await publisher.pollOnce();

      // Start worker connected to test queue and database
      const worker = createMediaWorker({
        queueName: testQueueName,
        db: pool,
        logger: silentLogger,
      });

      try {
        // Find created processing jobs
        const jobsRes = await pool.query<{ id: string; operation: string; project_id: string }>(
          `SELECT id, operation, project_id FROM processing_jobs WHERE media_asset_id = $1;`,
          [assetId]
        );
        assert.strictEqual(jobsRes.rows.length, 2);

        // Wait for both jobs to be processed by worker
        for (const jobRow of jobsRes.rows) {
          // Query BullMQ job by outbox event ID
          const outboxRes = await pool.query<{ id: string }>(
            `SELECT id FROM outbox_events WHERE aggregate_id = $1;`,
            [jobRow.id]
          );
          const bullJobId = `outbox-${outboxRes.rows[0]!.id}`;
          const bullJob = await testQueue.getJob(bullJobId);
          assert.ok(bullJob);

          const result = (await bullJob.waitUntilFinished(queueEvents, 10000)) as any;
          assert.strictEqual((result as ProcessingJobResult).status, 'completed');
          assert.strictEqual(result.jobId, jobRow.id);
        }

        // Verify processing_jobs table is now completed in PostgreSQL
        const completedJobsRes = await pool.query<{ id: string; status: string; completed_at: Date | null }>(
          `SELECT id, status, completed_at FROM processing_jobs WHERE media_asset_id = $1;`,
          [assetId]
        );
        for (const cJob of completedJobsRes.rows) {
          assert.strictEqual(cJob.status, 'completed');
          assert.ok(cJob.completed_at !== null);
        }

        // Test duplicate delivery idempotency: re-executing job on completed row does not fail or duplicate
        const firstJob = jobsRes.rows[0]!;
        const duplicateJob = await testQueue.add(
          firstJob.operation,
          {
            jobId: firstJob.id,
            projectId: firstJob.project_id,
            mediaAssetId: assetId,
            operation: firstJob.operation as any,
          },
          { jobId: `manual-duplicate-${Date.now()}` }
        );

        const duplicateResult = (await duplicateJob.waitUntilFinished(queueEvents, 10000)) as any;
        assert.strictEqual(duplicateResult.status, 'already_completed');
      } finally {
        await worker.close();
      }
    } finally {
      await cleanup();
    }
  });

  // =========================================================================
  // Focused Reliability Review Tests (Area 4: A, B, C, D, E)
  // =========================================================================

  it('11. Reliability (Area 4.A): Two workers attempting to claim the same processing job concurrently', async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    try {
      const jobId = uuidv7();
      await pool.query(
        `INSERT INTO processing_jobs (
          id, project_id, media_asset_id, operation, status, current_attempt_number
        ) VALUES ($1, $2, $3, 'extract_metadata', 'queued', 0);`,
        [jobId, projectId, assetId]
      );

      const mockJob = {
        name: 'extract_metadata',
        data: {
          jobId,
          projectId,
          mediaAssetId: assetId,
          operation: 'extract_metadata',
        },
      } as any;

      // Run two workers concurrently attempting to process the exact same job
      const [result1, result2] = await Promise.all([
        processJob(mockJob, pool, { workerId: 'worker-A' }),
        processJob(mockJob, pool, { workerId: 'worker-B' }),
      ]);

      const results = [result1, result2];
      const completedCount = results.filter((r: any) => r.status === 'completed').length;
      const alreadyCompletedCount = results.filter((r: any) => r.status === 'already_completed').length;

      assert.strictEqual(completedCount, 1, 'Exactly one worker should claim and complete the job');
      assert.strictEqual(alreadyCompletedCount, 1, 'The competing worker should cleanly observe already_completed');

      // Verify job in database is completed and has current_attempt_number = 1
      const jobRes = await pool.query<{ status: string; current_attempt_number: number }>(
        `SELECT status, current_attempt_number FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.strictEqual(jobRes.rows[0]?.current_attempt_number, 1);

      // Verify exactly one attempt record was created in job_attempts
      const attemptsRes = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(Number(attemptsRes.rows[0]?.count), 1);
    } finally {
      await cleanup();
    }
  });

  it('12. Reliability (Area 4.B): A stale publisher attempting to mark an event published after lease expired', async () => {
    const eventId = uuidv7();
    const publisherA = 'publisher-stale-A';

    try {
      // Insert an event that was locked by publisher A in the past (lease expired)
      await pool.query(
        `INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, event_type, payload, locked_by, locked_until
        ) VALUES ($1, 'test', $2, 'test.event', '{}', $3, NOW() - interval '5 seconds');`,
        [eventId, uuidv7(), publisherA]
      );

      // Stale publisher A attempts to mark the event published with lease validation
      const markRes = await pool.query(
        `UPDATE outbox_events
         SET published_at = NOW(),
             locked_by = NULL,
             locked_until = NULL,
             last_error = NULL
         WHERE id = $1
           AND locked_by = $2
           AND locked_until >= NOW();`,
        [eventId, publisherA]
      );

      // Row count must be 0 because lease expired
      assert.strictEqual(markRes.rowCount, 0, 'Stale publisher must match 0 rows due to expired lease');

      // Verify event in database is still unpublished
      const eventRes = await pool.query<{ published_at: Date | null; locked_by: string | null }>(
        `SELECT published_at, locked_by FROM outbox_events WHERE id = $1;`,
        [eventId]
      );
      assert.strictEqual(eventRes.rows[0]?.published_at, null);
      assert.strictEqual(eventRes.rows[0]?.locked_by, publisherA);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [eventId]).catch(() => {});
    }
  });

  it('13. Reliability (Area 4.C): A stale publisher cannot release or corrupt another publisher lease on failure', async () => {
    const eventId = uuidv7();
    const publisherA = 'publisher-stale-A';
    const publisherB = 'publisher-active-B';

    try {
      // Event was claimed by publisher B with an active future lease
      await pool.query(
        `INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, event_type, payload, locked_by, locked_until
        ) VALUES ($1, 'test', $2, 'test.event', '{}', $3, NOW() + interval '30 seconds');`,
        [eventId, uuidv7(), publisherB]
      );

      // Stale publisher A encounters a delayed failure and tries to release the lock
      const releaseRes = await pool.query(
        `UPDATE outbox_events
         SET locked_by = NULL,
             locked_until = NULL,
             last_error = $2
         WHERE id = $1
           AND locked_by = $3
           AND locked_until >= NOW();`,
        [eventId, 'Publisher A late error', publisherA]
      );

      // Stale publisher A must update 0 rows
      assert.strictEqual(releaseRes.rowCount, 0, 'Stale publisher A must not update rows owned by publisher B');

      // Verify publisher B lease remains untouched and uncorrupted
      const checkRes = await pool.query<{ locked_by: string | null; last_error: string | null }>(
        `SELECT locked_by, last_error FROM outbox_events WHERE id = $1;`,
        [eventId]
      );
      assert.strictEqual(checkRes.rows[0]?.locked_by, publisherB);
      assert.strictEqual(checkRes.rows[0]?.last_error, null);
    } finally {
      await pool.query(`DELETE FROM outbox_events WHERE id = $1;`, [eventId]).catch(() => {});
    }
  });

  it('14. Reliability (Area 4.D): Duplicate delivery after a completed BullMQ job has been removed', async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    try {
      const jobId = uuidv7();
      // Simulate a job already marked 'completed' in PostgreSQL
      await pool.query(
        `INSERT INTO processing_jobs (
          id, project_id, media_asset_id, operation, status, current_attempt_number, completed_at
        ) VALUES ($1, $2, $3, 'extract_metadata', 'completed', 1, NOW());`,
        [jobId, projectId, assetId]
      );

      const duplicateJob = {
        name: 'extract_metadata',
        data: {
          jobId,
          projectId,
          mediaAssetId: assetId,
          operation: 'extract_metadata',
        },
      } as any;

      // Worker receives duplicate job
      const result = await processJob(duplicateJob, pool, { workerId: 'worker-dup' });

      assert.strictEqual((result as ProcessingJobResult).status, 'already_completed');
      assert.strictEqual((result as any).jobId, jobId);

      // Verify no new attempt or status alteration in PostgreSQL
      const jobRes = await pool.query<{ status: string; current_attempt_number: number }>(
        `SELECT status, current_attempt_number FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.strictEqual(jobRes.rows[0]?.current_attempt_number, 1);

      // Verify attempts table has no additional attempt created
      const attemptsRes = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(Number(attemptsRes.rows[0]?.count), 0);
    } finally {
      await cleanup();
    }
  });

  it('15. Reliability (Area 4.E): Worker crash recovery after lease expiry with new fencing token and attempt count', async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    try {
      const jobId = uuidv7();
      const staleFencingToken = uuidv7();

      // Insert a job locked by crashed-worker whose lease expired 10 seconds ago
      await pool.query(
        `INSERT INTO processing_jobs (
          id, project_id, media_asset_id, operation, status,
          current_attempt_number, locked_by, lease_token, lease_expires_at, started_at
        ) VALUES ($1, $2, $3, 'extract_metadata', 'processing',
          1, 'crashed-worker-1', $4, NOW() - interval '10 seconds', NOW() - interval '20 seconds');`,
        [jobId, projectId, assetId, staleFencingToken]
      );

      // Also record the crashed worker's attempt in job_attempts
      await pool.query(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, status, fencing_token, started_at
        ) VALUES ($1, $2, 1, 'processing', $3, NOW() - interval '20 seconds');`,
        [uuidv7(), jobId, staleFencingToken]
      );

      const recoveryJob = {
        name: 'extract_metadata',
        data: {
          jobId,
          projectId,
          mediaAssetId: assetId,
          operation: 'extract_metadata',
        },
      } as any;

      // New worker claims and processes the expired job
      const result = await processJob(recoveryJob, pool, { workerId: 'recovery-worker-2' });

      assert.strictEqual((result as ProcessingJobResult).status, 'completed');

      // Verify job in database is completed with attempt count incremented to 2
      const jobRes = await pool.query<{
        status: string;
        current_attempt_number: number;
        locked_by: string | null;
        lease_token: string | null;
        completed_at: Date | null;
      }>(
        `SELECT status, current_attempt_number, locked_by, lease_token, completed_at
         FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.strictEqual(jobRes.rows[0]?.current_attempt_number, 2);
      assert.strictEqual(jobRes.rows[0]?.locked_by, null);
      assert.strictEqual(jobRes.rows[0]?.lease_token, null);
      assert.ok(jobRes.rows[0]?.completed_at !== null);

      // Verify attempts table has attempt 1 (still processing/orphaned from crash) and attempt 2 (completed)
      const attemptsRes = await pool.query<{
        attempt_number: number;
        status: string;
        fencing_token: string;
      }>(
        `SELECT attempt_number, status, fencing_token FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number ASC;`,
        [jobId]
      );
      assert.strictEqual(attemptsRes.rows.length, 2);
      assert.strictEqual(attemptsRes.rows[0]?.attempt_number, 1);
      assert.strictEqual(attemptsRes.rows[0]?.fencing_token, staleFencingToken);

      assert.strictEqual(attemptsRes.rows[1]?.attempt_number, 2);
      assert.strictEqual(attemptsRes.rows[1]?.status, 'completed');
      assert.notStrictEqual(attemptsRes.rows[1]?.fencing_token, staleFencingToken);
    } finally {
      await cleanup();
    }
  });
  it("16. Reliability: Worker attempting completion after lease expiry but before another worker claims the job", async () => {
    const { projectId, assetId, cleanup } = await createTestProjectAndAsset();
    try {
      const jobId = uuidv7();
      await pool.query(
        `INSERT INTO processing_jobs (
          id, project_id, media_asset_id, operation, status, current_attempt_number
        ) VALUES ($1, $2, $3, $4, $5, 0);`,
        [jobId, projectId, assetId, "extract_metadata", "queued"]
      );

      const mockJob = {
        name: "extract_metadata",
        data: {
          jobId,
          projectId,
          mediaAssetId: assetId,
          operation: "extract_metadata",
        },
      } as any;

      // Worker A claims with a short 10ms lease; processJob simulated work takes 50ms,
      // so the lease expires before Worker A attempts completion.
      // Worker B has NOT reclaimed the job yet.
      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            workerId: "worker-A-short-lease",
            leaseDurationMs: 10,
          });
        },
        /Worker lease expired or was revoked/
      );

      // Verify processing_jobs was NOT completed or failed by stale Worker A
      const jobRes = await pool.query<{
        status: string;
        locked_by: string | null;
        lease_token: string | null;
        completed_at: Date | null;
        current_attempt_number: number;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, locked_by, lease_token, completed_at, current_attempt_number, lease_expires_at
         FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      const job = jobRes.rows[0]!;
      assert.strictEqual(job.status, "processing", "Job status must remain processing, not completed or failed");
      assert.strictEqual(job.completed_at, null, "completed_at must remain NULL");
      assert.strictEqual(job.current_attempt_number, 1, "Attempt number remains 1");
      assert.strictEqual(job.locked_by, "worker-A-short-lease");
      assert.ok(job.lease_token !== null, "Original lease token must still be present since Worker B has not reclaimed");
      assert.ok(job.lease_expires_at !== null && job.lease_expires_at.getTime() < Date.now(), "Lease must be expired");

      // Verify job_attempts was NOT marked completed or failed by stale Worker A
      const attemptsRes = await pool.query<{
        attempt_number: number;
        status: string;
        completed_at: Date | null;
      }>(
        `SELECT attempt_number, status, completed_at FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptsRes.rows.length, 1);
      assert.strictEqual(attemptsRes.rows[0]?.status, "processing", "Attempt status must remain processing");
      assert.strictEqual(attemptsRes.rows[0]?.completed_at, null, "Attempt completed_at must remain NULL");

      // Verify direct SQL completion attempt by stale Worker A fails closed
      const directCompleteAttempt = await pool.query(
        `UPDATE processing_jobs
         SET status = $3, completed_at = NOW()
         WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW();`,
        [jobId, job.lease_token, 'completed']
      );
      assert.strictEqual(directCompleteAttempt.rowCount, 0, "Direct SQL update with expired lease must update 0 rows");

      // Verify direct SQL failure attempt by stale Worker A fails closed
      const directFailAttempt = await pool.query(
        `UPDATE processing_jobs
         SET status = $3, completed_at = NOW()
         WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW();`,
        [jobId, job.lease_token, 'failed']
      );
      assert.strictEqual(directFailAttempt.rowCount, 0, "Direct SQL failure update with expired lease must update 0 rows");

      // Now verify Worker B can successfully recover and complete the job
      const workerBResult = (await processJob(mockJob, pool, {
        workerId: "worker-B-reclaimer",
        leaseDurationMs: 60000,
      })) as ProcessingJobResult;

      assert.strictEqual(workerBResult.status, "completed");

      // Verify processing_jobs is now completed with attempt 2
      const finalJobRes = await pool.query<{
        status: string;
        completed_at: Date | null;
        current_attempt_number: number;
      }>(
        `SELECT status, completed_at, current_attempt_number FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(finalJobRes.rows[0]?.status, "completed");
      assert.ok(finalJobRes.rows[0]?.completed_at !== null);
      assert.strictEqual(finalJobRes.rows[0]?.current_attempt_number, 2);

      // Verify job_attempts has 2 attempts: attempt 1 (orphaned processing) and attempt 2 (completed)
      const allAttemptsRes = await pool.query<{
        attempt_number: number;
        status: string;
      }>(
        `SELECT attempt_number, status FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number ASC;`,
        [jobId]
      );
      assert.strictEqual(allAttemptsRes.rows.length, 2);
      assert.strictEqual(allAttemptsRes.rows[0]?.attempt_number, 1);
      assert.strictEqual(allAttemptsRes.rows[0]?.status, "processing");
      assert.strictEqual(allAttemptsRes.rows[1]?.attempt_number, 2);
      assert.strictEqual(allAttemptsRes.rows[1]?.status, "completed");
    } finally {
      await cleanup();
    }
  });
});
