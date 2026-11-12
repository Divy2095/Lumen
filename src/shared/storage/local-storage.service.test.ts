import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, utimes } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { LocalStorageService } from './local-storage.service.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-storage-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'root-sibling');
  await mkdir(outside);
  const storage = new LocalStorageService(root);
  await storage.init();
  return { directory, root, outside, storage, close: async () => await rm(directory, { recursive: true, force: true }) };
}

it('accepts existing keys and nonexistent nested outputs under a relative configured root', async () => {
  const f = await fixture();
  try {
    const storage = new LocalStorageService(relative(process.cwd(), f.root));
    assert.equal(storage.resolvePath('media/project/asset/renditions/new.mp4'), join(f.root, 'media/project/asset/renditions/new.mp4'));
    assert.equal(storage.resolvePath('media/../valid.mp4'), join(f.root, 'valid.mp4'));
    assert.equal(await storage.fileExists('missing.mp4'), false);
  } finally { await f.close(); }
});

it('initializes a nonexistent storage root through its real existing ancestor', async () => {
  const f = await fixture();
  try {
    const root = join(f.directory, 'missing', 'nested');
    const storage = new LocalStorageService(root);
    assert.equal(storage.resolvePath('media/new.mp4'), join(root, 'media/new.mp4'));
    await storage.init();
    assert.equal((await stat(storage.getTempDir())).isDirectory(), true);
  } finally { await f.close(); }
});

it('rejects traversal, absolute keys, sibling-prefix paths, empty keys, and the root itself', async () => {
  const f = await fixture();
  try {
    for (const key of ['', '.', '..', '../root-sibling/file', '../../etc/passwd', '/etc/passwd', join(f.root, 'file'), 'C:\\outside\\file', '\\outside', 'bad\0key']) {
      assert.throws(() => f.storage.resolvePath(key), /Security violation/);
    }
    await writeFile(join(f.outside, 'keep'), 'outside');
    assert.equal(await f.storage.fileExists(join(f.outside, 'keep')), false);
    assert.equal(await f.storage.unlinkFile(join(f.outside, 'keep')), false);
    assert.equal(await readFile(join(f.outside, 'keep'), 'utf8'), 'outside');
  } finally { await f.close(); }
});

it('rejects escaping, internal, and dangling symlinks for existing and missing leaves', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'inside'));
    await writeFile(join(f.outside, 'keep'), 'outside');
    await symlink(f.outside, join(f.root, 'escape'));
    await symlink(join(f.root, 'inside'), join(f.root, 'internal'));
    await symlink(join(f.outside, 'missing'), join(f.root, 'dangling'));
    await symlink(join(f.outside, 'keep'), join(f.root, 'leaf'));
    for (const key of ['escape/keep', 'escape/new/deep.mp4', 'internal/new', 'dangling', 'dangling/new', 'leaf']) {
      assert.throws(() => f.storage.resolvePath(key), /symlink/);
      assert.equal(await f.storage.fileExists(key), false);
    }
    assert.equal(await f.storage.unlinkFile(join(f.root, 'leaf')), false);
    assert.equal(await readFile(join(f.outside, 'keep'), 'utf8'), 'outside');
  } finally { await f.close(); }
});

it('supports a configured root symlink while rejecting symlinks below its canonical target', async () => {
  const f = await fixture();
  try {
    const alias = join(f.directory, 'alias');
    await symlink(f.root, alias);
    const storage = new LocalStorageService(alias);
    await storage.init();
    assert.equal(storage.resolvePath('file'), join(f.root, 'file'));
    await symlink(f.outside, join(f.root, 'link'));
    assert.throws(() => storage.resolvePath('link/file'), /symlink/);
  } finally { await f.close(); }
});

it('validates temp names and exclusively creates upload streams', async () => {
  const f = await fixture();
  try {
    for (const name of ['../escape', '/absolute', '.', '..', 'nested/file', 'bad\\name']) {
      assert.throws(() => f.storage.createTempWriteStream(name), /Invalid|Security/);
    }
    assert.throws(() => f.storage.createTempFilePath('../escape'), /Invalid/);
    const { writeStream, tempFilePath } = f.storage.createTempWriteStream('asset.upload.tmp');
    writeStream.end('upload');
    await finished(writeStream);
    assert.equal(await readFile(tempFilePath, 'utf8'), 'upload');
    const duplicate = f.storage.createTempWriteStream('asset.upload.tmp');
    duplicate.writeStream.end('overwrite');
    await assert.rejects(finished(duplicate.writeStream), { code: 'EEXIST' });
    assert.equal(await readFile(tempFilePath, 'utf8'), 'upload');
  } finally { await f.close(); }
});

