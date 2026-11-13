import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { generateApiKey } from '../../shared/crypto.js';
import { ProvisioningError, ProvisioningService } from './provisioning.service.js';

const projectId = '01900000-0000-7000-8000-000000000002';
const keyId = '01900000-0000-7000-8000-000000000003';
const otherProject = '01900000-0000-7000-8000-000000000004';
const target = { database: 'lumen', role: 'lumen' };
const selected = { projectId, keyId };
const rotation = { ...selected, name: 'Replacement' };
type Row = { id: string; project_id: string; name: string; key_prefix: string; key_hash: string;
  created_at: Date; expires_at: Date | null; revoked_at: Date | null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// Models transaction visibility and lock waits; actual PostgreSQL locking is reserved for integration tests.
function fixture() {
  const credential = generateApiKey();
  const state = {
    now: new Date('2030-01-01T00:00:00Z'), inactive: false, missingProject: false, mismatchProject: false,
    mismatchKey: false, failInsert: false, failUpdate: false, suppressUpdate: false, commitUnknown: false, wrongTarget: false,
    keys: new Map<string, Row>([[keyId, { id: keyId, project_id: projectId, name: 'Predecessor',
      key_prefix: credential.keyPrefix, key_hash: credential.hash, created_at: new Date('2029-01-01T00:00:00Z'),
      expires_at: new Date('2031-01-01T00:00:00Z'), revoked_at: null }]]),
  };
  const calls: Array<{ connection: string; sql: string; values: unknown[] }> = [];
  const generated: ReturnType<typeof generateApiKey>[] = [];
  const hooks: { beforeProjectLock?: (name: string) => void; afterKeyLock?: (name: string) => Promise<void> } = {};
  let lockTail = Promise.resolve();
  const service = (name = 'operator') => {
    let release: (() => void) | undefined;
    let working: Map<string, Row> | undefined;
    const unlock = () => { release?.(); release = undefined; working = undefined; };
    const db = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ connection: name, sql, values });
      const reply = (rows: unknown[] = [], rowCount = rows.length, command = sql.split(' ')[0]) => ({ rows, rowCount, command });
      if (sql === 'BEGIN') return reply([], 0);
      if (sql === 'COMMIT') {
        if (working) state.keys = working;
        unlock();
        if (state.commitUnknown) throw new Error('sensitive COMMIT transport error');
        return reply([], 0);
      }
      if (sql === 'ROLLBACK') { unlock(); return reply([], 0); }
      if (sql.includes('current_database()')) return reply([{ ...target, session_role: state.wrongTarget ? 'other' : target.role }]);
      if (sql.includes('FROM projects')) {
        if (sql.endsWith('FOR UPDATE')) {
          hooks.beforeProjectLock?.(name);
          const previous = lockTail;
          const next = deferred(); lockTail = next.promise;
          await previous;
          release = next.resolve;
          working = new Map([...state.keys].map(([id, row]) => [id, { ...row }]));
        }
        if (state.missingProject || values[0] !== projectId) return reply();
        return reply([{ id: state.mismatchProject ? otherProject : projectId,
          account_id: otherProject, name: 'Example', status: state.inactive ? 'deletion_pending' : 'active' }]);
      }
      if (sql.includes('clock_timestamp() AS checked_at')) return reply([{ checked_at: state.now }]);
      const keys = working ?? state.keys;
      if (sql.startsWith('SELECT') && sql.includes('FROM api_keys')) {
        if (sql.endsWith('FOR UPDATE')) await hooks.afterKeyLock?.(name);
        let rows = [...keys.values()].filter(row => row.project_id === values[0] && (values[1] === undefined || row.id === values[1]));
        rows = rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
        return reply(rows.map(row => ({ ...row, ...(state.mismatchKey ? { project_id: otherProject } : {}), checked_at: state.now })));
      }
      if (sql.startsWith('UPDATE api_keys')) {
        if (state.failUpdate) throw new Error('sensitive UPDATE detail');
        const row = keys.get(values[1] as string);
        if (!row || row.project_id !== values[0] || state.suppressUpdate) return reply();
        const updated = { ...row, revoked_at: row.revoked_at ?? state.now };
        keys.set(updated.id, updated);
        return reply([updated]);
      }
      if (sql.startsWith('INSERT INTO api_keys')) {
        if (state.failInsert) throw new Error('sensitive INSERT detail');
        const [id, project_id, name, key_prefix, key_hash, expires_at] = values as [string, string, string, string, string, Date | null];
        keys.set(id, { id, project_id, name, key_prefix, key_hash, expires_at, created_at: state.now, revoked_at: null });
        return reply([], 1);
      }
      throw new Error('Unexpected query in lifecycle fixture');
    } } as unknown as Pick<Client, 'query'>;
    return new ProvisioningService(db, target, () => { const key = generateApiKey(); generated.push(key); return key; }, () => state.now);
  };
  return { state, calls, generated, hooks, service, credential };
}

