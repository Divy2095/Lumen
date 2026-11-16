import '../../test/integration-preload.js';
import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Client, PoolClient } from 'pg';
import { TestPool } from '../../test/db-guard.js';
import { TEST_DATABASE, TEST_ROLE, testStorageDirectory, removeTestStorage } from '../../test/test-environment.js';
import { buildApp } from '../../app.js';
import { hashSha256 } from '../../shared/crypto.js';
import { ProvisioningError, ProvisioningService } from './provisioning.service.js';

const target = { database: TEST_DATABASE, role: TEST_ROLE };
const pool = new TestPool({ max: 8, connectionTimeoutMillis: 3000 });
const storage = testStorageDirectory('provisioning-live');
process.env.STORAGE_BASE_DIR = storage;
const app = buildApp({ logger: false });
before(async () => { await app.ready(); });
after(async () => { await app.close(); await pool.end(); await removeTestStorage(storage); });

async function connection() {
  const client = await pool.connect();
  try {
    // These bounds also apply to guard queries and real lock waits.
    await client.query("SET statement_timeout = '8s'");
    await client.query("SET lock_timeout = '5s'");
    return client;
  } catch (error) { client.release(true); throw error; }
}
async function fixture(action: (service: ProvisioningService, client: PoolClient) => Promise<void>) {
  const client = await connection();
  try { await action(new ProvisioningService(client, target), client); }
  finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}
async function project(service: ProvisioningService) {
  return service.createProject({ name: 'Integration project', email: `${randomUUID()}@test.invalid` });
}
function identitySubject() { return `user_${randomUUID().replace(/-/g, '')}`; }
async function authorizedStatus(secret: string) {
  return (await app.inject({ method: 'GET', url: `/v1/media/${randomUUID()}`, headers: { authorization: `Bearer ${secret}` } })).statusCode;
}
async function count(client: PoolClient, table: 'accounts' | 'projects' | 'api_keys') {
  return Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
}
function adapter(query: (sql: string, values?: unknown[]) => Promise<unknown>) {
  return { query } as unknown as Pick<Client, 'query'>;
}

it('live provisioning creates new ownership and explicitly reuses an account UUID, with project listing', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const first = await project(service);
    const second = await service.createProject({ name: 'Second project', accountId: first.account_id });
    assert.equal(second.account_id, first.account_id);
    assert.notEqual(first.id, second.id);
    assert.equal(first.status, 'active');
    const rows = await service.listProjects();
    assert.ok(rows.some(row => row.id === first.id && row.account_id === first.account_id));
    assert.ok(rows.some(row => row.id === second.id && row.account_id === first.account_id));
    const account = (await client.query('SELECT password_hash FROM accounts WHERE id=$1', [first.account_id])).rows[0];
    assert.equal(account.password_hash, null);
  });
});

it('live duplicate-email rejection leaves account and project counts unchanged', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const email = `${randomUUID()}@test.invalid`;
    await service.createProject({ name: 'First', email });
    const accounts = await count(client, 'accounts'), projects = await count(client, 'projects');
    await assert.rejects(service.createProject({ name: 'Duplicate', email: email.toUpperCase() }), { message: 'DUPLICATE_RECORD' });
    assert.equal(await count(client, 'accounts'), accounts);
    assert.equal(await count(client, 'projects'), projects);
  });
});

it('live mismatched database/role identities and invalid identifiers reject writes', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const before = await count(client, 'accounts');
    for (const wrong of [{ ...target, database: 'lumen' }, { ...target, role: 'lumen' }]) {
      await assert.rejects(new ProvisioningService(client, wrong).createProject({ name: 'Denied', email: `${randomUUID()}@test.invalid` }),
        { message: 'DATABASE_IDENTITY_MISMATCH' });
    }
    await assert.rejects(service.createProject({ name: 'Denied', accountId: 'invalid' }), { message: 'INVALID_UUID' });
    await assert.rejects(service.createProject({ name: 'Denied', accountId: randomUUID() }), { message: 'ACCOUNT_NOT_FOUND' });
    assert.equal(await count(client, 'accounts'), before);
  });
});

