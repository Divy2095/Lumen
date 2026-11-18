import { it } from 'node:test';
import assert from 'node:assert/strict';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import { ClerkService, type VerifiedClerkIdentity } from '../auth/clerk.service.js';
import { BrowserContextService } from './browser-context.service.js';
import { browserProjectRoutes } from './browser-project.route.js';
import { hashSha256 } from '../../shared/crypto.js';

const issuer = 'https://clerk.example.test';
const origin = 'http://127.0.0.1:5173';
const pair = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'browser-key', alg: 'RS256', use: 'sig' };
function clerk(unavailable = false) {
  return new ClerkService({
    issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, authorizedParties: [origin], clockToleranceSeconds: 5,
  }, { fetch: async () => {
    if (unavailable) throw new TypeError('private JWKS failure');
    return new Response(JSON.stringify({ keys: [jwk] }));
  } });
}

async function token(subject = 'user_linked', expired = false) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: origin }).setProtectedHeader({ alg: 'RS256', kid: 'browser-key' })
    .setIssuer(issuer).setSubject(subject).setExpirationTime(now + (expired ? -60 : 300)).sign(pair.privateKey);
}

const projects = [
  { id: 'project-a', name: 'Project A', account_id: 'account-a', status: 'active' },
  { id: 'project-b', name: 'Project B', account_id: 'account-b', status: 'active' },
  { id: 'project-inactive', name: 'Inactive', account_id: 'account-inactive', status: 'deletion_pending' },
];

function database(rows = projects) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('account_identities')) {
      assert.match(sql, /provider = 'clerk' AND provider_subject = \$1/);
      const accounts: Record<string, string> = {
        user_linked: 'account-a', user_other: 'account-b', user_empty: 'account-empty', user_inactive: 'account-inactive',
      };
      const account = accounts[String(values[0])];
      return { rows: account ? [{ account_id: account }] : [] };
    }
    if (sql.includes('FROM projects')) {
      assert.match(sql, /account_id = \$1 AND status = 'active' LIMIT 2/);
      return { rows: rows.filter(p => p.account_id === values[0] && p.status === 'active').slice(0, 2) };
    }
    if (sql.includes('FROM api_keys')) return { rows: values[0] === hashSha256('test-project-key') ? [{
      project_id: 'project-a', account_id: 'account-a', project_name: 'Project A', project_status: 'active', api_key_id: 'key-a',
    }] : [] };
    if (sql.includes('UPDATE api_keys')) return { rows: [] };
    throw new Error('Unexpected query');
  } } as unknown as Pick<Pool, 'query'>;
  return { db, calls };
}

async function fixture(options: { rows?: typeof projects; service?: ClerkService | null; dbError?: boolean } = {}) {
  const f = database(options.rows);
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = origin;
  const app = buildApp({ skipDatabase: true, logger: false,
    clerkService: options.service === undefined ? clerk() : options.service });
  if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = previous;
  app.register(fp(async instance => {
    instance.decorate('db', (options.dbError
      ? { query: async () => { throw new Error('private database password and SQL details'); } }
      : f.db) as Pool);
  }, { name: 'database' }));
  app.register(authenticatePlugin);
  app.register(browserProjectRoutes);
  // Exercise the unchanged API-key middleware without storage or live databases.
  app.get('/api-key-only', {
    preHandler: [async (request, reply) => (app as any).authenticateApiKey(request, reply)],
  }, async () => ({ ok: true }));
  await app.ready();
  return { ...f, app };
}

it('returns only id and name for a verified Clerk identity and its single active project', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ url: '/v1/browser/project', headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { id: 'project-a', name: 'Project A' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(f.calls.map(c => c.values), [['user_linked'], ['account-a']]);
  } finally { await f.app.close(); }
});

