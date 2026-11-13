import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { generateApiKey } from '../../shared/crypto.js';
import { ProvisioningService, ProvisioningError, keyExpiration, validateProject, validateId, validateName } from './provisioning.service.js';

const accountId = '01900000-0000-7000-8000-000000000001';
const projectId = '01900000-0000-7000-8000-000000000002';
const target = { database: 'lumen', role: 'lumen' };
const now = new Date('2030-01-01T00:00:00Z');
const input = { projectId, name: 'Development' };
const project = { id: projectId, account_id: accountId, name: 'Example', status: 'active' };

function fixture(options: { fail?: string; commitRollback?: boolean; missingAccount?: boolean; missingProject?: boolean;
  inactive?: boolean; wrongProject?: boolean; wrongTarget?: boolean; rollbackFails?: boolean; duplicate?: boolean; suppressInsert?: boolean } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let generated = 0;
  const key = generateApiKey();
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === options.fail || (options.rollbackFails && sql === 'ROLLBACK')) throw new Error('sensitive database error');
    if (options.duplicate && sql.startsWith('INSERT INTO accounts')) throw Object.assign(new Error('private account detail'), { code: '23505' });
    let rows: unknown[] = [];
    if (sql.includes('current_database')) rows = [{ ...target, session_role: options.wrongTarget ? 'other' : 'lumen' }];
    else if (sql.startsWith('SELECT id FROM accounts')) rows = options.missingAccount ? [] : [{ id: accountId }];
    else if (sql.startsWith('INSERT INTO projects')) rows = [{ id: values[0], account_id: values[1], name: values[2], status: 'active' }];
    else if (sql.startsWith('SELECT id, account_id')) rows = options.missingProject ? [] : [{ ...project,
      ...(options.inactive ? { status: 'deletion_pending' } : {}), ...(options.wrongProject ? { id: accountId } : {}) }];
    return { rows, rowCount: options.suppressInsert && sql.startsWith('INSERT INTO api_keys') ? 0 : 1,
      command: sql === 'COMMIT' && options.commitRollback ? 'ROLLBACK' : sql.split(' ')[0] };
  } } as unknown as Pick<Client, 'query'>;
  const service = new ProvisioningService(db, target, () => { generated++; return key; }, () => now);
  return { service, calls, key, generated: () => generated };
}

it('creates new ownership metadata and active project atomically without email-based reuse', async () => {
  const f = fixture();
  const result = await f.service.createProject({ name: 'Example', email: 'Developer@Example.com' });
  assert.equal(result.status, 'active');
  const account = f.calls.find(c => c.sql.startsWith('INSERT INTO accounts'))!;
  assert.equal(account.values[1], 'developer@example.com');
  assert.equal(result.account_id, account.values[0]);
  assert.equal(f.calls[0]!.sql, 'BEGIN');
  assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
  assert.ok(!f.calls.some(c => c.sql.includes('WHERE email') || c.sql.includes('ON CONFLICT')));
});

it('selects existing accounts only by explicit UUID and never creates another account', async () => {
  const f = fixture();
  assert.equal((await f.service.createProject({ name: 'Example', accountId })).account_id, accountId);
  assert.ok(f.calls.some(c => c.sql.includes('accounts WHERE id = $1 FOR KEY SHARE') && c.values[0] === accountId));
  assert.ok(!f.calls.some(c => c.sql.startsWith('INSERT INTO accounts')));
});

it('rejects duplicate emails without reuse and rolls back', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(f.service.createProject({ name: 'Example', email: 'dev@example.com' }), { message: 'DUPLICATE_RECORD' });
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
  assert.ok(!f.calls.some(c => c.sql.startsWith('INSERT INTO projects')));
});

it('rejects missing account selection targets and rolls back', async () => {
  const f = fixture({ missingAccount: true });
  await assert.rejects(f.service.createProject({ name: 'Example', accountId }), { message: 'ACCOUNT_NOT_FOUND' });
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
});

it('strictly validates UUIDs, names, ownership selection, and conservative email syntax', () => {
  for (const value of ['', 'not-a-uuid', '../project', '00000000-0000-0000-0000-000000000000']) assert.throws(() => validateId(value));
  assert.equal(validateId(projectId.toUpperCase()), projectId);
  for (const value of ['', ' ', ' leading', 'trailing ', 'x'.repeat(101), 'a\nb', 'a\u001bb', 'a\u202eb']) assert.throws(() => validateName(value));
  assert.equal(validateName('x'.repeat(100)).length, 100);
  assert.equal(validateName('プロジェクト'), 'プロジェクト');
  for (const email of ['', 'x', 'x@y..com', '.x@example.com', 'x..y@example.com', 'x@-example.com', 'x@example-.com', 'a\nb@example.com', ' x@example.com', 'a'.repeat(65) + '@example.com']) {
    assert.throws(() => validateProject({ name: 'Example', email }));
  }
  assert.throws(() => validateProject({ name: 'Example' } as never));
  assert.throws(() => validateProject({ name: 'Example', accountId, email: 'dev@example.com' } as never));
  assert.throws(() => validateProject({ name: 'Example', accountId: 'bad' }));
});

it('validates default, explicit, and explicitly non-expiring lifetimes', () => {
  assert.equal(keyExpiration(input, now)!.getTime() - now.getTime(), 90 * 86400000);
  assert.equal(keyExpiration({ ...input, expiresAt: '2030-06-01T00:00:00Z' }, now)!.toISOString(), '2030-06-01T00:00:00.000Z');
  assert.equal(keyExpiration({ ...input, noExpiry: true }, now), null);
  for (const expiresAt of ['', '2030-02-30T00:00:00Z', '2030-06-01', '2030-06-01T00:00:00+00:00', '2029-01-01T00:00:00Z', now.toISOString(), 'Infinity']) {
    assert.throws(() => keyExpiration({ ...input, expiresAt }, now));
  }
  assert.throws(() => keyExpiration({ ...input, noExpiry: true, expiresAt: '2030-06-01T00:00:00Z' }, now));
  assert.throws(() => keyExpiration({ ...input, noExpiry: 'true' } as never, now));
});