it('real PostgreSQL rolls back an inserted account when the subsequent project write fails', { timeout: 15000 }, async () => {
  await fixture(async (_service, client) => {
    const email = `${randomUUID()}@test.invalid`;
    const injected = new ProvisioningService(adapter(async (sql, values) => {
      if (sql.startsWith('INSERT INTO projects')) throw new Error('Injected project write failure');
      return client.query(sql, values);
    }), target);
    await assert.rejects(injected.createProject({ name: 'Rollback', email }), { message: 'DATABASE_OPERATION_FAILED' });
    assert.equal((await client.query('SELECT id FROM accounts WHERE email=$1', [email])).rowCount, 0);
    assert.equal((await client.query("SELECT count(*) FROM projects WHERE name='Rollback'")).rows[0].count, '0');
  });
});

it('live issuance persists hash-only credentials and default/explicit/non-expiring lifetimes', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service), start = Date.now();
    const key = await service.issueKey({ projectId: p.id, name: 'Default' });
    const stored = (await client.query('SELECT * FROM api_keys WHERE id=$1 AND project_id=$2', [key.id, p.id])).rows[0];
    assert.ok(stored.key_hash === hashSha256(key.secret));
    assert.ok(!JSON.stringify(stored).includes(key.secret));
    assert.ok(Math.abs(stored.expires_at.getTime() - start - 90 * 86400000) < 3000);
    assert.ok(!Object.keys(stored).some(name => ['secret', 'api_key', 'plaintext'].includes(name)));
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const explicit = await service.issueKey({ projectId: p.id, name: 'Explicit', expiresAt });
    assert.equal(explicit.expiresAt!.toISOString(), expiresAt);
    const indefinite = await service.issueKey({ projectId: p.id, name: 'Opt-in', noExpiry: true });
    assert.equal(indefinite.expiresAt, null);
    assert.equal((await client.query('SELECT expires_at FROM api_keys WHERE id=$1', [indefinite.id])).rows[0].expires_at, null);
  });
});

it('live issuance rejects missing and inactive projects without new keys', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service), before = await count(client, 'api_keys');
    await assert.rejects(service.issueKey({ projectId: randomUUID(), name: 'Missing' }), { message: 'PROJECT_NOT_FOUND' });
    await client.query("UPDATE projects SET status='deletion_pending' WHERE id=$1", [p.id]);
    await assert.rejects(service.issueKey({ projectId: p.id, name: 'Inactive' }), { message: 'PROJECT_INACTIVE' });
    assert.equal(await count(client, 'api_keys'), before);
  });
});

it('service-issued credentials authenticate through the real API and retain project isolation', { timeout: 15000 }, async () => {
  await fixture(async service => {
    const p = await project(service), other = await service.createProject({ name: 'Other tenant', accountId: p.account_id });
    const first = await service.issueKey({ projectId: p.id, name: 'First' });
    const second = await service.issueKey({ projectId: other.id, name: 'Second' });
    const registered = await app.inject({ method: 'POST', url: '/v1/media', headers: { authorization: `Bearer ${first.secret}` },
      payload: { original_filename: 'integration.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 } });
    assert.equal(registered.statusCode, 201);
    const id = registered.json().id as string;
    assert.equal((await app.inject({ url: `/v1/media/${id}`, headers: { 'x-api-key': first.secret } })).statusCode, 200);
    assert.equal((await app.inject({ url: `/v1/media/${id}`, headers: { authorization: `Bearer ${second.secret}` } })).statusCode, 404);
    assert.equal(await authorizedStatus('invalid-test-credential'), 401);
  });
});

it('live listing excludes secrets/hashes, derives statuses, and revocation preserves its timestamp', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service);
    assert.deepEqual(await service.listKeys(p.id), []);
    const active = await service.issueKey({ projectId: p.id, name: 'Active' });
    const expired = await service.issueKey({ projectId: p.id, name: 'Expired' });
    const revoked = await service.issueKey({ projectId: p.id, name: 'Revoked' });
    await client.query("UPDATE api_keys SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [expired.id]);
    const first = await service.revokeKey({ projectId: p.id, keyId: revoked.id });
    const timestamp = (await client.query('SELECT revoked_at::text AS exact FROM api_keys WHERE id=$1', [revoked.id])).rows[0].exact;
    const again = await service.revokeKey({ projectId: p.id, keyId: revoked.id });
    assert.equal(again.alreadyRevoked, true); assert.equal(first.alreadyRevoked, false);
    assert.equal((await client.query('SELECT revoked_at::text AS exact FROM api_keys WHERE id=$1', [revoked.id])).rows[0].exact, timestamp);
    const keys = await service.listKeys(p.id);
    assert.equal(keys.find(k => k.id === active.id)!.status, 'active');
    assert.equal(keys.find(k => k.id === expired.id)!.status, 'expired');
    assert.equal(keys.find(k => k.id === revoked.id)!.status, 'revoked');
    assert.ok(!JSON.stringify(keys).includes(active.secret));
    assert.ok(!JSON.stringify(keys).includes(hashSha256(active.secret)));
    assert.equal(await authorizedStatus(active.secret), 404);
    assert.equal(await authorizedStatus(expired.secret), 401);
    assert.equal(await authorizedStatus(revoked.secret), 401);
    await assert.rejects(service.listKeys(randomUUID()), { message: 'PROJECT_NOT_FOUND' });
  });
});

