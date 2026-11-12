import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Job } from 'bullmq';
import type { LumenJobPayload, LumenJobResult } from '../../workers/queue.js';
import { LocalStorageService } from '../../shared/storage/local-storage.service.js';
import { processJob } from '../../workers/processor.js';
import { FFprobeService } from './ffprobe.service.js';
import { TranscodingService } from './transcoding.service.js';

function raw(width = 640, height = 360, audio = true): any {
  return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0', tags: { major_brand: 'isom' } },
    streams: [{ codec_type: 'video', codec_name: 'h264', width, height },
      ...(audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : [])] };
}

async function run(output: unknown, overrides: Record<string, unknown> = {}, source = raw(1280, 720), content = 'encoded', maxOutputBytes = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-validation-'));
  const outputFilePath = join(directory, 'rendition.tmp');
  const executable = join(directory, 'ffmpeg.ts');
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1)!, ${JSON.stringify(content)});\n`, { mode: 0o700 });
  const parser = new FFprobeService();
  let probes = 0;
  const probe = { probe: async (path: string) => {
    probes++;
    return parser.parseMetadata(path === 'source' ? JSON.stringify(source) : typeof output === 'string' ? output : JSON.stringify(output));
  } } as unknown as FFprobeService;
  const service = new TranscodingService({ ffmpegPath: executable, videoEncoder: 'libx264', ffprobeService: probe, maxOutputBytes });
  const options = { inputFilePath: 'source', outputFilePath, targetWidth: 640, targetHeight: 360,
    bitrateKbps: 800, hasAudio: true, profile: '360p' as const, ...overrides };
  return { directory, service, probes: () => probes, execute: async () => await service.transcodeVideo(options),
    remaining: async () => await readdir(directory), close: async () => await rm(directory, { recursive: true, force: true }) };
}

const invalid: Array<[string, (value: any) => unknown]> = [
  ['invalid JSON', () => '{broken'],
  ['null response', () => null],
  ['missing format', (r) => { delete r.format; return r; }],
  ['nonobject format', (r) => { r.format = 'mp4'; return r; }],
  ['missing video', (r) => { r.streams = [r.streams[1]]; return r; }],
  ['nonarray streams', (r) => { r.streams = {}; return r; }],
  ['non-MP4 container', (r) => { r.format.format_name = 'matroska,webm'; return r; }],
  ['QuickTime brand', (r) => { r.format.tags.major_brand = 'qt  '; return r; }],
  ['malformed format name', (r) => { r.format.format_name = 123; return r; }],
  ['missing video codec', (r) => { delete r.streams[0].codec_name; return r; }],
  ['wrong video codec', (r) => { r.streams[0].codec_name = 'hevc'; return r; }],
  ['wrong dimensions', (r) => { r.streams[0].width = 638; return r; }],
  ['upscaled output', (r) => { r.streams[0].width = 1920; return r; }],
  ['boolean dimension', (r) => { r.streams[0].width = true; return r; }],
  ['fractional dimension', (r) => { r.streams[0].width = 640.5; return r; }],
  ['nonfinite dimension', (r) => { r.streams[0].width = Infinity; return r; }],
  ['missing expected audio', (r) => { r.streams.pop(); return r; }],
  ['wrong audio codec', (r) => { r.streams[1].codec_name = 'mp3'; return r; }],
  ['malformed audio codec', (r) => { r.streams[1].codec_name = {}; return r; }],
  ['unknown audio codec', (r) => { delete r.streams[1].codec_name; return r; }],
  ['invalid duration', (r) => { r.format.duration = '1oops'; return r; }],
];

for (const [name, mutate] of invalid) {
  it(`rejects ${name} and removes the temporary output`, async () => {
    const f = await run(mutate(raw()));
    try {
      await assert.rejects(f.execute());
      assert.deepEqual(await f.remaining(), ['ffmpeg.ts']);
      assert.equal(f.service.semaphore.activeCount, 0);
      assert.equal(f.probes(), 2);
    } finally { await f.close(); }
  });
}

it('accepts harmless missing tags, frame-rate/layout metadata, and a valid stream-duration fallback', async () => {
  const output = raw();
  delete output.format.tags;
  output.format.duration = 'N/A';
  output.streams[0].duration = '1.0';
  const f = await run(output, {}, raw(1280, 720), 'encoded', 7);
  try {
    const result = await f.execute();
    assert.equal(result.videoCodec, 'h264');
    assert.equal(result.audioCodec, 'aac');
    assert.equal(result.fileSizeBytes, 7);
    assert.equal(result.width, 640);
  } finally { await f.close(); }
});

it('accepts video-only source without requiring audio even when audio processing is enabled', async () => {
  const f = await run(raw(640, 360, false), {}, raw(1280, 720, false));
  try { assert.equal((await f.execute()).audioCodec, null); }
  finally { await f.close(); }
});

it('rejects unexpected audio in explicitly video-only output', async () => {
  const f = await run(raw(), { hasAudio: false });
  try {
    await assert.rejects(f.execute(), /audio/);
    assert.deepEqual(await f.remaining(), ['ffmpeg.ts']);
  } finally { await f.close(); }
});

it('accepts matching display dimensions with equivalent rotation metadata', async () => {
  const source = raw(1280, 720);
  source.streams[0].side_data_list = [{ side_data_type: 'Display Matrix', rotation: 90 }];
  const output = raw(640, 360);
  output.streams[0].side_data_list = [{ side_data_type: 'Display Matrix', rotation: 90 }];
  const f = await run(output, { targetWidth: 360, targetHeight: 640 }, source);
  try {
    const result = await f.execute();
    assert.equal(result.width, 360);
    assert.equal(result.height, 640);
  } finally { await f.close(); }
});

for (const [name, overrides] of [
  ['source upscaling', { targetWidth: 1920, targetHeight: 1080 }],
  ['incorrect profile dimensions', { targetWidth: 600, targetHeight: 338 }],
] as const) {
  it(`rejects ${name} before encoding`, async () => {
    const f = await run(raw(), overrides);
    try {
      await assert.rejects(f.execute(), /upscale|profile/);
      assert.equal(f.probes(), 1);
      assert.deepEqual(await f.remaining(), ['ffmpeg.ts']);
    } finally { await f.close(); }
  });
}

for (const [name, content, limit] of [['empty', '', 100], ['oversized', 'encoded', 6]] as const) {
  it(`rejects ${name} output before output probing`, async () => {
    const f = await run(raw(), {}, raw(1280, 720), content, limit);
    try {
      await assert.rejects(f.execute(), /nonempty|size/);
      assert.equal(f.probes(), 1);
      assert.deepEqual(await f.remaining(), ['ffmpeg.ts']);
    } finally { await f.close(); }
  });
}

it('worker rejects invalid probed output before promotion or transaction and preserves the current rendition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-validation-worker-'));
  const storage = new LocalStorageService(directory);
  await storage.init();
  const oldKey = 'media/project/asset/renditions/current.mp4';
  await mkdir(join(directory, 'media/project/asset/renditions'), { recursive: true });
  await writeFile(storage.resolvePath(oldKey), 'current committed rendition');
  await writeFile(storage.resolvePath('source.mp4'), 'source');
  const executable = join(directory, 'encoder.ts');
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1)!, 'encoded');\n`, { mode: 0o700 });
  const parser = new FFprobeService();
  const invalidOutput = raw();
  invalidOutput.streams[0].codec_name = 'hevc';
  const probe = { probe: async (path: string) => parser.parseMetadata(JSON.stringify(
    path.endsWith('source.mp4') ? raw(1280, 720) : invalidOutput)) } as unknown as FFprobeService;
  const transcoding = new TranscodingService({ ffmpegPath: executable, videoEncoder: 'libx264', ffprobeService: probe });
  let connections = 0;
  let parentWrites = 0;
  let jobQueued = false;
  let attemptFailed = false;
  const db = {
    query: async (sql: string | { text: string }) => {
      if (typeof sql !== 'string') return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE media_assets')) parentWrites++;
      if (sql.includes('RETURNING id, project_id')) return { rowCount: 1, rows: [{ id: 'job', current_attempt_number: 1 }] };
      if (sql.includes('SELECT id, project_id, storage_key')) return { rows: [{ storage_key: 'source.mp4' }] };
      if (sql.includes("SET status = 'queued'")) jobQueued = true;
      if (sql.includes('UPDATE job_attempts') && sql.includes("SET status = 'failed'")) attemptFailed = true;
      return { rowCount: 1, rows: [] };
    },
    connect: async () => { connections++; throw new Error('Invalid rendition must not reach transaction'); },
  } as unknown as Pool;
  const job = { name: 'transcode', data: { jobId: 'job', projectId: 'project', mediaAssetId: 'asset', operation: 'transcode',
    parameters: { profile: '360p', targetWidth: 640, targetHeight: 360, bitrateKbps: 800 } },
  } as unknown as Job<LumenJobPayload, LumenJobResult>;
  try {
    await assert.rejects(processJob(job, db, { storageService: storage, transcodingService: transcoding }), /H.264/);
    assert.equal(connections, 0);
    assert.equal(parentWrites, 0);
    assert.equal(jobQueued, true);
    assert.equal(attemptFailed, true);
    assert.deepEqual(await readdir(storage.getTempDir()), []);
    assert.equal(await readFile(storage.resolvePath(oldKey), 'utf8'), 'current committed rendition');
    assert.deepEqual(await readdir(join(directory, 'media/project/asset/renditions')), ['current.mp4']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
