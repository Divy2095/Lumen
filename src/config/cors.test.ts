import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { getCorsConfig } from './cors.js';

const allowed = 'http://127.0.0.1:5173';
const clerkVariables = ['CLERK_ISSUER', 'CLERK_JWKS_URL', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_CLOCK_TOLERANCE_SECONDS'];

async function appWith(raw: string | undefined, configure?: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  const previousClerk = clerkVariables.map(name => [name, process.env[name]] as const);
  if (raw === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = raw;
  for (const name of clerkVariables) delete process.env[name];
  try {
    const app = buildApp({ skipDatabase: true });
    configure?.(app);
    await app.ready();
    return app;
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
    for (const [name, value] of previousClerk) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function preflight(app: FastifyInstance, method: string, headers: Record<string, string>) {
  return app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: {
      origin: allowed,
      'access-control-request-method': method,
      'access-control-request-headers': headers['access-control-request-headers'] ?? '',
      ...headers,
    },
  });
}

it('allows an exact configured local origin and never emits a wildcard', async () => {
  const app = await appWith(allowed);
  try {
    const response = await app.inject({ url: '/health', headers: { origin: allowed } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], allowed);
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});

it('omits CORS headers for a disallowed origin and for requests without Origin', async () => {
  const app = await appWith(allowed);
  try {
    const disallowed = await app.inject({ url: '/health', headers: { origin: 'http://127.0.0.1:5174' } });
    assert.equal(disallowed.statusCode, 200);
    assert.equal(disallowed.headers['access-control-allow-origin'], undefined);

    const noOrigin = await app.inject({ url: '/health', headers: { 'x-api-key': 'server-to-server-key' } });
    assert.equal(noOrigin.statusCode, 200);
    assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
  } finally { await app.close(); }
});

it('matches origins exactly, including port and localhost versus 127.0.0.1', async () => {
  const app = await appWith(allowed);
  try {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5173/']) {
      const response = await app.inject({ url: '/health', headers: { origin } });
      assert.equal(response.headers['access-control-allow-origin'], origin === allowed ? allowed : undefined);
    }
  } finally { await app.close(); }
});

it('does not allow suffix-based origin spoofing', async () => {
  const app = await appWith(allowed);
  try {
    for (const origin of [
      `${allowed}.evil.test`,
      `${allowed}0`,
    ]) {
      const response = await app.inject({ url: '/health', headers: { origin } });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  } finally { await app.close(); }
});

it('handles unauthenticated Authorization preflight for JSON registration', async () => {
  const app = await appWith(allowed);
  try {
    const response = await preflight(app, 'POST', { 'access-control-request-headers': 'authorization,content-type' });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], allowed);
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    assert.match(String(response.headers['access-control-allow-headers']).toLowerCase(), /authorization/);
    assert.match(String(response.headers['access-control-allow-headers']).toLowerCase(), /content-type/);
    assert.doesNotMatch(String(response.headers['access-control-allow-headers']).toLowerCase(), /x-api-key/);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});

it('handles MP4 PUT preflight and exposes only the narrow method set', async () => {
  const app = await appWith(allowed);
  try {
    const response = await preflight(app, 'PUT', { 'access-control-request-headers': 'authorization,content-type' });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], allowed);
    const methods = String(response.headers['access-control-allow-methods']).split(',').map(value => value.trim()).sort();
    assert.deepEqual(methods, ['GET', 'POST', 'PUT']);
    assert.doesNotMatch(String(response.headers['access-control-allow-methods']), /DELETE|PATCH/);
  } finally { await app.close(); }
});

it('does not authorize a preflight from a disallowed origin', async () => {
  const app = await appWith(allowed);
  try {
    const response = await preflight(app, 'POST', {
      origin: 'http://127.0.0.1:5174',
      'access-control-request-headers': 'authorization,content-type',
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});

it('answers preflight before route authentication runs', async () => {
  const app = await appWith(allowed, fastify => {
    fastify.get('/protected-preflight', {
      preHandler: [async (_request, reply) => reply.status(401).send({ error: 'unauthorized' })],
    }, async () => ({ ok: true }));
  });
  try {
    const preflightResponse = await app.inject({
      method: 'OPTIONS',
      url: '/protected-preflight',
      headers: {
        origin: allowed,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    assert.equal(preflightResponse.statusCode, 204);
    assert.equal(preflightResponse.headers['access-control-allow-origin'], allowed);

    const actual = await app.inject({ url: '/protected-preflight', headers: { origin: allowed } });
    assert.equal(actual.statusCode, 401);
  } finally { await app.close(); }
});

it('supports multiple exact origins from the comma-separated allowlist', async () => {
  const second = 'http://127.0.0.1:4173';
  const app = await appWith(` ${allowed} , ${second} `);
  try {
    for (const origin of [allowed, second]) {
      const response = await app.inject({ url: '/health', headers: { origin } });
      assert.equal(response.headers['access-control-allow-origin'], origin);
    }
  } finally { await app.close(); }
});

it('treats missing configuration as no allowed browser origins', async () => {
  assert.deepEqual(getCorsConfig({}), { allowedOrigins: [] });
  const app = await appWith(undefined);
  try {
    const response = await app.inject({ url: '/health', headers: { origin: allowed } });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});

it('rejects malformed configured origins instead of reflecting or wildcarding them', () => {
  for (const raw of ['*', 'null', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173/path',
    'http://127.0.0.1:5173?query=1', 'http://127.0.0.1:5173#fragment',
    'http://user:pass@127.0.0.1:5173', 'ftp://127.0.0.1:5173', 'http://example.com',
    'http://127.0.0.1:5173 ,', 'http://127.0.0.1:5173,,http://127.0.0.1:4173']) {
    const previous = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = raw;
    try {
      assert.throws(() => buildApp({ skipDatabase: true }), /CORS_ALLOWED_ORIGINS/);
    } finally {
      if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = previous;
    }
  }
});