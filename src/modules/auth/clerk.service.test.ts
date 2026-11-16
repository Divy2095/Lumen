import { it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation, type JWTPayload } from 'jose';
import type { Pool } from 'pg';
import { getClerkConfig, type ClerkConfig } from '../../config/clerk.js';
import { ClerkService, registerClerkAuth, type VerifiedClerkIdentity } from './clerk.service.js';
import { ClerkIdentityResolver } from './clerk-identity.service.js';

const issuer = 'https://clerk.example.test';
const party = 'http://127.0.0.1:5173';
const subject = 'user_test123';
const config: ClerkConfig = {
  issuer,
  jwksUrl: `${issuer}/.well-known/jwks.json`,
  authorizedParties: [party],
  clockToleranceSeconds: 5,
};

const first = await generateKeyPair('RS256');
const second = await generateKeyPair('RS256');
const rs512 = await generateKeyPair('RS512');
const firstPublic = { ...await exportJWK(first.publicKey), kid: 'key-1', alg: 'RS256', use: 'sig' };
const secondPublic = { ...await exportJWK(second.publicKey), kid: 'key-2', alg: 'RS256', use: 'sig' };

function jwksFetch(keys: object[] = [firstPublic]) {
  let calls = 0;
  const impl: FetchImplementation = async () => {
    calls++;
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls: () => calls };
}

function service(fetchImpl: FetchImplementation, options: { cooldownDuration?: number } = {}) {
  return new ClerkService(config, { fetch: fetchImpl, jwks: { cooldownDuration: options.cooldownDuration ?? 0 } });
}

interface TokenOptions {
  subject?: string | null;
  issuer?: string;
  omitIssuer?: boolean;
  party?: string;
  azp?: unknown;
  omitAzp?: boolean;
  expiresAt?: number;
  notBefore?: number;
  includeExp?: boolean;
  kid?: string;
  key?: CryptoKey | Uint8Array;
  alg?: 'RS256' | 'RS512' | 'HS256';
}

async function token(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {};
  if (!options.omitAzp) claims.azp = options.azp !== undefined ? options.azp : (options.party ?? party);
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'key-1' })
    .setIssuedAt(now - 1);
  if (!options.omitIssuer) jwt = jwt.setIssuer(options.issuer ?? issuer);
  const tokenSubject = options.subject === undefined ? subject : options.subject;
  if (tokenSubject !== null) jwt = jwt.setSubject(tokenSubject);
  if (options.includeExp !== false) jwt = jwt.setExpirationTime(options.expiresAt ?? now + 300);
  if (options.notBefore !== undefined) jwt = jwt.setNotBefore(options.notBefore);
  return jwt.sign(options.key ?? first.privateKey);
}

function unsignedToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: issuer, sub: subject, azp: party, exp: Math.floor(Date.now() / 1000) + 300,
  })).toString('base64url');
  return `${header}.${body}.`;
}

async function protectedApp(clerk: ClerkService | null) {
  const app = Fastify({ logger: false });
  registerClerkAuth(app, clerk);
  app.get('/protected', { preHandler: [app.authenticateClerk] }, async request => ({ subject: request.clerkIdentity!.subject }));
  await app.ready();
  return app;
}

it('strictly loads public-key-only Clerk configuration', () => {
  assert.equal(getClerkConfig({}), null);
  const valid = getClerkConfig({
    CLERK_ISSUER: issuer,
    CLERK_AUTHORIZED_PARTIES: `${party}, http://127.0.0.1:4173`,
  });
  assert.deepEqual(valid, {
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    authorizedParties: [party, 'http://127.0.0.1:4173'],
    clockToleranceSeconds: 5,
  });
  assert.equal(getClerkConfig({
    CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party,
    CLERK_JWKS_URL: `${issuer}/custom/jwks.json`,
  })?.jwksUrl, `${issuer}/custom/jwks.json`);
  assert.equal(getClerkConfig({
    CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_CLOCK_TOLERANCE_SECONDS: '0',
  })?.clockToleranceSeconds, 0);

  for (const env of [
    { CLERK_AUTHORIZED_PARTIES: party },
    { CLERK_ISSUER: 'http://clerk.example.test', CLERK_AUTHORIZED_PARTIES: party },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: 'http://example.com' },
    { CLERK_ISSUER: `${issuer}/path`, CLERK_AUTHORIZED_PARTIES: party },
    { CLERK_ISSUER: issuer },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: '*' },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: `${party}/` },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_JWKS_URL: 'https://other.example.test/jwks.json' },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_JWKS_URL: 'http://clerk.example.test/jwks.json' },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_CLOCK_TOLERANCE_SECONDS: '61' },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_CLOCK_TOLERANCE_SECONDS: '1.5' },
    { CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_CLOCK_TOLERANCE_SECONDS: ' 5' },
  ]) assert.throws(() => getClerkConfig(env));
});

it('accepts a correctly signed token and returns only the verified subject', async () => {
  const fetch = jwksFetch();
  const result = await service(fetch.impl).verify(await token());
  assert.ok(result.ok);
  assert.equal(result.identity.subject, subject);
  assert.equal(result.identity.sessionId, null);
});

it('rejects expired, not-yet-valid, and missing-expiration tokens', async () => {
  const clerk = service(jwksFetch().impl);
  const now = Math.floor(Date.now() / 1000);
  for (const value of [
    await token({ expiresAt: now - 60 }),
    await token({ notBefore: now + 60 }),
    await token({ includeExp: false }),
  ]) assert.deepEqual(await clerk.verify(value), { ok: false, reason: 'invalid' });
});

