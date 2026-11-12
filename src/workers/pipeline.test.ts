import '../test/integration-preload.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { uuidv7 } from 'uuidv7';
import { TestPool } from '../test/db-guard.js';
import { testStorageDirectory, removeTestStorage } from '../test/test-environment.js';
import { generateApiKey } from '../shared/crypto.js';
import { buildApp } from '../app.js';
import { createMediaQueue } from './queue.js';
import { createMediaWorker } from './worker.js';
import { OutboxPublisher } from './outbox-publisher.js';

it('authenticated HTTP upload travels through outbox, BullMQ, worker, and authenticated output delivery', { timeout: 60000 }, async () => {
  const directory = testStorageDirectory('pipeline');
  process.env.STORAGE_BASE_DIR = directory;
  const db = new TestPool();
  const queueName = `pipeline-${uuidv7()}`;
  const queue = createMediaQueue(queueName);
  const logger = { info() {}, warn() {}, error() {} };
  const worker = createMediaWorker({ queueName, db, logger });
  const publisher = new OutboxPublisher(db, queue, { pollIntervalMs: 50, logger });
  const app = buildApp();
  try {
    const account = uuidv7();
    await db.query('INSERT INTO accounts (id, email) VALUES ($1, $2)', [account, `${account}@test.invalid`]);
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const project = uuidv7();
      const key = generateApiKey();
      await db.query('INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)', [project, account, `pipeline-${i}`]);
      await db.query('INSERT INTO api_keys (project_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [project, 'pipeline', key.keyPrefix, key.hash]);
      keys.push(key.apiKey);
    }
    const source = resolve(directory, 'source.mp4');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-i', resolve('src/test/fixtures/valid_sample.mp4'), '-vf', 'scale=800:600', '-c:v', 'mpeg4', '-c:a', 'copy', source]);
    const bytes = await readFile(source);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: `Bearer ${keys[0]}` };
    const registered = await fetch(`${origin}/v1/media`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ original_filename: 'pipeline.mp4', mime_type: 'video/mp4', file_size_bytes: bytes.length, transcoding: { profiles: ['360p'] } }) });
    assert.equal(registered.status, 201);
    const asset = await registered.json() as { id: string; upload_token: string; upload_url: string };
    assert.ok(asset.upload_token);
    const uploaded = await fetch(origin + asset.upload_url, { method: 'PUT', headers: { authorization: `Bearer ${asset.upload_token}`, 'content-type': 'video/mp4' }, body: bytes });
    assert.equal(uploaded.status, 200, await uploaded.text());
    publisher.start();
    let completed = false;
    for (let i = 0; i < 400; i++) {
      const jobs = await db.query('SELECT operation, status FROM processing_jobs WHERE media_asset_id=$1', [asset.id]);
      if (jobs.rows.length === 3 && jobs.rows.every((row) => row.status === 'completed')) { completed = true; break; }
      if (jobs.rows.some((row) => row.status === 'failed')) assert.fail(JSON.stringify(jobs.rows));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(completed, true);
    const outputs = await db.query('SELECT output_type, width, height, is_current FROM media_outputs WHERE media_asset_id=$1', [asset.id]);
    assert.equal(outputs.rows.length, 2);
    assert.ok(outputs.rows.some((row) => row.output_type === 'thumbnail'));
    assert.ok(outputs.rows.some((row) => row.output_type === 'rendition' && row.width === 480 && row.height === 360 && row.is_current));
    const events = await db.query('SELECT published_at FROM outbox_events WHERE payload->>\'mediaAssetId\'=$1', [asset.id]);
    assert.equal(events.rows.length, 3);
    assert.ok(events.rows.every((row) => row.published_at));
    const rendition = `/v1/media/${asset.id}/renditions/360p`;
    const delivered = await fetch(origin + rendition, { headers });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.headers.get('content-type'), 'video/mp4');
    assert.ok((await delivered.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(origin + rendition)).status, 401);
    assert.equal((await fetch(origin + rendition, { headers: { authorization: `Bearer ${keys[1]}` } })).status, 404);
    assert.equal((await fetch(`${origin}/v1/media/${asset.id}/thumbnail`, { headers })).status, 200);
  } finally {
    await publisher.stop(); await worker.close(); await queue.obliterate({ force: true }); await queue.close();
    await app.close(); await db.end(); await removeTestStorage(directory);
  }
});