it('publishes a regular temp file atomically without replacing existing output', async () => {
  const f = await fixture();
  try {
    const source = f.storage.createTempFilePath();
    await writeFile(source, 'first');
    await f.storage.commitFile(source, 'media/output.mp4');
    assert.equal(await readFile(f.storage.resolvePath('media/output.mp4'), 'utf8'), 'first');
    assert.equal(await f.storage.fileExists(source), false);
    const second = f.storage.createTempFilePath();
    await writeFile(second, 'second');
    await assert.rejects(f.storage.commitFile(second, 'media/output.mp4'), { code: 'EEXIST' });
    assert.equal(await readFile(f.storage.resolvePath('media/output.mp4'), 'utf8'), 'first');
    assert.equal(await readFile(second, 'utf8'), 'second');
  } finally { await f.close(); }
});

it('refuses promotion from outside temp storage or through source/destination symlinks', async () => {
  const f = await fixture();
  try {
    const source = f.storage.createTempFilePath();
    await writeFile(source, 'temp');
    await writeFile(join(f.outside, 'keep'), 'outside');
    await writeFile(join(f.root, 'not-temp'), 'inside');
    await symlink(f.outside, join(f.root, 'destination'));
    await symlink(join(f.outside, 'keep'), join(f.storage.getTempDir(), 'linked.tmp'));
    await assert.rejects(f.storage.commitFile(source, 'destination/new/file'), /symlink/);
    await assert.rejects(f.storage.commitFile(join(f.storage.getTempDir(), 'linked.tmp'), 'file'), /symlink/);
    await assert.rejects(f.storage.commitFile(join(f.root, 'not-temp'), 'file'), /temporary/);
    await assert.rejects(f.storage.commitFile(join(f.outside, 'keep'), 'file'), /Security/);
    assert.equal(await readFile(join(f.outside, 'keep'), 'utf8'), 'outside');
    await assert.rejects(stat(join(f.outside, 'new')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

it('refuses a substituted temp directory and never sweeps symlink targets', async () => {
  const f = await fixture();
  try {
    const stale = join(f.outside, 'keep');
    await writeFile(stale, 'outside');
    await utimes(stale, new Date(0), new Date(0));
    await symlink(stale, join(f.storage.getTempDir(), 'linked.tmp'));
    const result = await f.storage.cleanupStaleTempFiles(1);
    assert.equal(result.deleted, 0);
    assert.equal(result.errors, 1);
    assert.equal(await readFile(stale, 'utf8'), 'outside');
    await rm(f.storage.getTempDir(), { recursive: true });
    await symlink(f.outside, join(f.root, '.tmp'));
    assert.throws(() => f.storage.createTempFilePath(), /symlink/);
    await assert.rejects(f.storage.init(), /symlink/);
  } finally { await f.close(); }
});

it('a failed temp unlink after publication does not report promotion failure', async () => {
  const f = await fixture();
  try {
    const source = f.storage.createTempFilePath();
    await writeFile(source, 'published');
    f.storage.unlinkFile = async () => false;
    await f.storage.commitFile(source, 'output.mp4');
    assert.equal(await readFile(f.storage.resolvePath('output.mp4'), 'utf8'), 'published');
    assert.equal(await readFile(source, 'utf8'), 'published');
  } finally { await f.close(); }
});

it('a replaced canonical root cannot redirect later storage operations', async () => {
  const f = await fixture();
  try {
    await rm(f.root, { recursive: true });
    await symlink(f.outside, f.root);
    assert.throws(() => f.storage.resolvePath('new.mp4'), /Security violation/);
    await assert.rejects(f.storage.init(), /Security violation/);
    await assert.rejects(stat(join(f.outside, '.tmp')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

it('stale cleanup preserves active uploads and fails closed when ownership checks fail', async () => {
  const f = await fixture();
  try {
    const path = join(f.storage.getTempDir(), '00000000-0000-0000-0000-000000000001.upload.tmp');
    await writeFile(path, 'active upload');
    await utimes(path, new Date(0), new Date(0));
    const active = await f.storage.cleanupStaleTempFiles(1, async () => true);
    assert.equal(active.deleted, 0);
    assert.equal(await f.storage.fileExists(path), true);
    const uncertain = await f.storage.cleanupStaleTempFiles(1, async () => { throw new Error('ownership unavailable'); });
    assert.equal(uncertain.errors, 1);
    assert.equal(await f.storage.fileExists(path), true);
    const orphan = await f.storage.cleanupStaleTempFiles(1, async () => false);
    assert.equal(orphan.deleted, 1);
    assert.equal(await f.storage.fileExists(path), false);
  } finally { await f.close(); }
});
