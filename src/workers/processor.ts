import { type Job } from 'bullmq';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
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
import { defaultStorageService, type StorageService } from '../shared/storage/local-storage.service.js';

export interface ProcessJobOptions {
  workerId?: string | undefined;
  leaseDurationMs?: number | undefined;
  ffprobeService?: FFprobeService | undefined;
  storageService?: StorageService | undefined;
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

          if (existing.status === 'processing') {
            // Another worker holds an active lease
            if (existing.lease_expires_at && existing.lease_expires_at.getTime() >= Date.now()) {
              return {
                jobId: data.jobId,
                mediaAssetId: data.mediaAssetId,
                operation: data.operation,
                status: 'already_completed',
                durationMs: Date.now() - startTime,
              };
            }

            // Stale expired job that has exhausted all 3 attempts: reap to failed
            if (existing.current_attempt_number >= 3) {
              await db.query(
                `UPDATE processing_jobs
                 SET status = 'failed',
                     lease_expires_at = NULL,
                     locked_by = NULL,
                     lease_token = NULL,
                     completed_at = NOW()
                 WHERE id = $1 AND status = 'processing' AND lease_expires_at < NOW() AND current_attempt_number >= 3;`,
                [data.jobId]
              );

              return {
                jobId: data.jobId,
                mediaAssetId: data.mediaAssetId,
                operation: data.operation,
                status: 'failed',
                durationMs: Date.now() - startTime,
              };
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

          // Inconclusive state, avoid corrupting
          return {
            jobId: data.jobId,
            mediaAssetId: data.mediaAssetId,
            operation: data.operation,
            status: 'already_completed',
            durationMs: Date.now() - startTime,
          };
        }

        const claimedJob = claimResult.rows[0]!;

        // 3. Record attempt in job_attempts with fencing token
        const attemptId = uuidv7();
        await db.query(
          `INSERT INTO job_attempts (\n             id, job_id, attempt_number, status, fencing_token, started_at\n           ) VALUES ($1, $2, $3, 'processing', $4, NOW());`,
          [attemptId, claimedJob.id, claimedJob.current_attempt_number, leaseToken]
        );

        try {
          if (data.operation === 'extract_metadata') {
            // Real FFprobe execution
            const assetRes = await db.query<{
              id: string;
              project_id: string;
              storage_key: string;
              status: string;
            }>(
              `SELECT id, project_id, storage_key, status
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

            // Commit metadata and complete job in an atomic transaction guarded by fencing token and unexpired lease
            const client = await db.connect();
            try {
              await client.query('BEGIN');

              // 1. Guarded completion update on processing_jobs
              const completeJobResult = await client.query(
                `UPDATE processing_jobs
                 SET status = 'completed',
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     locked_by = NULL,
                     completed_at = NOW()
                 WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW()
                 RETURNING id;`,
                [data.jobId, leaseToken]
              );

              if (!completeJobResult.rowCount || completeJobResult.rowCount === 0) {
                throw new Error(
                  `Worker lease expired or was revoked for job "${data.jobId}" before completion could be committed`
                );
              }

              // 2. Persist metadata to media_assets
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
                  JSON.stringify(metadata.rawMetadata ?? {}),
                  data.projectId,
                ]
              );

              // 3. Complete attempt record
              await client.query(
                `UPDATE job_attempts
                 SET status = 'completed',
                     completed_at = NOW()
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
          } else {
            // Placeholder processing for other operations (generate_thumbnail, transcode)
            await new Promise((resolve) => setTimeout(resolve, 50));

            const completeJobResult = await db.query(
              `UPDATE processing_jobs
               SET status = 'completed',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   locked_by = NULL,
                   completed_at = NOW()
               WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW();`,
              [data.jobId, leaseToken]
            );

            if (completeJobResult.rowCount && completeJobResult.rowCount > 0) {
              await db.query(
                `UPDATE job_attempts
                 SET status = 'completed',
                     completed_at = NOW()
                 WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
                [data.jobId, claimedJob.current_attempt_number, leaseToken]
              );
            } else {
              throw new Error(
                `Worker lease expired or was revoked for job "${data.jobId}" before completion could be committed`
              );
            }
          }
        } catch (procErr: any) {
          // Guarded failure update: only update job and attempt if worker still holds an active, unexpired lease
          const failQuery = claimedJob.current_attempt_number >= 3
            ? `UPDATE processing_jobs
               SET status = 'failed',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   locked_by = NULL,
                   completed_at = NOW()
               WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW();`
            : `UPDATE processing_jobs
               SET status = 'queued',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   locked_by = NULL
               WHERE id = $1 AND lease_token = $2 AND lease_expires_at >= NOW();`;

          const failResult = await db.query(failQuery, [data.jobId, leaseToken]);

          // Only update job_attempts if this worker still owned the valid lease in processing_jobs
          if (failResult.rowCount && failResult.rowCount > 0) {
            const errorCode = (procErr as any)?.code ? String((procErr as any).code).slice(0, 100) : 'PROCESSING_ERROR';
            await db.query(
              `UPDATE job_attempts
               SET status = 'failed',
                   completed_at = NOW(),
                   error_code = $4,
                   error_message = $5
               WHERE job_id = $1 AND attempt_number = $2 AND fencing_token = $3;`,
              [data.jobId, claimedJob.current_attempt_number, leaseToken, errorCode, procErr?.message]
            );
          }

          throw procErr;
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
