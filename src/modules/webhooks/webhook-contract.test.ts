import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_POLICY, parseWebhookEvent, webhookDeduplicationKey } from './webhook-contract.js';

const asset = '01900000-0000-7000-8000-000000000001';
const job = '01900000-0000-7000-8000-000000000002';
function envelope(type: string, data: Record<string, unknown>) {
  return { id: asset, type, schema_version: 1, created_at: '2026-11-13T10:00:00.000Z', project_id: job, data };
}
const examples = [
  envelope('asset.ingested', { asset_id: asset, stage: 'ingestion', status: 'ready' }),
  envelope('asset.failed', { asset_id: asset, stage: 'ingestion', status: 'failed', error: { code: 'INGESTION_FAILED' } }),
  envelope('rendition.ready', { asset_id: asset, job_id: job, profile: '720p', status: 'ready', output_id: asset, version: 1 }),
  envelope('rendition.failed', { asset_id: asset, job_id: job, profile: '720p', status: 'failed', error: { code: 'TRANSCODING_FAILED' } }),
];

it('accepts exactly the four approved version-1 ingestion/rendition event envelopes', () => {
  assert.deepEqual(examples.map(event => parseWebhookEvent(event).type), [...WEBHOOK_EVENT_TYPES]);
  assert.equal(parseWebhookEvent(examples[0]).data.status, 'ready');
  for (const type of ['asset.ready', 'metadata.ready', 'thumbnail.failed', 'asset.processing.completed']) {
    assert.throws(() => parseWebhookEvent({ ...examples[0], type }));
  }
});

it('deduplicates logical outcomes independently of event IDs and delivery time', () => {
  const expected = [`asset:${asset}:ingested`, `asset:${asset}:failed`, `rendition:${job}:ready`, `rendition:${job}:failed`];
  examples.forEach((value, i) => {
    const event = parseWebhookEvent(value);
    assert.equal(webhookDeduplicationKey(event), expected[i]);
    assert.equal(webhookDeduplicationKey({ ...event, id: job, created_at: '2026-11-14T10:00:00.000Z' }), expected[i]);
  });
  const ready = parseWebhookEvent(examples[2]);
  if (ready.type !== 'rendition.ready') throw new Error('Invalid test fixture');
  assert.notEqual(webhookDeduplicationKey({ ...ready, data: { ...ready.data, job_id: asset } }), expected[2]);
});

it('rejects extra envelope/data/error fields instead of carrying secrets, paths, or raw diagnostics', () => {
  for (const event of examples) {
    for (const field of ['secret', 'api_key', 'path', 'stderr', 'message']) {
      assert.throws(() => parseWebhookEvent({ ...event, [field]: 'not-permitted' }));
      assert.throws(() => parseWebhookEvent({ ...event, data: { ...event.data, [field]: 'not-permitted' } }));
    }
  }
  assert.throws(() => parseWebhookEvent({ ...examples[1], data: { ...examples[1]!.data, error: { code: 'INGESTION_FAILED', message: 'not-permitted' } } }));
  assert.throws(() => parseWebhookEvent({ ...examples[3], data: { ...examples[3]!.data, error: { code: 'INTERNAL_STACK' } } }));
});

it('requires canonical UUIDs, schema version 1, and a real millisecond UTC timestamp', () => {
  for (const change of [{ id: 'bad' }, { project_id: null }, { schema_version: 0 }, { schema_version: '1' },
    { created_at: '2026-11-13T10:00:00Z' }, { created_at: '2026-02-30T10:00:00.000Z' },
    { created_at: '2026-11-13T10:00:00.000+00:00' }, { created_at: '0000-01-01T00:00:00.000Z' }]) {
    assert.throws(() => parseWebhookEvent({ ...examples[0], ...change }));
  }
  for (const value of [null, [], 1, new Date()]) assert.throws(() => parseWebhookEvent(value));
  const missing = { ...examples[0] }; delete (missing as Record<string, unknown>).id;
  assert.throws(() => parseWebhookEvent(missing));
});

it('rejects nulls, mismatched statuses, invalid profiles, versions, and source identifiers', () => {
  for (const event of examples) {
    for (const key of Object.keys(event.data)) {
      assert.throws(() => parseWebhookEvent({ ...event, data: { ...event.data, [key]: null } }));
    }
    assert.throws(() => parseWebhookEvent({ ...event, data: { ...event.data, status: 'processing' } }));
  }
  for (const version of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => parseWebhookEvent({ ...examples[2], data: { ...examples[2]!.data, version } }));
  }
  assert.throws(() => parseWebhookEvent({ ...examples[2], data: { ...examples[2]!.data, profile: '4k' } }));
  assert.throws(() => parseWebhookEvent({ ...examples[0], data: { ...examples[0]!.data, stage: 'processing' } }));
});

it('records approved future limits without implementing a scheduler or sender', () => {
  assert.deepEqual(WEBHOOK_POLICY, { maxActiveEndpointsPerProject: 5, secretOverlapHours: 24, maxAttempts: 8,
    retryBaseMs: 60000, retryCapMs: 3600000, maxDeliveryAgeMs: 86400000, httpDeadlineMs: 10000,
    globalConcurrency: 4, perEndpointConcurrency: 1, maxRequestBytes: 65536, maxResponseHeaderBytes: 16384 });
  assert.ok(Object.isFrozen(WEBHOOK_POLICY));
});
