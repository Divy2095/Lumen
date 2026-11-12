import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { FFprobeService } from './ffprobe.service.js';
import { AsyncSemaphore, TranscodingService } from './transcoding.service.js';
import { JobLease, RetryProcessingError } from '../../workers/job-lease.js';

const sourceProbe = { probe: async () => ({ video: { width: 1280, height: 720 }, durationSeconds: 1 }) } as unknown as FFprobeService;

const input = { inputFilePath: 'input.mp4', targetWidth: 640, targetHeight: 360,
  bitrateKbps: 800, hasAudio: false };

it('removes an aborted waiter without leaking permits or disturbing FIFO', async () => {
  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire();
  const cancellation = new AbortController();
  const cancelled = semaphore.acquire(cancellation.signal);
  const next = semaphore.acquire();
  const rejected = assert.rejects(cancelled, /cancelled/);
  cancellation.abort(new Error('cancelled'));
  await rejected;
  assert.equal(semaphore.waitingCount, 1);
  release();
  const releaseNext = await next;
  assert.equal(semaphore.activeCount, 1);
  releaseNext();
  releaseNext();
  assert.equal(semaphore.activeCount, 0);
});

it('a pre-aborted request does not acquire a permit', async () => {
  const semaphore = new AsyncSemaphore(1);
  const cancellation = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(semaphore.acquire(cancellation), /cancelled/);
  assert.equal(semaphore.activeCount, 0);
});

it('renews ownership while waiting, then cancels queued transcoding on revocation', async () => {
  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire();
  let renewals = 0;
  let revoked = false;
  const db = { query: async () => { renewals++; return { rowCount: revoked ? 0 : 1 }; } } as unknown as Pool;
  const lease = new JobLease(db, 'job', 'token', 300, performance.now());
  const service = new TranscodingService({ semaphore, videoEncoder: 'libx264', ffprobeService: sourceProbe });
  const work = service.transcodeVideo({ ...input, outputFilePath: 'never-created.tmp', signal: lease.signal });
  const rejected = assert.rejects(work, RetryProcessingError);
  try {
    await sleep(700);
    assert.ok(renewals >= 3);
    assert.equal(semaphore.waitingCount, 1);
    assert.equal(lease.signal.aborted, false);
    revoked = true;
    await rejected;
    assert.equal(semaphore.waitingCount, 0);
    assert.equal(semaphore.activeCount, 1);
  } finally { lease.stop(); release(); }
});

it('cancellation terminates a running process, cleans its partial output, and releases the permit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-cancel-'));
  const executable = join(directory, 'ffmpeg.ts');
  const outputFilePath = join(directory, 'output.tmp');
  // A controllable child exercises spawn/kill/close without requiring FFmpeg codecs.
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.argv.at(-1)!, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const semaphore = new AsyncSemaphore(1);
  const controller = new AbortController();
  const service = new TranscodingService({ ffmpegPath: executable, videoEncoder: 'libx264', semaphore, ffprobeService: sourceProbe });
  const work = service.transcodeVideo({ ...input, outputFilePath, signal: controller.signal });
  const rejected = assert.rejects(work, /ownership lost/);
  let pid: number | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(outputFilePath, 'utf8')); break; } catch { await sleep(20); }
    }
    assert.ok(pid, 'child started and wrote a partial output');
    controller.abort(new Error('ownership lost'));
    await rejected;
    await assert.rejects(stat(outputFilePath), { code: 'ENOENT' });
    assert.equal(semaphore.activeCount, 0);
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    controller.abort(new Error('test finished'));
    await work.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
