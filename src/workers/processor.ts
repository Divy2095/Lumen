import { type Job } from 'bullmq';
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';
import { JobLease, RetryProcessingError } from './job-lease.js';
import { integerInRange, MAX_TIMER_MS } from '../config/media-processing.js';
import {
  TEST_JOB_NAME,
  EXTRACT_METADATA_JOB,
  GENERATE_THUMBNAIL_JOB,
  TRANSCODE_JOB,
  PROCESSING_JOB_NAME,
  type LumenJobPayload,
  type LumenJobResult,
  type TestJobPayload,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from './queue.js';
import { defaultFFprobeService, type FFprobeService } from '../modules/media/ffprobe.service.js';
import {
  defaultFFmpegService,
  calculateThumbnailTimestamp,
  type FFmpegService,
} from '../modules/media/ffmpeg.service.js';
import { defaultStorageService, type StorageService } from '../shared/storage/local-storage.service.js';
import {
  resolveTranscodingProfiles,
  type TranscodingConfig,
  type TranscodingProfileName,
} from '../modules/media/transcoding-profiles.js';
import {
  defaultTranscodingService,
  type TranscodingService,
} from '../modules/media/transcoding.service.js';

export interface ProcessJobOptions {
  signal?: AbortSignal | undefined;
  workerId?: string | undefined;
  leaseDurationMs?: number | undefined;
  ffprobeService?: FFprobeService | undefined;
  ffmpegService?: FFmpegService | undefined;
  transcodingService?: TranscodingService | undefined;
  storageService?: StorageService | undefined;
  onBeforeCompletionCommit?: ((client: PoolClient) => Promise<void>) | undefined;
}

/**
 * Processes background jobs dispatched to the media processing worker.
 * Supports typed test jobs and PostgreSQL-backed media processing jobs dispatched via Outbox.
 *
 * Implements atomic job claiming, worker fencing tokens, and idempotent execution.
 */
export async function processJob(
  job: Job<LumenJobPayload, LumenJobResult>,
  db?: Pool,
  options: ProcessJobOptions = {}
): Promise<LumenJobResult> {
  const startTime = Date.now();

  switch (job.name) {
    case TEST_JOB_NAME: {
      const data = job.data as TestJobPayload;
      if (data.fail) {
        throw new Error(`Job ${job.id} forced failure: ${data.message}`);
      }

      // Small async pause (50ms) to simulate background processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      const durationMs = Date.now() - startTime;
      return {
        receivedMessage: data.message,
        processedAt: new Date().toISOString(),
        durationMs,
      };
    }

    case EXTRACT_METADATA_JOB:
    case GENERATE_THUMBNAIL_JOB:
    case TRANSCODE_JOB:
    case PROCESSING_JOB_NAME: {
      const data = job.data as ProcessingJobPayload;

      // 1. Validate payload structure
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid processing job payload: payload must be an object`);
      }
      if (!data.jobId || !data.projectId || !data.mediaAssetId || !data.operation) {
        throw new Error(
          `Invalid processing job payload: missing required fields (jobId, projectId, mediaAssetId, operation)`
        );
      }

      // 2. Database integration: atomic claim, fencing, and idempotency
      if (db) {
        const leaseToken = uuidv7();
        const workerId = options.workerId ?? `worker-${uuidv7().slice(0, 8)}`;
        const leaseDurationMs = options.leaseDurationMs ?? 60000;
        integerInRange('leaseDurationMs', leaseDurationMs, 1, MAX_TIMER_MS);
        const claimStartedAt = performance.now();

        // Atomically claim the job. Only succeeds if:
        // - status is 'queued' (and attempt ceiling not reached), OR
        // - status is 'processing' with an EXPIRED lease (< NOW()) and attempts < 3 (crash recovery)
        const claimQuery = `
          UPDATE processing_jobs
          SET status = 'processing',
              locked_by = $2,
              lease_token = $3,
              lease_expires_at = NOW() + ($4 || ' milliseconds')::interval,
              current_attempt_number = current_attempt_number + 1,
              started_at = COALESCE(started_at, NOW())
          WHERE id = $1
            AND project_id = $5
            AND (
              (status = 'queued' AND current_attempt_number < 3)
              OR (status = 'processing' AND lease_expires_at < NOW() AND current_attempt_number < 3)
            )
          RETURNING id, project_id, media_asset_id, operation, status, current_attempt_number, lease_token;
        `;

        const claimResult = await db.query<{
          id: string;
          project_id: string;
          media_asset_id: string;
          operation: string;
          status: string;
          current_attempt_number: number;
          lease_token: string;
        }>(claimQuery, [
          data.jobId,
          workerId,
          leaseToken,
          leaseDurationMs,
          data.projectId,
        ]);

        if (claimResult.rowCount === 0) {
          // Claim failed. Inspect current state for safe idempotent handling
          const inspectQuery = `
            SELECT id, status, current_attempt_number, lease_expires_at
            FROM processing_jobs
            WHERE id = $1 AND project_id = $2;
          `;
          const inspectRes = await db.query<{
            id: string;
            status: string;
            current_attempt_number: number;
            lease_expires_at: Date | null;
          }>(inspectQuery, [data.jobId, data.projectId]);

          const existing = inspectRes.rows[0];
          if (!existing) {
            throw new Error(
              `Processing job "${data.jobId}" for project "${data.projectId}" not found in database`
            );
          }

          if (existing.status === 'completed') {
            return {
              jobId: data.jobId,
              mediaAssetId: data.mediaAssetId,
              operation: data.operation,
              status: 'already_completed',
              durationMs: Date.now() - startTime,
            };
          }

          // Reap only an exhausted, unowned job. A renewed or reclaimed row must not be acknowledged.
          if (existing.current_attempt_number >= 3) {
            const reaped = await db.query(
              `UPDATE processing_jobs
               SET status = 'failed', lease_expires_at = NULL, locked_by = NULL,
                   lease_token = NULL, completed_at = clock_timestamp()
               WHERE id = $1 AND project_id = $2 AND current_attempt_number >= 3
                 AND (status = 'queued' OR (status = 'processing' AND lease_expires_at < clock_timestamp()))
               RETURNING id;`,
              [data.jobId, data.projectId]
            );
            if (reaped.rowCount === 1) {
              return { jobId: data.jobId, mediaAssetId: data.mediaAssetId,
                operation: data.operation, status: 'failed', durationMs: Date.now() - startTime };
            }
          }

          if (existing.status === 'cancelled') {
            return {
              jobId: data.jobId,
              mediaAssetId: data.mediaAssetId,
              operation: data.operation,
              status: 'cancelled',
              durationMs: Date.now() - startTime,
            };
          }

          if (existing.status === 'failed') {
            return {
              jobId: data.jobId,
              mediaAssetId: data.mediaAssetId,
              operation: data.operation,
              status: 'failed',
              durationMs: Date.now() - startTime,
            };
          }

          throw new RetryProcessingError();
        }

        const claimedJob = claimResult.rows[0]!;

        const lease = data.operation === 'transcode'
          ? new JobLease(db, data.jobId, leaseToken, leaseDurationMs, claimStartedAt, options.signal)
          : undefined;

        try {
          lease?.assertOwned();
          // 3. Record attempt in job_attempts with fencing token
          const attemptId = uuidv7();
          await db.query(
            `INSERT INTO job_attempts (
               id, job_id, attempt_number, status, fencing_token, started_at
             ) VALUES ($1, $2, $3, 'processing', $4, NOW());`,
            [attemptId, claimedJob.id, claimedJob.current_attempt_number, leaseToken]
          );

          if (data.operation === 'extract_metadata') {
            // Real FFprobe execution
            const assetRes = await db.query<{
              id: string;
              project_id: string;
              storage_key: string;
              status: string;
              transcoding_config: TranscodingConfig | null;
            }>(
              `SELECT id, project_id, storage_key, status, transcoding_config
               FROM media_assets
               WHERE id = $1 AND project_id = $2;`,
              [data.mediaAssetId, data.projectId]
            );

            const asset = assetRes.rows[0];
            if (!asset) {
              throw new Error(`Media asset "${data.mediaAssetId}" not found for project "${data.projectId}"`);
            }

            const storage = options.storageService ?? defaultStorageService;
            const filePath = storage.resolvePath(asset.storage_key);
            const exists = await storage.fileExists(filePath);
            if (!exists) {
              throw new Error(`Media file not found at storage path for asset "${data.mediaAssetId}"`);
            }

            const ffprobe = options.ffprobeService ?? defaultFFprobeService;
            const metadata = await ffprobe.probe(filePath);

            // Resolve requested transcoding profiles using the corrected resolver
            const profileResolution = resolveTranscodingProfiles({
              source: {
                width: metadata.video.width,
                height: metadata.video.height,
                rotation: metadata.video.rotation,
              },
              config: asset.transcoding_config ?? undefined,
            });

            // Commit metadata, transcoding rendition jobs, outbox events, skipped profiles,
            // and complete extract_metadata job in one atomic transaction guarded by fencing token and unexpired lease.
            // Strict lock hierarchy: media_assets FOR UPDATE -> processing_jobs FOR UPDATE -> child tables.
            const client = await db.connect();
            try {
              await client.query('BEGIN');

              // 1. Lock media_assets to serialize concurrent modifications for this media asset
              await client.query(
                `SELECT id FROM media_assets WHERE id = $1 FOR UPDATE;`,
                [data.mediaAssetId]
              );

              // 2. Validate lease ownership and lock the processing job row at transaction start
              const lockJobRes = await client.query<{ id: string }>(
                `SELECT id FROM processing_jobs
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 FOR UPDATE;`,
                [data.jobId, leaseToken]
              );

              if (!lockJobRes.rowCount || lockJobRes.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion transaction could begin`
                );
              }

              // 3. Persist metadata and skipped-profile outcomes to media_assets
              const transcodingSummary = {
                mode: profileResolution.mode,
                eligible: profileResolution.eligible.map((e) => ({
                  profile: e.profile,
                  targetWidth: e.targetWidth,
                  targetHeight: e.targetHeight,
                  scaleFactor: e.scaleFactor,
                  bitrateKbps: e.bitrateKbps,
                })),
                skipped: profileResolution.skipped,
              };

              await client.query(
                `UPDATE media_assets
                 SET duration_seconds = $2,
                     width = $3,
                     height = $4,
                     video_codec = $5,
                     audio_codec = $6,
                     bitrate = $7,
                     frame_rate = $8,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
                     updated_at = NOW()
                 WHERE id = $1 AND project_id = $10;`,
                [
                  data.mediaAssetId,
                  metadata.durationSeconds,
                  metadata.video.width,
                  metadata.video.height,
                  metadata.video.codec,
                  metadata.audio ? metadata.audio.codec : null,
                  metadata.bitrate,
                  metadata.video.frameRate,
                  JSON.stringify({
                    ...(metadata.rawMetadata ?? {}),
                    transcoding: transcodingSummary,
                    skipped_profiles: profileResolution.skipped,
                  }),
                  data.projectId,
                ]
              );

              // 4. Query existing transcode jobs for this asset to ensure idempotency against retries
              const existingJobsRes = await client.query<{ profile: string }>(
                `SELECT parameters->>'profile' AS profile
                 FROM processing_jobs
                 WHERE media_asset_id = $1 AND operation = 'transcode';`,
                [data.mediaAssetId]
              );
              const existingProfiles = new Set(existingJobsRes.rows.map((r) => r.profile));

              // 5. Create processing_jobs and outbox_events for every eligible rendition
              if (profileResolution.mode !== 'disabled') {
                for (const el of profileResolution.eligible) {
                  if (existingProfiles.has(el.profile)) {
                    continue; // Idempotent: already scheduled, do not duplicate
                  }

                  const renditionJobId = uuidv7();
                  const jobParams = {
                    profile: el.profile,
                    targetWidth: el.targetWidth,
                    targetHeight: el.targetHeight,
                    bitrateKbps: el.bitrateKbps,
                  };

                  await client.query(
                    `INSERT INTO processing_jobs (
                       id,
                       project_id,
                       media_asset_id,
                       operation,
                       parameters,
                       status,
                       current_attempt_number,
                       created_at
                     )
                     VALUES ($1, $2, $3, 'transcode', $4, 'queued', 0, NOW());`,
                    [renditionJobId, data.projectId, data.mediaAssetId, JSON.stringify(jobParams)]
                  );

                  const outboxEventId = uuidv7();
                  const outboxPayload = {
                    jobId: renditionJobId,
                    projectId: data.projectId,
                    mediaAssetId: data.mediaAssetId,
                    operation: 'transcode',
                    parameters: jobParams,
                  };

                  await client.query(
                    `INSERT INTO outbox_events (
                       id,
                       aggregate_type,
                       aggregate_id,
                       event_type,
                       payload,
                       created_at
                     )
                     VALUES ($1, 'processing_job', $2, 'processing_job.created', $3, NOW());`,
                    [outboxEventId, renditionJobId, JSON.stringify(outboxPayload)]
                  );
                }
              }

              // Optional test hook before final state transition
              if (options.onBeforeCompletionCommit) {
                await options.onBeforeCompletionCommit(client);
              }

              // 6. FINAL STATE TRANSITION: Guarded completion update on processing_jobs
              // Re-verifies fencing token AND verifies unexpired lease at the exact moment of completion using clock_timestamp()
              const completeJobResult = await client.query(
                `UPDATE processing_jobs
                 SET status = 'completed',
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     locked_by = NULL,
                     completed_at = clock_timestamp()
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 RETURNING id;`,
                [data.jobId, leaseToken]
              );

              if (!completeJobResult.rowCount || completeJobResult.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion could be committed`
                );
              }

              // 7. Complete attempt record
              await client.query(
                `UPDATE job_attempts
                 SET status = 'completed',
                     completed_at = clock_timestamp()
                 WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
                [data.jobId, claimedJob.current_attempt_number, leaseToken]
              );

              await client.query('COMMIT');
            } catch (txErr) {
              await client.query('ROLLBACK').catch(() => {});
              throw txErr;
            } finally {
              client.release();
            }
          } else if (data.operation === 'generate_thumbnail') {
            // Real FFmpeg thumbnail generation
            const assetRes = await db.query<{
              id: string;
              project_id: string;
              storage_key: string;
              duration_seconds: string | null;
              status: string;
            }>(
              `SELECT id, project_id, storage_key, duration_seconds, status
               FROM media_assets
               WHERE id = $1 AND project_id = $2;`,
              [data.mediaAssetId, data.projectId]
            );

            const asset = assetRes.rows[0];
            if (!asset) {
              throw new Error(`Media asset "${data.mediaAssetId}" not found for project "${data.projectId}"`);
            }

            const storage = options.storageService ?? defaultStorageService;
            const inputFilePath = storage.resolvePath(asset.storage_key);
            const exists = await storage.fileExists(inputFilePath);
            if (!exists) {
              throw new Error(`Media file not found at storage path for asset "${data.mediaAssetId}"`);
            }

            // Derive duration from trusted database column or fallback to probing
            let durationSeconds = asset.duration_seconds ? parseFloat(asset.duration_seconds) : null;
            if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
              try {
                const ffprobe = options.ffprobeService ?? defaultFFprobeService;
                const probeRes = await ffprobe.probe(inputFilePath);
                durationSeconds = probeRes.durationSeconds;
              } catch {
                durationSeconds = 1.0;
              }
            }

            const requestedOffset =
              data.parameters && typeof data.parameters['offset_seconds'] === 'number'
                ? (data.parameters['offset_seconds'] as number)
                : undefined;
            const seekSeconds = calculateThumbnailTimestamp(durationSeconds, requestedOffset);

            const tempThumbnailPath = storage.createTempFilePath('thumb');
            const ffmpeg = options.ffmpegService ?? defaultFFmpegService;
            const thumbResult = await ffmpeg.extractThumbnail(inputFilePath, tempThumbnailPath, seekSeconds);

            const logicalKey = 'thumbnail_default';
            const outputId = uuidv7();
            const thumbnailStorageKey = `media/${data.projectId}/${data.mediaAssetId}/thumbnails/${logicalKey}_${outputId}.jpg`;

            // Atomically place thumbnail in storage destination
            await storage.commitFile(tempThumbnailPath, thumbnailStorageKey);

            // Commit output record and complete job in an atomic transaction guarded by fencing token and unexpired lease
            const client = await db.connect();
            let commitCommitted = false;
            try {
              await client.query('BEGIN');

              // 1. Serialize version allocation and prevent concurrent conflicting inserts for this media asset
              await client.query(
                `SELECT id FROM media_assets WHERE id = $1 FOR UPDATE;`,
                [data.mediaAssetId]
              );

              // 2. Validate lease ownership and lock the processing job row at transaction start
              const lockJobRes = await client.query<{ id: string }>(
                `SELECT id FROM processing_jobs
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 FOR UPDATE;`,
                [data.jobId, leaseToken]
              );

              if (!lockJobRes.rowCount || lockJobRes.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion transaction could begin`
                );
              }

              // 3. Determine monotonic version for (media_asset_id, logical_key)
              const versionRes = await client.query<{ next_version: string }>(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                 FROM media_outputs
                 WHERE media_asset_id = $1 AND logical_key = $2;`,
                [data.mediaAssetId, logicalKey]
              );
              const nextVersion = parseInt(versionRes.rows[0]?.next_version ?? '1', 10);

              // 4. Demote existing current thumbnail outputs for this logical key
              await client.query(
                `UPDATE media_outputs
                 SET is_current = false
                 WHERE media_asset_id = $1 AND logical_key = $2 AND is_current = true;`,
                [data.mediaAssetId, logicalKey]
              );

              // 5. Insert new current thumbnail output
              await client.query(
                `INSERT INTO media_outputs (
                   id, media_asset_id, processing_job_id, output_type, logical_key,
                   version, is_current, storage_key, mime_type, file_size_bytes,
                   width, height, metadata, created_at
                 ) VALUES (
                   $1, $2, $3, 'thumbnail', $4,
                   $5, true, $6, $7, $8,
                   $9, $10, $11, NOW()
                 );`,
                [
                  outputId,
                  data.mediaAssetId,
                  data.jobId,
                  logicalKey,
                  nextVersion,
                  thumbnailStorageKey,
                  thumbResult.mimeType,
                  thumbResult.fileSizeBytes,
                  thumbResult.width,
                  thumbResult.height,
                  JSON.stringify({
                    offset_seconds: thumbResult.timestamp,
                    format: 'jpeg',
                  }),
                ]
              );

              // 6. Update media_assets metadata with thumbnail pointer
              await client.query(
                `UPDATE media_assets
                 SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('thumbnail_output_id', $2::text),
                     updated_at = NOW()
                 WHERE id = $1 AND project_id = $3;`,
                [data.mediaAssetId, outputId, data.projectId]
              );

              // Optional test hook before final state transition
              if (options.onBeforeCompletionCommit) {
                await options.onBeforeCompletionCommit(client);
              }

              // 7. FINAL STATE TRANSITION: Guarded completion update on processing_jobs
              const completeJobResult = await client.query(
                `UPDATE processing_jobs
                 SET status = 'completed',
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     locked_by = NULL,
                     completed_at = clock_timestamp()
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 RETURNING id;`,
                [data.jobId, leaseToken]
              );

              if (!completeJobResult.rowCount || completeJobResult.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion could be committed`
                );
              }

              // 8. Complete attempt record
              await client.query(
                `UPDATE job_attempts
                 SET status = 'completed',
                     completed_at = clock_timestamp()
                 WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
                [data.jobId, claimedJob.current_attempt_number, leaseToken]
              );

              await client.query('COMMIT');
              commitCommitted = true;
            } catch (txErr) {
              await client.query('ROLLBACK').catch(() => {});
              // If transaction failed or rolled back, clean up newly committed thumbnail file
              if (!commitCommitted) {
                await storage.unlinkFile(thumbnailStorageKey).catch(() => {});
              }
              throw txErr;
            } finally {
              client.release();
              // Ensure any leftover temp file is cleaned up
              await storage.unlinkFile(tempThumbnailPath).catch(() => {});
            }
          } else if (data.operation === 'transcode') {
            // Real FFmpeg video transcoding
            const rawParams = data.parameters;
            const params = typeof rawParams === 'string' ? JSON.parse(rawParams) : rawParams;
            const profile = params?.profile as TranscodingProfileName;
            const targetWidth = Number(params?.targetWidth);
            const targetHeight = Number(params?.targetHeight);
            const bitrateKbps = Number(params?.bitrateKbps);

            if (!profile || !targetWidth || !targetHeight || !bitrateKbps) {
              throw new Error(
                `Invalid transcode parameters for job "${data.jobId}": missing profile, targetWidth, targetHeight, or bitrateKbps`
              );
            }

            const assetRes = await db.query<{
              id: string;
              project_id: string;
              storage_key: string;
              status: string;
              audio_codec: string | null;
              metadata: any;
            }>(
              `SELECT id, project_id, storage_key, status, audio_codec, metadata
               FROM media_assets
               WHERE id = $1 AND project_id = $2;`,
              [data.mediaAssetId, data.projectId]
            );

            const asset = assetRes.rows[0];
            if (!asset) {
              throw new Error(`Media asset "${data.mediaAssetId}" not found for project "${data.projectId}"`);
            }

            const storage = options.storageService ?? defaultStorageService;
            const inputFilePath = storage.resolvePath(asset.storage_key);
            const exists = await storage.fileExists(inputFilePath);
            if (!exists) {
              throw new Error(`Media file not found at storage path for asset "${data.mediaAssetId}"`);
            }

            const logicalKey = `rendition_${profile}`;
            const outputId = uuidv7();
            const renditionStorageKey = `media/${data.projectId}/${data.mediaAssetId}/renditions/${logicalKey}_${outputId}.mp4`;
            const tempRenditionPath = storage.createTempFilePath(`transcode_${profile}`);

            let client: PoolClient | undefined;
            let published = false;
            let commitAttempted = false;
            let commitConfirmed = false;
            let transactionOpen = false;
            const assertOwnership = () => {
              lease?.assertOwned();
              if (options.signal?.aborted) throw new RetryProcessingError('Worker cancelled before rendition completion');
            };
            try {
              const transcoding = options.transcodingService ?? defaultTranscodingService;
              const transcodeResult = await transcoding.transcodeVideo({
                inputFilePath,
                outputFilePath: tempRenditionPath,
                targetWidth,
                targetHeight,
                bitrateKbps,
                // The service probes the source and enables audio only when it exists.
                hasAudio: true,
                profile,
                signal: lease?.signal,
              });
              lease?.assertOwned();

              // Refresh before the short, fenced completion transaction.
              await lease?.prepareCompletion();

              // Atomically place rendition in storage destination
              assertOwnership();
              await storage.commitFile(tempRenditionPath, renditionStorageKey);
              published = true;
              assertOwnership();

              // Commit output record and complete job in an atomic transaction guarded by fencing token and unexpired lease
              client = await db.connect();
              assertOwnership();
              transactionOpen = true;
              await client.query('BEGIN');

              // 1. Serialize version allocation and prevent concurrent conflicting inserts for this media asset
              await client.query(
                `SELECT id FROM media_assets WHERE id = $1 FOR UPDATE;`,
                [data.mediaAssetId]
              );

              // 2. Validate lease ownership and lock the processing job row at transaction start
              const lockJobRes = await client.query<{ id: string }>(
                `SELECT id FROM processing_jobs
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 FOR UPDATE;`,
                [data.jobId, leaseToken]
              );

              if (!lockJobRes.rowCount || lockJobRes.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion transaction could begin`
                );
              }

              // 3. Determine monotonic version for (media_asset_id, logical_key)
              const versionRes = await client.query<{ next_version: string }>(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                 FROM media_outputs
                 WHERE media_asset_id = $1 AND logical_key = $2;`,
                [data.mediaAssetId, logicalKey]
              );
              const nextVersion = parseInt(versionRes.rows[0]?.next_version ?? '1', 10);

              // 4. Demote existing current rendition outputs for this logical key
              await client.query(
                `UPDATE media_outputs
                 SET is_current = false
                 WHERE media_asset_id = $1 AND logical_key = $2 AND is_current = true;`,
                [data.mediaAssetId, logicalKey]
              );

              // 5. Insert new current rendition output
              await client.query(
                `INSERT INTO media_outputs (
                   id, media_asset_id, processing_job_id, output_type, logical_key,
                   version, is_current, storage_key, mime_type, file_size_bytes,
                   width, height, metadata, created_at
                 ) VALUES (
                   $1, $2, $3, 'rendition', $4,
                   $5, true, $6, 'video/mp4', $7,
                   $8, $9, $10, NOW()
                 );`,
                [
                  outputId,
                  data.mediaAssetId,
                  data.jobId,
                  logicalKey,
                  nextVersion,
                  renditionStorageKey,
                  transcodeResult.fileSizeBytes,
                  transcodeResult.width,
                  transcodeResult.height,
                  JSON.stringify({
                    profile,
                    video_codec: transcodeResult.videoCodec,
                    audio_codec: transcodeResult.audioCodec,
                    duration_seconds: transcodeResult.durationSeconds,
                    bitrate_kbps: bitrateKbps,
                  }),
                ]
              );

              // 6. Optional test hook before final state transition
              if (options.onBeforeCompletionCommit) {
                await options.onBeforeCompletionCommit(client);
              }

              assertOwnership();
              // 7. FINAL STATE TRANSITION: Guarded completion update on processing_jobs
              const completeJobResult = await client.query(
                `UPDATE processing_jobs
                 SET status = 'completed',
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     locked_by = NULL,
                     completed_at = clock_timestamp()
                 WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp()
                 RETURNING id;`,
                [data.jobId, leaseToken]
              );

              if (!completeJobResult.rowCount || completeJobResult.rowCount === 0) {
                throw new RetryProcessingError(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion could be committed`
                );
              }

              // 8. Complete attempt record
              await client.query(
                `UPDATE job_attempts
                 SET status = 'completed',
                     completed_at = clock_timestamp()
                 WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
                [data.jobId, claimedJob.current_attempt_number, leaseToken]
              );

              assertOwnership();
              // A lost COMMIT acknowledgement is not proof of rollback.
              commitAttempted = true;
              await client.query('COMMIT');
              commitConfirmed = true;
              transactionOpen = false;
            } catch (txErr) {
              if (client && transactionOpen) {
                try {
                  await client.query('ROLLBACK');
                  transactionOpen = false;
                } catch {
                  // Destroy a connection whose transaction state is unknown.
                }
              }
              // Our unique output cannot be referenced by a commit we never attempted.
              if (published && !commitAttempted) {
                await storage.unlinkFile(renditionStorageKey).catch(() => {});
              }
              if (commitAttempted && !commitConfirmed) {
                const uncertain = new RetryProcessingError('Rendition commit outcome unknown; retry delivery');
                uncertain.cause = txErr;
                throw uncertain;
              }
              throw txErr;
            } finally {
              try { client?.release(transactionOpen); }
              finally { await storage.unlinkFile(tempRenditionPath).catch(() => {}); }
            }
          } else {
            // Unhandled processing operation
            throw new Error(`Unhandled processing operation: "${data.operation}"`);
          }
        } catch (procErr: any) {
          // Ownership uncertainty is redelivered; it must not mutate another owner's state.
          if (lease?.signal.aborted) throw lease.signal.reason;
          if (procErr instanceof RetryProcessingError) throw procErr;
          // Guarded failure update: only update job and attempt if worker still holds an active, unexpired lease
          const failQuery = claimedJob.current_attempt_number >= 3
            ? `UPDATE processing_jobs
               SET status = 'failed',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   locked_by = NULL,
                   completed_at = clock_timestamp()
               WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp();`
            : `UPDATE processing_jobs
               SET status = 'queued',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   locked_by = NULL
               WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at >= clock_timestamp();`;

          const failResult = await db.query(failQuery, [data.jobId, leaseToken]);

          // Only update job_attempts if this worker still owned the valid lease in processing_jobs
          if (failResult.rowCount && failResult.rowCount > 0) {
            const errorCode = (procErr as any)?.code ? String((procErr as any).code).slice(0, 100) : 'PROCESSING_ERROR';
            await db.query(
              `UPDATE job_attempts
               SET status = 'failed',
                   completed_at = clock_timestamp(),
                   error_code = $4,
                   error_message = $5
               WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
              [data.jobId, claimedJob.current_attempt_number, leaseToken, errorCode, procErr?.message]
            );
          }

          throw procErr;
        } finally {
          lease?.stop();
        }
      } else {
        // Database not provided (unit test mock mode)
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const durationMs = Date.now() - startTime;
      const result: ProcessingJobResult = {
        jobId: data.jobId,
        mediaAssetId: data.mediaAssetId,
        operation: data.operation,
        status: 'completed',
        durationMs,
      };

      return result;
    }

    default: {
      throw new Error(`Unhandled job type: ${(job as any).name}`);
    }
  }
}
