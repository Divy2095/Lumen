import '../../test/integration-preload.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../../app.js';
import { TestPool } from '../../test/db-guard.js';
import { testStorageDirectory, removeTestStorage } from '../../test/test-environment.js';
import { createMediaQueue } from '../../workers/queue.js';
import { createMediaWorker } from '../../workers/worker.js';
import { OutboxPublisher } from '../../workers/outbox-publisher.js';
import { browserToken, testClerkService } from './browser-test-fixtures.js';

it('Clerk browser upload processes through the existing outbox/worker and delivers tenant-scoped metadata/JPEG', {
  timeout: 60000,
}, async () => {
  const directory = testStorageDirectory('browser-media');
  const previousStorage = process.env.STORAGE_BASE_DIR;
  process.env.STORAGE_BASE_DIR = directory;
  const db = new TestPool();
  const queueName = `browser-${randomUUID()}`;
  const queue = createMediaQueue(queueName);
  const logger = { info() {}, warn() {}, error() {} };
  const worker = createMediaWorker({ queueName, db, logger });
  const publisher = new OutboxPublisher(db, queue, { pollIntervalMs: 50, logger });
  const app = buildApp({ logger: false, clerkService: testClerkService() });
  const subject = `user_${randomUUID().replace(/-/g, '')}`;
  const otherSubject = `user_${randomUUID().replace(/-/g, '')}`;
  try {
    const projectIds: string[] = [];
    for (const sub of [subject, otherSubject]) {
      const account = randomUUID(), project = randomUUID();
      await db.query('INSERT INTO accounts (id, email) VALUES ($1, $2)', [account, `${account}@test.invalid`]);
      await db.query("INSERT INTO account_identities (account_id, provider, provider_subject) VALUES ($1, 'clerk', $2)",
        [account, sub]);
      await db.query('INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)', [project, account, 'Browser']);
      projectIds.push(project);
    }
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: `Bearer ${await browserToken(subject)}` };
    const otherHeaders = { authorization: `Bearer ${await browserToken(otherSubject)}` };
    const bytes = await readFile(resolve('src/test/fixtures/valid_sample.mp4'));
    const registration = await fetch(`${origin}/v1/browser/media`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ original_filename: 'browser.mp4', mime_type: 'video/mp4', file_size_bytes: bytes.length,
        transcoding: { enabled: false } }),
    });
    assert.equal(registration.status, 201);
    const asset = await registration.json() as { id: string; upload_token: string; upload_url: string; project_id?: string };
    assert.equal(asset.project_id, undefined);
    const stored = await db.query('SELECT project_id FROM media_assets WHERE id=$1', [asset.id]);
    assert.equal(stored.rows[0].project_id, projectIds[0]);
    assert.equal((await fetch(`${origin}${asset.upload_url}`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'video/mp4' }, body: bytes,
    })).status, 401);
    const uploadHeaders = { authorization: `Bearer ${asset.upload_token}`, 'content-type': 'video/mp4' };
    const uploaded = await fetch(origin + asset.upload_url, { method: 'PUT', headers: uploadHeaders, body: bytes });
    assert.equal(uploaded.status, 200, await uploaded.text());
    assert.equal((await fetch(origin + asset.upload_url, { method: 'PUT', headers: uploadHeaders, body: bytes })).status, 409);
    publisher.start();
    let completed = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const jobs = await db.query('SELECT operation, status FROM processing_jobs WHERE media_asset_id=$1', [asset.id]);
      if (jobs.rows.length === 2 && jobs.rows.every(row => row.status === 'completed')) { completed = true; break; }
      if (jobs.rows.some(row => row.status === 'failed')) assert.fail('Browser fixture processing failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(completed, true);
    const status = await fetch(`${origin}/v1/browser/media/${asset.id}`, { headers });
    assert.equal(status.status, 200);
    const text = await status.text();
    const dto = JSON.parse(text);
    assert.equal(dto.status, 'ready');
    assert.ok(dto.technical.duration_seconds > 0);
    assert.ok(dto.technical.width > 0);
    assert.ok(dto.processing.every((job: { status: string }) => job.status === 'completed'));
    assert.doesNotMatch(text, /storage_key|consumed_token_hash|rawMetadata|project_id|account_id|parameters/);
    const thumbnail = await fetch(origin + dto.thumbnail.url, { headers });
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get('content-type'), 'image/jpeg');
    const jpeg = Buffer.from(await thumbnail.arrayBuffer());
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    for (const suffix of ['', '/thumbnail']) {
      const path = `${origin}/v1/browser/media/${asset.id}${suffix}`;
      assert.equal((await fetch(path, { headers: otherHeaders })).status, 404);
      assert.equal((await fetch(path)).status, 401);
    }
    // A second active project must revoke implicit selection on all browser reads.
    const account = await db.query('SELECT account_id FROM projects WHERE id=$1', [projectIds[0]]);
    await db.query("INSERT INTO projects (account_id, name) VALUES ($1, 'Ambiguous')", [account.rows[0].account_id]);
    assert.equal((await fetch(`${origin}/v1/browser/media/${asset.id}`, { headers })).status, 409);
  } finally {
    await publisher.stop(); await worker.close();
    await queue.obliterate({ force: true }); await queue.close();
    await app.close(); await db.end(); await removeTestStorage(directory);
    if (previousStorage === undefined) delete process.env.STORAGE_BASE_DIR;
    else process.env.STORAGE_BASE_DIR = previousStorage;
  }
});