it('live staged rotation authenticates both credentials until explicit predecessor revocation', { timeout: 15000 }, async () => {
  await fixture(async service => {
    const p = await project(service), key = await service.issueKey({ projectId: p.id, name: 'Predecessor' });
    const next = await service.rotateKey({ projectId: p.id, keyId: key.id, name: 'Replacement' });
    assert.ok(next.secret !== key.secret);
    assert.equal(next.predecessorId, key.id);
    assert.equal(await authorizedStatus(key.secret), 404);
    assert.equal(await authorizedStatus(next.secret), 404);
    await service.revokeKey({ projectId: p.id, keyId: key.id });
    assert.equal(await authorizedStatus(key.secret), 401);
    assert.equal(await authorizedStatus(next.secret), 404);
  });
});

it('live rotation rejects inactive/expired/revoked predecessors and wrong-project mutations', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service), other = await project(service);
    const key = await service.issueKey({ projectId: p.id, name: 'Predecessor' });
    const before = await count(client, 'api_keys');
    await assert.rejects(service.rotateKey({ projectId: other.id, keyId: key.id, name: 'Foreign' }), { message: 'KEY_NOT_FOUND' });
    await assert.rejects(service.revokeKey({ projectId: other.id, keyId: key.id }), { message: 'KEY_NOT_FOUND' });
    await client.query("UPDATE projects SET status='deletion_pending' WHERE id=$1", [p.id]);
    await assert.rejects(service.rotateKey({ projectId: p.id, keyId: key.id, name: 'Inactive' }), { message: 'PROJECT_INACTIVE' });
    await client.query("UPDATE projects SET status='active' WHERE id=$1", [p.id]);
    await client.query("UPDATE api_keys SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [key.id]);
    await assert.rejects(service.rotateKey({ projectId: p.id, keyId: key.id, name: 'Expired' }), { message: 'PREDECESSOR_INACTIVE' });
    await service.revokeKey({ projectId: p.id, keyId: key.id });
    await assert.rejects(service.rotateKey({ projectId: p.id, keyId: key.id, name: 'Revoked' }), { message: 'PREDECESSOR_INACTIVE' });
    assert.equal(await count(client, 'api_keys'), before);
  });
});

it('lost COMMIT response against real PostgreSQL returns no secret and exposes only recovery IDs', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service), key = await service.issueKey({ projectId: p.id, name: 'Predecessor' });
    const interrupted = new ProvisioningService(adapter(async (sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT') throw new Error('Injected lost commit response');
      return result;
    }), target);
    let recoveryId = '';
    await assert.rejects(interrupted.rotateKey({ projectId: p.id, keyId: key.id, name: 'Unknown outcome' }), error => {
      assert.ok(error instanceof ProvisioningError); assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.deepEqual(Object.keys(error.recovery!).sort(), ['keyId', 'predecessorId', 'projectId']);
      recoveryId = error.recovery!.keyId!;
      assert.ok(!('secret' in error)); return true;
    });
    const keys = await service.listKeys(p.id);
    assert.equal(keys.length, 2);
    assert.ok(keys.some(row => row.id === recoveryId && row.status === 'active'));
    assert.equal(await authorizedStatus(key.secret), 404);
  });
});

