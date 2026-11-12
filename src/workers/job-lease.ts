import type { Pool, QueryConfig, QueryResult } from 'pg';
import { integerInRange, MAX_TIMER_MS } from '../config/media-processing.js';

export class RetryProcessingError extends Error {
  constructor(message = 'Database job is unfinished; retry delivery') {
    super(message);
    this.name = 'RetryProcessingError';
  }
}

/** A local deadline is conservative; PostgreSQL remains the ownership authority. */
export class JobLease {
  private readonly controller = new AbortController();
  private renewalTimer?: NodeJS.Timeout;
  private deadlineTimer?: NodeJS.Timeout;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private deadline: number;
  private readonly parentAbort = () => this.lose();

  constructor(
    private readonly db: Pool,
    private readonly jobId: string,
    private readonly token: string,
    private readonly durationMs: number,
    claimedAt: number,
    private readonly parentSignal?: AbortSignal,
  ) {
    integerInRange('leaseDurationMs', durationMs, 1, MAX_TIMER_MS);
    if (!Number.isFinite(claimedAt) || claimedAt > performance.now()) throw new Error('Lease claim time must be a finite past monotonic timestamp');
    this.deadline = claimedAt + durationMs;
    parentSignal?.addEventListener('abort', this.parentAbort, { once: true });
    if (parentSignal?.aborted) { this.lose(); return; }
    this.armDeadline();
    this.schedule();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  assertOwned(): void {
    if (performance.now() >= this.deadline) this.lose();
    this.signal.throwIfAborted();
  }

  private lose(): void {
    this.controller.abort(new RetryProcessingError('Worker lease expired or was revoked'));
    this.stop();
  }

  private armDeadline(): void {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => this.lose(), Math.max(0, this.deadline - performance.now()));
    this.deadlineTimer.unref();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.renewalTimer = setTimeout(() => {
      void this.renew().then(() => this.schedule(), () => {});
    }, Math.max(1, Math.floor(this.durationMs / 3)));
    this.renewalTimer.unref();
  }

  private renew(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.performRenewal().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async performRenewal(): Promise<void> {
    this.assertOwned();
    const startedAt = performance.now();
    try {
      const query: QueryConfig & { query_timeout: number } = {
        text: `WITH locked AS MATERIALIZED (
                 SELECT id FROM processing_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED
               )
               UPDATE processing_jobs
               SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond')
               FROM locked
               WHERE processing_jobs.id = locked.id AND lease_token = $2 AND status = 'processing'
                 AND lease_expires_at > clock_timestamp()
               RETURNING processing_jobs.id;`,
        values: [this.jobId, this.token, this.durationMs],
        // pg accepts query_timeout per query, although @types/pg omits it here.
        query_timeout: Math.max(1, Math.floor(this.durationMs / 3)),
      };
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(this.signal.reason);
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
      let result: QueryResult;
      try {
        result = await Promise.race([this.db.query(query), aborted]);
      } finally {
        this.signal.removeEventListener('abort', onAbort);
      }
      if (this.stopped) {
        this.signal.throwIfAborted();
        return;
      }
      this.assertOwned();
      if (result.rowCount !== 1) throw new Error('Lease ownership lost');
      this.deadline = startedAt + this.durationMs;
      this.armDeadline();
    } catch {
      this.lose();
      this.signal.throwIfAborted();
    }
  }

  /** Avoid renewing against a row locked by our own completion transaction. */
  async prepareCompletion(): Promise<void> {
    this.assertOwned();
    clearTimeout(this.renewalTimer);
    await this.renew();
    this.assertOwned();
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.parentSignal?.removeEventListener('abort', this.parentAbort);
    clearTimeout(this.renewalTimer);
    clearTimeout(this.deadlineTimer);
  }
}
