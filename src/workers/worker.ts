import { Worker, type WorkerOptions, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { getRedisConnectionOptions } from '../config/redis.js';
import {
  MEDIA_PROCESSING_QUEUE,
  type LumenJobPayload,
  type LumenJobResult,
} from './queue.js';
import { processJob, type ProcessJobOptions } from './processor.js';
import type { FFprobeService } from '../modules/media/ffprobe.service.js';
import type { StorageService } from '../shared/storage/local-storage.service.js';

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
  storageService?: StorageService | undefined;
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

  const worker = new Worker<LumenJobPayload, LumenJobResult>(
    queueName,
    async (job: Job<LumenJobPayload, LumenJobResult>) => {
      const processOptions: ProcessJobOptions = {};
      if (options.ffprobeService !== undefined) {
        processOptions.ffprobeService = options.ffprobeService;
      }
      if (options.storageService !== undefined) {
        processOptions.storageService = options.storageService;
      }
      return await processJob(job, options.db, processOptions);
    },
    {
      connection: getRedisConnectionOptions(),
      concurrency: options.concurrency ?? 5,
      ...options.workerOptions,
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
      `Job ${job?.id} failed`
    );
  });

  worker.on('error', (err) => {
    logger.error(
      {
        error: err.message,
        stack: err.stack,
      },
      'Worker encountered a Redis connection error'
    );
  });

  return worker;
}
