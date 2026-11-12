import '../../test/integration-preload.js';
import { testStorageDirectory, removeTestStorage } from '../../test/test-environment.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestPool as Pool } from '../../test/db-guard.js';
import { uuidv7 } from 'uuidv7';
import { resolve } from 'node:path';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { type Job } from 'bullmq';
import { assertTestDatabase } from '../../test/db-guard.js';
import { LocalStorageService } from '../../shared/storage/local-storage.service.js';
import {
  processJob,
  type ProcessJobOptions,
} from '../../workers/processor.js';
import {
  EXTRACT_METADATA_JOB,
  createMediaQueue,
  type LumenJobPayload,
  type LumenJobResult,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from '../../workers/queue.js';
import { FFprobeService, type ExtractedMediaMetadata } from './ffprobe.service.js';
import { MediaService } from './media.service.js';
import { OutboxPublisher } from '../../workers/outbox-publisher.js';

const FIXTURES_DIR = resolve(process.cwd(), 'src/test/fixtures');
const VALID_SAMPLE_MP4 = resolve(FIXTURES_DIR, 'valid_sample.mp4');
const TEST_STORAGE_DIR = testStorageDirectory('transcoding-scheduling');

describe('Milestone 3.5.2: Transactional Transcoding Scheduling Suite', () => {
  let pool: Pool;
  let storage: LocalStorageService;
  let mediaService: MediaService;
  let testAccountId: string;
  let testProjectId: string;

  before(async () => {
    pool = new Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
      database: process.env.PGDATABASE ?? 'lumen_test',
      user: process.env.PGUSER ?? 'lumen',
      password: process.env.PGPASSWORD,
    });

    await assertTestDatabase(pool);

    storage = new LocalStorageService(TEST_STORAGE_DIR);
    await storage.init();

    mediaService = new MediaService(pool);

    testAccountId = uuidv7();
    testProjectId = uuidv7();

    await pool.query(
      `INSERT INTO accounts (id, email) VALUES ($1, $2);`,
      [testAccountId, `sched-${Date.now()}@test.com`]
    );
    await pool.query(
      `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Transcode Scheduling Project');`,
      [testProjectId, testAccountId]
    );
  });

  after(async () => {
    if (pool) {
      await pool.query('DELETE FROM outbox_events WHERE aggregate_type = \'processing_job\';').catch(() => {});
      await pool.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id = $1);', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM processing_jobs WHERE project_id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM media_assets WHERE project_id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM projects WHERE id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE id = $1;', [testAccountId]).catch(() => {});
      await pool.end();
    }
    await removeTestStorage(TEST_STORAGE_DIR);
  });

  function createMockProbeService(dimensions: { width: number; height: number; rotation?: number }): FFprobeService {
    return {
      probe: async (): Promise<ExtractedMediaMetadata> => ({
        containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
        durationSeconds: 10.0,
        fileSizeBytes: 48796,
        bitrate: 500000,
        video: {
          codec: 'h264',
          width: dimensions.width,
          height: dimensions.height,
          frameRate: 24.0,
          pixelFormat: 'yuv420p',
          rotation: dimensions.rotation ?? 0,
        },
        audio: {
          codec: 'aac',
          sampleRate: 44100,
          channels: 2,
        },
        rawMetadata: { format: { test: true } },
      }),
    } as unknown as FFprobeService;
  }

  it('1. Schedules eligible rendition jobs and outbox events for a 1080p source in automatic mode', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, '1080p_sample.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

    const result = (await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    })) as ProcessingJobResult;

    assert.strictEqual(result.status, 'completed');

    // 1. Verify extract_metadata job completed
    const metaJobRes = await pool.query<{ status: string; lease_token: string | null }>(
      `SELECT status, lease_token FROM processing_jobs WHERE id = $1;`,
      [jobId]
    );
    assert.strictEqual(metaJobRes.rows[0]?.status, 'completed');
    assert.strictEqual(metaJobRes.rows[0]?.lease_token, null);

    // 2. Verify media_assets has metadata and skipped profile outcomes
    const assetRes = await pool.query<{ metadata: any; width: number; height: number }>(
      `SELECT metadata, width, height FROM media_assets WHERE id = $1;`,
      [assetId]
    );
    const assetRow = assetRes.rows[0]!;
    assert.strictEqual(assetRow.width, 1920);
    assert.strictEqual(assetRow.height, 1080);
    assert.ok(assetRow.metadata?.transcoding);
    assert.strictEqual(assetRow.metadata.transcoding.mode, 'automatic');
    assert.deepStrictEqual(assetRow.metadata.transcoding.skipped, [
      {
        profile: '1080p',
        reason: 'SOURCE_ALREADY_WITHIN_PROFILE',
        message: 'Source resolution (1920x1080) already fits within profile bounding box (1920x1080)',
      },
    ]);

    // 3. Verify exactly 3 processing_jobs created for transcode (360p, 480p, 720p)
    const transcodeJobsRes = await pool.query<{
      id: string;
      operation: string;
      status: string;
      parameters: any;
      current_attempt_number: number;
    }>(
      `SELECT id, operation, status, parameters, current_attempt_number
       FROM processing_jobs
       WHERE media_asset_id = $1 AND operation = 'transcode'
       ORDER BY (parameters->>'targetWidth')::int ASC;`,
      [assetId]
    );

    assert.strictEqual(transcodeJobsRes.rows.length, 3);
    const profiles = transcodeJobsRes.rows.map((r) => r.parameters.profile);
    assert.deepStrictEqual(profiles, ['360p', '480p', '720p']);
    assert.ok(transcodeJobsRes.rows.every((r) => r.status === 'queued'));
    assert.ok(transcodeJobsRes.rows.every((r) => r.current_attempt_number === 0));

    // Check 480p floored dimension: 852x480
    const job480 = transcodeJobsRes.rows.find((r) => r.parameters.profile === '480p')!;
    assert.strictEqual(job480.parameters.targetWidth, 852);
    assert.strictEqual(job480.parameters.targetHeight, 480);

    // 4. Verify corresponding outbox_events exist for each scheduled job
    const scheduledJobIds = transcodeJobsRes.rows.map((r) => r.id);
    const outboxRes = await pool.query<{
      id: string;
      aggregate_id: string;
      event_type: string;
      payload: any;
    }>(
      `SELECT id, aggregate_id, event_type, payload
       FROM outbox_events
       WHERE aggregate_id = ANY($1::uuid[])
       ORDER BY created_at ASC;`,
      [scheduledJobIds]
    );

    assert.strictEqual(outboxRes.rows.length, 3);
    for (const outboxRow of outboxRes.rows) {
      assert.strictEqual(outboxRow.event_type, 'processing_job.created');
      const payload = outboxRow.payload;
      assert.strictEqual(payload.operation, 'transcode');
      assert.strictEqual(payload.projectId, testProjectId);
      assert.strictEqual(payload.mediaAssetId, assetId);
      assert.ok(scheduledJobIds.includes(payload.jobId));
    }

    // 5. Verify API reporting via getMediaAsset
    const publicAsset = await mediaService.getMediaAsset(testProjectId, assetId);
    assert.ok(publicAsset);
    assert.ok(publicAsset.transcoding);
    assert.strictEqual(publicAsset.transcoding.mode, 'automatic');
    assert.strictEqual(publicAsset.transcoding.renditions.length, 3);
    assert.deepStrictEqual(
      publicAsset.transcoding.skipped,
      [{ profile: '1080p', reason: 'SOURCE_ALREADY_WITHIN_PROFILE', message: 'Source resolution (1920x1080) already fits within profile bounding box (1920x1080)' }]
    );
    assert.deepStrictEqual(publicAsset.skipped_profiles, publicAsset.transcoding.skipped);
  });

  it('2. Schedules all 4 renditions for a 4K video (3840x2160)', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, '4k_sample.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 3840, height: 2160 });

    await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    });

    const transcodeJobsRes = await pool.query<{ parameters: any }>(
      `SELECT parameters FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rows.length, 4);
    const profiles = transcodeJobsRes.rows.map((r) => r.parameters.profile).sort();
    assert.deepStrictEqual(profiles, ['1080p', '360p', '480p', '720p']);

    const publicAsset = await mediaService.getMediaAsset(testProjectId, assetId);
    assert.ok(publicAsset?.transcoding);
    assert.strictEqual(publicAsset.transcoding.renditions.length, 4);
    assert.strictEqual(publicAsset.transcoding.skipped.length, 0);
  });

  it('3. Schedules only client-requested profiles when specified', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status, transcoding_config
       ) VALUES ($1, $2, 'client_profiles.mp4', 'video/mp4', 48796, 48796, $3, 'ready', $4::jsonb);`,
      [assetId, testProjectId, storageKey, JSON.stringify({ profiles: ['720p', '360p'] })]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

    await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    });

    const transcodeJobsRes = await pool.query<{ parameters: any }>(
      `SELECT parameters FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rows.length, 2);
    const profiles = transcodeJobsRes.rows.map((r) => r.parameters.profile);
    assert.deepStrictEqual(profiles, ['720p', '360p']);
  });

  it('4. Does not schedule any rendition jobs when transcoding is explicitly disabled', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status, transcoding_config
       ) VALUES ($1, $2, 'disabled.mp4', 'video/mp4', 48796, 48796, $3, 'ready', $4::jsonb);`,
      [assetId, testProjectId, storageKey, JSON.stringify({ enabled: false })]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

    await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    });

    const transcodeJobsRes = await pool.query(
      `SELECT id FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rows.length, 0);

    const outboxRes = await pool.query(
      `SELECT id FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND payload->>'operation' = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(outboxRes.rows.length, 0);
  });

  it('5. Correctly skips and reports small sources (e.g. 320x240) with SOURCE_ALREADY_WITHIN_PROFILE', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, 'small.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 320, height: 240 });

    await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    });

    const transcodeJobsRes = await pool.query(
      `SELECT id FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rows.length, 0);

    const publicAsset = await mediaService.getMediaAsset(testProjectId, assetId);
    assert.ok(publicAsset?.transcoding);
    assert.strictEqual(publicAsset.transcoding.renditions.length, 0);
    assert.strictEqual(publicAsset.transcoding.skipped.length, 4);
    assert.ok(publicAsset.transcoding.skipped.every((s) => s.reason === 'SOURCE_ALREADY_WITHIN_PROFILE'));
  });

  it('6. Idempotency against retries: does not duplicate jobs or outbox events', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, 'retry_test.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

    // First execution
    const res1 = (await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    })) as ProcessingJobResult;
    assert.strictEqual(res1.status, 'completed');

    const jobCount1 = await pool.query(
      `SELECT count(*)::int AS cnt FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(jobCount1.rows[0]?.cnt, 3);

    const outboxCount1 = await pool.query(
      `SELECT count(*)::int AS cnt FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND payload->>'operation' = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(outboxCount1.rows[0]?.cnt, 3);

    // Second execution with same job payload (re-delivery)
    const res2 = (await processJob(mockJob, pool, {
      storageService: storage,
      ffprobeService: mockProbe,
    })) as ProcessingJobResult;
    assert.strictEqual(res2.status, 'already_completed');

    // Counts remain strictly identical
    const jobCount2 = await pool.query(
      `SELECT count(*)::int AS cnt FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(jobCount2.rows[0]?.cnt, 3);

    const outboxCount2 = await pool.query(
      `SELECT count(*)::int AS cnt FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND payload->>'operation' = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(outboxCount2.rows[0]?.cnt, 3);
  });

  it('7. Rollback integrity: failure during transaction commits neither jobs nor outbox events', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, 'rollback_test.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    // Mock probe producing an invalid frameRate that causes a PostgreSQL numeric field overflow on UPDATE media_assets
    const invalidProbe: FFprobeService = {
      probe: async (): Promise<ExtractedMediaMetadata> => ({
        containerFormat: 'mp4',
        durationSeconds: 5.0,
        fileSizeBytes: 48796,
        bitrate: 500000,
        video: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          frameRate: 99999.99, // Exceeds NUMERIC(6,2)
          pixelFormat: 'yuv420p',
        },
      }),
    } as unknown as FFprobeService;

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    await assert.rejects(
      async () => {
        await processJob(mockJob, pool, {
          storageService: storage,
          ffprobeService: invalidProbe,
        });
      },
      /numeric field overflow/
    );

    // Verify 0 transcode jobs were created
    const jobsRes = await pool.query(
      `SELECT id FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(jobsRes.rows.length, 0);

    // Verify 0 outbox events were created
    const outboxRes = await pool.query(
      `SELECT id FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND payload->>'operation' = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(outboxRes.rows.length, 0);

    // Verify metadata was not persisted on media_assets
    const assetCheck = await pool.query<{ width: number | null }>(
      `SELECT width FROM media_assets WHERE id = $1;`,
      [assetId]
    );
    assert.strictEqual(assetCheck.rows[0]?.width, null);
  });

  it('8. Outbox publisher dispatches scheduled transcode jobs to BullMQ', async () => {
    await pool.query('DELETE FROM outbox_events;');
    const queueName = `test-sched-queue-${Date.now()}`;
    const testQueue = createMediaQueue(queueName);

    const publisher = new OutboxPublisher(pool, testQueue, {
      pollIntervalMs: 5000,
      batchSize: 10,
    });

    try {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'dispatch_test.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      const mockJob = {
        id: jobId,
        name: EXTRACT_METADATA_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'extract_metadata',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

      await processJob(mockJob, pool, {
        storageService: storage,
        ffprobeService: mockProbe,
      });

      // Execute outbox poll cycle
      const publishedCount = await publisher.pollOnce();
      assert.ok(publishedCount >= 3, `Expected at least 3 published events, got ${publishedCount}`);

      // Verify jobs appeared in BullMQ with 'transcode' name
      const queuedJobs = await testQueue.getJobs(['waiting', 'delayed', 'active']);
      const transcodeBullJobs = queuedJobs.filter((j) => j.name === 'transcode' && (j.data as any)?.mediaAssetId === assetId);
      assert.strictEqual(transcodeBullJobs.length, 3);

      // Verify outbox_events rows are marked published
      const unpublishedCount = await pool.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM outbox_events WHERE payload->>'mediaAssetId' = $1 AND published_at IS NULL;`,
        [assetId]
      );
      assert.strictEqual(unpublishedCount.rows[0]?.cnt, 0);
    } finally {
      await testQueue.drain().catch(() => {});
      await testQueue.clean(0, 1000, 'wait').catch(() => {});
      await testQueue.close();
    }
  });

  it('9. Reliability: Worker A lease expires during metadata completion transaction, rolling back all changes', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, 'lease_race.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    const mockProbe = createMockProbeService({ width: 1920, height: 1080 });

    // Worker A claims with a short 60ms lease.
    // Inside the transaction, before the final state transition, Worker A pauses for 90ms.
    // This guarantees that clock_timestamp() > lease_expires_at when attempting the final state transition.
    await assert.rejects(
      async () => {
        await processJob(mockJob, pool, {
          workerId: 'worker-A-expiring',
          leaseDurationMs: 60,
          storageService: storage,
          ffprobeService: mockProbe,
          onBeforeCompletionCommit: async () => {
            // Sleep so lease expires while transaction is holding locks
            await new Promise((resolve) => setTimeout(resolve, 90));
          },
        });
      },
      /Worker lease expired or was revoked/
    );

    // Verify entire transaction rolled back:
    // 1. media_assets metadata must NOT be persisted
    const assetRes = await pool.query<{ width: number | null; metadata: any }>(
      `SELECT width, metadata FROM media_assets WHERE id = $1;`,
      [assetId]
    );
    assert.strictEqual(assetRes.rows[0]?.width, null);
    assert.strictEqual(assetRes.rows[0]?.metadata, null);

    // 2. No transcode jobs were scheduled
    const transcodeJobsRes = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rows[0]?.count, 0);

    // 3. No outbox events were created
    const outboxEventsRes = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events WHERE payload->>'mediaAssetId' = $1;`,
      [assetId]
    );
    assert.strictEqual(outboxEventsRes.rows[0]?.count, 0);

    // 4. Job status remains processing with attempt 1, completed_at is NULL
    const jobRes = await pool.query<{ status: string; completed_at: Date | null; current_attempt_number: number }>(
      `SELECT status, completed_at, current_attempt_number FROM processing_jobs WHERE id = $1;`,
      [jobId]
    );
    assert.strictEqual(jobRes.rows[0]?.status, 'processing');
    assert.strictEqual(jobRes.rows[0]?.completed_at, null);
    assert.strictEqual(jobRes.rows[0]?.current_attempt_number, 1);

    // 5. Job attempt remains in processing/failed, not completed
    const attemptRes = await pool.query<{ status: string }>(
      `SELECT status FROM job_attempts WHERE job_id = $1 AND attempt_number = 1;`,
      [jobId]
    );
    assert.notStrictEqual(attemptRes.rows[0]?.status, 'completed');
  });

  it('10. Reliability: Worker B reclaims job after lease expiry, preventing stale Worker A from committing', async () => {
    const assetId = uuidv7();
    const jobId = uuidv7();
    const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

    const destPath = storage.resolvePath(storageKey);
    await mkdir(resolve(destPath, '..'), { recursive: true });
    await copyFile(VALID_SAMPLE_MP4, destPath);

    await pool.query(
      `INSERT INTO media_assets (
         id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
       ) VALUES ($1, $2, 'reclaim_race.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
      [assetId, testProjectId, storageKey]
    );

    await pool.query(
      `INSERT INTO processing_jobs (
         id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
       ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
      [jobId, testProjectId, assetId]
    );

    const mockJob = {
      id: jobId,
      name: EXTRACT_METADATA_JOB,
      data: {
        jobId,
        projectId: testProjectId,
        mediaAssetId: assetId,
        operation: 'extract_metadata',
      } as ProcessingJobPayload,
    } as unknown as Job<LumenJobPayload, LumenJobResult>;

    // Worker A claims with a short 30ms lease and delays in ffprobe
    const delayedProbe = {
      probe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          durationSeconds: 5.0,
          format: 'mp4',
          bitrate: 1000000,
          video: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            frameRate: 30,
            rotation: 0,
            pixelFormat: 'yuv420p',
          },
          audio: null,
          rawMetadata: {},
        };
      },
    };

    // Launch Worker A
    const workerAPromise = processJob(mockJob, pool, {
      workerId: 'worker-A-stale',
      leaseDurationMs: 30,
      storageService: storage,
      ffprobeService: delayedProbe as any,
    });

    // Wait 40ms so Worker A's lease expires while Worker A is still probing
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Worker B reclaims the job
    const fastProbe = createMockProbeService({ width: 1920, height: 1080 });
    const workerBResult = await processJob(mockJob, pool, {
      workerId: 'worker-B-reclaimer',
      leaseDurationMs: 60000,
      storageService: storage,
      ffprobeService: fastProbe,
    });

    assert.strictEqual((workerBResult as ProcessingJobResult).status, 'completed');

    // Worker A should fail due to lease revocation / fencing token mismatch
    await assert.rejects(
      async () => {
        await workerAPromise;
      },
      /Worker lease expired or was revoked/
    );

    // Verify Worker B's completion is authoritative
    const finalJobRes = await pool.query<{ status: string; locked_by: string | null; current_attempt_number: number }>(
      `SELECT status, locked_by, current_attempt_number FROM processing_jobs WHERE id = $1;`,
      [jobId]
    );
    assert.strictEqual(finalJobRes.rows[0]?.status, 'completed');
    assert.strictEqual(finalJobRes.rows[0]?.current_attempt_number, 2);

    // Verify rendition jobs were created exactly once (no duplicates from Worker A)
    const transcodeJobsRes = await pool.query<{ profile: string }>(
      `SELECT parameters->>'profile' AS profile FROM processing_jobs WHERE media_asset_id = $1 AND operation = 'transcode';`,
      [assetId]
    );
    assert.strictEqual(transcodeJobsRes.rowCount, 3);
  });
});
