import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTestMigrationPlan } from '../test/migration-plan.js';
import { WEBHOOK_EVENT_TYPES } from '../modules/webhooks/webhook-contract.js';

it('keeps historical values untouched while quarantining legacy webhook records', async () => {
  const up = (await readTestMigrationPlan())[2]!.up;
  assert.doesNotMatch(up, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i);
  const updates = [...up.matchAll(/^UPDATE[^;]+;/gm)].map(match => match[0]);
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /^UPDATE webhook_delivery_attempts a SET project_id = d.project_id/);
  assert.match(up, /ADD COLUMN schema_version SMALLINT NOT NULL DEFAULT 0/);
  assert.match(up, /schema_version = 0 AND deduplication_key IS NULL AND payload_bytes IS NULL/);
  assert.match(up, /contract_version = 0 AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL/);
});

it('declares wire immutability, logical uniqueness, ownership/contract FKs, and bounded active slots', async () => {
  const up = (await readTestMigrationPlan())[2]!.up;
  for (const event of WEBHOOK_EVENT_TYPES) assert.ok(up.includes(`'${event}'`));
  assert.match(up, /UNIQUE INDEX uq_webhook_event_logical ON webhook_events \(project_id, event_type, deduplication_key\)/);
  assert.match(up, /OLD IS DISTINCT FROM NEW/);
  assert.match(up, /wire := convert_to\(NEW.payload::TEXT, 'UTF8'\)/);
  assert.match(up, /active_slot IS NOT NULL AND active_slot BETWEEN 1 AND 5/);
  assert.match(up, /UNIQUE INDEX uq_webhook_endpoint_active_slot ON webhook_endpoints \(project_id, active_slot\)/);
  assert.match(up, /previous_secret_valid_until <= rotation_started_at \+ INTERVAL '24 hours'/);
  assert.match(up, /FOREIGN KEY \(project_id, event_id, contract_version\)/);
  assert.match(up, /FOREIGN KEY \(project_id, endpoint_id, contract_version\)/);
  assert.match(up, /FOREIGN KEY \(project_id, delivery_id, contract_version\)/);
  assert.match(up, /octet_length\(payload_bytes\) BETWEEN 1 AND 65536/);
  const original = await readFile('migrations/001_initial_schema.sql', 'utf8');
  assert.match(original, /UNIQUE \(event_id, endpoint_id\)/);
});

it('adds scheduling metadata without emitting events or changing media dispatch behavior', async () => {
  const up = (await readTestMigrationPlan())[2]!.up;
  assert.doesNotMatch(up, /INSERT INTO (?:outbox_events|webhook_events|webhook_deliveries)/i);
  assert.match(up, /idx_outbox_available ON outbox_events \(available_at, created_at, id\) WHERE published_at IS NULL/);
  assert.match(up, /idx_webhook_delivery_expired_lease/);
  assert.match(up, /idx_webhook_delivery_due/);
});
