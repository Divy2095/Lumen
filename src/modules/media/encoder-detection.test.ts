import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAvailableH264Encoder } from './transcoding.service.js';

async function executable(body: string, name = 'ffmpeg with spaces.ts') {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-encoder-'));
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { directory, path, close: async () => await rm(directory, { recursive: true, force: true }) };
}

for (const [encoders, expected] of [
  ['libopenh264 libx264', 'libx264'], ['libopenh264', 'libopenh264'], ['other_encoder', 'h264'],
]) {
  it(`selects ${expected} from a literal executable path containing spaces`, async () => {
    const f = await executable(`if (process.argv.slice(2).join(',') !== '-encoders') process.exit(9); console.log('${encoders}');`);
    try { assert.equal(getAvailableH264Encoder(f.path), expected); }
    finally { await f.close(); }
  });
}

it('treats shell metacharacters as literal filename characters', async () => {
  const f = await executable("console.log('libopenh264');", 'ffmpeg; exit 42;.ts');
  try {
    assert.equal(getAvailableH264Encoder(f.path), 'libopenh264');
  } finally { await f.close(); }
});

it('caches by executable path and preserves an explicit environment override', async () => {
  const a = await executable("console.log('libx264');");
  const b = await executable("console.log('libopenh264');");
  const override = process.env.FFMPEG_VIDEO_ENCODER;
  try {
    assert.equal(getAvailableH264Encoder(a.path), 'libx264');
    assert.equal(getAvailableH264Encoder(b.path), 'libopenh264');
    await writeFile(a.path, `#!${process.execPath}\nprocess.exit(1);\n`);
    assert.equal(getAvailableH264Encoder(a.path), 'libx264');
    process.env.FFMPEG_VIDEO_ENCODER = 'custom_encoder';
    assert.equal(getAvailableH264Encoder(b.path), 'custom_encoder');
  } finally {
    if (override === undefined) delete process.env.FFMPEG_VIDEO_ENCODER;
    else process.env.FFMPEG_VIDEO_ENCODER = override;
    await a.close(); await b.close();
  }
});

it('falls back on a missing executable, nonzero exit, and excessive stdout without poisoning retries', async () => {
  const f = await executable('process.exit(2);');
  try {
    assert.equal(getAvailableH264Encoder(join(f.directory, 'missing')), 'libx264');
    assert.equal(getAvailableH264Encoder(f.path), 'libx264');
    await writeFile(f.path, `#!${process.execPath}\nconsole.log('x'.repeat(2 * 1024 * 1024));\n`);
    assert.equal(getAvailableH264Encoder(f.path), 'libx264');
    await writeFile(f.path, `#!${process.execPath}\nconsole.log('libopenh264');\n`);
    assert.equal(getAvailableH264Encoder(f.path), 'libopenh264');
  } finally { await f.close(); }
});

it('kills and reaps a detection process that ignores SIGTERM when its timeout expires', async () => {
  const f = await executable(`import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.argv[1] + '.pid', String(process.pid));
setInterval(() => {}, 1000);`);
  try {
    const started = performance.now();
    assert.equal(getAvailableH264Encoder(f.path, 500), 'libx264');
    assert.ok(performance.now() - started < 3000);
    const pid = Number(await readFile(f.path + '.pid', 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await f.close(); }
});

it('invalid timeout values cannot disable the detection deadline', async () => {
  for (const timeout of [0, -1, NaN, Infinity]) {
    assert.throws(() => getAvailableH264Encoder('/unused-executable', timeout), /timeout/);
  }
});
