import { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { fileURLToPath } from 'node:url';
import { createMediaQueue, type LumenJobPayload, type LumenJobResult } from './queue.js';
import { createDatabasePool } from '../database/pool.js';
import { defaultWorkerLogger, type WorkerLogger } from './worker.js';

export interface OutboxPublisherOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  publisherId?: string;
  logger?: WorkerLogger;
}

export interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  attempts_count: number;
}

export class OutboxPublisher {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly publisherId: string;
  readonly logger: WorkerLogger;

  private isRunning: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPollingActive: boolean = false;
  private inFlightPollPromise: Promise<number> | null = null;

  constructor(
    private db: Pool,
    private queue: Queue<LumenJobPayload, LumenJobResult>,
    options: OutboxPublisherOptions = {}
  ) {
    this.batchSize = options.batchSize ?? (process.env.OUTBOX_BATCH_SIZE ? parseInt(process.env.OUTBOX_BATCH_SIZE, 10) : 20);
    this.pollIntervalMs = options.pollIntervalMs ?? (process.env.OUTBOX_POLL_INTERVAL_MS ? parseInt(process.env.OUTBOX_POLL_INTERVAL_MS, 10) : 1000);
    this.leaseDurationMs = options.leaseDurationMs ?? (process.env.OUTBOX_LEASE_DURATION_MS ? parseInt(process.env.OUTBOX_LEASE_DURATION_MS, 10) : 30000);
    this.publisherId = options.publisherId ?? `publisher-${process.pid}-${uuidv7().slice(0, 8)}`;
    this.logger = options.logger ?? defaultWorkerLogger;
  }

  /**
   * Starts periodic polling for unpublished outbox events.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger.info(
      {
        publisherId: this.publisherId,
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
        leaseDurationMs: this.leaseDurationMs,
      },
      'Outbox publisher started'
    );

    this.scheduleNextPoll(0);
  }

  /**
   * Stops the publisher gracefully, ensuring any active batch finishes processing.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.inFlightPollPromise) {
      await this.inFlightPollPromise.catch(() => {});
    }

    this.logger.info({ publisherId: this.publisherId }, 'Outbox publisher stopped');
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) {
      return;
    }

    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (!this.isRunning) return;

      try {
        const publishedCount = await this.pollOnce();
        // If we found a full batch, poll immediately again; otherwise wait pollIntervalMs
        const nextDelay = publishedCount >= this.batchSize ? 50 : this.pollIntervalMs;
        this.scheduleNextPoll(nextDelay);
      } catch (err: any) {
        this.logger.error(
          { publisherId: this.publisherId, err: err?.message },
          'Error occurred during outbox polling cycle'
        );
        this.scheduleNextPoll(this.pollIntervalMs);
      }
    }, delayMs);
    this.pollTimer.unref();
  }

  /**
   * Performs a single polling cycle:
   * 1. Claims and leases up to batchSize events inside a short DB transaction (FOR UPDATE SKIP LOCKED).
   * 2. Publishes claimed events to BullMQ with deterministic job IDs.
   * 3. Marks successfully dispatched events as published in PostgreSQL only if current lease ownership is verified.
   * 4. Releases locks and logs errors on failures conditionally for safe retry without clobbering newer leases.
   */
  async pollOnce(): Promise<number> {
    if (this.isPollingActive) {
      return 0;
    }

    this.isPollingActive = true;
    const pollPromise = this.executePollCycle();
    this.inFlightPollPromise = pollPromise;

    try {
      return await pollPromise;
    } finally {
      this.isPollingActive = false;
      this.inFlightPollPromise = null;
    }
  }

