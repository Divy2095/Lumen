import { QueueEvents } from 'bullmq';
import { getRedisConnectionOptions } from '../config/redis.js';
import {
  createMediaQueue,
  MEDIA_PROCESSING_QUEUE,
  TEST_JOB_NAME,
  type TestJobPayload,
} from '../workers/queue.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fail = args.includes('--fail');
  const noWait = args.includes('--no-wait');
  const messageArgs = args.filter((arg) => !arg.startsWith('--'));
  const message = messageArgs.length > 0 ? messageArgs.join(' ') : 'Test processing job';

  const payload: TestJobPayload = {
    message,
    timestamp: new Date().toISOString(),
  };
  if (fail) {
    payload.fail = true;
  }

  console.log(`[Job Submitter] Connecting to queue: "${MEDIA_PROCESSING_QUEUE}"`);
  const queue = createMediaQueue();
  const queueEvents = new QueueEvents(MEDIA_PROCESSING_QUEUE, {
    connection: getRedisConnectionOptions(),
  });

  try {
    const job = await queue.add(TEST_JOB_NAME, payload);
    console.log(`[Job Submitter] Successfully enqueued job:`);
    console.log(`  Job ID: ${job.id}`);
    console.log(`  Job Name: ${job.name}`);
    console.log(`  Payload:`, JSON.stringify(payload, null, 2));

    if (noWait) {
      console.log(`[Job Submitter] --no-wait specified; exiting without awaiting completion.`);
      return;
    }

    console.log(`[Job Submitter] Waiting for worker to process job ${job.id}...`);

    try {
      const result = await job.waitUntilFinished(queueEvents, 15000);
      console.log(`[Job Submitter] Job ${job.id} completed successfully!`);
      console.log(`  Result:`, JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`[Job Submitter] Job ${job.id} failed or timed out:`, err.message);
      process.exitCode = 1;
    }
  } finally {
    await queue.close();
    await queueEvents.close();
  }
}

void main();