it('live identity linking is idempotent, preserves mappings, and rejects conflicts', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const firstAccount = await project(service), otherAccount = await project(service);
    const subject = identitySubject();
    const linked = await service.linkIdentity({ accountId: firstAccount.account_id, provider: 'clerk', subject });
    assert.equal(linked.alreadyLinked, false);
    assert.equal(linked.accountId, firstAccount.account_id);

    const stored = await client.query(
      'SELECT account_id, provider, provider_subject FROM account_identities WHERE provider=$1 AND provider_subject=$2',
      ['clerk', subject]);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].account_id, firstAccount.account_id);

    const again = await service.linkIdentity({ accountId: firstAccount.account_id, provider: 'clerk', subject });
    assert.equal(again.alreadyLinked, true);
    assert.equal(again.id, linked.id);
    assert.equal((await client.query(
      'SELECT count(*) AS count FROM account_identities WHERE provider=$1 AND provider_subject=$2',
      ['clerk', subject])).rows[0].count, '1');

    await assert.rejects(service.linkIdentity({ accountId: otherAccount.account_id, provider: 'clerk', subject }),
      { message: 'IDENTITY_CONFLICT' });
    assert.equal((await client.query(
      'SELECT account_id FROM account_identities WHERE provider=$1 AND provider_subject=$2',
      ['clerk', subject])).rows[0].account_id, firstAccount.account_id);
  });
});

it('live identity linking rejects unknown accounts, invalid subjects, and unsupported providers', { timeout: 15000 }, async () => {
  await fixture(async (service, client) => {
    const before = Number((await client.query('SELECT count(*) AS count FROM account_identities')).rows[0].count);
    await assert.rejects(service.linkIdentity({ accountId: randomUUID(), provider: 'clerk', subject: identitySubject() }),
      { message: 'ACCOUNT_NOT_FOUND' });
    await assert.rejects(service.linkIdentity({ accountId: randomUUID(), provider: 'clerk', subject: 'not-a-clerk-user' }),
      { message: 'INVALID_SUBJECT' });
    await assert.rejects(service.linkIdentity({ accountId: randomUUID(), provider: 'github', subject: identitySubject() } as never),
      { message: 'UNSUPPORTED_PROVIDER' });
    assert.equal(Number((await client.query('SELECT count(*) AS count FROM account_identities')).rows[0].count), before);
  });
});

