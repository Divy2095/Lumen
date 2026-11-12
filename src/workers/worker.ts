import { Worker, DelayedError, type WorkerOptions, type Job } from 'bullmq';
import { RetryProcessingError } from './job-lease.js';
import { integerInRange, MAX_FFMPEG_INTEGER, MAX_TIMER_MS } from '../config/media-processing.js';
import type { Pool } from 'pg';
import { getRedisConnectionOptions } from '../config/redis.js';
import {
  MEDIA_PROCESSING_QUEUE,
  type LumenJobPayload,
  type LumenJobResult,
} from './queue.js';
import { processJob, type ProcessJobOptions } from './processor.js';
import type { FFprobeService } from '../modules/media/ffprobe.service.js';
import type { FFmpegService } from '../modules/media/ffmpeg.service.js';
import type { StorageService } from '../shared/storage/local-storage.service.js';
import type { TranscodingService } from '../modules/media/transcoding.service.js';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const defaultWorkerLogger: WorkerLogger = {
  info(obj, msg) {
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), component: 'media-worker', msg, ...obj }));
  },
  warn(obj, msg) {
    console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), component: 'media-worker', msg, ...obj }));
  },
  error(obj, msg) {
    console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), component: 'media-worker', msg, ...obj }));
  },
};

export interface CreateWorkerOptions {
  queueName?: string | undefined;
  concurrency?: number | undefined;
  workerOptions?: Partial<WorkerOptions> | undefined;
  logger?: WorkerLogger | undefined;
  db?: Pool | undefined;
  ffprobeService?: FFprobeService | undefined;
  ffmpegService?: FFmpegService | undefined;
  storageService?: StorageService | undefined;
  transcodingService?: TranscodingService | undefined;
}

/**
 * Creates and configures a BullMQ worker for the media processing queue
 * with structured lifecycle logging and connection cleanup.
 */
export function createMediaWorker(
  options: CreateWorkerOptions = {}
): Worker<LumenJobPayload, LumenJobResult> {
  const queueName = options.queueName ?? MEDIA_PROCESSING_QUEUE;
  const logger = options.logger ?? defaultWorkerLogger;
  const concurrency = integerInRange('Worker concurrency', options.workerOptions?.concurrency ?? options.concurrency ?? 5, 1, MAX_FFMPEG_INTEGER);
  const lockDuration = integerInRange('BullMQ lockDuration', options.workerOptions?.lockDuration ?? 30000, 2, MAX_TIMER_MS);
  const lockRenewTime = integerInRange('BullMQ lockRenewTime', options.workerOptions?.lockRenewTime ?? Math.floor(lockDuration / 2), 1, lockDuration - 1);
  for (const name of ['stalledInterval', 'maximumRateLimitDelay', 'runRetryDelay'] as const) {
    const value = options.workerOptions?.[name];
    if (value !== undefined) integerInRange(`BullMQ ${name}`, value, name === 'runRetryDelay' ? 0 : 1, MAX_TIMER_MS);
  }

  const drainDelay = options.workerOptions?.drainDelay;
  if (drainDelay !== undefined && (typeof drainDelay !== 'number' || !Number.isFinite(drainDelay) || drainDelay <= 0 || drainDelay > MAX_TIMER_MS / 1000)) {
    throw new Error('BullMQ drainDelay must be positive finite seconds within the timer range');
  }

  const worker = new Worker<LumenJobPayload, LumenJobResult>(
    queueName,
    async (job: Job<LumenJobPayload, LumenJobResult>, token?: string, signal?: AbortSignal) => {
      const processOptions: ProcessJobOptions = { signal };
      if (options.ffprobeService !== undefined) {
        processOptions.ffprobeService = options.ffprobeService;
      }
      if (options.ffmpegService !== undefined) {
        processOptions.ffmpegService = options.ffmpegService;
      }
      if (options.storageService !== undefined) {
        processOptions.storageService = options.storageService;
      }
      if (options.transcodingService !== undefined) {
        processOptions.transcodingService = options.transcodingService;
      }
      return await processWithRedelivery(job, token, options.db, processOptions);
    },
    {
      connection: getRedisConnectionOptions(),
      ...options.workerOptions,
      concurrency,
      lockDuration,
      lockRenewTime,
    }
  );

  worker.on('active', (job) => {
    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        payload: job.data,
      },
      `Job ${job.id} started processing`
    );
  });

  worker.on('completed', (job, result) => {
    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        result,
      },
      `Job ${job.id} completed successfully`
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err.message,
        stack: err.stack,
      },
      `Job ${job?.id} failed processing`
    );
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message, stack: err.stack }, 'BullMQ worker encountered connection error');
  });

  return worker;
}

/** Delaying contention does not consume BullMQ's processing-failure attempts. */
export async function processWithRedelivery(
  job: Job<LumenJobPayload, LumenJobResult>,
  token: string | undefined,
  db?: Pool,
  options: ProcessJobOptions = {},
): Promise<LumenJobResult> {
  try {
    return await processJob(job, db, options);
  } catch (error) {
    if (!(error instanceof RetryProcessingError) || !token) throw error;
    await job.moveToDelayed(Date.now() + 1000, token);
    throw new DelayedError();
  }
}