it('lists deterministic scoped metadata with active/expired/revoked status and excludes hashes/secrets', async () => {
  const f = fixture();
  const predecessor = f.state.keys.get(keyId)!;
  f.state.keys.set(otherProject, { ...predecessor, id: otherProject, expires_at: f.state.now });
  const revokedId = '01900000-0000-7000-8000-000000000005';
  f.state.keys.set(revokedId, { ...predecessor, id: revokedId, expires_at: f.state.now, revoked_at: new Date('2029-06-01T00:00:00Z') });
  f.state.keys.set('foreign', { ...predecessor, id: 'foreign', project_id: otherProject });
  const result = await f.service().listKeys(projectId);
  assert.deepEqual(result.map(row => row.id), [keyId, otherProject, revokedId]);
  assert.deepEqual(result.map(row => row.status), ['active', 'expired', 'revoked']);
  assert.deepEqual(Object.keys(result[0]!).sort(), ['id', 'projectId', 'name', 'keyPrefix', 'createdAt', 'expiresAt', 'revokedAt', 'status'].sort());
  assert.ok(!JSON.stringify(result).includes(f.credential.hash));
  assert.ok(!JSON.stringify(result).includes(f.credential.apiKey));
  const query = f.calls.find(c => c.sql.includes('FROM api_keys'))!;
  assert.ok(query.sql.includes('WHERE project_id = $1 ORDER BY created_at, id'));
  assert.deepEqual(query.values, [projectId]);
  assert.ok(!query.sql.includes('key_hash') && !query.sql.includes('*'));
});

it('lists empty projects and inactive projects but rejects missing or mismatched projects', async () => {
  const f = fixture(); f.state.keys.clear(); f.state.inactive = true;
  assert.deepEqual(await f.service().listKeys(projectId), []);
  f.state.missingProject = true;
  await assert.rejects(f.service().listKeys(projectId), { message: 'PROJECT_NOT_FOUND' });
  f.state.missingProject = false; f.state.mismatchProject = true;
  await assert.rejects(f.service().listKeys(projectId), { message: 'PROJECT_IDENTITY_MISMATCH' });
});

it('revokes idempotently and preserves the original timestamp even on inactive projects', async () => {
  const f = fixture(); f.state.inactive = true;
  const first = await f.service().revokeKey(selected);
  assert.equal(first.status, 'revoked'); assert.equal(first.alreadyRevoked, false);
  assert.equal(first.revokedAt, f.state.now);
  f.state.now = new Date('2030-02-01T00:00:00Z');
  const second = await f.service().revokeKey(selected);
  assert.equal(second.alreadyRevoked, true); assert.equal(second.revokedAt, first.revokedAt);
  assert.equal(f.calls.filter(c => c.sql.startsWith('UPDATE api_keys')).length, 1);
  const update = f.calls.find(c => c.sql.startsWith('UPDATE api_keys'))!;
  assert.ok(update.sql.includes('WHERE project_id = $1 AND id = $2'));
  assert.deepEqual(update.values, [projectId, keyId]);
  assert.ok(!JSON.stringify(second).includes(f.credential.hash));
});