it('live concurrent conflicting identity links allow exactly one account mapping', { timeout: 20000 }, async () => {
  const clients: PoolClient[] = [];
  try {
    for (let i = 0; i < 2; i++) clients.push(await connection());
    const first = clients[0]!, second = clients[1]!;
    const setup = new ProvisioningService(first, target);
    const one = await project(setup), two = await project(setup);
    const subject = identitySubject();

    const results = await Promise.allSettled([
      new ProvisioningService(first, target).linkIdentity({ accountId: one.account_id, provider: 'clerk', subject }),
      new ProvisioningService(second, target).linkIdentity({ accountId: two.account_id, provider: 'clerk', subject }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof ProvisioningError);
    assert.equal(rejected.reason.code, 'IDENTITY_CONFLICT');

    const rows = await first.query(
      'SELECT account_id FROM account_identities WHERE provider=$1 AND provider_subject=$2', ['clerk', subject]);
    assert.equal(rows.rowCount, 1);
    assert.ok([one.account_id, two.account_id].includes(rows.rows[0].account_id));
  } finally {
    await Promise.allSettled(clients.map(async client => { try { await client.query('ROLLBACK'); } finally { client.release(); } }));
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function observeBlocking(observer: PoolClient, blocked: number, blocker: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await observer.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected PostgreSQL lock wait was not observed within the bounded deadline');
}

for (const firstOperation of ['revoke', 'rotate'] as const) it(`real row locks serialize ${firstOperation}-first lifecycle ordering`, { timeout: 20000 }, async () => {
  const clients: PoolClient[] = [];
  const locked = deferred(), release = deferred();
  let leader: Promise<unknown> | undefined, follower: Promise<unknown> | undefined;
  try {
    for (let i = 0; i < 3; i++) clients.push(await connection());
    const [first, second, observer] = [clients[0]!, clients[1]!, clients[2]!];
    const service = new ProvisioningService(observer, target), p = await project(service);
    const key = await service.issueKey({ projectId: p.id, name: 'Concurrent predecessor' });
    const input = { projectId: p.id, keyId: key.id, name: 'Concurrent replacement' };
    const pid1 = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const pid2 = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const heldService = new ProvisioningService(adapter(async (sql, values) => {
      const result = await first.query(sql, values);
      if (sql.includes('FROM api_keys') && sql.endsWith('FOR UPDATE')) {
        locked.resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([release.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Lock coordination timed out')), 6000); })]);
        } finally { clearTimeout(timer); }
      }
      return result;
    }), target);
    const waitingService = new ProvisioningService(second, target);
    leader = firstOperation === 'revoke' ? heldService.revokeKey(input) : heldService.rotateKey(input);
    // Race failure with lock acquisition so a failed leader cannot hang coordination.
    await Promise.race([locked.promise, leader.then(() => { throw new Error('Leader finished without predecessor lock'); })]);
    follower = firstOperation === 'revoke' ? waitingService.rotateKey(input) : waitingService.revokeKey(input);
    // Attach a rejection handler immediately; assertions inspect the outcome after release.
    const outcome = follower.then(value => ({ value }), error => ({ error }));
    await observeBlocking(observer, pid2, pid1);
    assert.equal((await service.listKeys(p.id)).length, 1);
    release.resolve(); await leader;
    const result = await outcome;
    if (firstOperation === 'revoke') {
      assert.ok('error' in result && result.error instanceof ProvisioningError && result.error.code === 'PREDECESSOR_INACTIVE');
      assert.equal((await service.listKeys(p.id)).length, 1);
    } else {
      assert.ok('value' in result);
      const keys = await service.listKeys(p.id);
      assert.equal(keys.length, 2);
      assert.equal(keys.find(row => row.id === key.id)!.status, 'revoked');
      assert.equal(keys.filter(row => row.id !== key.id)[0]!.status, 'active');
    }
    assert.equal(await authorizedStatus(key.secret), 401);
  } finally {
    release.resolve(); await Promise.allSettled([leader, follower]);
    await Promise.allSettled(clients.map(async client => { try { await client.query('ROLLBACK'); } finally { client.release(); } }));
  }
});

async function cli(args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/provision.ts', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, output };
  } finally { clearTimeout(timer); }
}

it('real CLI reads the disposable database with its actual role and rejects mismatched identities', { timeout: 20000 }, async () => {
  await fixture(async service => {
    const p = await project(service), key = await service.issueKey({ projectId: p.id, name: 'CLI metadata' });
    const args = ['--database', TEST_DATABASE, '--role', TEST_ROLE];
    const projects = await cli(['project:list', ...args]);
    assert.equal(projects.code, 0); assert.ok(projects.output.includes(p.id));
    const keys = await cli(['key:list', ...args, '--project-id', p.id]);
    assert.equal(keys.code, 0); assert.ok(keys.output.includes(key.id));
    assert.ok(!keys.output.includes(key.secret)); assert.ok(!keys.output.includes(hashSha256(key.secret)));
    const wrong = await cli(['project:list', '--database', 'lumen', '--role', 'lumen']);
    assert.equal(wrong.code, 1); assert.ok(wrong.output.includes('identity does not match'));
    const missing = await cli(['key:list', ...args, '--project-id', randomUUID()]);
    assert.equal(missing.code, 1);
  });
});

it('real CLI refuses redirected lifecycle writes without mutation or credential output', { timeout: 20000 }, async () => {
  await fixture(async (service, client) => {
    const p = await project(service), key = await service.issueKey({ projectId: p.id, name: 'No redirected writes' });
    const args = ['--database', TEST_DATABASE, '--role', TEST_ROLE, '--project-id', p.id];
    for (const command of [['key:issue', ...args, '--name', 'Denied'], ['key:rotate', ...args, '--key-id', key.id, '--name', 'Denied'],
      ['key:revoke', ...args, '--key-id', key.id]]) {
      const result = await cli(command);
      assert.equal(result.code, 1); assert.ok(result.output.includes('interactive stdin and stdout'));
      assert.ok(!result.output.includes(key.secret));
    }
    assert.equal((await service.listKeys(p.id)).length, 1);
    assert.equal((await client.query('SELECT revoked_at FROM api_keys WHERE id=$1', [key.id])).rows[0].revoked_at, null);

    const subject = identitySubject();
    const identity = await cli(['identity:link', '--database', TEST_DATABASE, '--role', TEST_ROLE,
      '--account-id', p.account_id, '--provider', 'clerk', '--subject', subject]);
    assert.equal(identity.code, 1);
    assert.ok(identity.output.includes('interactive stdin and stdout'));
    assert.equal((await client.query(
      'SELECT count(*) AS count FROM account_identities WHERE provider = $1 AND provider_subject = $2',
      ['clerk', subject])).rows[0].count, '0');
  });
});