it('rejects wrong issuer, authorized party, and signature', async () => {
  const clerk = service(jwksFetch().impl);
  for (const value of [
    await token({ issuer: 'https://other.example.test' }),
    await token({ party: 'https://other.example.test' }),
    await token({ key: second.privateKey }),
  ]) assert.deepEqual(await clerk.verify(value), { ok: false, reason: 'invalid' });
});

it('requires a string azp claim from the configured allowlist', async () => {
  const clerk = service(jwksFetch().impl);
  for (const value of [
    await token({ omitAzp: true }),
    await token({ azp: 123 }),
    await token({ azp: null }),
  ]) assert.deepEqual(await clerk.verify(value), { ok: false, reason: 'invalid' });
});

it('rejects tokens without an issuer claim', async () => {
  assert.deepEqual(await service(jwksFetch().impl).verify(await token({ omitIssuer: true })),
    { ok: false, reason: 'invalid' });
});

it('rejects unsupported algorithms and unsigned tokens', async () => {
  const clerk = service(jwksFetch().impl);
  const unsupported = await token({ alg: 'RS512', key: rs512.privateKey });
  const hmac = await token({ alg: 'HS256', key: new TextEncoder().encode('a'.repeat(32)) });
  for (const value of [unsupported, hmac, unsignedToken()]) {
    assert.deepEqual(await clerk.verify(value), { ok: false, reason: 'invalid' });
  }
});

it('requires a nonempty Clerk user subject and rejects impersonation actors', async () => {
  const clerk = service(jwksFetch().impl);
  for (const value of [
    await token({ subject: null }),
    await token({ subject: '' }),
    await token({ subject: 'not-a-clerk-user' }),
    await token({ subject: 'user_bad-name' }),
    await new SignJWT({ azp: party, act: { sub: 'user_actor' } }).setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(issuer).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(first.privateKey),
  ]) assert.deepEqual(await clerk.verify(value), { ok: false, reason: 'invalid' });
});

it('caches JWKS keys and refreshes once for a rotated key', async () => {
  const keys = [firstPublic];
  const fetch = jwksFetch(keys);
  const clerk = service(fetch.impl, { cooldownDuration: 0 });
  assert.ok((await clerk.verify(await token())).ok);
  assert.ok((await clerk.verify(await token())).ok);
  assert.equal(fetch.calls(), 1);

  keys[0] = secondPublic;
  const rotated = await token({ kid: 'key-2', key: second.privateKey });
  assert.ok((await clerk.verify(rotated)).ok);
  assert.equal(fetch.calls(), 2);
});

it('fails closed with unavailable when JWKS cannot be fetched', async () => {
  const unreachable: FetchImplementation = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await service(unreachable).verify(await token()), { ok: false, reason: 'unavailable' });
});

it('fails closed when the JWKS provider returns an unusable response', async () => {
  const failures: FetchImplementation[] = [
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  for (const fetch of failures) {
    assert.deepEqual(await service(fetch).verify(await token()), { ok: false, reason: 'unavailable' });
  }
});

it('returns 401 for missing, malformed, invalid, and expired bearer headers', async () => {
  const app = await protectedApp(service(jwksFetch().impl));
  try {
    const valid = await token();
    const expired = await token({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    for (const headers of [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer a b' },
      { authorization: `Bearer ${expired}` },
      { authorization: `Bearer ${unsignedToken()}` },
    ]) {
      const response = await app.inject({ url: '/protected', headers });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'unauthorized');
      assert.doesNotMatch(response.payload, /eyJ|clerk\.example|jwks|fetch/);
    }
    const response = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${valid}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().subject, subject);
  } finally { await app.close(); }
});

it('returns a sanitized 503 when Clerk configuration is missing', async () => {
  const app = await protectedApp(null);
  try {
    const response = await app.inject({ url: '/protected', headers: { authorization: 'Bearer anything' } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: 'authentication_unavailable',
      message: 'Clerk authentication is not configured',
    });
  } finally { await app.close(); }
});

it('returns a sanitized 503 when the trusted JWKS provider is unavailable', async () => {
  const unreachable: FetchImplementation = async () => { throw new TypeError('fetch failed'); };
  const app = await protectedApp(service(unreachable));
  try {
    const response = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${await token()}` } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'authentication_unavailable');
    assert.doesNotMatch(response.payload, /fetch failed|clerk\.example|jwks/);
  } finally { await app.close(); }
});

it('resolves a linked account only from a genuinely verified Clerk identity', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const accountId = '01900000-0000-7000-8000-000000000001';
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: values[0] === subject ? [{ account_id: accountId }] : [] };
  } } as unknown as Pick<Pool, 'query'>;

  const result = await service(jwksFetch().impl).verify(await token());
  if (!result.ok) assert.fail('expected a verified identity');
  const resolver = new ClerkIdentityResolver(db);
  assert.equal(await resolver.resolveAccountId(result.identity), accountId);

  assert.equal(Object.isFrozen(result.identity), true);
  assert.equal(Reflect.set(result.identity, 'subject', 'user_changed'), false);
  assert.equal(result.identity.subject, subject);

  await assert.rejects(resolver.resolveAccountId({} as VerifiedClerkIdentity), /verified Clerk identity/);
  await assert.rejects(resolver.resolveAccountId({ ...result.identity } as VerifiedClerkIdentity),
    /verified Clerk identity/);
  await assert.rejects(resolver.resolveAccountId({ ...result.identity, subject: 'user_missing' } as VerifiedClerkIdentity),
    /verified Clerk identity/);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /account_identities/);
  assert.match(calls[0]!.sql, /provider = 'clerk'/);
  assert.deepEqual(calls[0]!.values, [subject]);
});