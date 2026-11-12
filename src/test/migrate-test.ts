import { readTestMigrationPlan } from './migration-plan.js';
import { runner } from 'node-pg-migrate';
import { TestPool, assertTestConnection } from './db-guard.js';
import { integrationPreflight } from './preflight.js';

await readTestMigrationPlan();
await integrationPreflight();
const pool = new TestPool();
try {
  const client = await pool.connect();
  try {
    await assertTestConnection(client.query.bind(client));
    await runner({ dbClient: client, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', checkOrder: true });
  } finally { client.release(); }
} finally { await pool.end(); }
