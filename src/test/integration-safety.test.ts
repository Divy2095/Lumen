import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient, QueryResult } from 'pg';
import { assertTestEnvironment, assertStoragePath } from './test-environment.js';
import { assertTestConnection, guardClient } from './db-guard.js';
import { readTestMigrationPlan } from './migration-plan.js';

const valid = { LUMEN_ALLOW_DESTRUCTIVE_TESTS: '1', LUMEN_TEST_DISPOSABLE_TOKEN: 'a'.repeat(64),
  PGHOST: 'postgres-test', PGPORT: '5432', PGDATABASE: 'lumen_test', PGUSER: 'lumen_test_runner',
  PGPASSWORD: 'b'.repeat(64), REDIS_HOST: 'redis-test', REDIS_PORT: '6379', REDIS_DB: '0',
  REDIS_PASSWORD: 'c'.repeat(64), STORAGE_BASE_DIR: '/lumen-test-storage/runtime' };
const identity = { database: 'lumen_test', role: 'lumen_test_runner', session_role: 'lumen_test_runner', port: 5432,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
  memberships: false, other_databases: false };
const marker = { purpose: 'lumen-disposable-integration-v1', token: valid.LUMEN_TEST_DISPOSABLE_TOKEN,
  owner: 'lumen_test_admin', schema_write: false, marker_write: false };
function fakeQuery(id = identity, proof = marker) {
  const calls: string[] = [];
  return { calls, query: async (text: string) => {
    calls.push(text);
    return { rows: text.includes('pg_catalog.pg_roles') ? [id] : text.includes('FROM lumen_test_safety') ? [proof] : [], rowCount: 1 } as QueryResult;
  } };
}

it('requires every exact endpoint, identity, opt-in, token, and storage setting', async () => {
  assert.equal(assertTestEnvironment(valid), valid.LUMEN_TEST_DISPOSABLE_TOKEN);
  for (const key of Object.keys(valid)) {
    const wrong = { ...valid, [key]: key === 'PGHOST' ? '127.0.0.1' : 'wrong' };
    const f = fakeQuery();
    await assert.rejects(assertTestConnection(f.query, wrong), /Test safety/);
    assert.equal(f.calls.length, 0);
    const missing = { ...valid } as NodeJS.ProcessEnv;
    delete missing[key];
    assert.throws(() => assertTestEnvironment(missing), /Test safety/);
  }
});

it('rejects unsafe connected identity and privileges without trusting environment names', async () => {
  for (const [key, value] of Object.entries({ database: 'lumen', role: 'lumen', session_role: 'admin', port: 5433,
    rolsuper: true, rolcreatedb: true, rolcreaterole: true, rolreplication: true, rolbypassrls: true, memberships: true, other_databases: true })) {
    const f = fakeQuery({ ...identity, [key]: value });
    await assert.rejects(assertTestConnection(f.query, valid), /SAFETY VIOLATION/);
    assert.equal(f.calls.length, 1);
  }
});

it('requires a matching administrator-owned marker with no runner write privileges', async () => {
  await assertTestConnection(fakeQuery().query, valid);
  for (const change of [{ token: 'd'.repeat(64) }, { owner: 'lumen_test_runner' }, { purpose: 'production' }, { schema_write: true }, { marker_write: true }]) {
    await assert.rejects(assertTestConnection(fakeQuery(identity, { ...marker, ...change }).query, valid), /SAFETY VIOLATION/);
  }
  await assert.rejects(assertTestConnection(async () => ({ rows: [], rowCount: 0 } as unknown as QueryResult), valid), /SAFETY VIOLATION/);
});

it('checks the same client before writes and supports pg callback queries', async () => {
  const originalEnv = process.env;
  process.env = { ...valid };
  const f = fakeQuery();
  const client = { query: f.query } as unknown as Pick<PoolClient, 'query'>;
  try {
    guardClient(client);
    await client.query('DELETE FROM test_rows');
    assert.equal(f.calls.length, 3);
    assert.match(f.calls[0]!, /pg_roles/);
    assert.match(f.calls[1]!, /disposable_environment/);
    assert.equal(f.calls[2], 'DELETE FROM test_rows');
    await new Promise<void>((resolve, reject) => client.query('SELECT 1', (error) => error ? reject(error) : resolve()));
    assert.equal(f.calls.at(-1), 'SELECT 1');
    delete process.env.LUMEN_ALLOW_DESTRUCTIVE_TESTS;
    const before = f.calls.length;
    await assert.rejects(client.query('TRUNCATE test_rows'), /opt-in/);
    assert.equal(f.calls.length, before);
    await client.query('ROLLBACK');
    assert.equal(f.calls.at(-1), 'ROLLBACK');
    await assert.rejects(client.query('ROLLBACK; DROP TABLE test_rows'), /opt-in/);
  } finally { process.env = originalEnv; }
});

it('refuses storage escapes, sibling prefixes, and symlinks before recursive removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-test-safety-'));
  try {
    const root = join(directory, 'root');
    await mkdir(root);
    await mkdir(join(directory, 'root-sibling'));
    await symlink(join(directory, 'root-sibling'), join(root, 'escape'));
    assert.doesNotThrow(() => assertStoragePath(root, join(root, 'new', 'file')));
    for (const path of [root, join(root, '..'), join(directory, 'root-sibling'), join(root, 'escape', 'file')]) {
      assert.throws(() => assertStoragePath(root, path), /Test safety/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('statically checks migration order and separates up SQL from destructive down SQL', async () => {
  const plan = await readTestMigrationPlan();
  assert.deepEqual(plan.map((p) => p.name), ['001_initial_schema.sql', '002_add_transcoding_config.sql', '003_webhook_contract.sql', '004_webhook_encryption_key_metadata.sql']);
  assert.match(plan[0]!.up, /CREATE TABLE media_assets/);
  assert.match(plan[1]!.up, /ADD COLUMN transcoding_config JSONB NULL/);
  for (const entry of plan) assert.doesNotMatch(entry.up, /^\s*(DROP|TRUNCATE|DELETE)\b/im);
  const compose = await readFile('compose.test.yaml', 'utf8');
  assert.doesNotMatch(compose, /container_name:|ports:|external:|postgres_data:|redis_data:/);
  assert.match(compose, /internal: true/);
  const init = await readFile('infra/test/init-postgres.sh', 'utf8');
  assert.match(init, /NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(init, /REVOKE CONNECT ON DATABASE postgres FROM PUBLIC/);
  assert.match(init, /GRANT SELECT ON lumen_test_safety/);
});
