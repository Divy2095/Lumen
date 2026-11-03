import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { QueueEvents, type Job } from 'bullmq';
import {
  createRedisConnection,
  closeRedisConnection,
  getRedisConnectionOptions,
} from '../config/redis.js';
import {
  TEST_JOB_NAME,
  createMediaQueue,
  type LumenJobPayload,
  type LumenJobResult,
  type TestJobPayload,
  type TestJobResult,
} from './queue.js';
import { processJob } from './processor.js';
import { createMediaWorker, type WorkerLogger } from './worker.js';

describe('Media Processing Worker Suite', () => {
  describe('1. Processor Unit Tests (No Redis Required)', () => {
    it('should process a valid test-job payload and return typed result', async () => {
      const mockJob = {
        id: 'mock-1',
        name: TEST_JOB_NAME,
        data: {
          message: 'Hello Unit Test',
          timestamp: new Date().toISOString(),
        },
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      const result = (await processJob(mockJob)) as TestJobResult;
      assert.strictEqual(result.receivedMessage, 'Hello Unit Test');
      assert.ok(typeof result.processedAt === 'string');
      assert.ok(result.durationMs >= 40);
    });

    it('should reject a failing job payload with forced error', async () => {
      const mockJob = {
        id: 'mock-fail',
        name: TEST_JOB_NAME,
        data: {
          message: 'Expected failure test',
          fail: true,
        },
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => await processJob(mockJob),
        /Job mock-fail forced failure: Expected failure test/
      );
    });

    it('should throw an error for unknown job types', async () => {
      const mockJob = {
        id: 'mock-unknown',
        name: 'unknown-job-type',
        data: {
          message: 'Unknown',
        },
      } as unknown as Job<LumenJobPayload, LumenJobResult>;

      await assert.rejects(
        async () => await processJob(mockJob),
        /Unhandled job type: unknown-job-type/
      );
    });
  });

  describe('2. Live Redis + BullMQ Integration Suite', () => {
    let redisAvailable = false;
    let testQueueName: string;
    let queue: ReturnType<typeof createMediaQueue>;
    let queueEvents: QueueEvents;

    const silentLogger: WorkerLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    before(async () => {
      // Fast single-attempt check to determine if Redis is reachable
      const probeClient = createRedisConnection({
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
      });

      try {
        await probeClient.connect();
        const reply = await probeClient.ping();
        if (reply === 'PONG') {
          redisAvailable = true;
        }
      } catch {
        redisAvailable = false;
      } finally {
        await closeRedisConnection(probeClient);
      }

      if (redisAvailable) {
        testQueueName = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        queue = createMediaQueue(testQueueName);
        queueEvents = new QueueEvents(testQueueName, {
          connection: getRedisConnectionOptions(),
        });
      }
    });

    after(async () => {
      if (queue) {
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close();
      }
      if (queueEvents) {
        await queueEvents.close();
      }
    });

    it('should verify live Redis connectivity via PING', async (t) => {
      if (!redisAvailable) {
        t.skip('Redis is not available');
        return;
      }

      const client = createRedisConnection();
      try {
        const pingResponse = await client.ping();
        assert.strictEqual(pingResponse, 'PONG');
      } finally {
        await closeRedisConnection(client);
      }
    });

    it('should successfully submit a typed test job to the queue', async (t) => {
      if (!redisAvailable) {
        t.skip('Redis is not available');
        return;
      }

      const payload: TestJobPayload = {
        message: 'Integration test job',
        timestamp: new Date().toISOString(),
      };

      const job = await queue.add(TEST_JOB_NAME, payload);
      assert.ok(job.id);
      assert.strictEqual(job.name, TEST_JOB_NAME);
      assert.strictEqual((job.data as TestJobPayload).message, 'Integration test job');

      const retrievedJob = await queue.getJob(job.id);
      assert.ok(retrievedJob);
      assert.strictEqual((retrievedJob.data as TestJobPayload).message, 'Integration test job');
    });

    it('should execute worker and complete job successfully', async (t) => {
      if (!redisAvailable) {
        t.skip('Redis is not available');
        return;
      }

      const worker = createMediaWorker({
        queueName: testQueueName,
        logger: silentLogger,
      });

      try {
        const payload: TestJobPayload = {
          message: 'Process me successfully',
          timestamp: new Date().toISOString(),
        };

        const job = await queue.add(TEST_JOB_NAME, payload);
        const result = (await job.waitUntilFinished(queueEvents, 10000)) as TestJobResult;

        assert.strictEqual(result.receivedMessage, 'Process me successfully');
        assert.ok(typeof result.processedAt === 'string');
        assert.ok(result.durationMs >= 40);

        const updatedJob = await queue.getJob(job.id!);
        assert.ok(updatedJob);
        const state = await updatedJob.getState();
        assert.strictEqual(state, 'completed');
      } finally {
        await worker.close();
      }
    });

    it('should handle job failure properly and transition to failed state', async (t) => {
      if (!redisAvailable) {
        t.skip('Redis is not available');
        return;
      }

      const worker = createMediaWorker({
        queueName: testQueueName,
        logger: silentLogger,
        workerOptions: {
          concurrency: 1,
        },
      });

      try {
        const payload: TestJobPayload = {
          message: 'Should deliberately fail',
          timestamp: new Date().toISOString(),
          fail: true,
        };

        // 1 attempt so it fails immediately without retry delays
        const job = await queue.add(TEST_JOB_NAME, payload, { attempts: 1 });

        await assert.rejects(
          async () => await job.waitUntilFinished(queueEvents, 10000),
          /Should deliberately fail/
        );

        const updatedJob = await queue.getJob(job.id!);
        assert.ok(updatedJob);
        const state = await updatedJob.getState();
        assert.strictEqual(state, 'failed');
        assert.match(updatedJob.failedReason ?? '', /forced failure: Should deliberately fail/);
      } finally {
        await worker.close();
      }
    });

    it('should support graceful shutdown without hanging connections', async (t) => {
      if (!redisAvailable) {
        t.skip('Redis is not available');
        return;
      }

      const worker = createMediaWorker({
        queueName: testQueueName,
        logger: silentLogger,
      });

      // Worker is running
      assert.strictEqual(worker.isRunning(), true);

      // Graceful shutdown
      await worker.close();

      assert.strictEqual(worker.isRunning(), false);
    });
  });
});
