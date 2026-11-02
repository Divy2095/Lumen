import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseError, Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { assertTestDatabase } from '../test/db-guard.js';

const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
  database: process.env.PGDATABASE ?? 'lumen_test',
  user: process.env.PGUSER ?? 'lumen',
  password: process.env.PGPASSWORD,
});

async function cleanupTestData(): Promise<void> {
  await assertTestDatabase(pool);
  await pool.query(`
    TRUNCATE TABLE
      idempotency_keys,
      outbox_events,
      webhook_delivery_attempts,
      webhook_deliveries,
      webhook_events,
      webhook_endpoints,
      media_outputs,
      job_attempts,
      processing_jobs,
      media_assets,
      api_keys,
      projects,
      account_identities,
      accounts
    CASCADE;
  `);
}

test.before(async () => {
  await assertTestDatabase(pool);
  await cleanupTestData();
});

test.after(async () => {
  try {
    await cleanupTestData();
  } finally {
    await pool.end();
  }
});

function isDatabaseErrorWithCode(err: unknown, expectedCode: string): boolean {
  return err instanceof DatabaseError && err.code === expectedCode;
}

test('Schema Validation Suite', async (t) => {
  await t.test('1. All 14 expected tables exist in public schema', async () => {
    const expectedTables = [
      'accounts',
      'account_identities',
      'projects',
      'api_keys',
      'media_assets',
      'processing_jobs',
      'job_attempts',
      'media_outputs',
      'webhook_endpoints',
      'webhook_events',
      'webhook_deliveries',
      'webhook_delivery_attempts',
      'outbox_events',
      'idempotency_keys',
    ];

    const result = await pool.query<{ table_name: string }>(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);

    const tableNames = new Set(result.rows.map((r) => r.table_name));

    for (const table of expectedTables) {
      assert.ok(tableNames.has(table), `Table "${table}" must exist in the database`);
    }
  });

  await t.test('2. UUIDv7 application generation and fallback UUID default work', async () => {
    const customId = uuidv7();

    // Insert using application-supplied UUIDv7
    const customRes = await pool.query(
      `INSERT INTO accounts (id, email) VALUES ($1, $2) RETURNING id;`,
      [customId, `uuidv7-test-${Date.now()}@example.com`]
    );
    assert.equal(customRes.rows[0]?.id, customId);

    // Insert using PostgreSQL default gen_random_uuid()
    const defaultRes = await pool.query(
      `INSERT INTO accounts (email) VALUES ($1) RETURNING id;`,
      [`uuid-default-${Date.now()}@example.com`]
    );
    assert.ok(defaultRes.rows[0]?.id);
    assert.notEqual(defaultRes.rows[0]?.id, customId);
  });

  await t.test('3. Case-insensitive email uniqueness constraint', async () => {
    const email = `case-test-${Date.now()}@example.com`;
    await pool.query(`INSERT INTO accounts (email) VALUES ($1);`, [email]);

    await assert.rejects(
      async () => {
        await pool.query(`INSERT INTO accounts (email) VALUES ($1);`, [email.toUpperCase()]);
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23505') // Unique constraint violation
    );
  });

  await t.test('4. Tenant isolation constraint: jobs cannot reference assets from other projects', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `tenant-${Date.now()}@example.com`,
    ]);
    const accountId = accRes.rows[0]?.id;

    const projARes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Project A') RETURNING id;`,
      [accountId]
    );
    const projectAId = projARes.rows[0]?.id;

    const projBRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Project B') RETURNING id;`,
      [accountId]
    );
    const projectBId = projBRes.rows[0]?.id;

    // Create an asset under Project A
    const assetARes = await pool.query(
      `INSERT INTO media_assets (
        project_id, original_filename, mime_type, file_size_bytes, storage_key
      ) VALUES ($1, 'video.mp4', 'video/mp4', 1048576, 'storage/projA/video.mp4')
      RETURNING id;`,
      [projectAId]
    );
    const assetAId = assetARes.rows[0]?.id;

    // Attempt to create a processing job under Project B referencing Asset A (from Project A)
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO processing_jobs (
            project_id, media_asset_id, operation
          ) VALUES ($1, $2, 'extract_metadata');`,
          [projectBId, assetAId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23503') // Foreign key violation
    );

    // Creating the job under Project A (matching asset ownership) succeeds
    const jobARes = await pool.query(
      `INSERT INTO processing_jobs (
        project_id, media_asset_id, operation
      ) VALUES ($1, $2, 'extract_metadata') RETURNING id;`,
      [projectAId, assetAId]
    );
    assert.ok(jobARes.rows[0]?.id);
  });

  await t.test('5. Output-to-Job coherence: outputs cannot mix asset and unrelated job', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `coherence-${Date.now()}@example.com`,
    ]);
    const accountId = accRes.rows[0]?.id;

    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Coherence Project') RETURNING id;`,
      [accountId]
    );
    const projectId = projRes.rows[0]?.id;

    // Asset 1 with Job 1
    const asset1Res = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'vid1.mp4', 'video/mp4', 1000, 's1') RETURNING id;`,
      [projectId]
    );
    const asset1Id = asset1Res.rows[0]?.id;

    const job1Res = await pool.query(
      `INSERT INTO processing_jobs (project_id, media_asset_id, operation)
       VALUES ($1, $2, 'transcode') RETURNING id;`,
      [projectId, asset1Id]
    );
    const job1Id = job1Res.rows[0]?.id;

    // Asset 2
    const asset2Res = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'vid2.mp4', 'video/mp4', 2000, 's2') RETURNING id;`,
      [projectId]
    );
    const asset2Id = asset2Res.rows[0]?.id;

    // Attempting to create an output referencing Asset 2 and Job 1 (which belongs to Asset 1) MUST FAIL
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO media_outputs (
            media_asset_id, processing_job_id, output_type, logical_key, version, storage_key, mime_type, file_size_bytes
          ) VALUES ($1, $2, 'rendition', 'rendition:720p', 1, 's/out.mp4', 'video/mp4', 500);`,
          [asset2Id, job1Id]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23503') // fk_media_outputs_asset_job violation
    );

    // Creating output with Asset 1 and Job 1 succeeds
    const outputRes = await pool.query(
      `INSERT INTO media_outputs (
        media_asset_id, processing_job_id, output_type, logical_key, version, storage_key, mime_type, file_size_bytes
      ) VALUES ($1, $2, 'rendition', 'rendition:720p', 1, 's/out.mp4', 'video/mp4', 500) RETURNING id;`,
      [asset1Id, job1Id]
    );
    assert.ok(outputRes.rows[0]?.id);
  });

  await t.test('6. Attempt ceiling: attempt_number > 3 is rejected', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `attempts-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Attempts Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const assetRes = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'video.mp4', 'video/mp4', 1000, 'k') RETURNING id;`,
      [projRes.rows[0]?.id]
    );
    const jobRes = await pool.query(
      `INSERT INTO processing_jobs (project_id, media_asset_id, operation)
       VALUES ($1, $2, 'transcode') RETURNING id;`,
      [projRes.rows[0]?.id, assetRes.rows[0]?.id]
    );
    const jobId = jobRes.rows[0]?.id;

    // Attempts 1, 2, 3 succeed
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        `INSERT INTO job_attempts (job_id, attempt_number, status, fencing_token) VALUES ($1, $2, 'failed', $3);`,
        [jobId, i, uuidv7()]
      );
    }

    // Attempt 4 must fail check constraint
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO job_attempts (job_id, attempt_number, status, fencing_token) VALUES ($1, 4, 'processing', $2);`,
          [jobId, uuidv7()]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23514') // check_violation
    );
  });

  await t.test('7. Output versioning: duplicate is_current = true is rejected', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `version-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Version Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const assetRes = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'video.mp4', 'video/mp4', 1000, 'k') RETURNING id;`,
      [projRes.rows[0]?.id]
    );
    const jobRes = await pool.query(
      `INSERT INTO processing_jobs (project_id, media_asset_id, operation)
       VALUES ($1, $2, 'generate_thumbnail') RETURNING id;`,
      [projRes.rows[0]?.id, assetRes.rows[0]?.id]
    );
    const assetId = assetRes.rows[0]?.id;
    const jobId = jobRes.rows[0]?.id;

    // First current output succeeds
    await pool.query(
      `INSERT INTO media_outputs (
        media_asset_id, processing_job_id, output_type, logical_key, version, is_current, storage_key, mime_type, file_size_bytes
      ) VALUES ($1, $2, 'thumbnail', 'thumbnail:default', 1, true, 't1.jpg', 'image/jpeg', 100);`,
      [assetId, jobId]
    );

    // Second current output with same (media_asset_id, logical_key) without demoting first MUST FAIL
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO media_outputs (
            media_asset_id, processing_job_id, output_type, logical_key, version, is_current, storage_key, mime_type, file_size_bytes
          ) VALUES ($1, $2, 'thumbnail', 'thumbnail:default', 2, true, 't2.jpg', 'image/jpeg', 120);`,
          [assetId, jobId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23505') // Unique violation on partial index
    );
  });

  await t.test('8. Stale worker recovery: expired 3rd attempt transitions to failed', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `reaper-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Reaper Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const assetRes = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'video.mp4', 'video/mp4', 1000, 'k') RETURNING id;`,
      [projRes.rows[0]?.id]
    );
    const assetId = assetRes.rows[0]?.id;

    const jobRes = await pool.query(
      `INSERT INTO processing_jobs (
        project_id, media_asset_id, operation, status, current_attempt_number, lease_expires_at, locked_by
      ) VALUES ($1, $2, 'transcode', 'processing', 3, NOW() - INTERVAL '10 seconds', 'worker-crashed')
      RETURNING id;`,
      [projRes.rows[0]?.id, assetId]
    );
    const jobId = jobRes.rows[0]?.id;

    const reapResult = await pool.query(
      `UPDATE processing_jobs
       SET status = 'failed',
           lease_expires_at = NULL,
           locked_by = NULL,
           lease_token = NULL,
           completed_at = NOW()
       WHERE status = 'processing'
         AND lease_expires_at < NOW()
         AND current_attempt_number >= 3
         AND id = $1
       RETURNING id, status;`,
      [jobId]
    );

    assert.equal(reapResult.rowCount, 1);
    assert.equal(reapResult.rows[0]?.status, 'failed');
  });

  await t.test('9. Worker fencing token prevents stale worker updates', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `fence-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Fencing Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const assetRes = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'video.mp4', 'video/mp4', 1000, 'k') RETURNING id;`,
      [projRes.rows[0]?.id]
    );

    const oldToken = uuidv7();
    const newToken = uuidv7();

    const jobRes = await pool.query(
      `INSERT INTO processing_jobs (
        project_id, media_asset_id, operation, status, lease_token, current_attempt_number
      ) VALUES ($1, $2, 'transcode', 'processing', $3, 1) RETURNING id;`,
      [projRes.rows[0]?.id, assetRes.rows[0]?.id, newToken]
    );
    const jobId = jobRes.rows[0]?.id;

    const staleUpdate = await pool.query(
      `UPDATE processing_jobs SET status = 'completed' WHERE id = $1 AND lease_token = $2;`,
      [jobId, oldToken]
    );
    assert.equal(staleUpdate.rowCount, 0, 'Stale worker with outdated lease_token must not update job');

    const validUpdate = await pool.query(
      `UPDATE processing_jobs SET status = 'completed' WHERE id = $1 AND lease_token = $2;`,
      [jobId, newToken]
    );
    assert.equal(validUpdate.rowCount, 1, 'Current worker with matching lease_token updates job');
  });

  await t.test('10. Webhook tenant isolation: cross-project deliveries are rejected', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `webhook-tenant-${Date.now()}@example.com`,
    ]);
    const accountId = accRes.rows[0]?.id;

    // Create Project A and Project B
    const projARes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Webhook Proj A') RETURNING id;`,
      [accountId]
    );
    const projectAId = projARes.rows[0]?.id;

    const projBRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Webhook Proj B') RETURNING id;`,
      [accountId]
    );
    const projectBId = projBRes.rows[0]?.id;

    // Create Endpoint under Project A
    const endpointARes = await pool.query(
      `INSERT INTO webhook_endpoints (project_id, url, encrypted_secret)
       VALUES ($1, 'https://example.com/webhook-a', decode('aabb', 'hex')) RETURNING id;`,
      [projectAId]
    );
    const endpointAId = endpointARes.rows[0]?.id;

    // Create Event under Project B
    const eventBRes = await pool.query(
      `INSERT INTO webhook_events (project_id, event_type, payload)
       VALUES ($1, 'media.processing.completed', '{"job_id":"abc"}'::jsonb) RETURNING id;`,
      [projectBId]
    );
    const eventBId = eventBRes.rows[0]?.id;

    // Attempting to deliver Event B to Endpoint A under Project A MUST FAIL composite FK
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO webhook_deliveries (project_id, event_id, endpoint_id)
           VALUES ($1, $2, $3);`,
          [projectAId, eventBId, endpointAId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23503') // Foreign key violation on project_event
    );

    // Attempting under Project B also fails because Endpoint A belongs to Project A
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO webhook_deliveries (project_id, event_id, endpoint_id)
           VALUES ($1, $2, $3);`,
          [projectBId, eventBId, endpointAId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23503') // Foreign key violation on project_endpoint
    );

    // Creating Event A under Project A and delivering to Endpoint A succeeds
    const eventARes = await pool.query(
      `INSERT INTO webhook_events (project_id, event_type, payload)
       VALUES ($1, 'media.processing.completed', '{"job_id":"xyz"}'::jsonb) RETURNING id;`,
      [projectAId]
    );
    const eventAId = eventARes.rows[0]?.id;

    const deliveryRes = await pool.query(
      `INSERT INTO webhook_deliveries (project_id, event_id, endpoint_id)
       VALUES ($1, $2, $3) RETURNING id;`,
      [projectAId, eventAId, endpointAId]
    );
    assert.ok(deliveryRes.rows[0]?.id);
  });

  await t.test('11. Upload byte integrity: uploaded_bytes > file_size_bytes is rejected', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `bytes-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Bytes Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const projectId = projRes.rows[0]?.id;

    // Valid uploaded_bytes (0 <= uploaded_bytes <= file_size_bytes) succeeds
    const validAsset = await pool.query(
      `INSERT INTO media_assets (
        project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key
      ) VALUES ($1, 'valid.mp4', 'video/mp4', 1000, 500, 'storage/valid.mp4')
      RETURNING id;`,
      [projectId]
    );
    assert.ok(validAsset.rows[0]?.id);

    // Invalid: uploaded_bytes > file_size_bytes MUST FAIL
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO media_assets (
            project_id, original_filename, mime_type, file_size_bytes, uploaded_bytes, storage_key
          ) VALUES ($1, 'overflow.mp4', 'video/mp4', 1000, 1001, 'storage/overflow.mp4');`,
          [projectId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23514') // Check violation chk_media_assets_uploaded_bytes
    );
  });

  await t.test('12. Worker attempt integrity: job_attempts.fencing_token cannot be NULL', async () => {
    const accRes = await pool.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id;`, [
      `token-notnull-${Date.now()}@example.com`,
    ]);
    const projRes = await pool.query(
      `INSERT INTO projects (account_id, name) VALUES ($1, 'Token Project') RETURNING id;`,
      [accRes.rows[0]?.id]
    );
    const assetRes = await pool.query(
      `INSERT INTO media_assets (project_id, original_filename, mime_type, file_size_bytes, storage_key)
       VALUES ($1, 'video.mp4', 'video/mp4', 1000, 'k') RETURNING id;`,
      [projRes.rows[0]?.id]
    );
    const jobRes = await pool.query(
      `INSERT INTO processing_jobs (project_id, media_asset_id, operation)
       VALUES ($1, $2, 'transcode') RETURNING id;`,
      [projRes.rows[0]?.id, assetRes.rows[0]?.id]
    );
    const jobId = jobRes.rows[0]?.id;

    // Attempting to insert job_attempts without fencing_token MUST FAIL NOT NULL constraint
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO job_attempts (job_id, attempt_number, status, fencing_token)
           VALUES ($1, 1, 'processing', NULL);`,
          [jobId]
        );
      },
      (err: unknown) => isDatabaseErrorWithCode(err, '23502') // not_null_violation
    );
  });

  await t.test('13. Test database safety guard fails closed if database is not lumen_test', async () => {
    // Construct a mock pool that reports current_database as 'lumen'
    const fakeDevPool = {
      query: async () => ({ rows: [{ current_database: 'lumen' }] }),
    } as unknown as Pool;

    await assert.rejects(
      async () => {
        await assertTestDatabase(fakeDevPool);
      },
      /CRITICAL DATABASE SAFETY VIOLATION/
    );
  });
});
