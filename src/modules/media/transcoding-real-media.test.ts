import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FFprobeService } from './ffprobe.service.js';
import { TranscodingService } from './transcoding.service.js';
import { resolveTranscodingProfiles } from './transcoding-profiles.js';

it('validates real landscape, rotated, and video-only renditions without database services', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-real-media-'));
  const service = new TranscodingService({ timeoutMs: 10000 });
  const probe = new FFprobeService();
  const execute = promisify(execFile);
  try {
    const source = join(directory, 'source.mp4');
    await execute(service.ffmpegPath, ['-v', 'error', '-y', '-i', resolve('src/test/fixtures/valid_sample.mp4'),
      '-vf', 'scale=800:600', '-c:v', 'mpeg4', '-c:a', 'copy', source], { timeout: 10000 });
    const rotated = join(directory, 'rotated.mp4');
    await execute(service.ffmpegPath, ['-v', 'error', '-y', '-i', source, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotated], { timeout: 10000 });
    if ((await probe.probe(rotated)).video.rotation !== 90) {
      await execute(service.ffmpegPath, ['-v', 'error', '-y', '-display_rotation', '90', '-i', source, '-c', 'copy', rotated], { timeout: 10000 });
    }
    const silent = join(directory, 'silent.mp4');
    await execute(service.ffmpegPath, ['-v', 'error', '-y', '-i', source, '-c:v', 'copy', '-an', silent], { timeout: 10000 });
    for (const [index, path] of [source, rotated, silent].entries()) {
      const input = await probe.probe(path);
      const profile = resolveTranscodingProfiles({ source: input.video, config: { profiles: ['360p'] } }).eligible[0]!;
      const output = join(directory, `rendition-${index}.tmp`);
      const result = await service.transcodeVideo({ inputFilePath: path, outputFilePath: output,
        targetWidth: profile.targetWidth, targetHeight: profile.targetHeight, bitrateKbps: profile.bitrateKbps,
        hasAudio: true, profile: '360p' });
      const actual = await probe.probe(output);
      assert.equal(result.videoCodec, 'h264');
      assert.equal(actual.video.codec, 'h264');
      assert.ok(actual.containerFormat.split(',').includes('mp4'));
      assert.equal(result.width, profile.targetWidth);
      assert.equal(result.height, profile.targetHeight);
      assert.equal(actual.audio?.codec ?? null, index === 2 ? null : 'aac');
      assert.ok((await stat(output)).size > 0);
      assert.ok(result.fileSizeBytes <= service.maxOutputBytes);
      if (index === 1) {
        assert.equal(input.video.rotation, 90);
        assert.equal(result.width, 360);
        assert.equal(result.height, 480);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
