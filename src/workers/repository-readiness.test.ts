import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('Git exposes required storage source and migration while ignoring runtime storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-git-ignore-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', directory]).status, 0);
    await copyFile('.gitignore', join(directory, '.gitignore'));
    await mkdir(join(directory, 'src/shared/storage'), { recursive: true });
    for (const [path, expected] of [['src/shared/storage/local-storage.service.ts', 1], ['migrations/002_add_transcoding_config.sql', 1], ['storage/.tmp/example.tmp', 0]] as const) {
      const result = spawnSync('git', ['check-ignore', '--no-index', path], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, expected, result.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
