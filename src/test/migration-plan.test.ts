import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTestMigrationPlan } from './migration-plan.js';

it('returns only the reviewed 001/002/003/004 up sections and excludes the forward-only down guard', async () => {
  const plan = await readTestMigrationPlan();
  assert.deepEqual(plan.map(entry => entry.name), ['001_initial_schema.sql', '002_add_transcoding_config.sql', '003_webhook_contract.sql', '004_webhook_encryption_key_metadata.sql']);
  assert.match(plan[2]!.up, /ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(plan[2]!.up, /Migration 003 is forward-only/);
  assert.match(await readFile('migrations/003_webhook_contract.sql', 'utf8'), /-- Down Migration\s+DO \$\$ BEGIN\s+RAISE EXCEPTION 'Migration 003 is forward-only/);
});

it('fails closed for missing, extra, or unsafe migration files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-migration-plan-'));
  try {
    const names = ['001_initial_schema.sql', '002_add_transcoding_config.sql', '003_webhook_contract.sql', '004_webhook_encryption_key_metadata.sql'];
    for (const name of names) await writeFile(join(directory, name), '-- Up Migration\nSELECT 1;\n-- Down Migration\nSELECT 1;\n');
    assert.equal((await readTestMigrationPlan(directory)).length, 4);
    await writeFile(join(directory, '005_unreviewed.sql'), '-- Up Migration\nSELECT 1;\n-- Down Migration\n');
    await assert.rejects(readTestMigrationPlan(directory), /requires review/);
    await rm(join(directory, '005_unreviewed.sql'));
    await rm(join(directory, names[2]!));
    await assert.rejects(readTestMigrationPlan(directory), /requires review/);
    for (const unsafe of ['DELETE FROM accounts;', 'TRUNCATE accounts;', 'DROP TABLE accounts;']) {
      await writeFile(join(directory, names[2]!), `-- Up Migration\n${unsafe}\n-- Down Migration\n`);
      await assert.rejects(readTestMigrationPlan(directory), /Unsafe/);
    }
    await writeFile(join(directory, names[2]!), '-- Up Migration\nSELECT 1;');
    await assert.rejects(readTestMigrationPlan(directory), /missing up section/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('004 preserves historical ciphertext and guards new managed metadata without weakening 003', async () => {
  const up=(await readTestMigrationPlan())[3]!.up;
  assert.match(up,/ADD COLUMN encryption_key_id VARCHAR\(64\) NULL/);
  assert.match(up,/ADD COLUMN previous_encryption_key_id VARCHAR\(64\) NULL/);
  assert.doesNotMatch(up,/^\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/im);
  assert.match(up,/NEW.config_version = 1 AND NEW.encryption_key_id IS NULL/);
  assert.match(up,/previous_signing_key_id IS NOT NULL AND previous_encryption_key_id IS NOT NULL/);
  assert.match(up,/NEW.url IS DISTINCT FROM OLD.url/);
  assert.match(up,/BEFORE INSERT OR UPDATE/);
  assert.doesNotMatch(up,/Migration 004 is forward-only/);
});
