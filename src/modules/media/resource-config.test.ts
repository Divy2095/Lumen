import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { MAX_CAPTURE_BYTES, MAX_FFMPEG_INTEGER, MAX_TIMER_MS } from '../../config/media-processing.js';
import { AsyncSemaphore, TranscodingService, getAvailableH264Encoder } from './transcoding.service.js';
import { FFprobeService } from './ffprobe.service.js';
import { JobLease } from '../../workers/job-lease.js';
import { createMediaWorker } from '../../workers/worker.js';
import { normalizeSourceDimensions } from './transcoding-profiles.js';

const invalid = [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2'];
const fields = [
  ['concurrencyLimit', 'TRANSCODING_CONCURRENCY', MAX_FFMPEG_INTEGER, 1],
  ['timeoutMs', 'TRANSCODING_TIMEOUT_MS', MAX_TIMER_MS, 1],
  ['maxOutputBytes', 'TRANSCODING_MAX_OUTPUT_BYTES', Number.MAX_SAFE_INTEGER, 1],
  ['maxStderrBytes', 'TRANSCODING_MAX_STDERR_BYTES', MAX_CAPTURE_BYTES, 0],
  ['threads', 'TRANSCODING_THREADS', MAX_FFMPEG_INTEGER, 0],
] as const;

function env(name: string, value: string, callback: () => void) {
  const before = process.env[name];
  process.env[name] = value;
  try { callback(); }
  finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
}

for (const [field, name, max, min] of fields) {
  it(`validates ${name} option bounds and decimal environment syntax`, () => {
    for (const value of [...invalid, max + 1, ...(min === 1 ? [0] : [])]) {
      assert.throws(() => new TranscodingService({ videoEncoder: 'libx264', [field]: value }), /integer/);
    }
    for (const value of ['', ' ', '2oops', '1.5', 'NaN', 'Infinity', '-1', '0x10', '1e3', String(max + 1)]) {
      env(name, value, () => assert.throws(() => new TranscodingService({ videoEncoder: 'libx264' }), /integer/));
    }
    const low = new TranscodingService({ videoEncoder: 'libx264', [field]: min });
    const high = new TranscodingService({ videoEncoder: 'libx264', [field]: max });
    assert.ok(low);
    assert.ok(high);
    env(name, ' 2 ', () => assert.ok(new TranscodingService({ videoEncoder: 'libx264' })));
    env(name, 'bad', () => assert.ok(new TranscodingService({ videoEncoder: 'libx264', [field]: 2 })));
  });
}

for (const [field, name, max] of [['timeoutMs', 'FFPROBE_TIMEOUT_MS', MAX_TIMER_MS], ['maxBufferBytes', 'FFPROBE_MAX_BUFFER_BYTES', MAX_CAPTURE_BYTES]] as const) {
  it(`validates ${name} before starting a process`, () => {
    for (const value of [...invalid, 0, max + 1]) assert.throws(() => new FFprobeService({ [field]: value }), /integer/);
    for (const value of ['', 'bad', '1ms', 'Infinity', '1.5', String(max + 1)]) {
      env(name, value, () => assert.throws(() => new FFprobeService(), /integer/));
    }
    assert.ok(new FFprobeService({ [field]: 1 }));
    assert.ok(new FFprobeService({ [field]: max }));
  });
}

it('preserves documented transcoding and probe defaults and allows zero threads', () => {
  const t = new TranscodingService({ videoEncoder: 'libx264' });
  assert.equal(t.timeoutMs, 120000);
  assert.equal(t.maxOutputBytes, 500 * 1024 * 1024);
  assert.equal(t.maxStderrBytes, 64 * 1024);
  assert.equal(t.threads, 2);
  assert.equal(t.semaphore.maxConcurrency, 2);
  const p = new FFprobeService();
  assert.equal(p.timeoutMs, 10000);
  assert.equal(p.maxBufferBytes, 1024 * 1024);
  assert.equal(new TranscodingService({ videoEncoder: 'libx264', threads: 0 }).threads, 0);
});

it('rejects malformed executable and encoder names while retaining literal paths with spaces', () => {
  for (const value of ['', '  ', 'bad\0path', 42, null]) {
    assert.throws(() => new TranscodingService({ ffmpegPath: value as string, videoEncoder: 'libx264' }), /FFMPEG_PATH/);
    assert.throws(() => new FFprobeService({ ffprobePath: value as string }), /FFPROBE_PATH/);
    assert.throws(() => new TranscodingService({ videoEncoder: value as string }), /FFMPEG_VIDEO_ENCODER/);
  }
  assert.equal(new FFprobeService({ ffprobePath: '/literal path/ffprobe' }).ffprobePath, '/literal path/ffprobe');
  assert.equal(new TranscodingService({ ffmpegPath: '/literal path/ffmpeg', videoEncoder: 'libx264' }).ffmpegPath, '/literal path/ffmpeg');
  env('FFMPEG_PATH', '', () => assert.throws(() => new TranscodingService(), /FFMPEG_PATH/));
  env('FFPROBE_PATH', '', () => assert.throws(() => new FFprobeService(), /FFPROBE_PATH/));
  env('FFMPEG_VIDEO_ENCODER', '', () => assert.throws(() => getAvailableH264Encoder(), /FFMPEG_VIDEO_ENCODER/));
});

it('validates semaphore limits and direct lease timing without overflowing timers', () => {
  for (const value of [...invalid, 0, MAX_FFMPEG_INTEGER + 1]) assert.throws(() => new AsyncSemaphore(value as number), /integer/);
  assert.equal(new AsyncSemaphore(MAX_FFMPEG_INTEGER).maxConcurrency, MAX_FFMPEG_INTEGER);
  const db = {} as Pool;
  for (const value of [...invalid, 0, MAX_TIMER_MS + 1]) {
    assert.throws(() => new JobLease(db, 'job', 'token', value as number, performance.now()), /integer/);
  }
  assert.throws(() => new JobLease(db, 'job', 'token', 100, NaN), /finite/);
  assert.throws(() => new JobLease(db, 'job', 'token', 100, Number.MAX_VALUE), /finite/);
  const lease = new JobLease(db, 'job', 'token', MAX_TIMER_MS, performance.now());
  assert.equal(lease.signal.aborted, false);
  lease.stop();
});

it('rejects unsafe BullMQ lock and retry timings before creating a Redis connection', () => {
  for (const value of [0, NaN, Infinity, 1.5, MAX_TIMER_MS + 1]) {
    assert.throws(() => createMediaWorker({ workerOptions: { lockDuration: value } }), /lockDuration/);
    assert.throws(() => createMediaWorker({ workerOptions: { lockRenewTime: value } }), /lockRenewTime/);
    assert.throws(() => createMediaWorker({ concurrency: value }), /concurrency/);
    assert.throws(() => createMediaWorker({ workerOptions: { stalledInterval: value } }), /stalledInterval/);
  }
  assert.throws(() => createMediaWorker({ workerOptions: { lockDuration: 100, lockRenewTime: 100 } }), /lockRenewTime/);
  assert.throws(() => createMediaWorker({ workerOptions: { runRetryDelay: -1 } }), /runRetryDelay/);
  assert.throws(() => createMediaWorker({ workerOptions: { drainDelay: Infinity } }), /drainDelay/);
});

it('rejects invalid target arguments and source dimensions before encoding', async () => {
  const service = new TranscodingService({ videoEncoder: 'libx264' });
  const good = { inputFilePath: 'input', outputFilePath: 'output', targetWidth: 640, targetHeight: 360, bitrateKbps: 800, hasAudio: false };
  for (const value of [NaN, Infinity, -1, 0, 1.5, 641, 16385]) {
    await assert.rejects(service.transcodeVideo({ ...good, targetWidth: value }), /integer|even/);
  }
  for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(service.transcodeVideo({ ...good, bitrateKbps: value }), /integer/);
  }
  for (const value of [NaN, Infinity, 1.5, 16385]) {
    assert.throws(() => normalizeSourceDimensions({ width: value, height: 720 }), /Invalid source/);
  }
  assert.throws(() => normalizeSourceDimensions({ width: 1280, height: 720, rotation: Infinity }), /rotation/);
});