it('rejects missing, invalid, and expired JWTs before any database lookup', async () => {
  const f = await fixture();
  try {
    for (const authorization of [undefined, 'Bearer invalid', `Bearer ${await token('user_linked', true)}`]) {
      const response = await f.app.inject({ url: '/v1/browser/project',
        headers: authorization ? { authorization } : {} });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'unauthorized');
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});

for (const [subject, error] of [
  ['user_unlinked', 'account_not_linked'],
  ['user_empty', 'no_active_project'],
  ['user_inactive', 'no_active_project'],
]) {
  it(`rejects ${subject} with 403 ${error}`, async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ url: '/v1/browser/project',
        headers: { authorization: `Bearer ${await token(subject)}` } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, error);
      assert.doesNotMatch(response.payload, /account-a|user_|project-inactive/);
      if (subject === 'user_unlinked') assert.equal(f.calls.length, 1);
    } finally { await f.app.close(); }
  });
}

it('fails closed for multiple active projects rather than choosing the first', async () => {
  const f = await fixture({ rows: [...projects, { ...projects[0]!, id: 'project-extra' }] });
  try {
    const response = await f.app.inject({ url: '/v1/browser/project', headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'project_selection_ambiguous');
  } finally { await f.app.close(); }
});

it('isolates accounts and ignores client-supplied account/project IDs in query and body', async () => {
  const f = await fixture();
  try {
    const headers = { authorization: `Bearer ${await token('user_other')}` };
    for (const extra of [
      { url: '/v1/browser/project?account_id=account-a&project_id=project-a' },
      { url: '/v1/browser/project', payload: { account_id: 'account-a', project_id: 'project-a' } },
    ]) {
      const response = await f.app.inject({ method: 'GET', headers, ...extra });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { id: 'project-b', name: 'Project B' });
    }
    assert.ok(f.calls.filter(c => c.sql.includes('FROM projects')).every(c => c.values[0] === 'account-b'));
  } finally { await f.app.close(); }
});

it('rejects forged and copied identities at the existing runtime guard without querying', async () => {
  const f = database();
  const context = new BrowserContextService(f.db);
  const verified = await clerk().verify(await token());
  if (!verified.ok) assert.fail('Expected a verified identity');
  for (const identity of [{ subject: 'user_linked' }, { ...verified.identity }]) {
    await assert.rejects(context.resolveProject(identity as VerifiedClerkIdentity), /verified Clerk identity/);
  }
  assert.equal(f.calls.length, 0);
});

it('returns sanitized 503 for missing configuration and JWKS failure', async () => {
  for (const service of [null, clerk(true)]) {
    const f = await fixture({ service });
    try {
      const response = await f.app.inject({ url: '/v1/browser/project', headers: { authorization: `Bearer ${await token()}` } });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'authentication_unavailable');
      assert.doesNotMatch(response.payload, /private|JWKS|clerk\.example/);
      assert.equal(f.calls.length, 0);
    } finally { await f.app.close(); }
  }
});

it('sanitizes database errors through the existing application error handler', async () => {
  const f = await fixture({ dbError: true });
  try {
    const response = await f.app.inject({ url: '/v1/browser/project', headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'internal_error', message: 'An internal error occurred' });
  } finally { await f.app.close(); }
});

it('keeps Clerk tokens separate from the existing API-key middleware', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ url: '/api-key-only', headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(response.statusCode, 401);
    assert.ok(f.calls.some(c => c.sql.includes('FROM api_keys')));
    assert.ok(f.calls.every(c => !c.sql.includes('account_identities')));
    const apiKey = await f.app.inject({ url: '/api-key-only', headers: { authorization: 'Bearer test-project-key' } });
    assert.equal(apiKey.statusCode, 200);
    const legacyHeader = await f.app.inject({ url: '/api-key-only', headers: { 'x-api-key': 'test-project-key' } });
    assert.equal(legacyHeader.statusCode, 200);
    const wrongToken = await f.app.inject({ url: '/v1/browser/project', headers: { authorization: 'Bearer test-project-key' } });
    assert.equal(wrongToken.statusCode, 401);
    const browser = await f.app.inject({ url: '/v1/browser/project', headers: { 'x-api-key': 'project-key' } });
    assert.equal(browser.statusCode, 401);
  } finally { await f.app.close(); }
});

it('handles browser project preflight before authentication with exact-origin CORS', async () => {
  const f = await fixture();
  try {
    for (const requestOrigin of [origin, `${origin}0`]) {
      const response = await f.app.inject({ method: 'OPTIONS', url: '/v1/browser/project', headers: {
        origin: requestOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization',
      } });
      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], requestOrigin === origin ? origin : undefined);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
