import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import type { Job } from 'bullmq';
import { LocalStorageService } from '../shared/storage/local-storage.service.js';
import { TranscodingService } from '../modules/media/transcoding.service.js';
import type { FFprobeService } from '../modules/media/ffprobe.service.js';
import { processJob } from './processor.js';
import { RetryProcessingError } from './job-lease.js';
import type { LumenJobPayload, LumenJobResult } from './queue.js';

type Boundary = 'encoding' | 'probing' | 'promotion' | 'connection' | 'begin' | 'lock' |
  'version' | 'demotion' | 'insert' | 'completion' | 'attempt' | 'commit-ack' | 'commit-reject' |
  'cancellation' | 'revocation' | 'release' | 'collision';

async function fixture(boundary?: Boundary, rollbackFails = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-rendition-'));
  const storage = new LocalStorageService(directory);
  await storage.init();
  const oldKey = 'media/project/asset/renditions/previous.mp4';
  await mkdir(dirname(storage.resolvePath(oldKey)), { recursive: true });
  await writeFile(storage.resolvePath(oldKey), 'previous committed output');
  await writeFile(storage.resolvePath('source.mp4'), 'input');
  const cancellation = new AbortController();
  const state = { boundary, status: 'queued', currentKey: oldKey, stagedKey: '',
    publications: [] as string[], releases: [] as boolean[], revoked: false, calls: 0 };
  const fail = (at: Boundary) => { if (state.boundary === at) throw new Error(`injected ${at}`); };
  const poolQuery = async (sql: string | { text: string }) => {
    if (typeof sql !== 'string') return { rowCount: state.revoked ? 0 : 1, rows: [] };
    if (sql.includes('RETURNING id, project_id')) {
      if (state.status !== 'queued') return { rowCount: 0, rows: [] };
      state.status = 'processing';
      return { rowCount: 1, rows: [{ id: 'job', current_attempt_number: 1 }] };
    }
    if (sql.includes('SELECT id, status')) return { rows: [{ status: state.status, current_attempt_number: 1 }] };
    if (sql.includes('SELECT id, project_id, storage_key')) return { rows: [{ storage_key: 'source.mp4', audio_codec: null, metadata: {} }] };
    if (sql.includes("SET status = 'queued'") && state.status === 'processing') state.status = 'queued';
    return { rowCount: 1, rows: [] };
  };
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN') fail('begin');
      if (sql.includes('SELECT id FROM processing_jobs') && state.boundary === 'lock') return { rowCount: 0, rows: [] };
      if (sql.includes('MAX(version)')) { fail('version'); return { rows: [{ next_version: '2' }] }; }
      if (sql.includes('UPDATE media_outputs')) fail('demotion');
      if (sql.includes('INSERT INTO media_outputs')) { fail('insert'); state.stagedKey = String(values?.[5]); }
      if (sql.includes("SET status = 'completed'")) {
        if (sql.includes('UPDATE processing_jobs') && state.boundary === 'completion') return { rowCount: 0, rows: [] };
        if (sql.includes('UPDATE job_attempts')) fail('attempt');
      }
      if (sql === 'COMMIT') {
        fail('commit-reject');
        state.currentKey = state.stagedKey;
        state.status = 'completed';
        fail('commit-ack');
      }
      if (sql === 'ROLLBACK') {
        if (rollbackFails) throw new Error('injected rollback');
        state.stagedKey = '';
      }
      return { rowCount: 1, rows: [{ id: 'job' }] };
    },
    release: (destroy: boolean) => { state.releases.push(destroy); fail('release'); },
  };
  const db = { query: poolQuery, connect: async () => { fail('connection'); return client; } } as unknown as Pool;
  const publish = storage.commitFile.bind(storage);
  storage.commitFile = async (source, key) => {
    fail('promotion');
    if (state.boundary === 'collision') {
      await writeFile(storage.resolvePath(key), 'already committed current');
      state.currentKey = key;
    }
    await publish(source, key);
    state.publications.push(key);
    if (state.boundary === 'cancellation') cancellation.abort();
  };
  const transcoding = { transcodeVideo: async ({ outputFilePath }: { outputFilePath: string }) => {
    state.calls++;
    await writeFile(outputFilePath, 'new rendition');
    fail('encoding'); fail('probing');
    if (state.boundary === 'revocation') state.revoked = true;
    return { width: 640, height: 360, fileSizeBytes: 13, mimeType: 'video/mp4', videoCodec: 'h264', durationSeconds: 1 };
  } } as unknown as TranscodingService;
  const job = { name: 'transcode', data: { jobId: 'job', projectId: 'project', mediaAssetId: 'asset',
    operation: 'transcode', parameters: { profile: '360p', targetWidth: 640, targetHeight: 360, bitrateKbps: 800 } },
  } as unknown as Job<LumenJobPayload, LumenJobResult>;
  return { directory, storage, state, oldKey,
    run: async () => await processJob(job, db, { storageService: storage, transcodingService: transcoding, signal: cancellation.signal }),
    close: async () => await rm(directory, { recursive: true, force: true }) };
}

for (const boundary of ['encoding', 'probing', 'promotion', 'connection', 'begin', 'lock', 'version',
  'demotion', 'insert', 'completion', 'attempt', 'cancellation', 'revocation'] as const) {
  it(`cleans only this rendition attempt on ${boundary} failure`, async () => {
    const f = await fixture(boundary);
    try {
      await assert.rejects(f.run());
      assert.equal(f.state.currentKey, f.oldKey);
      assert.equal(await readFile(f.storage.resolvePath(f.oldKey), 'utf8'), 'previous committed output');
      assert.deepEqual(await readdir(f.storage.getTempDir()), []);
      assert.deepEqual(await readdir(dirname(f.storage.resolvePath(f.oldKey))), ['previous.mp4']);
    } finally { await f.close(); }
  });
}