it('persists only hash and metadata, binds the selected project, and returns secret after COMMIT', async () => {
  const f = fixture();
  const result = await f.service.issueKey(input);
  const insertion = f.calls.find(c => c.sql.startsWith('INSERT INTO api_keys'))!;
  assert.equal(insertion.values[1], projectId);
  assert.equal(insertion.values[4], f.key.hash);
  assert.ok(!JSON.stringify(f.calls).includes(f.key.apiKey));
  assert.ok(result.secret === f.key.apiKey);
  assert.equal(result.expiresAt!.getTime() - now.getTime(), 90 * 86400000);
  assert.ok(f.calls.some(c => c.sql.endsWith('FOR UPDATE')));
  assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
  assert.equal(f.generated(), 1);
});

it('persists explicit expiry or null only with opt-in', async () => {
  for (const expiry of [{ noExpiry: true }, { expiresAt: '2030-06-01T00:00:00Z' }]) {
    const f = fixture();
    const result = await f.service.issueKey({ ...input, ...expiry });
    assert.equal(f.calls.find(c => c.sql.startsWith('INSERT INTO api_keys'))!.values[5], result.expiresAt);
    assert.equal(result.expiresAt === null, 'noExpiry' in expiry);
  }
});

it('rejects suppressed inserts rather than returning an unpersisted credential', async () => {
  const f = fixture({ suppressInsert: true });
  await assert.rejects(f.service.issueKey(input), { message: 'DATABASE_OPERATION_FAILED' });
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
  assert.ok(!f.calls.some(c => c.sql === 'COMMIT'));
});

it('rolls back both ownership and project creation if project insertion fails', async () => {
  const f = fixture({ fail: "INSERT INTO projects (id, account_id, name, status) VALUES ($1, $2, $3, 'active') RETURNING id, account_id, name, status" });
  await assert.rejects(f.service.createProject({ name: 'Example', email: 'dev@example.com' }), { message: 'DATABASE_OPERATION_FAILED' });
  assert.ok(f.calls.some(c => c.sql.startsWith('INSERT INTO accounts')));
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
  assert.ok(!f.calls.some(c => c.sql === 'COMMIT'));
});

for (const [options, code] of [
  [{ inactive: true }, 'PROJECT_INACTIVE'], [{ missingProject: true }, 'PROJECT_NOT_FOUND'],
  [{ wrongProject: true }, 'PROJECT_IDENTITY_MISMATCH'], [{ wrongTarget: true }, 'DATABASE_IDENTITY_MISMATCH'],
] as const) it(`blocks issuance before generation: ${code}`, async () => {
  const f = fixture(options);
  await assert.rejects(f.service.issueKey(input), { message: code });
  assert.equal(f.generated(), 0);
  assert.ok(!f.calls.some(c => c.sql.startsWith('INSERT INTO api_keys')));
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
});

it('rejects invalid issuance before starting any database operation', async () => {
  const f = fixture();
  await assert.rejects(f.service.issueKey({ ...input, projectId: 'bad' }));
  await assert.rejects(f.service.issueKey({ ...input, name: '' }));
  await assert.rejects(f.service.issueKey({ ...input, expiresAt: '' }));
  assert.equal(f.calls.length, 0);
});

it('rolls back failed writes and suppresses database errors even when rollback also fails', async () => {
  const f = fixture({ fail: 'INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', rollbackFails: true });
  await assert.rejects(f.service.issueKey(input), { message: 'DATABASE_OPERATION_FAILED' });
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
  assert.ok(!f.calls.some(c => c.sql === 'COMMIT'));
});

for (const options of [{ fail: 'COMMIT' }, { commitRollback: true }]) it('never reveals or retries issuance when COMMIT is not confirmed', async () => {
  const f = fixture(options);
  await assert.rejects(f.service.issueKey(input), error => {
    assert.ok(error instanceof ProvisioningError);
    assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.equal(error.recovery!.projectId, projectId);
    assert.ok(uuidLike(error.recovery!.keyId));
    assert.ok(!JSON.stringify(error).includes(f.key.apiKey));
    return true;
  });
  assert.equal(f.generated(), 1);
  assert.equal(f.calls.filter(c => c.sql.startsWith('INSERT INTO api_keys')).length, 1);
});
function uuidLike(value: string | undefined) { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }

it('reports non-secret recovery IDs for uncertain project creation', async () => {
  const f = fixture({ fail: 'COMMIT' });
  await assert.rejects(f.service.createProject({ name: 'Example', email: 'dev@example.com' }), error => {
    assert.ok(error instanceof ProvisioningError);
    assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.ok(uuidLike(error.recovery!.accountId));
    assert.ok(uuidLike(error.recovery!.projectId));
    return true;
  });
});

it('lists project ownership metadata and previews only the requested active project', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.listProjects(), [project]);
  assert.deepEqual(await f.service.getProject(projectId), project);
  assert.ok(f.calls.some(c => c.sql.endsWith('WHERE id = $1') && c.values[0] === projectId));
  await assert.rejects(fixture({ missingProject: true }).service.getProject(projectId), { message: 'PROJECT_NOT_FOUND' });
  await assert.rejects(fixture({ inactive: true }).service.getProject(projectId), { message: 'PROJECT_INACTIVE' });
});
