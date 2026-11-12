import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';

export const TEST_STORAGE_ROOT = '/lumen-test-storage';
export const TEST_DATABASE = 'lumen_test';
export const TEST_ROLE = 'lumen_test_runner';

export function assertTestEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LUMEN_ALLOW_DESTRUCTIVE_TESTS !== '1') throw new Error('Test safety: explicit destructive-test opt-in is required');
  const exact = { PGHOST: 'postgres-test', PGPORT: '5432', PGDATABASE: TEST_DATABASE,
    PGUSER: TEST_ROLE, REDIS_HOST: 'redis-test', REDIS_PORT: '6379', REDIS_DB: '0' };
  for (const [key, value] of Object.entries(exact)) {
    if (env[key] !== value) throw new Error(`Test safety: ${key} is not allowlisted`);
  }
  for (const key of ['LUMEN_TEST_DISPOSABLE_TOKEN', 'PGPASSWORD', 'REDIS_PASSWORD']) {
    if (!/^[a-f0-9]{64}$/.test(env[key] ?? '')) throw new Error(`Test safety: ${key} must be 64 lowercase hex characters`);
  }
  const storage = env.STORAGE_BASE_DIR ?? '';
  if (!storage.startsWith(`${TEST_STORAGE_ROOT}/`) || storage.includes('..')) throw new Error('Test safety: storage must be disposable');
  return env.LUMEN_TEST_DISPOSABLE_TOKEN!;
}

export function assertStoragePath(root: string, path: string): void {
  if (realpathSync(root) !== root) throw new Error('Test safety: storage root is not canonical');
  if (path !== resolve(path)) throw new Error('Test safety: storage path is not normalized');
  const suffix = relative(root, path);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Test safety: storage escapes disposable root');
  let current = root;
  for (const component of suffix.split(sep)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Test safety: storage symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

export function prepareTestStorage(): void {
  const token = assertTestEnvironment();
  if (realpathSync(TEST_STORAGE_ROOT) !== TEST_STORAGE_ROOT) throw new Error('Test safety: invalid storage root');
  const marker = join(TEST_STORAGE_ROOT, '.disposable');
  assertStoragePath(TEST_STORAGE_ROOT, marker);
  try { writeFileSync(marker, token, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (readFileSync(marker, 'utf8') !== token) throw new Error('Test safety: storage marker mismatch');
}

export function testStorageDirectory(name: string): string {
  const token = assertTestEnvironment();
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Test safety: invalid fixture directory');
  assertStoragePath(TEST_STORAGE_ROOT, join(TEST_STORAGE_ROOT, '.disposable'));
  if (readFileSync(join(TEST_STORAGE_ROOT, '.disposable'), 'utf8') !== token) throw new Error('Test safety: storage marker mismatch');
  const path = join(TEST_STORAGE_ROOT, name);
  assertStoragePath(TEST_STORAGE_ROOT, path);
  mkdirSync(path, { recursive: true });
  return path;
}

export async function removeTestStorage(path: string): Promise<void> {
  const token = assertTestEnvironment();
  assertStoragePath(TEST_STORAGE_ROOT, join(TEST_STORAGE_ROOT, '.disposable'));
  if (readFileSync(join(TEST_STORAGE_ROOT, '.disposable'), 'utf8') !== token) throw new Error('Test safety: storage marker mismatch');
  assertStoragePath(TEST_STORAGE_ROOT, path);
  rmSync(path, { recursive: true, force: true });
}
