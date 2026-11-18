import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { buildApp } from '../../app.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import { mediaRoutes } from '../media/media.route.js';
import { LocalStorageService } from '../../shared/storage/local-storage.service.js';
import { hashSha256 } from '../../shared/crypto.js';
import { browserMediaRoutes } from './browser-media.route.js';
import { browserToken, testClerkService, browserOrigin } from './browser-test-fixtures.js';
import type { ClerkService } from '../auth/clerk.service.js';

const projectId = randomUUID();
const otherProject = randomUUID();
const assetId: string = randomUUID();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const body = { original_filename: 'video.mp4', mime_type: 'video/mp4', file_size_bytes: 32 };

async function fixture(options: {
  projects?: number; thumbnail?: boolean; missingFile?: boolean; symlink?: boolean;
  clerkService?: ClerkService | null; dbError?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-browser-'));
  const storage = new LocalStorageService(directory);
  await storage.init();
  const thumbnailPath = join(directory, 'thumb.jpg');
  if (!options.missingFile) await writeFile(thumbnailPath, jpeg);
  if (options.symlink) await symlink(thumbnailPath, join(directory, 'link.jpg'));
  const now = new Date('2026-01-01T00:00:00Z');
  const asset = {
    id: assetId, project_id: projectId, status: 'ready', original_filename: 'video.mp4',
    mime_type: 'video/mp4', file_size_bytes: '32', uploaded_bytes: '32',
    created_at: now, updated_at: now, transcoding_config: null,
    duration_seconds: '1.250', width: 640, height: 360, video_codec: 'h264', audio_codec: 'aac',
    bitrate: '1000000', frame_rate: '29.97', storage_key: 'private/original.mp4',
    metadata: { raw_ffprobe: 'private-probe', consumed_token_hash: 'private-hash' },
    upload_token_hash: null as string | null, upload_token_expires_at: now,
  };
  const assets = new Map<string, typeof asset>([[assetId, asset]]);
  const jobs = [
    { operation: 'extract_metadata', status: 'completed', parameters: { private: 'payload' } },
    { operation: 'generate_thumbnail', status: 'queued', parameters: { private: 'payload' } },
  ];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (options.dbError) throw new Error('private SQL password and database path');
    if (sql.includes('account_identities')) return { rows: values[0] === 'user_unlinked' ? [] :
      [{ account_id: values[0] === 'user_other' ? 'other-account' : 'linked-account' }] };
    if (sql.includes('FROM projects')) {
      assert.match(sql, /account_id = \$1 AND status = 'active'/);
      const id = values[0] === 'other-account' ? otherProject : projectId;
      return { rows: Array.from({ length: options.projects ?? 1 }, (_, i) => ({ id: i ? randomUUID() : id, name: 'Playground' })) };
    }
    if (sql.includes('FROM api_keys')) return { rows: values[0] === hashSha256('legacy-key') ? [{
      project_id: projectId, account_id: 'linked-account', project_name: 'Playground', project_status: 'active', api_key_id: 'key',
    }] : [] };
    if (sql.includes('UPDATE api_keys')) return { rows: [] };
    if (sql.includes('INSERT INTO media_assets')) {
      assert.equal(values[1], projectId);
      const row = { ...asset, id: String(values[0]), status: 'uploading', original_filename: String(values[2]),
        file_size_bytes: String(values[4]), uploaded_bytes: '0',
        upload_token_hash: String(values[5]), upload_token_expires_at: new Date(String(values[6])) };
      assets.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.includes('JOIN media_assets ma')) {
      assert.match(sql, /ma.project_id = \$2/);
      const row = assets.get(String(values[0]));
      return { rows: options.thumbnail && row?.project_id === values[1] ? [{
        storage_key: options.symlink ? 'link.jpg' : 'thumb.jpg', mime_type: 'image/jpeg', file_size_bytes: String(jpeg.length),
      }] : [] };
    }
    if (sql.includes('FROM processing_jobs')) {
      if (!sql.includes('project_id = $2')) return { rows: [] };
      assert.match(sql, /project_id = \$2/);
      return { rows: jobs };
    }
    if (sql.includes('FROM media_outputs')) return { rows: [] };
    if (sql.includes('FROM media_assets')) {
      const row = assets.get(String(values[0]));
      if (sql.includes('project_id = $2')) return { rows: row?.project_id === values[1] ? [row] : [] };
      return { rows: row ? [{ ...row, consumed_token_hash: row.metadata.consumed_token_hash }] : [] };
    }
    if (sql.includes('jsonb_set')) {
      const row = assets.get(String(values[0]));
      if (!row || row.upload_token_hash !== values[1]) return { rows: [] };
      row.upload_token_hash = null;
      row.metadata.consumed_token_hash = String(values[1]);
      return { rows: [row] };
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  } } as unknown as Pool;
  const previous = { storage: process.env.STORAGE_BASE_DIR, cors: process.env.CORS_ALLOWED_ORIGINS };
  process.env.STORAGE_BASE_DIR = directory;
  process.env.CORS_ALLOWED_ORIGINS = browserOrigin;
  const app = buildApp({ skipDatabase: true,
    clerkService: options.clerkService === undefined ? testClerkService() : options.clerkService, logger: false });
  app.register(fp(async instance => { instance.decorate('db', db); }, { name: 'database' }));
  app.register(authenticatePlugin);
  app.register(mediaRoutes);
  app.register(browserMediaRoutes, { storage });
  await app.ready();
  return {
    app, db, asset, jobs, calls, assets,
    async close() {
      await app.close();
      if (previous.storage === undefined) delete process.env.STORAGE_BASE_DIR;
      else process.env.STORAGE_BASE_DIR = previous.storage;
      if (previous.cors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = previous.cors;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('requires a valid, unexpired Clerk JWT on every browser media endpoint', async () => {
  const f = await fixture();
  try {
    for (const authorization of [undefined, 'Bearer invalid', `Bearer ${await browserToken('user_linked', true)}`]) {
      for (const [method, url] of [['POST', '/v1/browser/media'], ['GET', `/v1/browser/media/${assetId}`],
        ['GET', `/v1/browser/media/${assetId}/thumbnail`]] as const) {
        const response = await f.app.inject({ method, url, ...(method === 'POST' ? { payload: body } : {}),
          headers: authorization ? { authorization } : {} });
        assert.equal(response.statusCode, 401);
      }
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

it('fails closed with sanitized 503 for unavailable Clerk configuration/provider on all media routes', async () => {
  for (const service of [null, testClerkService(true)]) {
    const f = await fixture({ clerkService: service });
    try {
      for (const [method, url] of [['POST', '/v1/browser/media'], ['GET', `/v1/browser/media/${assetId}`],
        ['GET', `/v1/browser/media/${assetId}/thumbnail`]] as const) {
        const response = await f.app.inject({ method, url, ...(method === 'POST' ? { payload: body } : {}),
          headers: { authorization: `Bearer ${await browserToken()}` } });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error, 'authentication_unavailable');
        assert.doesNotMatch(response.payload, /private|provider failure|clerk\.example/);
      }
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

it('does not expose database errors from media routes', async () => {
  const f = await fixture({ dbError: true });
  try {
    for (const [method, url] of [['POST', '/v1/browser/media'], ['GET', `/v1/browser/media/${assetId}`],
      ['GET', `/v1/browser/media/${assetId}/thumbnail`]] as const) {
      const response = await f.app.inject({ method, url, ...(method === 'POST' ? { payload: body } : {}),
        headers: { authorization: `Bearer ${await browserToken()}` } });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'internal_error', message: 'An internal error occurred' });
    }
  } finally { await f.close(); }
});

for (const [subject, projects, status, error] of [
  ['user_unlinked', 1, 403, 'account_not_linked'],
  ['user_linked', 0, 403, 'no_active_project'],
  ['user_linked', 2, 409, 'project_selection_ambiguous'],
] as const) {
  it(`fails closed with ${error} on all media endpoints`, async () => {
    const f = await fixture({ projects });
    try {
      for (const [method, url] of [['POST', '/v1/browser/media'], ['GET', `/v1/browser/media/${assetId}`],
        ['GET', `/v1/browser/media/${assetId}/thumbnail`]] as const) {
        const response = await f.app.inject({ method, url, ...(method === 'POST' ? { payload: body } : {}),
          headers: { authorization: `Bearer ${await browserToken(subject)}` } });
        assert.equal(response.statusCode, status);
        assert.equal(response.json().error, error);
      }
      assert.ok(f.calls.every(call => !/media_assets|media_outputs|processing_jobs/.test(call.sql)));
    } finally { await f.close(); }
  });
}

it('registers using the resolved project and existing hashed single-use upload credentials', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'POST', url: '/v1/browser/media',
      headers: { authorization: `Bearer ${await browserToken()}` },
      payload: { ...body, original_filename: 'private/path/video.mp4' } });
    assert.equal(response.statusCode, 201, response.payload);
    const registered = response.json();
    assert.equal(registered.original_filename, 'video.mp4');
    assert.equal(registered.status, 'uploading');
    assert.equal(registered.upload_url, `/v1/media/${registered.id}/upload`);
    assert.ok(Date.parse(registered.upload_expires_at) > Date.now());
    assert.equal(f.assets.get(registered.id)?.upload_token_hash, hashSha256(registered.upload_token));
    assert.equal(registered.project_id, undefined);
    assert.equal(registered.storage_key, undefined);
    const { MediaService } = await import('../media/media.service.js');
    // The unchanged upload-token service consumes the exact credential issued above.
    const claim = new MediaService(f.db);
    assert.equal((await claim.claimUploadToken(registered.id, registered.upload_token)).claimed, true);
    assert.equal(f.assets.get(registered.id)?.upload_token_hash, null);
    assert.deepEqual(await claim.claimUploadToken(registered.id, registered.upload_token),
      { claimed: false, reason: 'in_progress_or_consumed' });
    assert.deepEqual(await claim.findAssetForUploadPreflight(registered.id, 'not-the-token'),
      { claimed: false, reason: 'invalid_token' });
  } finally { await f.close(); }
});

it('rejects client authority IDs and preserves registration MIME, size and transcoding validation', async () => {
  const f = await fixture();
  try {
    const headers = { authorization: `Bearer ${await browserToken()}` };
    for (const payload of [
      { ...body, account_id: 'attacker' }, { ...body, project_id: otherProject },
      { ...body, mime_type: 'text/plain' }, { ...body, file_size_bytes: 0 },
      { ...body, file_size_bytes: 100 * 1024 * 1024 + 1 },
      { ...body, transcoding: { profiles: ['bogus'] } },
    ]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/v1/browser/media', headers, payload })).statusCode, 400);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: `/v1/browser/media?project_id=${otherProject}`,
      headers, payload: body })).statusCode, 400);
    assert.ok(f.calls.every(c => !c.sql.includes('INSERT INTO media_assets')));
  } finally { await f.close(); }
});

it('returns a strict technical/job whitelist, not raw metadata, paths, accounts, or worker parameters', async () => {
  const f = await fixture({ thumbnail: true });
  try {
    const response = await f.app.inject({ url: `/v1/browser/media/${assetId}`,
      headers: { authorization: `Bearer ${await browserToken()}` } });
    assert.equal(response.statusCode, 200, response.payload);
    const status = response.json();
    assert.deepEqual(status.technical, { duration_seconds: 1.25, width: 640, height: 360,
      video_codec: 'h264', audio_codec: 'aac', bitrate: 1000000, frame_rate: 29.97 });
    assert.equal(status.status, 'ready');
    assert.deepEqual(status.processing, [
      { operation: 'extract_metadata', status: 'completed' }, { operation: 'generate_thumbnail', status: 'queued' },
    ]);
    assert.deepEqual(status.thumbnail, { status: 'ready', url: `/v1/browser/media/${assetId}/thumbnail` });
    assert.doesNotMatch(response.payload, /private|metadata":|storage_key|project_id|account_id|parameters|upload_token|job_id/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const query = f.calls.find(c => c.sql.includes('FROM media_assets'))!;
    assert.match(query.sql, /WHERE id = \$1 AND project_id = \$2/);
    assert.doesNotMatch(query.sql, /\bmetadata\b|storage_key/);
    assert.deepEqual(query.values, [assetId, projectId]);
  } finally { await f.close(); }
});

it('represents absent technical metadata and unfinished/failed/cancelled jobs without fake progress', async () => {
  const f = await fixture();
  try {
    Object.assign(f.asset, { duration_seconds: null, width: null, height: null, video_codec: null,
      audio_codec: null, bitrate: null, frame_rate: null });
    for (const jobState of ['queued', 'processing', 'failed', 'cancelled', 'completed']) {
      f.jobs[1]!.status = jobState;
      const response = await f.app.inject({ url: `/v1/browser/media/${assetId}`,
        headers: { authorization: `Bearer ${await browserToken()}` } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().thumbnail.status, jobState === 'completed' ? 'not_found' : jobState);
      assert.ok(Object.values(response.json().technical).every(value => value === null));
      assert.equal(response.json().progress, undefined);
    }
  } finally { await f.close(); }
});

it('hides cross-project assets and thumbnails, even with injected query project IDs', async () => {
  const f = await fixture({ thumbnail: true });
  try {
    for (const suffix of ['', '/thumbnail']) {
      const response = await f.app.inject({ url: `/v1/browser/media/${assetId}${suffix}?project_id=${projectId}`,
        headers: { authorization: `Bearer ${await browserToken('user_other')}` } });
      assert.equal(response.statusCode, 404);
      assert.doesNotMatch(response.payload, /private|storage|linked-account/);
    }
    assert.equal((await f.app.inject({ url: '/v1/browser/media/not-a-uuid',
      headers: { authorization: `Bearer ${await browserToken()}` } })).statusCode, 400);
  } finally { await f.close(); }
});

it('streams actual JPEG bytes only after Clerk and project authorization', async () => {
  const f = await fixture({ thumbnail: true });
  try {
    const response = await f.app.inject({ url: `/v1/browser/media/${assetId}/thumbnail`,
      headers: { authorization: `Bearer ${await browserToken()}` } });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(Number(response.headers['content-length']), jpeg.length);
    assert.deepEqual(response.rawPayload, jpeg);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally { await f.close(); }
});

for (const options of [{}, { thumbnail: true, missingFile: true }, { thumbnail: true, symlink: true }]) {
  it(`does not deliver missing/unfinished/unsafe thumbnail: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      const response = await f.app.inject({ url: `/v1/browser/media/${assetId}/thumbnail`,
        headers: { authorization: `Bearer ${await browserToken()}` } });
      assert.equal(response.statusCode, options.symlink ? 500 : 404);
      assert.doesNotMatch(response.payload, /lumen-browser|private|symlink|thumb\.jpg/);
    } finally { await f.close(); }
  });
}

it('preserves actual API-key registration/read routes and upload-token-only authentication', async () => {
  const f = await fixture();
  try {
    const headers = { authorization: 'Bearer legacy-key' };
    const legacy = await f.app.inject({ method: 'POST', url: '/v1/media', headers, payload: body });
    assert.equal(legacy.statusCode, 201);
    assert.equal(legacy.json().project_id, projectId);
    assert.ok(legacy.json().upload_token);
    assert.equal((await f.app.inject({ url: `/v1/media/${assetId}`, headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: `/v1/media/${assetId}`,
      headers: { authorization: `Bearer ${await browserToken()}` } })).statusCode, 401);
    assert.equal((await f.app.inject({ url: `/v1/browser/media/${assetId}`, headers })).statusCode, 401);
    for (const authorization of ['Bearer legacy-key', `Bearer ${await browserToken()}`, 'Bearer wrong-upload-token']) {
      const upload = await f.app.inject({ method: 'PUT', url: `/v1/media/${legacy.json().id}/upload`,
        headers: { authorization, 'content-type': 'video/mp4' }, payload: Buffer.alloc(32) });
      assert.equal(upload.statusCode, 401);
      assert.equal(f.assets.get(legacy.json().id)?.status, 'uploading');
    }
    const mismatched = await f.app.inject({ method: 'PUT', url: legacy.json().upload_url,
      headers: { authorization: `Bearer ${legacy.json().upload_token}`, 'content-type': 'video/mp4' },
      payload: Buffer.alloc(16) });
    assert.equal(mismatched.statusCode, 400);
    assert.equal(mismatched.json().error, 'content_length_mismatch');
    assert.equal(f.assets.get(legacy.json().id)?.upload_token_hash, hashSha256(legacy.json().upload_token));
  } finally { await f.close(); }
});

it('preserves restricted browser media CORS preflight before authentication', async () => {
  const f = await fixture();
  try {
    for (const origin of [browserOrigin, `${browserOrigin}0`]) {
      const response = await f.app.inject({ method: 'OPTIONS', url: '/v1/browser/media', headers: {
        origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
      } });
      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], origin === browserOrigin ? origin : undefined);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