it('rotation creates an independent credential and retains the valid predecessor', async () => {
  const f = fixture();
  const result = await f.service().rotateKey(rotation);
  assert.equal(result.predecessorId, keyId);
  assert.notEqual(result.id, keyId);
  assert.ok(result.secret !== f.credential.apiKey);
  assert.ok(f.generated[0]!.hash !== f.credential.hash);
  assert.equal(result.expiresAt!.getTime() - f.state.now.getTime(), 90 * 86400000);
  assert.equal(f.state.keys.size, 2);
  assert.equal(f.state.keys.get(keyId)!.revoked_at, null);
  assert.ok(!f.calls.some(c => c.sql.startsWith('UPDATE api_keys')));
  assert.ok(!JSON.stringify(f.calls).includes(result.secret));
  assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
});

it('rotation supports explicit expiry and explicit non-expiring replacement only', async () => {
  for (const expiry of [{ expiresAt: '2030-06-01T00:00:00Z' }, { noExpiry: true }]) {
    const f = fixture(); const result = await f.service().rotateKey({ ...rotation, ...expiry });
    assert.equal(result.expiresAt?.toISOString() ?? null, 'noExpiry' in expiry ? null : '2030-06-01T00:00:00.000Z');
    assert.equal(f.state.keys.get(result.id)!.expires_at, result.expiresAt);
  }
});

for (const status of ['expired', 'revoked', 'inactive'] as const) it(`rejects rotation from ${status} state before generation`, async () => {
  const f = fixture(); const row = f.state.keys.get(keyId)!;
  if (status === 'expired') row.expires_at = f.state.now;
  if (status === 'revoked') row.revoked_at = f.state.now;
  if (status === 'inactive') f.state.inactive = true;
  await assert.rejects(f.service().rotateKey(rotation), { message: status === 'inactive' ? 'PROJECT_INACTIVE' : 'PREDECESSOR_INACTIVE' });
  assert.equal(f.generated.length, 0); assert.equal(f.state.keys.size, 1);
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
});

it('project-scoped reads and writes reject foreign or missing keys without mutations', async () => {
  for (const operation of ['revokeKey', 'rotateKey', 'getKey'] as const) {
    const f = fixture(); f.state.keys.get(keyId)!.project_id = otherProject;
    await assert.rejects(f.service()[operation](rotation), { message: 'KEY_NOT_FOUND' });
    assert.equal(f.generated.length, 0);
    assert.ok(!f.calls.some(c => c.sql.startsWith('UPDATE') || c.sql.startsWith('INSERT')));
    const query = f.calls.find(c => c.sql.includes('FROM api_keys'))!;
    assert.deepEqual(query.values, [projectId, keyId]);
    assert.ok(query.sql.includes('WHERE project_id = $1 AND id = $2'));
  }
});

it('fail-closes on returned key identity mismatches and wrong database sessions', async () => {
  for (const operation of ['revokeKey', 'rotateKey', 'getKey'] as const) {
    const f = fixture(); f.state.mismatchKey = true;
    await assert.rejects(f.service()[operation](rotation), { message: 'KEY_IDENTITY_MISMATCH' });
    const g = fixture(); g.state.wrongTarget = true;
    await assert.rejects(g.service()[operation](rotation), { message: 'DATABASE_IDENTITY_MISMATCH' });
    assert.equal(g.generated.length, 0);
  }
});

it('validates lifecycle IDs and expiration before any query', async () => {
  const f = fixture(), service = f.service();
  await assert.rejects(service.listKeys('invalid'));
  await assert.rejects(service.revokeKey({ projectId: 'invalid', keyId }));
  await assert.rejects(service.revokeKey({ projectId, keyId: 'invalid' }));
  await assert.rejects(service.rotateKey({ ...rotation, keyId: 'invalid' }));
  await assert.rejects(service.rotateKey({ ...rotation, name: '' }));
  await assert.rejects(service.rotateKey({ ...rotation, noExpiry: true, expiresAt: '2030-06-01T00:00:00Z' }));
  assert.equal(f.calls.length, 0);
});

