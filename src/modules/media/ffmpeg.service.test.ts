import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { copyFile, mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { type Job } from 'bullmq';
import {
  FFmpegService,
  FFmpegError,
  FFmpegTimeoutError,
  FFmpegOutputLimitError,
  InvalidMediaError,
  calculateThumbnailTimestamp,
  parseJpegDimensions,
} from './ffmpeg.service.js';
import { processJob } from '../../workers/processor.js';
import {
  GENERATE_THUMBNAIL_JOB,
  type LumenJobPayload,
  type LumenJobResult,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from '../../workers/queue.js';
import { LocalStorageService } from '../../shared/storage/local-storage.service.js';
import { assertTestDatabase } from '../../test/db-guard.js';
import { buildApp } from '../../app.js';
import { generateApiKey } from '../../shared/crypto.js';

const FIXTURES_DIR = resolve('src/test/fixtures');
const VALID_SAMPLE_MP4 = resolve(FIXTURES_DIR, 'valid_sample.mp4');
const SHORT_SAMPLE_MP4 = resolve(FIXTURES_DIR, 'short_sample.mp4');
const AUDIO_ONLY_MP4 = resolve(FIXTURES_DIR, 'audio_only.mp4');
const CORRUPT_MP4 = resolve(FIXTURES_DIR, 'corrupt.mp4');
const TEST_STORAGE_DIR = resolve('storage_ffmpeg_test');
async function fileExistsOnDisk(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
process.env.STORAGE_BASE_DIR = TEST_STORAGE_DIR;

describe('FFmpeg Thumbnail Generation Suite (Milestone 3.4)', () => {
  describe('1. Unit Tests — Helper Functions', () => {
    it('calculateThumbnailTimestamp defaults to ~10% of duration', () => {
      assert.strictEqual(calculateThumbnailTimestamp(10.0), 1.0);
      assert.strictEqual(calculateThumbnailTimestamp(60.0), 6.0);
      assert.strictEqual(calculateThumbnailTimestamp(1.0), 0.1);
    });

    it('calculateThumbnailTimestamp provides sensible fallback for very short or zero duration', () => {
      assert.strictEqual(calculateThumbnailTimestamp(0.2), 0.02);
      assert.strictEqual(calculateThumbnailTimestamp(0), 0);
      assert.strictEqual(calculateThumbnailTimestamp(-5), 0);
    });

    it('calculateThumbnailTimestamp validates requested offset within duration', () => {
      // Valid offset
      assert.strictEqual(calculateThumbnailTimestamp(10.0, 3.5), 3.5);
      assert.strictEqual(calculateThumbnailTimestamp(10.0, 0), 0);

      // Out of bounds requested offset falls back to 10%
      assert.strictEqual(calculateThumbnailTimestamp(10.0, 15.0), 1.0);
      assert.strictEqual(calculateThumbnailTimestamp(10.0, -2.0), 1.0);
    });

    it('parseJpegDimensions validates JPEG magic bytes and parses SOF markers', () => {
      // Empty buffer
      assert.strictEqual(parseJpegDimensions(Buffer.alloc(0)), null);
      // Non-JPEG buffer
      assert.strictEqual(parseJpegDimensions(Buffer.from('PNG_HEADER_DATA')), null);

      // Minimal valid JPEG header with SOF0 marker (0xFF, 0xC0)
      const fakeJpeg = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xc0, // SOF0
        0x00, 0x0b, // Length (11 bytes)
        0x08,       // Precision
        0x00, 0xf0, // Height = 240
        0x01, 0x40, // Width = 320
        0x03,       // Components
      ]);
      const dims = parseJpegDimensions(fakeJpeg);
      assert.ok(dims);
      assert.strictEqual(dims.width, 320);
      assert.strictEqual(dims.height, 240);
    });
  });

  describe('2. Unit Tests — FFmpegService Execution & Validation', () => {
    const service = new FFmpegService();

    it('successfully extracts thumbnail from valid MP4 fixture', async () => {
      const outPath = resolve(TEST_STORAGE_DIR, `unit-thumb-${uuidv7()}.jpg`);
      await mkdir(TEST_STORAGE_DIR, { recursive: true });

      const result = await service.extractThumbnail(VALID_SAMPLE_MP4, outPath, 0.1);

      assert.strictEqual(result.outputFilePath, outPath);
      assert.strictEqual(result.mimeType, 'image/jpeg');
      assert.strictEqual(result.timestamp, 0.1);
      assert.strictEqual(result.width, 320);
      assert.strictEqual(result.height, 240);
      assert.ok(result.fileSizeBytes > 1000);
      assert.ok(result.width <= 640 && result.height <= 360);

      // Verify file on disk is a valid JPEG
      const data = await readFile(outPath);
      assert.strictEqual(data[0], 0xff);
      assert.strictEqual(data[1], 0xd8);

      await rm(outPath, { force: true });
    });

    it('successfully extracts thumbnail from very short video (0.2s duration)', async () => {
      const outPath = resolve(TEST_STORAGE_DIR, `short-thumb-${uuidv7()}.jpg`);
      await mkdir(TEST_STORAGE_DIR, { recursive: true });

      const result = await service.extractThumbnail(SHORT_SAMPLE_MP4, outPath, 0.02);

      assert.strictEqual(result.mimeType, 'image/jpeg');
      assert.strictEqual(result.width, 320);
      assert.strictEqual(result.height, 240);
      assert.ok(result.fileSizeBytes > 500);

      await rm(outPath, { force: true });
    });

    it('rejects corrupt MP4 fixture with InvalidMediaError', async () => {
      const outPath = resolve(TEST_STORAGE_DIR, `corrupt-thumb-${uuidv7()}.jpg`);
      await mkdir(TEST_STORAGE_DIR, { recursive: true });

      await assert.rejects(
        async () => await service.extractThumbnail(CORRUPT_MP4, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          assert.strictEqual(err.code, 'INVALID_MEDIA');
          return true;
        }
      );
    });

    it('rejects audio-only MP4 fixture with InvalidMediaError (no video stream)', async () => {
      const outPath = resolve(TEST_STORAGE_DIR, `audio-thumb-${uuidv7()}.jpg`);
      await mkdir(TEST_STORAGE_DIR, { recursive: true });

      await assert.rejects(
        async () => await service.extractThumbnail(AUDIO_ONLY_MP4, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          return true;
        }
      );
    });

    it('rejects non-existent file path with InvalidMediaError and sanitizes internal paths', async () => {
      const nonExistentPath = resolve(FIXTURES_DIR, 'missing_file.mp4');
      const outPath = resolve(TEST_STORAGE_DIR, `missing-thumb-${uuidv7()}.jpg`);

      await assert.rejects(
        async () => await service.extractThumbnail(nonExistentPath, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          // Path sanitization check: internal paths must be redacted
          assert.ok(!err.message.includes(nonExistentPath));
          assert.ok(!err.message.includes(outPath));
          assert.ok(err.message.includes('[media-file]') || err.message.includes('[output-file]'));
          return true;
        }
      );
    });

    it('rejects when FFmpeg executable is unavailable (ENOENT)', async () => {
      const badService = new FFmpegService({
        ffmpegPath: '/usr/bin/nonexistent_ffmpeg_binary',
      });
      const outPath = resolve(TEST_STORAGE_DIR, `enoent-thumb-${uuidv7()}.jpg`);

      await assert.rejects(
        async () => await badService.extractThumbnail(VALID_SAMPLE_MP4, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof FFmpegError);
          assert.strictEqual(err.code, 'ENOENT');
          return true;
        }
      );
    });

    it('rejects with FFmpegTimeoutError when execution exceeds timeout limit', async () => {
      const slowService = new FFmpegService({
        timeoutMs: 1, // 1ms timeout triggers timeout immediately
      });
      const outPath = resolve(TEST_STORAGE_DIR, `timeout-thumb-${uuidv7()}.jpg`);

      await assert.rejects(
        async () => await slowService.extractThumbnail(VALID_SAMPLE_MP4, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof FFmpegTimeoutError);
          assert.strictEqual(err.code, 'TIMEOUT');
          return true;
        }
      );
    });

    it('rejects with FFmpegOutputLimitError when output image exceeds max file size', async () => {
      const strictLimitService = new FFmpegService({
        maxOutputBytes: 100, // 100 bytes limit will be exceeded by generated JPEG
      });
      const outPath = resolve(TEST_STORAGE_DIR, `limit-thumb-${uuidv7()}.jpg`);

      await assert.rejects(
        async () => await strictLimitService.extractThumbnail(VALID_SAMPLE_MP4, outPath, 0.1),
        (err: any) => {
          assert.ok(err instanceof FFmpegOutputLimitError);
          assert.strictEqual(err.code, 'OUTPUT_LIMIT_EXCEEDED');
          return true;
        }
      );
    });

    it('extractThumbnail removes temporary output file on corrupt media failure', async () => {
      const ffmpeg = new FFmpegService();
      const tempOutput = resolve(TEST_STORAGE_DIR, `corrupt-clean-${uuidv7()}.jpg`);
      await assert.rejects(
        async () => {
          await ffmpeg.extractThumbnail(CORRUPT_MP4, tempOutput, 0.5);
        },
        InvalidMediaError
      );
      assert.strictEqual(await fileExistsOnDisk(tempOutput), false);
    });

    it('extractThumbnail removes temporary output file when maxOutputBytes is exceeded', async () => {
      const ffmpeg = new FFmpegService({ maxOutputBytes: 100 });
      const tempOutput = resolve(TEST_STORAGE_DIR, `size-clean-${uuidv7()}.jpg`);
      await assert.rejects(
        async () => {
          await ffmpeg.extractThumbnail(VALID_SAMPLE_MP4, tempOutput, 0.5);
        },
        FFmpegOutputLimitError
      );
      assert.strictEqual(await fileExistsOnDisk(tempOutput), false);
    });

    it('extractThumbnail removes temporary output file when process times out', async () => {
      const ffmpeg = new FFmpegService({ timeoutMs: 1 });
      const tempOutput = resolve(TEST_STORAGE_DIR, `timeout-clean-${uuidv7()}.jpg`);
      await assert.rejects(
        async () => {
          await ffmpeg.extractThumbnail(VALID_SAMPLE_MP4, tempOutput, 0.5);
        },
        FFmpegTimeoutError
      );
      assert.strictEqual(await fileExistsOnDisk(tempOutput), false);
    });
  });

  describe('3. Integration Tests — Worker & PostgreSQL Output Persistence', () => {
    let pool: Pool;
    let storage: LocalStorageService;
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

      testAccountId = uuidv7();
      testProjectId = uuidv7();

      await pool.query(`INSERT INTO accounts (id, email) VALUES ($1, $2);`, [
        testAccountId,
        `ffmpeg-${Date.now()}@test.com`,
      ]);
      await pool.query(
        `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Thumbnail Project');`,
        [testProjectId, testAccountId]
      );
    });

    after(async () => {
      if (pool) {
        await pool.query(
          `DELETE FROM media_outputs WHERE media_asset_id IN (SELECT id FROM media_assets WHERE project_id = $1);`,
          [testProjectId]
        ).catch(() => {});
        await pool.query(
          `DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id = $1);`,
          [testProjectId]
        ).catch(() => {});
        await pool.query(`DELETE FROM processing_jobs WHERE project_id = $1;`, [testProjectId]).catch(() => {});
        await pool.query(`DELETE FROM media_assets WHERE project_id = $1;`, [testProjectId]).catch(() => {});
        await pool.query(`DELETE FROM projects WHERE id = $1;`, [testProjectId]).catch(() => {});
        await pool.query(`DELETE FROM accounts WHERE id = $1;`, [testAccountId]).catch(() => {});
        await pool.end();
      }
      await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    });

    it('worker successfully generates thumbnail and persists media_outputs record', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, width, height, status
         ) VALUES ($1, $2, 'sample.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 320, 240, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{"offset_seconds": 0.5}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      const mockJob = {
        id: jobId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
          parameters: { offset_seconds: 0.5 },
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      const result = (await processJob(mockJob, pool, {
        storageService: storage,
      })) as ProcessingJobResult;

      assert.strictEqual(result.status, 'completed');

      // Verify processing_jobs row
      const jobRes = await pool.query<{
        status: string;
        lease_token: string | null;
        completed_at: Date | null;
      }>(`SELECT status, lease_token, completed_at FROM processing_jobs WHERE id = $1;`, [jobId]);
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.strictEqual(jobRes.rows[0]?.lease_token, null);
      assert.ok(jobRes.rows[0]?.completed_at);

      // Verify media_outputs row
      const outputRes = await pool.query<{
        output_type: string;
        logical_key: string;
        version: number;
        is_current: boolean;
        storage_key: string;
        mime_type: string;
        file_size_bytes: string;
        width: number;
        height: number;
        metadata: any;
      }>(
        `SELECT output_type, logical_key, version, is_current, storage_key, mime_type, file_size_bytes, width, height, metadata
         FROM media_outputs WHERE media_asset_id = $1 AND output_type = 'thumbnail';`,
        [assetId]
      );

      assert.strictEqual(outputRes.rows.length, 1);
      const output = outputRes.rows[0]!;
      assert.strictEqual(output.output_type, 'thumbnail');
      assert.strictEqual(output.logical_key, 'thumbnail_default');
      assert.strictEqual(output.version, 1);
      assert.strictEqual(output.is_current, true);
      assert.strictEqual(output.mime_type, 'image/jpeg');
      assert.strictEqual(output.width, 320);
      assert.strictEqual(output.height, 240);
      assert.ok(Number(output.file_size_bytes) > 0);
      assert.strictEqual(output.metadata.offset_seconds, 0.5);

      // Verify thumbnail file exists in storage
      const thumbDiskPath = storage.resolvePath(output.storage_key);
      assert.strictEqual(await storage.fileExists(thumbDiskPath), true);
    });

    it('retrying or regenerating thumbnail produces monotonically increasing version and keeps exactly one current output', async () => {
      const assetId = uuidv7();
      const jobId1 = uuidv7();
      const jobId2 = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'regen.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId1, testProjectId, assetId]
      );

      // Job 1 processes version 1
      const mockJob1 = {
        id: jobId1,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId: jobId1,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await processJob(mockJob1, pool, { storageService: storage });

      // Now create Job 2 for the same asset
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId2, testProjectId, assetId]
      );

      const mockJob2 = {
        id: jobId2,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId: jobId2,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await processJob(mockJob2, pool, { storageService: storage });

      // Verify outputs table has 2 versions, and only version 2 is is_current = true
      const outputsRes = await pool.query<{
        version: number;
        is_current: boolean;
      }>(
        `SELECT version, is_current FROM media_outputs WHERE media_asset_id = $1 ORDER BY version ASC;`,
        [assetId]
      );

      assert.strictEqual(outputsRes.rows.length, 2);
      assert.strictEqual(outputsRes.rows[0]?.version, 1);
      assert.strictEqual(outputsRes.rows[0]?.is_current, false);
      assert.strictEqual(outputsRes.rows[1]?.version, 2);
      assert.strictEqual(outputsRes.rows[1]?.is_current, true);
    });

    it('stale worker cannot commit thumbnail metadata or complete job after lease expires', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'stale_thumb.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      // Slow mock FFmpeg that delays until after 30ms lease expiration
      const slowMockFFmpeg = {
        extractThumbnail: async (input: string, output: string, seek: number) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new FFmpegService().extractThumbnail(input, output, seek);
        },
      } as unknown as FFmpegService;

      const mockJob = {
        id: jobId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            storageService: storage,
            ffmpegService: slowMockFFmpeg,
            leaseDurationMs: 30,
          });
        },
        /Worker lease expired or was revoked/
      );

      // Verify media_outputs has NO records committed
      const outputsRes = await pool.query(
        `SELECT id FROM media_outputs WHERE media_asset_id = $1;`,
        [assetId]
      );
      assert.strictEqual(outputsRes.rows.length, 0);

      // Verify job remained in processing (not completed)
      const jobRes = await pool.query<{ status: string }>(
        `SELECT status FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'processing');
    });

    it('records failed attempt when media file is corrupt', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/corrupt.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(CORRUPT_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'corrupt.mp4', 'video/mp4', 512, 512, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      const mockJob = {
        id: jobId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, { storageService: storage });
        },
        InvalidMediaError
      );

      // Verify attempt marked as failed
      const attemptRes = await pool.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');
      assert.strictEqual(attemptRes.rows[0]?.error_code, 'INVALID_MEDIA');
    });

    it('fails safely when input media file is missing from storage', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/missing.mp4`;

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'missing.mp4', 'video/mp4', 1000, 1000, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      const mockJob = {
        id: jobId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, { storageService: storage });
        },
        /Media file not found at storage path/
      );

      const attemptRes = await pool.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');
      assert.match(attemptRes.rows[0]?.error_message ?? '', /Media file not found/);
    });

    it('rolls back database records and unlinks storage file if transaction fails', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'tx_fail.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      // Mock FFmpeg that returns dimensions exceeding schema constraints (e.g. width negative or invalid)
      // Or mock FFmpeg output result with an oversized width
      const invalidDataFfmpeg = {
        extractThumbnail: async (input: string, output: string, seek: number) => {
          const res = await new FFmpegService().extractThumbnail(input, output, seek);
          return {
            ...res,
            width: 999999999999, // Exceeds PostgreSQL INTEGER max (overflows)
          };
        },
      } as unknown as FFmpegService;

      const mockJob = {
        id: jobId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            storageService: storage,
            ffmpegService: invalidDataFfmpeg,
          });
        },
        /out of range/
      );

      // 1. Verify media_outputs has NO records committed
      const outputsRes = await pool.query(
        `SELECT id FROM media_outputs WHERE media_asset_id = $1;`,
        [assetId]
      );
      assert.strictEqual(outputsRes.rows.length, 0);

      // 2. Verify committed file was cleaned up on rollback
      const thumbDir = storage.resolvePath(`media/${testProjectId}/${assetId}/thumbnails`);
      let thumbFiles: string[] = [];
      try {
        thumbFiles = await readdir(thumbDir);
      } catch {
        thumbFiles = [];
      }
      assert.strictEqual(thumbFiles.length, 0);

      // 3. Verify job status reset to queued for retry
      const jobRes = await pool.query<{ status: string }>(
        `SELECT status FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'queued');
    });

    it('stale worker rollback cannot delete newer output committed by another worker', async () => {
      const assetId = uuidv7();
      const job1Id = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'stale_test.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      // Create Job 1
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [job1Id, testProjectId, assetId]
      );

      // 1. Worker 1 claims Job 1
      const lease1 = uuidv7();
      await pool.query(
        `UPDATE processing_jobs
         SET status = 'processing',
             lease_token = $1,
             lease_expires_at = NOW() + INTERVAL '30 seconds',
             current_attempt_number = 1
         WHERE id = $2;`,
        [lease1, job1Id]
      );

      // Worker 1 creates its thumbnail file on disk (simulating its execution)
      const output1Id = uuidv7();
      const worker1StorageKey = `media/${testProjectId}/${assetId}/thumbnails/thumbnail_default_${output1Id}.jpg`;
      const temp1 = storage.createTempFilePath('thumb1');
      await new FFmpegService().extractThumbnail(VALID_SAMPLE_MP4, temp1, 0.1);
      await storage.commitFile(temp1, worker1StorageKey);
      assert.strictEqual(await storage.fileExists(worker1StorageKey), true);

      // 2. Worker 1's lease expires
      await pool.query(
        `UPDATE processing_jobs
         SET lease_expires_at = NOW() - INTERVAL '5 seconds'
         WHERE id = $1;`,
        [job1Id]
      );

      // 3. Worker 2 takes over Job 1 and successfully completes it
      const mockJob2 = {
        id: job1Id,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId: job1Id,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await processJob(mockJob2, pool, { storageService: storage });

      // Verify Worker 2 committed its output
      const worker2OutputRes = await pool.query<{ id: string; storage_key: string; is_current: boolean }>(
        `SELECT id, storage_key, is_current FROM media_outputs WHERE media_asset_id = $1 AND is_current = true;`,
        [assetId]
      );
      assert.strictEqual(worker2OutputRes.rows.length, 1);
      const worker2Output = worker2OutputRes.rows[0]!;
      assert.notStrictEqual(worker2Output.id, output1Id);
      assert.strictEqual(await storage.fileExists(worker2Output.storage_key), true);

      // 4. Now Worker 1 wakes up and attempts to commit its transaction with its expired leaseToken (lease1)
      const client1 = await pool.connect();
      let worker1RolledBack = false;
      try {
        await client1.query('BEGIN');
        await client1.query('SELECT id FROM media_assets WHERE id = $1 FOR UPDATE;', [assetId]);
        const res = await client1.query(
          `UPDATE processing_jobs
           SET status = 'completed'
           WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW()
           RETURNING id;`,
          [job1Id, lease1]
        );
        if (res.rowCount === 0) {
          throw new Error('Worker lease expired or was revoked');
        }
        await client1.query('COMMIT');
      } catch (err) {
        await client1.query('ROLLBACK').catch(() => {});
        worker1RolledBack = true;
        // Worker 1 executes its rollback cleanup of ITS OWN output key
        await storage.unlinkFile(worker1StorageKey).catch(() => {});
      } finally {
        client1.release();
      }

      assert.strictEqual(worker1RolledBack, true);

      // 5. Assertions:
      // Worker 1's file was unlinked
      assert.strictEqual(await storage.fileExists(worker1StorageKey), false);
      // CRITICAL: Worker 2's output file MUST STILL EXIST and NOT have been deleted by Worker 1
      assert.strictEqual(await storage.fileExists(worker2Output.storage_key), true);

      // Worker 2's DB record is still the valid current thumbnail
      const verifyRes = await pool.query<{ id: string; is_current: boolean }>(
        `SELECT id, is_current FROM media_outputs WHERE id = $1;`,
        [worker2Output.id]
      );
      assert.strictEqual(verifyRes.rows[0]?.is_current, true);
    });

    it('concurrent workers safely serialize output version allocation without unique constraint conflicts', async () => {
      const assetId = uuidv7();
      const jobAId = uuidv7();
      const jobBId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'concurrent.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES
           ($1, $3, $4, 'generate_thumbnail', '{}'::jsonb, 'queued', 0),
           ($2, $3, $4, 'generate_thumbnail', '{}'::jsonb, 'queued', 0);`,
        [jobAId, jobBId, testProjectId, assetId]
      );

      const jobA = {
        id: jobAId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId: jobAId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      const jobB = {
        id: jobBId,
        name: GENERATE_THUMBNAIL_JOB,
        data: {
          jobId: jobBId,
          projectId: testProjectId,
          mediaAssetId: assetId,
          operation: 'generate_thumbnail',
        } as ProcessingJobPayload,
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      // Run both jobs concurrently
      const results = await Promise.allSettled([
        processJob(jobA, pool, { storageService: storage }),
        processJob(jobB, pool, { storageService: storage }),
      ]);

      // Both must succeed cleanly
      assert.strictEqual(results[0]?.status, 'fulfilled');
      assert.strictEqual(results[1]?.status, 'fulfilled');

      // Check outputs in database
      const outputs = await pool.query<{ version: number; is_current: boolean; storage_key: string }>(
        `SELECT version, is_current, storage_key
         FROM media_outputs
         WHERE media_asset_id = $1 AND output_type = 'thumbnail'
         ORDER BY version ASC;`,
        [assetId]
      );

      assert.strictEqual(outputs.rows.length, 2);
      // Versions must be monotonically increasing (1 and 2)
      assert.strictEqual(outputs.rows[0]?.version, 1);
      assert.strictEqual(outputs.rows[0]?.is_current, false);
      assert.strictEqual(outputs.rows[1]?.version, 2);
      assert.strictEqual(outputs.rows[1]?.is_current, true);

      // Both output files exist on disk with separate immutable keys
      assert.strictEqual(await storage.fileExists(outputs.rows[0]!.storage_key), true);
      assert.strictEqual(await storage.fileExists(outputs.rows[1]!.storage_key), true);
      assert.notStrictEqual(outputs.rows[0]!.storage_key, outputs.rows[1]!.storage_key);
    });
  });

  describe('4. API Tests — Thumbnail Exposure & Retrieval', () => {
    let pool: Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    let apiKey: string;
    let otherApiKey: string;
    let projectId: string;
    let otherProjectId: string;
    let assetId: string;
    let storage: LocalStorageService;

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

      app = await buildApp({ logger: false });
      await app.ready();

      // Seed Account A and Project A
      const accountAId = uuidv7();
      projectId = uuidv7();
      await pool.query(`INSERT INTO accounts (id, email) VALUES ($1, $2);`, [
        accountAId,
        `api-a-${Date.now()}@test.com`,
      ]);
      await pool.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Project A');`, [
        projectId,
        accountAId,
      ]);

      const keyGenA = generateApiKey('lumen_live');
      apiKey = keyGenA.apiKey;
      await pool.query(
        `INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, 'Key A', $2, $3);`,
        [projectId, keyGenA.keyPrefix, keyGenA.hash]
      );

      // Seed Account B and Project B
      const accountBId = uuidv7();
      otherProjectId = uuidv7();
      await pool.query(`INSERT INTO accounts (id, email) VALUES ($1, $2);`, [
        accountBId,
        `api-b-${Date.now()}@test.com`,
      ]);
      await pool.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Project B');`, [
        otherProjectId,
        accountBId,
      ]);

      const keyGenB = generateApiKey('lumen_live');
      otherApiKey = keyGenB.apiKey;
      await pool.query(
        `INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, 'Key B', $2, $3);`,
        [otherProjectId, keyGenB.keyPrefix, keyGenB.hash]
      );

      // Seed media asset for Project A
      assetId = uuidv7();
      const storageKey = `media/${projectId}/${assetId}/original.mp4`;
      const thumbStorageKey = `media/${projectId}/${assetId}/thumbnails/thumbnail_default.jpg`;

      // Copy sample to destination
      const thumbDiskPath = storage.resolvePath(thumbStorageKey);
      await mkdir(resolve(thumbDiskPath, '..'), { recursive: true });
      await new FFmpegService().extractThumbnail(VALID_SAMPLE_MP4, thumbDiskPath, 0.1);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes,
           storage_key, duration_seconds, status
         ) VALUES ($1, $2, 'thumb_api.mp4', 'video/mp4', 48796, 48796, $3, 1.0, 'ready');`,
        [assetId, projectId, storageKey]
      );

      const jobId = uuidv7();
      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'generate_thumbnail', '{}'::jsonb, 'completed', 1);`,
        [jobId, projectId, assetId]
      );

      await pool.query(
        `INSERT INTO media_outputs (
           id, media_asset_id, processing_job_id, output_type, logical_key,
           version, is_current, storage_key, mime_type, file_size_bytes,
           width, height, metadata, created_at
         ) VALUES (
           $1, $2, $3, 'thumbnail', 'thumbnail_default',
           1, true, $4, 'image/jpeg', 6947,
           320, 240, '{"offset_seconds": 0.1}'::jsonb, NOW()
         );`,
        [uuidv7(), assetId, jobId, thumbStorageKey]
      );
    });

    after(async () => {
      await app.close();
      if (pool) {
        await pool.query(`DELETE FROM media_outputs WHERE media_asset_id = $1;`, [assetId]).catch(() => {});
        await pool.query(`DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id = $1);`, [projectId]).catch(() => {});
        await pool.query(`DELETE FROM processing_jobs WHERE project_id = $1;`, [projectId]).catch(() => {});
        await pool.query(`DELETE FROM media_assets WHERE project_id = $1;`, [projectId]).catch(() => {});
        await pool.query(`DELETE FROM api_keys WHERE project_id IN ($1, $2);`, [projectId, otherProjectId]).catch(() => {});
        await pool.query(`DELETE FROM projects WHERE id IN ($1, $2);`, [projectId, otherProjectId]).catch(() => {});
        await pool.end();
      }
      await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    });

    it('GET /v1/media/:id returns thumbnail metadata when thumbnail is ready', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/media/${assetId}`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.id, assetId);
      assert.ok(body.thumbnail);
      assert.strictEqual(body.thumbnail.status, 'ready');
      assert.strictEqual(body.thumbnail.mime_type, 'image/jpeg');
      assert.strictEqual(body.thumbnail.width, 320);
      assert.strictEqual(body.thumbnail.height, 240);
      assert.strictEqual(body.thumbnail.file_size_bytes, 6947);
      assert.strictEqual(body.thumbnail.url, `/v1/media/${assetId}/thumbnail`);
      // Ensure internal storage_key is NOT leaked
      assert.strictEqual(body.thumbnail.storage_key, undefined);
    });

    it('GET /v1/media/:id/thumbnail successfully streams the thumbnail image with correct headers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/media/${assetId}/thumbnail`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.headers['content-type'], 'image/jpeg');
      assert.strictEqual(response.headers['cache-control'], 'private, max-age=86400');
      assert.ok(response.rawPayload.length > 1000);
      // Valid JPEG magic bytes
      assert.strictEqual(response.rawPayload[0], 0xff);
      assert.strictEqual(response.rawPayload[1], 0xd8);
    });

    it('GET /v1/media/:id/thumbnail rejects unauthenticated requests with 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/media/${assetId}/thumbnail`,
      });

      assert.strictEqual(response.statusCode, 401);
    });

    it('GET /v1/media/:id/thumbnail enforces tenant isolation and returns 404 for unauthorized project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/media/${assetId}/thumbnail`,
        headers: {
          Authorization: `Bearer ${otherApiKey}`, // Project B attempting to access Project A's thumbnail
        },
      });

      assert.strictEqual(response.statusCode, 404);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.error, 'thumbnail_not_found');
    });

    it('GET /v1/media/:id/thumbnail returns 404 for non-existent asset', async () => {
      const nonExistentId = uuidv7();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/media/${nonExistentId}/thumbnail`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      assert.strictEqual(response.statusCode, 404);
    });
  });
});