it('destroys a connection after failed rollback and cleans its never-committed file', async () => {
  const f = await fixture('insert', true);
  try {
    await assert.rejects(f.run(), /injected insert/);
    assert.deepEqual(f.state.releases, [true]);
    assert.equal(await f.storage.fileExists(f.state.publications[0]!), false);
    assert.equal(await f.storage.fileExists(f.oldKey), true);
  } finally { await f.close(); }
});

it('preserves a committed current output when the COMMIT acknowledgement is lost', async () => {
  const f = await fixture('commit-ack');
  try {
    await assert.rejects(f.run(), RetryProcessingError);
    const key = f.state.currentKey;
    assert.notEqual(key, f.oldKey);
    assert.equal(await readFile(f.storage.resolvePath(key), 'utf8'), 'new rendition');
    const result = await f.run();
    assert.equal('status' in result && result.status, 'already_completed');
    assert.equal(f.state.calls, 1);
    assert.equal(await f.storage.fileExists(key), true);
    assert.deepEqual(await readdir(f.storage.getTempDir()), []);
  } finally { await f.close(); }
});

it('retains an unreferenced output if a COMMIT attempt fails without a confirmed outcome', async () => {
  const f = await fixture('commit-reject');
  try {
    await assert.rejects(f.run(), RetryProcessingError);
    assert.equal(f.state.currentKey, f.oldKey);
    assert.equal(await f.storage.fileExists(f.state.publications[0]!), true);
    assert.deepEqual(await readdir(f.storage.getTempDir()), []);
  } finally { await f.close(); }
});

it('successful completion and a post-commit release failure never delete committed files', async () => {
  for (const boundary of [undefined, 'release'] as const) {
    const f = await fixture(boundary);
    try {
      if (boundary) await assert.rejects(f.run(), /injected release/);
      else { const result = await f.run(); assert.equal('status' in result && result.status, 'completed'); }
      assert.equal(f.state.status, 'completed');
      assert.equal(await f.storage.fileExists(f.state.currentKey), true);
      assert.equal(await f.storage.fileExists(f.oldKey), true);
      assert.deepEqual(await readdir(f.storage.getTempDir()), []);
    } finally { await f.close(); }
  }
});

it('a retry after connection failure uses a fresh output and leaves no partial attempt', async () => {
  const f = await fixture('connection');
  try {
    await assert.rejects(f.run(), /injected connection/);
    const abandoned = f.state.publications[0]!;
    f.state.boundary = undefined;
    await f.run();
    assert.equal(await f.storage.fileExists(abandoned), false);
    assert.notEqual(f.state.currentKey, abandoned);
    assert.equal(await f.storage.fileExists(f.state.currentKey), true);
    assert.equal(f.state.calls, 2);
  } finally { await f.close(); }
});

it('real transcoding service removes output when output probing fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-probe-cleanup-'));
  try {
    const executable = join(directory, 'fake-ffmpeg.ts');
    const output = join(directory, 'output.tmp');
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1)!, 'encoded');\n`, { mode: 0o700 });
    const service = new TranscodingService({ ffmpegPath: executable, videoEncoder: 'libx264',
      ffprobeService: { probe: async (path: string) => {
        if (path === 'input') return { video: { width: 1280, height: 720 } };
        throw new Error('injected output probe failure');
      } } as unknown as FFprobeService });
    await assert.rejects(service.transcodeVideo({ inputFilePath: 'input', outputFilePath: output,
      targetWidth: 640, targetHeight: 360, bitrateKbps: 800, hasAudio: false }), /injected output probe failure/);
    assert.deepEqual(await readdir(directory), ['fake-ffmpeg.ts']);
    assert.equal(service.semaphore.activeCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('a promotion collision never overwrites or deletes an existing current file', async () => {
  const f = await fixture('collision');
  try {
    await assert.rejects(f.run(), { code: 'EEXIST' });
    assert.equal(await readFile(f.storage.resolvePath(f.state.currentKey), 'utf8'), 'already committed current');
    assert.deepEqual(await readdir(f.storage.getTempDir()), []);
    assert.equal(await f.storage.fileExists(f.oldKey), true);
  } finally { await f.close(); }
});

it('cancellation during output probing prevents publication and cleans the completed temp output', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-probe-cancel-'));
  try {
    const executable = join(directory, 'fake-ffmpeg.ts');
    const output = join(directory, 'output.tmp');
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1)!, 'encoded');\n`, { mode: 0o700 });
    let started!: () => void;
    const probing = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const proceed = new Promise<void>((resolve) => { finish = resolve; });
    const service = new TranscodingService({ ffmpegPath: executable, videoEncoder: 'libx264',
      ffprobeService: { probe: async (path: string) => {
        if (path === 'input') return { video: { width: 1280, height: 720 } };
        started(); await proceed;
        return { containerFormat: 'mov,mp4', video: { width: 640, height: 360, codec: 'h264' }, durationSeconds: 1 };
      } } as unknown as FFprobeService });
    const controller = new AbortController();
    const work = service.transcodeVideo({ inputFilePath: 'input', outputFilePath: output,
      targetWidth: 640, targetHeight: 360, bitrateKbps: 800, hasAudio: false, signal: controller.signal });
    const rejected = assert.rejects(work, /cancelled during probe/);
    await probing;
    controller.abort(new Error('cancelled during probe'));
    finish();
    await rejected;
    assert.deepEqual(await readdir(directory), ['fake-ffmpeg.ts']);
    assert.equal(service.semaphore.activeCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