  private async executePollCycle(): Promise<number> {
    // 1. Claim and lease unpublished events inside a short database transaction
    const client = await this.db.connect();
    let claimedEvents: OutboxEventRow[] = [];

    try {
      await client.query('BEGIN');

      const claimQuery = `
        WITH claimable AS (
          SELECT id
          FROM outbox_events
          WHERE published_at IS NULL
            AND (locked_until IS NULL OR locked_until < NOW())
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events
        SET locked_by = $2,
            locked_until = NOW() + ($3 || ' milliseconds')::interval,
            attempts_count = attempts_count + 1
        FROM claimable
        WHERE outbox_events.id = claimable.id
        RETURNING outbox_events.id,
                  outbox_events.aggregate_type,
                  outbox_events.aggregate_id,
                  outbox_events.event_type,
                  outbox_events.payload,
                  outbox_events.attempts_count;
      `;

      const claimResult = await client.query<OutboxEventRow>(claimQuery, [
        this.batchSize,
        this.publisherId,
        this.leaseDurationMs,
      ]);

      await client.query('COMMIT');
      claimedEvents = claimResult.rows;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (claimedEvents.length === 0) {
      return 0;
    }

    this.logger.info(
      { publisherId: this.publisherId, count: claimedEvents.length },
      `Claimed ${claimedEvents.length} outbox event(s) for dispatch`
    );

    // 2. Dispatch events to BullMQ and record completion
    let successCount = 0;

    for (const event of claimedEvents) {
      try {
        const payload =
          typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload;

        // Validate payload
        if (
          !payload ||
          typeof payload !== 'object' ||
          !payload.jobId ||
          !payload.operation
        ) {
          throw new Error(
            `Invalid outbox event payload: missing required fields (jobId, operation)`
          );
        }

        const jobName = payload.operation;
        const customJobId = `outbox-${event.id}`;

        // Publish to BullMQ with deterministic custom jobId derived from outbox event ID
        await this.queue.add(
          jobName,
          {
            jobId: payload.jobId,
            projectId: payload.projectId,
            mediaAssetId: payload.mediaAssetId,
            operation: payload.operation,
            parameters: payload.parameters,
            outboxEventId: event.id,
          },
          {
            jobId: customJobId,
          }
        );

        // Mark as published in PostgreSQL ONLY if this publisher still owns the valid lease
        const markRes = await this.db.query(
          `UPDATE outbox_events
           SET published_at = NOW(),
               locked_by = NULL,
               locked_until = NULL,
               last_error = NULL
           WHERE id = $1
             AND locked_by = $2
             AND locked_until >= NOW();`,
          [event.id, this.publisherId]
        );

        if (markRes.rowCount && markRes.rowCount > 0) {
          this.logger.info(
            {
              eventId: event.id,
              jobId: payload.jobId,
              queueJobId: customJobId,
              operation: payload.operation,
            },
            `Outbox event ${event.id} successfully published to BullMQ`
          );
          successCount++;
        } else {
          this.logger.warn(
            {
              eventId: event.id,
              publisherId: this.publisherId,
            },
            `Lease expired or ownership lost for outbox event ${event.id}; did not mark published`
          );
        }
      } catch (publishErr: any) {
        this.logger.error(
          { eventId: event.id, err: publishErr?.message },
          `Failed to publish outbox event ${event.id}`
        );

        // On publication failure: unlock event and record error ONLY if this publisher still owns the lease
        await this.db.query(
          `UPDATE outbox_events
           SET locked_by = NULL,
               locked_until = NULL,
               last_error = $2
           WHERE id = $1
             AND locked_by = $3
             AND locked_until >= NOW();`,
          [event.id, publishErr?.message ?? 'Unknown publication error', this.publisherId]
        );
      }
    }

    return successCount;
  }
}

/**
 * Standalone process runner when outbox-publisher.ts is executed directly.
 */
async function runStandalone(): Promise<void> {
  const SHUTDOWN_TIMEOUT_MS = 10000;
  const db = createDatabasePool();
  const queue = createMediaQueue();
  const publisher = new OutboxPublisher(db, queue);

  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    publisher.logger.info({ signal }, 'Termination signal received; starting graceful outbox publisher shutdown');

    const forceTimer = setTimeout(() => {
      publisher.logger.error({}, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      await publisher.stop();
      await queue.close();
      await db.end();
      clearTimeout(forceTimer);
      publisher.logger.info({}, 'Outbox publisher shutdown completed cleanly');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      publisher.logger.error({ err }, 'Error during outbox publisher shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  publisher.start();
}

// Check if this module is being run directly as a CLI script
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && currentFile === fileURLToPath(new URL(process.argv[1], 'file:'))) {
  void runStandalone();
}
