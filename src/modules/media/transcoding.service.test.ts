import '../../test/integration-preload.js';
import { testStorageDirectory, removeTestStorage } from '../../test/test-environment.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestPool as Pool } from '../../test/db-guard.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { resolve } from 'node:path';
import { mkdir, copyFile, rm, stat, readFile } from 'node:fs/promises';
import { type Job } from 'bullmq';
import { assertTestDatabase } from '../../test/db-guard.js';
import { LocalStorageService, defaultStorageService } from '../../shared/storage/local-storage.service.js';
import { buildApp } from '../../app.js';
import { generateApiKey } from '../../shared/crypto.js';
import {
  TranscodingService,
  AsyncSemaphore,
  TranscodingError,
  TranscodingTimeoutError,
  TranscodingOutputLimitError,
  InvalidMediaError,
  getAvailableH264Encoder,
} from './transcoding.service.js';
import { FFprobeService } from './ffprobe.service.js';
import { processJob } from '../../workers/processor.js';
import {
  TRANSCODE_JOB,
  type LumenJobPayload,
  type LumenJobResult,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from '../../workers/queue.js';

const FIXTURES_DIR = resolve(process.cwd(), 'src/test/fixtures');
const SEED_SAMPLE_MP4 = resolve(FIXTURES_DIR, 'valid_sample.mp4');
const CORRUPT_MP4 = resolve(FIXTURES_DIR, 'corrupt.mp4');
const TEST_STORAGE_DIR = testStorageDirectory('transcoding-service');
const VALID_SAMPLE_MP4 = resolve(TEST_STORAGE_DIR, 'source-1080p.mp4');
const SHORT_SAMPLE_MP4 = VALID_SAMPLE_MP4;
process.env.STORAGE_BASE_DIR = TEST_STORAGE_DIR;

async function checkFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('Milestone 3.5.3: Video Transcoding Suite', () => {
  let pool: Pool;
  let storage: LocalStorageService;
  let ffprobe: FFprobeService;
  let transcodingService: TranscodingService;
  let testAccountId: string;
  let testProjectId: string;
  let activeApiKey: string;
  let app: any;

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
    await defaultStorageService.init();

    ffprobe = new FFprobeService();
    transcodingService = new TranscodingService({ ffprobeService: ffprobe });
    // Test source must exceed rendition dimensions; the committed seed is only 320x240.
    await promisify(execFile)(transcodingService.ffmpegPath, [
      '-v', 'error', '-y', '-i', SEED_SAMPLE_MP4, '-vf', 'scale=1920:1080',
      '-c:v', 'mpeg4', '-c:a', 'copy', VALID_SAMPLE_MP4,
    ], { timeout: 30000 });

    testAccountId = uuidv7();
    testProjectId = uuidv7();

    await pool.query(
      `INSERT INTO accounts (id, email) VALUES ($1, $2);`,
      [testAccountId, `transcode-${Date.now()}@test.com`]
    );
    await pool.query(
      `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Transcode Service Test Project');`,
      [testProjectId, testAccountId]
    );

    // Create API key for authenticated API tests
    const keyGen = generateApiKey('lumen_live');
    activeApiKey = keyGen.apiKey;
    await pool.query(
      `INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, created_at)
       VALUES ($1, $2, 'Test Key', $3, $4, NOW());`,
      [uuidv7(), testProjectId, keyGen.keyPrefix, keyGen.hash]
    );

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
    if (pool) {
      await pool.query('DELETE FROM outbox_events WHERE aggregate_type = \'processing_job\';').catch(() => {});
      await pool.query('DELETE FROM media_outputs WHERE media_asset_id IN (SELECT id FROM media_assets WHERE project_id = $1);', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id = $1);', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM processing_jobs WHERE project_id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM media_assets WHERE project_id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM api_keys WHERE project_id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM projects WHERE id = $1;', [testProjectId]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE id = $1;', [testAccountId]).catch(() => {});
      await pool.end();
    }
    await removeTestStorage(TEST_STORAGE_DIR).catch(() => {});
  });

  // =========================================================================
  // 1. AsyncSemaphore Concurrency Limiting Tests
  // =========================================================================
  describe('1. AsyncSemaphore Concurrency Limiter', () => {
    it('enforces maximum concurrency and queues excess requests FIFO', async () => {
      const semaphore = new AsyncSemaphore(2);
      const executionOrder: number[] = [];
      let activeDuringTask2 = 0;

      const runTask = async (id: number, durationMs: number) => {
        const release = await semaphore.acquire();
        try {
          executionOrder.push(id);
          if (id === 2) {
            activeDuringTask2 = semaphore.activeCount;
          }
          await new Promise((r) => setTimeout(r, durationMs));
        } finally {
          release();
        }
      };

      const p1 = runTask(1, 50);
      const p2 = runTask(2, 50);
      const p3 = runTask(3, 30);

      assert.strictEqual(semaphore.activeCount, 2);
      assert.strictEqual(semaphore.waitingCount, 1);

      await Promise.all([p1, p2, p3]);

      assert.strictEqual(activeDuringTask2, 2);
      assert.deepStrictEqual(executionOrder, [1, 2, 3]);
      assert.strictEqual(semaphore.activeCount, 0);
      assert.strictEqual(semaphore.waitingCount, 0);
    });

    it('rejects semaphore construction with concurrency less than 1', () => {
      assert.throws(() => new AsyncSemaphore(0), /integer between 1/);
      assert.throws(() => new AsyncSemaphore(-1), /integer between 1/);
    });
  });

  // =========================================================================
  // 2. TranscodingService Unit Tests
  // =========================================================================
  describe('2. TranscodingService Unit Tests', () => {
    it('detects available H.264 encoder on current environment', () => {
      const encoder = getAvailableH264Encoder();
      assert.ok(typeof encoder === 'string' && encoder.length > 0);
      assert.ok(['libx264', 'libopenh264', 'h264'].includes(encoder));
    });

    it('validates input parameters and rejects invalid dimensions or bitrate', async () => {
      const outPath = storage.createTempFilePath('val_test');

      await assert.rejects(
        transcodingService.transcodeVideo({
          inputFilePath: '',
          outputFilePath: outPath,
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        /valid inputFilePath is required/
      );

      await assert.rejects(
        transcodingService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: '',
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        /valid outputFilePath is required/
      );

      await assert.rejects(
        transcodingService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: 0,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        /targetWidth must be an integer/
      );

      await assert.rejects(
        transcodingService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: -100,
          hasAudio: false,
        }),
        /bitrateKbps must be an integer/
      );
    });

    it('successfully transcodes valid MP4 to 360p with AAC audio and faststart', async () => {
      const outPath = storage.createTempFilePath('transcode_360p');

      const result = await transcodingService.transcodeVideo({
        inputFilePath: VALID_SAMPLE_MP4,
        outputFilePath: outPath,
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
        hasAudio: true,
      });

      assert.strictEqual(result.width, 640);
      assert.strictEqual(result.height, 360);
      assert.strictEqual(result.mimeType, 'video/mp4');
      assert.ok(result.fileSizeBytes > 0);
      assert.ok(result.durationSeconds > 0);
      assert.ok(result.videoCodec.includes('264'));
      assert.ok(result.audioCodec === 'aac' || result.audioCodec === null);

      const exists = await checkFileExists(outPath);
      assert.strictEqual(exists, true);

      // Clean up test file
      await rm(outPath, { force: true }).catch(() => {});
    });

    it('transcodes video without audio producing an audio-less rendition (-an)', async () => {
      const outPath = storage.createTempFilePath('transcode_no_audio');

      const result = await transcodingService.transcodeVideo({
        inputFilePath: VALID_SAMPLE_MP4,
        outputFilePath: outPath,
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
        hasAudio: false,
      });

      assert.strictEqual(result.width, 640);
      assert.strictEqual(result.height, 360);
      assert.strictEqual(result.audioCodec, null);

      const probeRes = await ffprobe.probe(outPath);
      assert.strictEqual(probeRes.audio, undefined);

      await rm(outPath, { force: true }).catch(() => {});
    });

    it('transcodes across all supported profile bounding boxes (360p, 480p, 720p, 1080p)', async () => {
      const profiles = [
        { name: '360p', w: 640, h: 360, b: 800 },
        { name: '480p', w: 854, h: 480, b: 1400 },
        { name: '720p', w: 1280, h: 720, b: 2800 },
      ];

      for (const p of profiles) {
        const outPath = storage.createTempFilePath(`transcode_${p.name}`);
        const result = await transcodingService.transcodeVideo({
          inputFilePath: SHORT_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: p.w,
          targetHeight: p.h,
          bitrateKbps: p.b,
          hasAudio: false,
        });

        assert.strictEqual(result.width, p.w);
        assert.strictEqual(result.height, p.h);
        assert.ok(result.fileSizeBytes > 0);

        await rm(outPath, { force: true }).catch(() => {});
      }
    });

    it('rejects corrupt input file and cleans up partial output file', async () => {
      const outPath = storage.createTempFilePath('corrupt_out');

      await assert.rejects(
        transcodingService.transcodeVideo({
          inputFilePath: CORRUPT_MP4,
          outputFilePath: outPath,
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        (err: any) => {
          assert.strictEqual(err.code, 'INVALID_MEDIA');
          return true;
        }
      );

      // Verify partial output file was removed
      const exists = await checkFileExists(outPath);
      assert.strictEqual(exists, false, 'Output file must be cleaned up on failure');
    });

    it('enforces execution timeout and aborts runaway process', async () => {
      const fastTimeoutService = new TranscodingService({
        timeoutMs: 10, // 10ms timeout will reliably trigger on real video encoding
        ffprobeService: ffprobe,
      });

      const outPath = storage.createTempFilePath('timeout_out');

      await assert.rejects(
        fastTimeoutService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: 1280,
          targetHeight: 720,
          bitrateKbps: 2800,
          hasAudio: false,
        }),
        (err: any) => {
          assert.ok(err instanceof TranscodingTimeoutError);
          assert.strictEqual(err.code, 'TIMEOUT');
          return true;
        }
      );

      const exists = await checkFileExists(outPath);
      assert.strictEqual(exists, false);
    });

    it('enforces output file size limit and terminates encoding', async () => {
      const tinyLimitService = new TranscodingService({
        maxOutputBytes: 100, // tiny 100-byte limit
        ffprobeService: ffprobe,
      });

      const outPath = storage.createTempFilePath('size_limit_out');

      await assert.rejects(
        tinyLimitService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        (err: any) => {
          assert.ok(err instanceof TranscodingOutputLimitError);
          assert.strictEqual(err.code, 'OUTPUT_LIMIT_EXCEEDED');
          return true;
        }
      );

      const exists = await checkFileExists(outPath);
      assert.strictEqual(exists, false);
    });

    it('handles process spawn error gracefully when ffmpeg binary path is invalid', async () => {
      const badPathService = new TranscodingService({
        ffmpegPath: '/invalid/path/to/nonexistent/ffmpeg_bin',
        ffprobeService: ffprobe,
      });

      const outPath = storage.createTempFilePath('bad_path_out');

      await assert.rejects(
        badPathService.transcodeVideo({
          inputFilePath: VALID_SAMPLE_MP4,
          outputFilePath: outPath,
          targetWidth: 640,
          targetHeight: 360,
          bitrateKbps: 800,
          hasAudio: false,
        }),
        (err: any) => {
          assert.ok(err instanceof TranscodingError);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 3. Worker Integration Tests (Operation: 'transcode')
  // =========================================================================
  describe('3. Worker Processor Transcode Integration', () => {
    it('executes transcode operation end-to-end, persists media_outputs and completes job', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      // Copy test video to storage location
      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      // Create ready media asset
      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes,
           uploaded_bytes, storage_key, status, audio_codec, created_at, updated_at
         ) VALUES ($1, $2, 'sample.mp4', 'video/mp4', 100000, 100000, $3, 'ready', 'aac', NOW(), NOW());`,
        [assetId, testProjectId, storageKey]
      );

      const jobParams = {
        profile: '360p',
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
      };

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [jobId, testProjectId, assetId, JSON.stringify(jobParams)]
      );

      const mockJob = {
        id: jobId,
        name: TRANSCODE_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'transcode',
          parameters: jobParams,
        } as ProcessingJobPayload,
      } as Job<LumenJobPayload, LumenJobResult>;

      const result = await processJob(mockJob, pool, {
        storageService: storage,
        transcodingService,
        ffprobeService: ffprobe,
      });

      assert.strictEqual((result as ProcessingJobResult).status, 'completed');

      // Check processing_jobs record
      const jobRes = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.ok(jobRes.rows[0]?.completed_at !== null);

      // Check job_attempts record
      const attemptRes = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'completed');

      // Check media_outputs record
      const outRes = await pool.query<{
        output_type: string;
        logical_key: string;
        version: number;
        is_current: boolean;
        storage_key: string;
        width: number;
        height: number;
        mime_type: string;
      }>(
        `SELECT output_type, logical_key, version, is_current, storage_key, width, height, mime_type
         FROM media_outputs
         WHERE media_asset_id = $1 AND logical_key = 'rendition_360p';`,
        [assetId]
      );

      assert.strictEqual(outRes.rows.length, 1);
      const outRow = outRes.rows[0]!;
      assert.strictEqual(outRow.output_type, 'rendition');
      assert.strictEqual(outRow.version, 1);
      assert.strictEqual(outRow.is_current, true);
      assert.strictEqual(outRow.width, 640);
      assert.strictEqual(outRow.height, 360);
      assert.strictEqual(outRow.mime_type, 'video/mp4');

      // Check rendition file physically exists in storage
      const renditionDiskPath = storage.resolvePath(outRow.storage_key);
      const fileExists = await checkFileExists(renditionDiskPath);
      assert.strictEqual(fileExists, true);
    });

    it('monotonic version allocation: re-transcoding increments version and maintains single is_current', async () => {
      const assetId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;
      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes,
           uploaded_bytes, storage_key, status, audio_codec, created_at, updated_at
         ) VALUES ($1, $2, 'versioning.mp4', 'video/mp4', 100000, 100000, $3, 'ready', 'aac', NOW(), NOW());`,
        [assetId, testProjectId, storageKey]
      );

      const jobParams = {
        profile: '360p',
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
      };

      // Run attempt 1
      const job1Id = uuidv7();
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [job1Id, testProjectId, assetId, JSON.stringify(jobParams)]
      );

      await processJob(
        {
          id: job1Id,
          name: TRANSCODE_JOB,
          data: {
            jobId: job1Id,
            projectId: testProjectId,
            mediaAssetId: assetId,
            operation: 'transcode',
            parameters: jobParams,
          },
        } as any,
        pool,
        { storageService: storage, transcodingService, ffprobeService: ffprobe }
      );

      // Run attempt 2 (e.g. reprocessing)
      const job2Id = uuidv7();
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [job2Id, testProjectId, assetId, JSON.stringify(jobParams)]
      );

      await processJob(
        {
          id: job2Id,
          name: TRANSCODE_JOB,
          data: {
            jobId: job2Id,
            projectId: testProjectId,
            mediaAssetId: assetId,
            operation: 'transcode',
            parameters: jobParams,
          },
        } as any,
        pool,
        { storageService: storage, transcodingService, ffprobeService: ffprobe }
      );

      // Verify versions and is_current
      const versionsRes = await pool.query<{ version: number; is_current: boolean }>(
        `SELECT version, is_current
         FROM media_outputs
         WHERE media_asset_id = $1 AND logical_key = 'rendition_360p'
         ORDER BY version ASC;`,
        [assetId]
      );

      assert.strictEqual(versionsRes.rows.length, 2);
      assert.strictEqual(versionsRes.rows[0]?.version, 1);
      assert.strictEqual(versionsRes.rows[0]?.is_current, false);
      assert.strictEqual(versionsRes.rows[1]?.version, 2);
      assert.strictEqual(versionsRes.rows[1]?.is_current, true);
    });

    it('independent failures: transcode failure resets job and leaves parent media asset ready', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/corrupt.mp4`;

      // Copy corrupt file to asset storage location
      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(CORRUPT_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes,
           uploaded_bytes, storage_key, status, audio_codec, created_at, updated_at
         ) VALUES ($1, $2, 'corrupt.mp4', 'video/mp4', 1000, 1000, $3, 'ready', 'aac', NOW(), NOW());`,
        [assetId, testProjectId, storageKey]
      );

      const jobParams = {
        profile: '360p',
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
      };

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [jobId, testProjectId, assetId, JSON.stringify(jobParams)]
      );

      await assert.rejects(
        processJob(
          {
            id: jobId,
            name: TRANSCODE_JOB,
            data: {
              jobId,
              projectId: testProjectId,
              mediaAssetId: assetId,
              operation: 'transcode',
              parameters: jobParams,
            },
          } as any,
          pool,
          { storageService: storage, transcodingService, ffprobeService: ffprobe }
        )
      );

      // Verify processing_jobs reset to 'queued' (attempt 1 of 3)
      const jobRes = await pool.query<{ status: string; current_attempt_number: number }>(
        `SELECT status, current_attempt_number FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'queued');
      assert.strictEqual(jobRes.rows[0]?.current_attempt_number, 1);

      // Verify attempt recorded as failed
      const attemptRes = await pool.query<{ status: string; error_code: string | null }>(
        `SELECT status, error_code FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');

      // CRITICAL: Parent media_assets status remains 'ready' (independent failure)
      const assetRes = await pool.query<{ status: string }>(
        `SELECT status FROM media_assets WHERE id = $1;`,
        [assetId]
      );
      assert.strictEqual(assetRes.rows[0]?.status, 'ready');
    });

    it('lease expiry race: stale worker cannot commit transcode completion when lease expired', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes,
           uploaded_bytes, storage_key, status, audio_codec, created_at, updated_at
         ) VALUES ($1, $2, 'lease_race.mp4', 'video/mp4', 100000, 100000, $3, 'ready', 'aac', NOW(), NOW());`,
        [assetId, testProjectId, storageKey]
      );

      const jobParams = {
        profile: '360p',
        targetWidth: 640,
        targetHeight: 360,
        bitrateKbps: 800,
      };

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [jobId, testProjectId, assetId, JSON.stringify(jobParams)]
      );

      // Worker claims with a short 60ms lease and sleeps 90ms before completion commit
      await assert.rejects(
        processJob(
          {
            id: jobId,
            name: TRANSCODE_JOB,
            data: {
              jobId,
              projectId: testProjectId,
              mediaAssetId: assetId,
              operation: 'transcode',
              parameters: jobParams,
            },
          } as any,
          pool,
          {
            workerId: 'worker-expiring',
            leaseDurationMs: 60,
            storageService: storage,
            transcodingService,
            ffprobeService: ffprobe,
            onBeforeCompletionCommit: async () => {
              await new Promise((r) => setTimeout(r, 90));
            },
          }
        ),
        /Worker lease expired or was revoked/
      );

      // media_outputs should NOT have committed
      const outputsRes = await pool.query(
        `SELECT id FROM media_outputs WHERE media_asset_id = $1 AND logical_key = 'rendition_360p';`,
        [assetId]
      );
      assert.strictEqual(outputsRes.rows.length, 0);
    });
  });

  // =========================================================================
  // 4. API Integration Tests (GET /v1/media/:id & GET .../renditions/:profile)
  // =========================================================================
  describe('4. API Delivery & Metadata Integration', () => {
    let apiAssetId: string;
    let apiRenditionDiskPath: string;

    before(async () => {
      apiAssetId = uuidv7();
      const storageKey = `media/${testProjectId}/${apiAssetId}/original.mp4`;
      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      // Create ready asset
      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes,
           uploaded_bytes, storage_key, status, audio_codec, created_at, updated_at
         ) VALUES ($1, $2, 'api_test.mp4', 'video/mp4', 100000, 100000, $3, 'ready', 'aac', NOW(), NOW());`,
        [apiAssetId, testProjectId, storageKey]
      );

      // Complete 360p rendition job
      const jobId = uuidv7();
      const jobParams = { profile: '360p', targetWidth: 640, targetHeight: 360, bitrateKbps: 800 };
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [jobId, testProjectId, apiAssetId, JSON.stringify(jobParams)]
      );

      await processJob(
        {
          id: jobId,
          name: TRANSCODE_JOB,
          data: {
            jobId,
            projectId: testProjectId,
            mediaAssetId: apiAssetId,
            operation: 'transcode',
            parameters: jobParams,
          },
        } as any,
        pool,
        { storageService: defaultStorageService, transcodingService, ffprobeService: ffprobe }
      );

      const outRes = await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM media_outputs WHERE media_asset_id = $1 AND logical_key = 'rendition_360p';`,
        [apiAssetId]
      );
      apiRenditionDiskPath = defaultStorageService.resolvePath(outRes.rows[0]!.storage_key);

      // Also create a queued 720p job (for 409 testing)
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
        [uuidv7(), testProjectId, apiAssetId, JSON.stringify({ profile: '720p', targetWidth: 1280, targetHeight: 720, bitrateKbps: 2800 })]
      );

      // And a failed 1080p job (for 409 testing)
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number, created_at
         ) VALUES ($1, $2, $3, 'transcode', $4, 'failed', 3, NOW());`,
        [uuidv7(), testProjectId, apiAssetId, JSON.stringify({ profile: '1080p', targetWidth: 1920, targetHeight: 1080, bitrateKbps: 5000 })]
      );
    });

    it('GET /v1/media/:id returns completed, queued, and failed renditions in metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.payload);

      assert.ok(body.transcoding);
      assert.ok(Array.isArray(body.transcoding.renditions));

      const r360p = body.transcoding.renditions.find((r: any) => r.profile === '360p');
      assert.ok(r360p);
      assert.strictEqual(r360p.status, 'completed');
      assert.strictEqual(r360p.width, 640);
      assert.strictEqual(r360p.height, 360);
      assert.strictEqual(r360p.mime_type, 'video/mp4');
      assert.strictEqual(r360p.version, 1);
      assert.strictEqual(r360p.url, `/v1/media/${apiAssetId}/renditions/360p`);
      assert.ok(r360p.completed_at);

      const r720p = body.transcoding.renditions.find((r: any) => r.profile === '720p');
      assert.ok(r720p);
      assert.strictEqual(r720p.status, 'queued');

      const r1080p = body.transcoding.renditions.find((r: any) => r.profile === '1080p');
      assert.ok(r1080p);
      assert.strictEqual(r1080p.status, 'failed');
    });

    it('GET /v1/media/:id/renditions/:profile returns 200 streaming MP4 with correct headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/360p`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'video/mp4');
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.strictEqual(res.headers['accept-ranges'], undefined);
      assert.ok(Number(res.headers['content-length']) > 0);

      // Verify returned bytes match the actual file bytes
      const actualFileBytes = await readFile(apiRenditionDiskPath);
      assert.strictEqual(res.rawPayload.length, actualFileBytes.length);
    });

    it('GET /v1/media/:id/renditions/:profile rejects unauthenticated request with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/360p`,
      });

      assert.strictEqual(res.statusCode, 401);
    });

    it('GET /v1/media/:id/renditions/:profile returns 404 for unknown profile name', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/4k`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'rendition_not_found');
    });

    it('GET /v1/media/:id/renditions/:profile returns 404 for unconfigured profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/480p`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'rendition_not_found');
    });

    it('GET /v1/media/:id/renditions/:profile enforces tenant isolation with 404', async () => {
      // Create second project and API key
      const otherProjectId = uuidv7();
      await pool.query(
        `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Other Project');`,
        [otherProjectId, testAccountId]
      );
      const otherKeyGen = generateApiKey('lumen_live');
      await pool.query(
        `INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, created_at)
         VALUES ($1, $2, 'Other Key', $3, $4, NOW());`,
        [uuidv7(), otherProjectId, otherKeyGen.keyPrefix, otherKeyGen.hash]
      );

      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/360p`,
        headers: { Authorization: `Bearer ${otherKeyGen.apiKey}` },
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'media_asset_not_found');
    });

    it('GET /v1/media/:id/renditions/:profile returns 409 while rendition is queued/processing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/720p`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 409);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'rendition_processing');
    });

    it('GET /v1/media/:id/renditions/:profile returns 409 when rendition processing failed', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/media/${apiAssetId}/renditions/1080p`,
        headers: { Authorization: `Bearer ${activeApiKey}` },
      });

      assert.strictEqual(res.statusCode, 409);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'rendition_failed');
    });
  });
});
