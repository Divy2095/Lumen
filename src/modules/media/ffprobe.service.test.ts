import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { type Job } from 'bullmq';
import {
  FFprobeService,
  FFprobeError,
  FFprobeTimeoutError,
  FFprobeOutputLimitError,
  InvalidMediaError,
  parseFrameRate,
  parseDuration,
} from './ffprobe.service.js';
import { processJob } from '../../workers/processor.js';
import {
  EXTRACT_METADATA_JOB,
  type LumenJobPayload,
  type LumenJobResult,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from '../../workers/queue.js';
import { LocalStorageService } from '../../shared/storage/local-storage.service.js';
import { assertTestDatabase } from '../../test/db-guard.js';

const FIXTURES_DIR = resolve('src/test/fixtures');
const VALID_SAMPLE_MP4 = resolve(FIXTURES_DIR, 'valid_sample.mp4');
const AUDIO_ONLY_MP4 = resolve(FIXTURES_DIR, 'audio_only.mp4');
const CORRUPT_MP4 = resolve(FIXTURES_DIR, 'corrupt.mp4');
const TEST_STORAGE_DIR = resolve('storage_ffprobe_test');

describe('FFprobe Metadata Extraction Suite', () => {
  describe('1. Unit Tests — Helper Functions', () => {
    it('parseFrameRate correctly parses fractional rates', () => {
      assert.strictEqual(parseFrameRate('24/1'), 24);
      assert.strictEqual(parseFrameRate('30000/1001'), 29.97);
      assert.strictEqual(parseFrameRate('60/1'), 60);
    });

    it('parseFrameRate falls back to avg_frame_rate or decimal strings', () => {
      assert.strictEqual(parseFrameRate('0/0', '25/1'), 25);
      assert.strictEqual(parseFrameRate('29.97'), 29.97);
      assert.strictEqual(parseFrameRate(undefined, undefined), 0);
      assert.strictEqual(parseFrameRate('invalid', 'rate'), 0);
    });

    it('parseDuration correctly parses duration strings', () => {
      assert.strictEqual(parseDuration('10.500000'), 10.5);
      assert.strictEqual(parseDuration(undefined, '5.123456'), 5.123);
    });

    it('parseDuration throws InvalidMediaError on invalid duration', () => {
      assert.throws(() => parseDuration('0.000000'), InvalidMediaError);
      assert.throws(() => parseDuration(undefined, undefined), InvalidMediaError);
      assert.throws(() => parseDuration('-5'), InvalidMediaError);
    });
  });

  describe('2. Unit Tests — FFprobeService Execution & Validation', () => {
    const service = new FFprobeService();

    it('successfully extracts metadata from valid MP4 fixture', async () => {
      const metadata = await service.probe(VALID_SAMPLE_MP4);

      assert.strictEqual(typeof metadata.containerFormat, 'string');
      assert.ok(metadata.containerFormat.includes('mp4') || metadata.containerFormat.includes('mov'));
      assert.strictEqual(metadata.durationSeconds, 1);
      assert.strictEqual(metadata.video.codec, 'mpeg4');
      assert.strictEqual(metadata.video.width, 320);
      assert.strictEqual(metadata.video.height, 240);
      assert.strictEqual(metadata.video.frameRate, 24);
      assert.strictEqual(metadata.video.pixelFormat, 'yuv420p');

      // Audio stream is present
      assert.ok(metadata.audio);
      assert.strictEqual(metadata.audio?.codec, 'aac');
      assert.strictEqual(metadata.audio?.sampleRate, 44100);
      assert.strictEqual(metadata.audio?.channels, 1);

      // JSONB metadata is prepared
      assert.ok(metadata.rawMetadata);
      assert.strictEqual(metadata.rawMetadata?.format_name, metadata.containerFormat);
      assert.strictEqual(metadata.rawMetadata?.video.codec, 'mpeg4');
    });

    it('rejects corrupt MP4 fixture with InvalidMediaError', async () => {
      await assert.rejects(
        async () => await service.probe(CORRUPT_MP4),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          assert.strictEqual(err.code, 'INVALID_MEDIA');
          return true;
        }
      );
    });

    it('rejects audio-only MP4 fixture with InvalidMediaError (no video stream)', async () => {
      await assert.rejects(
        async () => await service.probe(AUDIO_ONLY_MP4),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          assert.match(err.message, /media file contains no video stream/i);
          return true;
        }
      );
    });

    it('rejects non-existent file path with InvalidMediaError (non-zero exit code)', async () => {
      const nonExistentPath = resolve(FIXTURES_DIR, 'does_not_exist.mp4');
      await assert.rejects(
        async () => await service.probe(nonExistentPath),
        (err: any) => {
          assert.ok(err instanceof InvalidMediaError);
          // Ensures internal file path is sanitized in error message
          assert.ok(!err.message.includes(nonExistentPath));
          assert.ok(err.message.includes('[media-file]'));
          return true;
        }
      );
    });

    it('rejects when FFprobe executable is unavailable (ENOENT)', async () => {
      const badService = new FFprobeService({
        ffprobePath: '/usr/bin/nonexistent_ffprobe_executable_binary',
      });

      await assert.rejects(
        async () => await badService.probe(VALID_SAMPLE_MP4),
        (err: any) => {
          assert.ok(err instanceof FFprobeError);
          assert.strictEqual(err.code, 'ENOENT');
          return true;
        }
      );
    });

    it('rejects with FFprobeTimeoutError when execution exceeds timeout', async () => {
      const slowService = new FFprobeService({
        timeoutMs: 1, // 1ms timeout triggers timeout immediately
      });

      await assert.rejects(
        async () => await slowService.probe(VALID_SAMPLE_MP4),
        (err: any) => {
          assert.ok(err instanceof FFprobeTimeoutError);
          assert.strictEqual(err.code, 'TIMEOUT');
          return true;
        }
      );
    });

    it('rejects with FFprobeOutputLimitError when output exceeds buffer size limit', async () => {
      const smallBufferService = new FFprobeService({
        maxBufferBytes: 50, // 50 bytes output limit will be exceeded by json output
      });

      await assert.rejects(
        async () => await smallBufferService.probe(VALID_SAMPLE_MP4),
        (err: any) => {
          assert.ok(err instanceof FFprobeOutputLimitError);
          assert.strictEqual(err.code, 'BUFFER_LIMIT_EXCEEDED');
          return true;
        }
      );
    });

    it('parseMetadata rejects malformed JSON output', () => {
      assert.throws(
        () => service.parseMetadata('not-json-output'),
        /Malformed FFprobe output: output is not valid JSON/
      );
    });

    it('parseMetadata rejects missing format or streams structure', () => {
      assert.throws(
        () => service.parseMetadata(JSON.stringify({ format: {} })),
        /missing format or streams array/
      );
    });

    it('parseMetadata rejects video with invalid dimensions', () => {
      const badDimensionsJson = JSON.stringify({
        format: { format_name: 'mov,mp4', duration: '1.0' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: -10,
            height: 0,
            r_frame_rate: '24/1',
          },
        ],
      });

      assert.throws(
        () => service.parseMetadata(badDimensionsJson),
        /Invalid video width/
      );
    });
  });

  describe('3. Integration Tests — Worker & PostgreSQL Metadata Persistence', () => {
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

      // Initialize test storage directory
      storage = new LocalStorageService(TEST_STORAGE_DIR);
      await storage.init();

      // Seed account and project
      testAccountId = uuidv7();
      testProjectId = uuidv7();

      await pool.query(
        `INSERT INTO accounts (id, email) VALUES ($1, $2);`,
        [testAccountId, `metadata-${Date.now()}@test.com`]
      );
      await pool.query(
        `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Metadata Project');`,
        [testProjectId, testAccountId]
      );
    });

    after(async () => {
      if (pool) {
        // Clean up created test data with referential integrity ordering
        await pool.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id = $1);', [testProjectId]).catch(() => {});
        await pool.query('DELETE FROM processing_jobs WHERE project_id = $1;', [testProjectId]).catch(() => {});
        await pool.query('DELETE FROM media_assets WHERE project_id = $1;', [testProjectId]).catch(() => {});
        await pool.query('DELETE FROM projects WHERE id = $1;', [testProjectId]).catch(() => {});
        await pool.query('DELETE FROM accounts WHERE id = $1;', [testAccountId]).catch(() => {});
        await pool.end();
      }
      await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    });

    it('worker successfully extracts and persists metadata in media_assets', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      // Copy fixture into storage path
      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      // Create ready media asset
      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'sample.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      // Create queued processing job
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

      const result = (await processJob(mockJob, pool, {
        storageService: storage,
      })) as ProcessingJobResult;

      assert.strictEqual(result.status, 'completed');

      // Verify processing_jobs row
      const jobRes = await pool.query<{
        status: string;
        lease_token: string | null;
        lease_expires_at: Date | null;
        completed_at: Date | null;
      }>(
        `SELECT status, lease_token, lease_expires_at, completed_at
         FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'completed');
      assert.strictEqual(jobRes.rows[0]?.lease_token, null);
      assert.strictEqual(jobRes.rows[0]?.lease_expires_at, null);
      assert.ok(jobRes.rows[0]?.completed_at);

      // Verify job_attempts row
      const attemptRes = await pool.query<{
        status: string;
        attempt_number: number;
        completed_at: Date | null;
      }>(
        `SELECT status, attempt_number, completed_at
         FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'completed');
      assert.strictEqual(attemptRes.rows[0]?.attempt_number, 1);
      assert.ok(attemptRes.rows[0]?.completed_at);

      // Verify media_assets metadata columns and JSONB
      const assetRes = await pool.query<{
        duration_seconds: string;
        width: number;
        height: number;
        video_codec: string;
        audio_codec: string;
        bitrate: string;
        frame_rate: string;
        metadata: any;
      }>(
        `SELECT duration_seconds, width, height, video_codec, audio_codec, bitrate, frame_rate, metadata
         FROM media_assets WHERE id = $1;`,
        [assetId]
      );

      const saved = assetRes.rows[0]!;
      assert.strictEqual(Number(saved.duration_seconds), 1.0);
      assert.strictEqual(saved.width, 320);
      assert.strictEqual(saved.height, 240);
      assert.strictEqual(saved.video_codec, 'mpeg4');
      assert.strictEqual(saved.audio_codec, 'aac');
      assert.ok(Number(saved.bitrate) > 0);
      assert.strictEqual(Number(saved.frame_rate), 24.0);

      assert.strictEqual(saved.metadata.video.codec, 'mpeg4');
      assert.strictEqual(saved.metadata.audio.codec, 'aac');
      assert.ok(saved.metadata.probed_at);
    });

    it('stale worker cannot persist metadata after lease expiration', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'stale_test.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      // Create a mock FFprobe service that delays until after lease expires
      const slowMockFFprobe = {
        probe: async () => {
          // Wait 60ms to let 30ms lease expire
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new FFprobeService().probe(VALID_SAMPLE_MP4);
        },
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

      // Attempt execution with 30ms lease
      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            storageService: storage,
            ffprobeService: slowMockFFprobe,
            leaseDurationMs: 30,
          });
        },
        /Worker lease expired or was revoked/
      );

      // Verify that media_assets was NOT updated
      const assetRes = await pool.query<{
        duration_seconds: string | null;
        width: number | null;
      }>(
        `SELECT duration_seconds, width FROM media_assets WHERE id = $1;`,
        [assetId]
      );
      assert.strictEqual(assetRes.rows[0]?.duration_seconds, null);
      assert.strictEqual(assetRes.rows[0]?.width, null);
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
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'corrupt.mp4', 'video/mp4', 512, 512, $3, 'ready');`,
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

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            storageService: storage,
          });
        },
        InvalidMediaError
      );

      // Verify attempt recorded as failed
      const attemptRes = await pool.query<{
        status: string;
        error_code: string;
        error_message: string;
      }>(
        `SELECT status, error_code, error_message FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');
      assert.strictEqual(attemptRes.rows[0]?.error_code, 'INVALID_MEDIA');
      assert.ok(attemptRes.rows[0]?.error_message);
    });

    it('fails safely when storage file is missing', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/missing.mp4`;

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'missing.mp4', 'video/mp4', 1000, 1000, $3, 'ready');`,
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

      await assert.rejects(
        async () => {
          await processJob(mockJob, pool, {
            storageService: storage,
          });
        },
        /Media file not found at storage path/
      );

      // Verify attempt marked as failed
      const attemptRes = await pool.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');
      assert.match(attemptRes.rows[0]?.error_message ?? '', /Media file not found at storage path/);
    });

    it('rolls back transaction and records attempt failure when database persistence fails', async () => {
      const assetId = uuidv7();
      const jobId = uuidv7();
      const storageKey = `media/${testProjectId}/${assetId}/original.mp4`;

      const destPath = storage.resolvePath(storageKey);
      await mkdir(resolve(destPath, '..'), { recursive: true });
      await copyFile(VALID_SAMPLE_MP4, destPath);

      await pool.query(
        `INSERT INTO media_assets (
           id, project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key, status
         ) VALUES ($1, $2, 'persistence_fail.mp4', 'video/mp4', 48796, 48796, $3, 'ready');`,
        [assetId, testProjectId, storageKey]
      );

      await pool.query(
        `INSERT INTO processing_jobs (
           id, project_id, media_asset_id, operation, parameters, status, current_attempt_number
         ) VALUES ($1, $2, $3, 'extract_metadata', '{}'::jsonb, 'queued', 0);`,
        [jobId, testProjectId, assetId]
      );

      // Create a mock FFprobe service that produces a frameRate exceeding PostgreSQL NUMERIC(6,2) constraint
      const invalidDataProbeService = {
        probe: async () => {
          const valid = await new FFprobeService().probe(VALID_SAMPLE_MP4);
          return {
            ...valid,
            video: {
              ...valid.video,
              frameRate: 99999.99, // Exceeds NUMERIC(6,2) max 9999.99
            },
          };
        },
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
            ffprobeService: invalidDataProbeService,
          });
        },
        /numeric field overflow/
      );

      // 1. Verify media_assets was NOT updated (rolled back)
      const assetRes = await pool.query<{ duration_seconds: string | null }>(
        `SELECT duration_seconds FROM media_assets WHERE id = $1;`,
        [assetId]
      );
      assert.strictEqual(assetRes.rows[0]?.duration_seconds, null);

      // 2. Verify processing_jobs was NOT completed (remains queued for retry)
      const jobRes = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM processing_jobs WHERE id = $1;`,
        [jobId]
      );
      assert.strictEqual(jobRes.rows[0]?.status, 'queued');
      assert.strictEqual(jobRes.rows[0]?.completed_at, null);

      // 3. Verify job_attempts recorded attempt failure
      const attemptRes = await pool.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM job_attempts WHERE job_id = $1;`,
        [jobId]
      );
      assert.strictEqual(attemptRes.rows[0]?.status, 'failed');
      assert.match(attemptRes.rows[0]?.error_message ?? '', /numeric field overflow/);
    });
  });
});
