import { uuidv7 } from 'uuidv7';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { rm, writeFile, utimes, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import http from 'node:http';
import { buildApp } from '../../app.js';
import { generateApiKey } from '../../shared/crypto.js';
import { assertTestDatabase } from '../../test/db-guard.js';
import { defaultStorageService, LocalStorageService } from '../../shared/storage/local-storage.service.js';
import { MediaService } from './media.service.js';
import { InvalidStateTransitionError } from './media.types.js';

// Dedicated test database
const TEST_STORAGE_DIR = resolve('storage_test');
process.env.PGDATABASE = 'lumen_test';
process.env.STORAGE_BASE_DIR = TEST_STORAGE_DIR;

const testPool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
  database: 'lumen_test',
  user: process.env.PGUSER ?? 'lumen',
  password: process.env.PGPASSWORD,
});

function createMockMp4Buffer(sizeBytes: number, brand = 'isom'): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  // Box size (first 4 bytes)
  buf.writeUInt32BE(sizeBytes >= 16 ? 16 : sizeBytes, 0);
  // 'ftyp' box type
  buf.write('ftyp', 4, 4, 'ascii');
  // Major brand
  buf.write(brand, 8, 4, 'ascii');
  // Minor version
  buf.writeUInt32BE(512, 12);
  return buf;
}