it('failed or suppressed writes roll back without changing predecessor or returning a replacement', async () => {
  for (const failure of ['failInsert', 'failUpdate', 'suppressUpdate'] as const) {
    const f = fixture(); f.state[failure] = true;
    await assert.rejects(failure === 'failInsert' ? f.service().rotateKey(rotation) : f.service().revokeKey(selected), { message: 'DATABASE_OPERATION_FAILED' });
    assert.equal(f.state.keys.size, 1);
    assert.equal(f.state.keys.get(keyId)!.revoked_at, null);
    assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
    assert.ok(!f.calls.some(c => c.sql === 'COMMIT'));
  }
});

it('uncertain commits report scoped recovery IDs, never reveal secrets, and never repeat writes', async () => {
  for (const operation of ['rotateKey', 'revokeKey'] as const) {
    const f = fixture(); f.state.commitUnknown = true;
    await assert.rejects(f.service()[operation](rotation), error => {
      assert.ok(error instanceof ProvisioningError); assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.equal(error.recovery!.projectId, projectId);
      assert.ok(typeof error.recovery!.keyId === 'string');
      if (operation === 'rotateKey') {
        assert.equal(error.recovery!.predecessorId, keyId);
        assert.ok(!JSON.stringify(error).includes(f.generated[0]!.apiKey));
      } else assert.equal(error.recovery!.keyId, keyId);
      return true;
    });
    assert.equal(f.calls.filter(c => c.sql.startsWith('INSERT') || c.sql.startsWith('UPDATE')).length, 1);
    assert.equal(f.calls.filter(c => c.sql === 'COMMIT').length, 1);
  }
});

it('revocation winning a lock race makes waiting rotation reject the newly revoked predecessor', async () => {
  const f = fixture(), locked = deferred(), release = deferred(), rotationWaiting = deferred();
  f.hooks.afterKeyLock = async name => { if (name === 'revoke') { locked.resolve(); await release.promise; } };
  f.hooks.beforeProjectLock = name => { if (name === 'rotate') rotationWaiting.resolve(); };
  const revoked = f.service('revoke').revokeKey(selected);
  await locked.promise;
  const rejected = assert.rejects(f.service('rotate').rotateKey(rotation), { message: 'PREDECESSOR_INACTIVE' });
  await rotationWaiting.promise;
  assert.equal(f.generated.length, 0);
  release.resolve(); await revoked; await rejected;
  assert.equal(f.generated.length, 0); assert.equal(f.state.keys.size, 1);
  for (const connection of ['rotate', 'revoke']) {
    const locks = f.calls.filter(c => c.connection === connection && c.sql.endsWith('FOR UPDATE'));
    assert.ok(locks[0]!.sql.includes('FROM projects'));
    assert.ok(locks[1]!.sql.includes('FROM api_keys'));
  }
});

it('rotation winning a lock race commits before waiting revocation; replacement remains valid', async () => {
  const f = fixture(), locked = deferred(), release = deferred(), revokeWaiting = deferred();
  f.hooks.afterKeyLock = async name => { if (name === 'rotate') { locked.resolve(); await release.promise; } };
  f.hooks.beforeProjectLock = name => { if (name === 'revoke') revokeWaiting.resolve(); };
  const rotated = f.service('rotate').rotateKey(rotation); await locked.promise;
  const revoked = f.service('revoke').revokeKey(selected); await revokeWaiting.promise;
  release.resolve(); const replacement = await rotated; await revoked;
  assert.notEqual(f.state.keys.get(keyId)!.revoked_at, null);
  assert.equal(f.state.keys.get(replacement.id)!.revoked_at, null);
  assert.equal(f.state.keys.size, 2);
});

it('rotation rechecks database time after waits, rejecting a predecessor that expired while waiting', async () => {
  const f = fixture();
  f.hooks.afterKeyLock = async () => { f.state.now = new Date('2031-01-01T00:00:00Z'); };
  await assert.rejects(f.service().rotateKey(rotation), { message: 'PREDECESSOR_INACTIVE' });
  assert.equal(f.generated.length, 0);
  const lockIndex = f.calls.findIndex(c => c.sql.includes('FROM api_keys') && c.sql.endsWith('FOR UPDATE'));
  const clockIndex = f.calls.findIndex(c => c.sql.includes('clock_timestamp() AS checked_at'));
  assert.ok(clockIndex > lockIndex);
});
