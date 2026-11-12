import { it } from 'node:test';
import assert from 'node:assert/strict';
import fp from 'fastify-plugin';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import { authenticatePlugin } from '../../plugins/authenticate.js';
import { hashSha256 } from '../../shared/crypto.js';
import { mediaRoutes } from './media.route.js';

async function fixture(status = 'completed', missingFile = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-rendition-http-'));
  const previous = process.env.STORAGE_BASE_DIR;
  process.env.STORAGE_BASE_DIR = directory;
  const id = randomUUID();
  const project = randomUUID();
  const bytes = Buffer.from('complete MP4 fixture bytes');
  await mkdir(join(directory, 'media'));
  if (!missingFile) await writeFile(join(directory, 'media/rendition.mp4'), bytes);
  const calls: string[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    calls.push(sql);
    if (sql.includes('FROM api_keys')) {
      if (![hashSha256('owner-key'), hashSha256('other-key')].includes(String(values?.[0]))) return { rows: [] };
      return { rows: [{ project_id: values?.[0] === hashSha256('owner-key') ? project : randomUUID(),
        account_id: randomUUID(), project_name: 'HTTP test', project_status: 'active', api_key_id: randomUUID() }] };
    }
    if (sql.includes('UPDATE api_keys')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT id FROM media_assets')) return { rows: values?.[0] === id && values?.[1] === project ? [{ id }] : [] };
    if (sql.includes('LEFT JOIN media_outputs')) return { rows: [{ job_status: status, storage_key: status === 'completed' ? 'media/rendition.mp4' : null,
      mime_type: 'video/mp4', file_size_bytes: status === 'completed' ? String(bytes.length) : null, width: 480, height: 360, version: 1 }] };
    throw new Error('Unexpected database query in HTTP regression');
  } };
  const app = buildApp({ skipDatabase: true });
  app.register(fp(async (server) => { server.decorate('db', db as never); }, { name: 'database' }));
  app.register(authenticatePlugin);
  app.register(mediaRoutes);
  await app.ready();
  return { app, calls, bytes, url: `/v1/media/${id}/renditions/360p`, close: async () => {
    await app.close();
    if (previous === undefined) delete process.env.STORAGE_BASE_DIR; else process.env.STORAGE_BASE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  } };
}

it('streams the complete rendition without caching or unsupported range advertising', async () => {
  const f = await fixture();
  try {
    for (const range of [undefined, 'bytes=0-3']) {
      const response = await f.app.inject({ url: f.url, headers: { authorization: 'Bearer owner-key', ...(range ? { range } : {}) } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'video/mp4');
      assert.equal(Number(response.headers['content-length']), f.bytes.length);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['accept-ranges'], undefined);
      assert.equal(response.headers['content-range'], undefined);
      assert.deepEqual(response.rawPayload, f.bytes);
    }
  } finally { await f.close(); }
});

it('rejects malformed UUIDs before database access with a client validation error', async () => {
  const f = await fixture();
  try {
    for (const id of ['not-a-uuid', '123', '00000000-0000-0000-0000-00000000000z']) {
      const before = f.calls.length;
      const response = await f.app.inject({ url: `/v1/media/${id}/renditions/360p`, headers: { authorization: 'Bearer owner-key' } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, 'validation_error');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(f.calls.length, before);
    }
  } finally { await f.close(); }
});

it('retains API-key authentication, project isolation, and unknown-profile responses', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url: f.url })).statusCode, 401);
    assert.equal((await f.app.inject({ url: f.url, headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal((await f.app.inject({ url: f.url, headers: { authorization: 'Bearer other-key' } })).statusCode, 404);
    assert.equal((await f.app.inject({ url: f.url.replace('360p', '4k'), headers: { authorization: 'Bearer owner-key' } })).statusCode, 404);
  } finally { await f.close(); }
});

for (const status of ['queued', 'processing', 'failed']) {
  it(`preserves the ${status} rendition response`, async () => {
    const f = await fixture(status);
    try {
      const response = await f.app.inject({ url: f.url, headers: { authorization: 'Bearer owner-key' } });
      assert.equal(response.statusCode, 409);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json().error, status === 'failed' ? 'rendition_failed' : 'rendition_processing');
    } finally { await f.close(); }
  });
}

it('returns 404 when a persisted rendition file is missing', async () => {
  const f = await fixture('completed', true);
  try {
    assert.equal((await f.app.inject({ url: f.url, headers: { authorization: 'Bearer owner-key' } })).statusCode, 404);
  } finally { await f.close(); }
});