describe('Media Ingestion API (Milestone 2)', () => {
  let app: ReturnType<typeof buildApp>;
  let activeProjectId: string;
  let inactiveProjectId: string;
  let activeApiKey: string;
  let inactiveApiKey: string;
  let activeKeyPrefix: string;

  before(async () => {
    // Fail-closed safety guard: must strictly target lumen_test
    await assertTestDatabase(testPool);

    app = buildApp();
    await app.ready();

    // Clean test database
    await testPool.query(`
      TRUNCATE TABLE media_assets, api_keys, projects, accounts CASCADE;
    `);

    // Create developer account
    const accRes = await testPool.query(
      `INSERT INTO accounts (email) VALUES ('dev@example.com') RETURNING id;`
    );
    const accountId = accRes.rows[0]!.id;

    // Create Active Project
    const projRes = await testPool.query(
      `INSERT INTO projects (account_id, name, status) VALUES ($1, 'Active Project', 'active') RETURNING id;`,
      [accountId]
    );
    activeProjectId = projRes.rows[0]!.id;

    // Create Inactive Project
    const inactProjRes = await testPool.query(
      `INSERT INTO projects (account_id, name, status) VALUES ($1, 'Inactive Project', 'deletion_pending') RETURNING id;`,
      [accountId]
    );
    inactiveProjectId = inactProjRes.rows[0]!.id;

    // Provision API keys
    const activeKeyGen = generateApiKey('lumen_live');
    activeApiKey = activeKeyGen.apiKey;
    activeKeyPrefix = activeKeyGen.keyPrefix;
    await testPool.query(
      `INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, 'Active Key', $2, $3);`,
      [activeProjectId, activeKeyGen.keyPrefix, activeKeyGen.hash]
    );

    const inactiveKeyGen = generateApiKey('lumen_live');
    inactiveApiKey = inactiveKeyGen.apiKey;
    await testPool.query(
      `INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, 'Inactive Key', $2, $3);`,
      [inactiveProjectId, inactiveKeyGen.keyPrefix, inactiveKeyGen.hash]
    );
  });

  after(async () => {
    await app.close();
    await testPool.end();
    await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  describe('1. API Key Authentication (POST /v1/media)', () => {
    it('should reject request missing Authorization header with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        payload: {
          original_filename: 'test.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 1024,
        },
      });

      assert.strictEqual(res.statusCode, 401);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'unauthorized');
    });

    it('should reject request with invalid API key with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: {
          Authorization: 'Bearer lumen_live_invalidsecret0000000000000000',
        },
        payload: {
          original_filename: 'test.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 1024,
        },
      });

      assert.strictEqual(res.statusCode, 401);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'unauthorized');
    });

    it('should reject request for inactive project with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: {
          Authorization: `Bearer ${inactiveApiKey}`,
        },
        payload: {
          original_filename: 'test.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 1024,
        },
      });

      assert.strictEqual(res.statusCode, 403);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'project_inactive');
    });

    it('should throttle last_used_at update to prevent write amplification', async () => {
      // First request updates last_used_at
      await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'test.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });

      // Wait a moment for fire-and-forget query
      await new Promise((r) => setTimeout(r, 50));

      const keyRow1 = await testPool.query(
        `SELECT last_used_at FROM api_keys WHERE key_prefix = $1;`,
        [activeKeyPrefix]
      );
      const initialTimestamp = keyRow1.rows[0]?.last_used_at;
      assert.ok(initialTimestamp, 'last_used_at should be set after first use');

      // Second request immediately after should NOT change last_used_at due to 5min throttle
      await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'test2.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });

      await new Promise((r) => setTimeout(r, 50));

      const keyRow2 = await testPool.query(
        `SELECT last_used_at FROM api_keys WHERE key_prefix = $1;`,
        [activeKeyPrefix]
      );
      assert.strictEqual(
        keyRow2.rows[0]?.last_used_at.getTime(),
        initialTimestamp.getTime(),
        'last_used_at must not be overwritten within the 5-minute throttle window'
      );
    });
  });

  describe('2. Media Registration (POST /v1/media)', () => {
    it('should register media asset and return single-use upload token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: {
          Authorization: `Bearer ${activeApiKey}`,
        },
        payload: {
          original_filename: 'sample_video.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 2048,
        },
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.payload);
      assert.ok(body.id);
      assert.strictEqual(body.project_id, activeProjectId);
      assert.strictEqual(body.status, 'uploading');
      assert.strictEqual(body.original_filename, 'sample_video.mp4');
      assert.strictEqual(body.mime_type, 'video/mp4');
      assert.strictEqual(body.file_size_bytes, 2048);
      assert.strictEqual(body.uploaded_bytes, 0);
      assert.ok(body.upload_token.startsWith('lup_tok_'));
      assert.strictEqual(body.upload_url, `/v1/media/${body.id}/upload`);
      assert.ok(body.upload_expires_at);
      // Ensure storage_key is NOT leaked
      assert.strictEqual((body as any).storage_key, undefined);
    });

    it('should reject registration exceeding 100 MB limit with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: {
          Authorization: `Bearer ${activeApiKey}`,
        },
        payload: {
          original_filename: 'huge.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 100 * 1024 * 1024 + 1, // 100 MB + 1 byte
        },
      });

      assert.strictEqual(res.statusCode, 400);
    });

    it('should reject unsupported MIME type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: {
          Authorization: `Bearer ${activeApiKey}`,
        },
        payload: {
          original_filename: 'song.mp3',
          mime_type: 'audio/mpeg',
          file_size_bytes: 5000,
        },
      });

      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('3. Upload Streaming (PUT /v1/media/:id/upload)', () => {
    it('should successfully stream valid MP4 and transition to ready', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'isom');

      // Register asset
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: {
          original_filename: 'valid.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: fileSize,
        },
      });
      const registered = JSON.parse(regRes.payload);

      // Stream upload
      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
        },
        payload: mp4Data,
      });

      assert.strictEqual(uploadRes.statusCode, 200);
      const uploaded = JSON.parse(uploadRes.payload);
      assert.strictEqual(uploaded.id, registered.id);
      assert.strictEqual(uploaded.status, 'ready');
      assert.strictEqual(uploaded.uploaded_bytes, fileSize);

      // Verify DB record status
      const dbCheck = await testPool.query(
        `SELECT status, uploaded_bytes, upload_token_hash FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'ready');
      assert.strictEqual(Number(dbCheck.rows[0]!.uploaded_bytes), fileSize);
      assert.strictEqual(dbCheck.rows[0]!.upload_token_hash, null);
    });

    it('should accept video/mp4 with media parameters and application/octet-stream', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'isom');

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'params.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      // Upload with media parameters in Content-Type
      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
          'Content-Length': String(fileSize),
        },
        payload: mp4Data,
      });

      assert.strictEqual(uploadRes.statusCode, 200);
      const body = JSON.parse(uploadRes.payload);
      assert.strictEqual(body.status, 'ready');
    });

    it('should reject missing Content-Type header with 415', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'no_ct.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Length': '1024',
          // Omit Content-Type
        },
        payload: createMockMp4Buffer(1024),
      });

      assert.strictEqual(uploadRes.statusCode, 415);
      const body = JSON.parse(uploadRes.payload);
      assert.strictEqual(body.error, 'unsupported_media_type');
    });

    it('should reject invalid upload token with 401 without disclosing asset state', async () => {
      // 1. Non-existent asset
      const resNonExistent = await app.inject({
        method: 'PUT',
        url: '/v1/media/00000000-0000-0000-0000-000000000000/upload',
        headers: {
          Authorization: 'Bearer lup_tok_invalidtoken0000000000000000',
          'Content-Type': 'video/mp4',
          'Content-Length': '1024',
        },
        payload: createMockMp4Buffer(1024),
      });
      assert.strictEqual(resNonExistent.statusCode, 401);
      const body1 = JSON.parse(resNonExistent.payload);
      assert.strictEqual(body1.error, 'unauthorized');

      // 2. Existing asset in uploading status with wrong token
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'test.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      const resWrongToken = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: 'Bearer lup_tok_wrongcredential00000000000000',
          'Content-Type': 'video/mp4',
          'Content-Length': '1024',
        },
        payload: createMockMp4Buffer(1024),
      });
      assert.strictEqual(resWrongToken.statusCode, 401);

      // 3. Existing asset already in ready status with invalid token -> MUST STILL RETURN 401
      // (Never disclose already_uploaded to callers with invalid credentials)
      await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': '1024',
        },
        payload: createMockMp4Buffer(1024),
      });

      const resReadyWithBadToken = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: 'Bearer lup_tok_attackerguessing00000000000',
          'Content-Type': 'video/mp4',
          'Content-Length': '1024',
        },
        payload: createMockMp4Buffer(1024),
      });
      assert.strictEqual(resReadyWithBadToken.statusCode, 401);
      const body3 = JSON.parse(resReadyWithBadToken.payload);
      assert.strictEqual(body3.error, 'unauthorized');
    });

    it('should distinguish consumed token from invalid token and return 409', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'mp42');

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'replay.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      // First upload succeeds
      const upload1 = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
        },
        payload: mp4Data,
      });
      assert.strictEqual(upload1.statusCode, 200);

      // Replay attempt with the genuine (now consumed) token returns 409
      const upload2 = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
        },
        payload: mp4Data,
      });
      assert.strictEqual(upload2.statusCode, 409);
      const body2 = JSON.parse(upload2.payload);
      assert.strictEqual(body2.error, 'asset_already_uploaded');
    });

    it('should reject non-MP4 payload with 400 and mark asset failed', async () => {
      const fileSize = 512;
      const garbageData = Buffer.alloc(fileSize, 0x41); // 'AAAA...'

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'fake.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
        },
        payload: garbageData,
      });

      assert.strictEqual(uploadRes.statusCode, 400);
      const body = JSON.parse(uploadRes.payload);
      assert.strictEqual(body.error, 'invalid_media_container');

      const dbCheck = await testPool.query(
        `SELECT status FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'failed');
    });

    it('should reject Content-Length mismatch before consuming token', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'mismatch.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': '2048',
        },
        payload: createMockMp4Buffer(2048),
      });

      assert.strictEqual(uploadRes.statusCode, 400);
      const body = JSON.parse(uploadRes.payload);
      assert.strictEqual(body.error, 'content_length_mismatch');

      // Token should NOT be consumed
      const dbCheck = await testPool.query(
        `SELECT status, upload_token_hash FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'uploading');
      assert.ok(dbCheck.rows[0]!.upload_token_hash !== null);
    });

    it('should reject undersized stream with 400 stream_byte_mismatch', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'short.mp4', mime_type: 'video/mp4', file_size_bytes: 2048 },
      });
      const registered = JSON.parse(regRes.payload);

      // Client declared 2048 in Content-Length, but payload stream prematurely ends at 1024 bytes
      // We test this using a stream that terminates early
      const shortBuffer = createMockMp4Buffer(1024);

      const uploadRes = await app.inject({
        method: 'PUT',
        url: registered.upload_url,
        headers: {
          Authorization: `Bearer ${registered.upload_token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': '2048',
        },
        payload: shortBuffer,
      });

      assert.strictEqual(uploadRes.statusCode, 400);
      const body = JSON.parse(uploadRes.payload);
      assert.strictEqual(body.error, 'stream_byte_mismatch');

      const dbCheck = await testPool.query(
        `SELECT status FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'failed');
    });

    it('should handle two genuinely concurrent uploads with the same token atomically', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'isom');

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'concurrent.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      // Fire two genuine parallel uploads
      const [upload1, upload2] = await Promise.all([
        app.inject({
          method: 'PUT',
          url: registered.upload_url,
          headers: {
            Authorization: `Bearer ${registered.upload_token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(fileSize),
          },
          payload: mp4Data,
        }),
        app.inject({
          method: 'PUT',
          url: registered.upload_url,
          headers: {
            Authorization: `Bearer ${registered.upload_token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(fileSize),
          },
          payload: mp4Data,
        }),
      ]);

      const statusCodes = [upload1.statusCode, upload2.statusCode].sort();
      // Exactly one succeeds with 200, one fails with 409 conflict
      assert.deepStrictEqual(statusCodes, [200, 409]);
    });

    it('should prevent failed asset from transitioning to ready (state integrity)', async () => {
      const mediaService = new MediaService(testPool);
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'fail_check.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      // Transition asset directly to failed in DB
      await mediaService.markUploadFailed(registered.id);

      // Attempting to finalize an asset not in 'uploading' status MUST throw InvalidStateTransitionError
      await assert.rejects(
        async () => {
          await mediaService.finalizeUpload(registered.id, 1024);
        },
        (err: unknown) => err instanceof InvalidStateTransitionError
      );

      // Verify status remains failed
      const dbCheck = await testPool.query(
        `SELECT status FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'failed');
    });

    it('should clean up orphaned file on database finalization failure', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'isom');

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'db_fail.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      // Mock mediaService.finalizeUpload to simulate database failure during finalization
      const originalFinalize = MediaService.prototype.finalizeUpload;
      MediaService.prototype.finalizeUpload = async () => {
        throw new Error('Simulated PostgreSQL disconnect during finalization commit');
      };

      try {
        const uploadRes = await app.inject({
          method: 'PUT',
          url: registered.upload_url,
          headers: {
            Authorization: `Bearer ${registered.upload_token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(fileSize),
          },
          payload: mp4Data,
        });

        assert.strictEqual(uploadRes.statusCode, 500);
        const body = JSON.parse(uploadRes.payload);
        assert.strictEqual(body.error, 'internal_error');

        // Verify destination file was unlinked and does not remain orphaned
        const destinationPath = defaultStorageService.resolvePath(
          `media/${activeProjectId}/${registered.id}/original.mp4`
        );
        const exists = await defaultStorageService.fileExists(destinationPath);
        assert.strictEqual(exists, false, 'Orphaned final file must be deleted upon confirmed finalization failure');

        // Asset must be marked failed
        const dbCheck = await testPool.query(
          `SELECT status FROM media_assets WHERE id = $1;`,
          [registered.id]
        );
        assert.strictEqual(dbCheck.rows[0]!.status, 'failed');
      } finally {
        MediaService.prototype.finalizeUpload = originalFinalize;
      }
    });

    it('should preserve final file and log alert if commit outcome cannot be determined', async () => {
      const fileSize = 1024;
      const mp4Data = createMockMp4Buffer(fileSize, 'isom');

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'uncertain.mp4', mime_type: 'video/mp4', file_size_bytes: fileSize },
      });
      const registered = JSON.parse(regRes.payload);

      const originalFinalize = MediaService.prototype.finalizeUpload;
      const originalCheck = MediaService.prototype.checkAssetStatus;

      // Simulate both finalize and status check failing (uncertain outcome)
      MediaService.prototype.finalizeUpload = async () => {
        throw new Error('Connection terminated unexpectedly');
      };
      MediaService.prototype.checkAssetStatus = async () => {
        throw new Error('Database completely unreachable');
      };

      try {
        const uploadRes = await app.inject({
          method: 'PUT',
          url: registered.upload_url,
          headers: {
            Authorization: `Bearer ${registered.upload_token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(fileSize),
          },
          payload: mp4Data,
        });

        assert.strictEqual(uploadRes.statusCode, 500);

        // When outcome cannot be determined, file MUST be preserved for manual reconciliation
        const destinationPath = defaultStorageService.resolvePath(
          `media/${activeProjectId}/${registered.id}/original.mp4`
        );
        const exists = await defaultStorageService.fileExists(destinationPath);
        assert.strictEqual(exists, true, 'File must be preserved when commit outcome is uncertain');

        // Clean up preserved file manually
        await defaultStorageService.unlinkFile(destinationPath);
      } finally {
        MediaService.prototype.finalizeUpload = originalFinalize;
        MediaService.prototype.checkAssetStatus = originalCheck;
      }
    });
  });

  describe('4. Real HTTP Streaming & Socket Behaviour', () => {
    let httpServer: ReturnType<typeof buildApp>;
    let httpPort: number;

    before(async () => {
      httpServer = buildApp();
      await httpServer.listen({ port: 0 });
      httpPort = (httpServer.server.address() as any).port;
    });

    after(async () => {
      await httpServer.close();
    });

    it('should enforce inactivity timeout on idle HTTP stream with 408', async () => {
      // Set short inactivity timeout for test
      process.env.STORAGE_INACTIVITY_TIMEOUT_MS = '150';

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'inactivity.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      const status = await new Promise<number>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(0), 4000);
        const req = http.request(
          {
            port: httpPort,
            method: 'PUT',
            path: registered.upload_url,
            headers: {
              Authorization: `Bearer ${registered.upload_token}`,
              'Content-Type': 'video/mp4',
              'Content-Length': '1024',
            },
          },
          (res) => {
            clearTimeout(timer);
            resolvePromise(res.statusCode ?? 0);
          }
        );

        req.on('error', (err) => {
          clearTimeout(timer);
          resolvePromise(408);
        });
        req.write(createMockMp4Buffer(100));
      });

      assert.strictEqual(status, 408);
      delete process.env.STORAGE_INACTIVITY_TIMEOUT_MS;
    });

    it('should enforce maximum upload duration with 408', async () => {
      // Set short max duration for test
      process.env.STORAGE_MAX_UPLOAD_DURATION_MS = '250';

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'duration.mp4', mime_type: 'video/mp4', file_size_bytes: 1024 },
      });
      const registered = JSON.parse(regRes.payload);

      const status = await new Promise<number>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(0), 4000);
        let interval: NodeJS.Timeout;
        const req = http.request(
          {
            port: httpPort,
            method: 'PUT',
            path: registered.upload_url,
            headers: {
              Authorization: `Bearer ${registered.upload_token}`,
              'Content-Type': 'video/mp4',
              'Content-Length': '1024',
            },
          },
          (res) => {
            clearTimeout(timer);
            clearInterval(interval);
            resolvePromise(res.statusCode ?? 0);
          }
        );

        req.on('error', (err) => {
          clearTimeout(timer);
          clearInterval(interval);
          resolvePromise(408);
        });

        req.write(createMockMp4Buffer(100));
        interval = setInterval(() => {
          if (!req.destroyed) {
            req.write(Buffer.alloc(50));
          }
        }, 80);

        setTimeout(() => {
          clearInterval(interval);
        }, 500);
      });

      assert.strictEqual(status, 408);
      delete process.env.STORAGE_MAX_UPLOAD_DURATION_MS;
    });

    it('should handle client disconnect gracefully without leaving temporary files', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: { original_filename: 'disconnect.mp4', mime_type: 'video/mp4', file_size_bytes: 10240 },
      });
      const registered = JSON.parse(regRes.payload);

      await new Promise<void>((resolvePromise) => {
        const req = http.request({
          port: httpPort,
          method: 'PUT',
          path: registered.upload_url,
          headers: {
            Authorization: `Bearer ${registered.upload_token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': '10240',
          },
        });

        req.on('error', () => {
          // Client error expected upon destroy
          resolvePromise();
        });

        req.write(createMockMp4Buffer(100));
        // Abruptly destroy client socket
        setTimeout(() => {
          req.destroy();
          resolvePromise();
        }, 50);
      });

      // Wait a moment for server cleanup
      await new Promise((r) => setTimeout(r, 100));

      // Temp file must be unlinked
      const tempPath = resolve(TEST_STORAGE_DIR, '.tmp', `${registered.id}.upload.tmp`);
      const tempExists = await defaultStorageService.fileExists(tempPath);
      assert.strictEqual(tempExists, false, 'Temporary file must be unlinked on client disconnect');

      // Asset marked failed in DB
      const dbCheck = await testPool.query(
        `SELECT status FROM media_assets WHERE id = $1;`,
        [registered.id]
      );
      assert.strictEqual(dbCheck.rows[0]!.status, 'failed');
    });
  });

  describe('5. Stale Temporary File Cleanup', () => {
    it('should clean up stale temporary files exceeding max age threshold', async () => {
      const storage = new LocalStorageService(TEST_STORAGE_DIR);
      await storage.init();

      const tempDir = resolve(TEST_STORAGE_DIR, '.tmp');
      const staleFile = resolve(tempDir, 'stale_test_123.upload.tmp');
      const freshFile = resolve(tempDir, 'fresh_test_456.upload.tmp');

      await writeFile(staleFile, 'old data');
      await writeFile(freshFile, 'new data');

      // Backdate stale file mtime by 3 hours
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await utimes(staleFile, threeHoursAgo, threeHoursAgo);

      // Run cleanup with 2 hour threshold
      const result = await storage.cleanupStaleTempFiles(2 * 60 * 60 * 1000);
      assert.ok(result.deleted >= 1);
      assert.strictEqual(result.errors, 0);

      // Stale file should be gone, fresh file should still exist
      assert.strictEqual(await storage.fileExists(staleFile), false);
      assert.strictEqual(await storage.fileExists(freshFile), true);

      // Clean up fresh file
      await storage.unlinkFile(freshFile);
    });

    it('should execute startup cleanup during application boot, removing stale files while preserving active upload files', async () => {
      const tempDir = resolve(TEST_STORAGE_DIR, '.tmp');
      await mkdir(tempDir, { recursive: true });

      // 1. Create an active uploading asset in the database
      const activeAssetId = uuidv7();
      await testPool.query(`
        INSERT INTO media_assets (
          id, project_id, original_filename, mime_type, file_size_bytes, storage_key, status, updated_at
        ) VALUES (
          $1, $2, 'active.mp4', 'video/mp4', 1024, 'storage/active.mp4', 'uploading', NOW()
        );
      `, [activeAssetId, activeProjectId]);

      // 2. Create an orphaned stale temporary file (> 2 hours old, not an active upload)
      const staleOrphanedFile = resolve(tempDir, '00000000-0000-0000-0000-000000000001.upload.tmp');
      await writeFile(staleOrphanedFile, 'orphaned upload chunk');
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await utimes(staleOrphanedFile, threeHoursAgo, threeHoursAgo);

      // 3. Create a temporary file belonging to the actively uploading asset (even if older mtime)
      const activeUploadFile = resolve(tempDir, `${activeAssetId}.upload.tmp`);
      await writeFile(activeUploadFile, 'active in-flight chunk');
      await utimes(activeUploadFile, threeHoursAgo, threeHoursAgo);

      // 4. Create a fresh temporary file modified 5 minutes ago (< 2 hours old)
      const freshFile = resolve(tempDir, '00000000-0000-0000-0000-000000000002.upload.tmp');
      await writeFile(freshFile, 'recent chunk');
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
      await utimes(freshFile, fiveMinsAgo, fiveMinsAgo);

      // 5. Initialize application (triggers startup lifecycle cleanup in mediaRoutes)
      const startupApp = buildApp();
      await startupApp.ready();

      // Assertions:
      // A. The stale orphaned file MUST be removed
      assert.strictEqual(
        await defaultStorageService.fileExists(staleOrphanedFile),
        false,
        'Stale orphaned temporary file must be removed during startup'
      );

      // B. The active upload file MUST be preserved
      assert.strictEqual(
        await defaultStorageService.fileExists(activeUploadFile),
        true,
        'Temporary file belonging to an active upload must NEVER be removed'
      );

      // C. The fresh file (< 2 hours) MUST be preserved
      assert.strictEqual(
        await defaultStorageService.fileExists(freshFile),
        true,
        'Recent temporary file (< 2h) must be preserved'
      );

      // Cleanup
      await startupApp.close();
      await defaultStorageService.unlinkFile(activeUploadFile);
      await defaultStorageService.unlinkFile(freshFile);
    });
  });

  describe('6. Metadata Retrieval & Tenant Isolation (GET /v1/media/:id)', () => {
    it('should retrieve asset metadata for project owner', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: {
          original_filename: 'owner_check.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 1024,
        },
      });
      const registered = JSON.parse(regRes.payload);

      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/media/${registered.id}`,
        headers: {
          Authorization: `Bearer ${activeApiKey}`,
        },
      });

      assert.strictEqual(getRes.statusCode, 200);
      const body = JSON.parse(getRes.payload);
      assert.strictEqual(body.id, registered.id);
      assert.strictEqual(body.original_filename, 'owner_check.mp4');
      assert.strictEqual((body as any).storage_key, undefined);
    });

    it('should return 404 when querying an asset owned by another project', async () => {
      // Create Project B and key
      const accRes = await testPool.query(`SELECT id FROM accounts LIMIT 1;`);
      const projBRes = await testPool.query(
        `INSERT INTO projects (account_id, name, status) VALUES ($1, 'Tenant B', 'active') RETURNING id;`,
        [accRes.rows[0]!.id]
      );
      const projectBId = projBRes.rows[0]!.id;
      const keyBGen = generateApiKey('lumen_live');
      await testPool.query(
        `INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, 'Key B', $2, $3);`,
        [projectBId, keyBGen.keyPrefix, keyBGen.hash]
      );

      // Register asset under Project A
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { Authorization: `Bearer ${activeApiKey}` },
        payload: {
          original_filename: 'tenant_a.mp4',
          mime_type: 'video/mp4',
          file_size_bytes: 1024,
        },
      });
      const registeredA = JSON.parse(regRes.payload);

      // Query from Project B API key
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/media/${registeredA.id}`,
        headers: {
          Authorization: `Bearer ${keyBGen.apiKey}`,
        },
      });

      assert.strictEqual(getRes.statusCode, 404);
      const body = JSON.parse(getRes.payload);
      assert.strictEqual(body.error, 'asset_not_found');
    });

    it('should return sanitized HTTP 500 without leaking database internal errors', async () => {
      const originalQuery = testPool.query;
      // Simulate unexpected query error
      const mediaService = new MediaService(testPool);
      const origGet = mediaService.getMediaAsset;

      const appWithError = buildApp();
      appWithError.get('/test-error', async () => {
        throw new Error('pg: relation "secrets" does not exist at /var/lib/postgresql');
      });
      await appWithError.ready();

      const res = await appWithError.inject({
        method: 'GET',
        url: '/test-error',
      });

      assert.strictEqual(res.statusCode, 500);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.error, 'internal_error');
      assert.strictEqual(body.message, 'An internal error occurred');
      assert.strictEqual((body as any).stack, undefined);
      assert.ok(!res.payload.includes('relation "secrets"'));

      await appWithError.close();
    });
  });
});
