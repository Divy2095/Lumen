import { Queue, type QueueOptions, type JobsOptions, type Job } from 'bullmq';
import { getRedisConnectionOptions } from '../config/redis.js';

export const MEDIA_PROCESSING_QUEUE = 'media-processing';
export const TEST_JOB_NAME = 'test-job';
export const EXTRACT_METADATA_JOB = 'extract_metadata';
export const GENERATE_THUMBNAIL_JOB = 'generate_thumbnail';
export const TRANSCODE_JOB = 'transcode';
export const PROCESSING_JOB_NAME = 'processing_job';

export interface TestJobPayload {
  message: string;
  timestamp?: string;
  fail?: boolean;
}

export interface TestJobResult {
  receivedMessage: string;
  processedAt: string;
  durationMs: number;
}

export interface ProcessingJobPayload {
  jobId: string;
  projectId: string;
  mediaAssetId: string;
  operation: 'extract_metadata' | 'generate_thumbnail' | 'transcode';
  parameters?: Record<string, unknown>;
  outboxEventId?: string;
}

export interface ProcessingJobResult {
  jobId: string;
  mediaAssetId: string;
  operation: string;
  status: 'completed' | 'already_completed' | 'failed' | 'cancelled';
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export type LumenJobName =
  | typeof TEST_JOB_NAME
  | typeof EXTRACT_METADATA_JOB
  | typeof GENERATE_THUMBNAIL_JOB
  | typeof TRANSCODE_JOB
  | typeof PROCESSING_JOB_NAME;

export type LumenJobPayload = TestJobPayload | ProcessingJobPayload;
export type LumenJobResult = TestJobResult | ProcessingJobResult;

/**
 * Creates an instance of the media processing BullMQ queue.
 */
export function createMediaQueue(
  queueName: string = MEDIA_PROCESSING_QUEUE,
  options?: Partial<QueueOptions>
): Queue<LumenJobPayload, LumenJobResult> {
  return new Queue<LumenJobPayload, LumenJobResult>(queueName, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        age: 3600, // Keep completed jobs for 1 hour
        count: 1000,
      },
      removeOnFail: {
        age: 86400, // Keep failed jobs for 24 hours
        count: 5000,
      },
    },
    ...options,
  });
}

/**
 * Convenience helper to enqueue a typed test job into the media queue.
 */
export async function enqueueTestJob(
  payload: TestJobPayload,
  options?: JobsOptions,
  queueName: string = MEDIA_PROCESSING_QUEUE
): Promise<Job<LumenJobPayload, LumenJobResult>> {
  const queue = createMediaQueue(queueName);
  try {
    const jobPayload: TestJobPayload = {
      message: payload.message,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    };
    if (payload.fail !== undefined) {
      jobPayload.fail = payload.fail;
    }
    const job = await queue.add(
      TEST_JOB_NAME,
      jobPayload,
      options
    );
    return job;
  } finally {
    await queue.close();
  }
}
