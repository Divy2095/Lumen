import { Pool, type PoolConfig, type PoolClient, type QueryResult } from 'pg';
import { assertTestEnvironment, TEST_DATABASE, TEST_ROLE } from './test-environment.js';

export const REQUIRED_TEST_DATABASE = TEST_DATABASE;
type SafetyQuery = (text: string, values?: unknown[]) => Promise<QueryResult>;

/** Must run through the very same client that is about to issue test writes. */
export async function assertTestConnection(query: SafetyQuery, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = assertTestEnvironment(env);
  const identity = await query(`SELECT current_database() AS database, current_user AS role,
    session_user AS session_role, inet_server_port() AS port,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) AS memberships,
    EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datallowconn
      AND d.datname <> current_database() AND has_database_privilege(current_user, d.oid, 'CONNECT')) AS other_databases
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;`);
  const row = identity.rows[0];
  if (identity.rows.length !== 1 || row.database !== TEST_DATABASE || row.role !== TEST_ROLE ||
      row.session_role !== TEST_ROLE || row.port !== 5432 ||
      [row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolreplication, row.rolbypassrls, row.memberships, row.other_databases].some((flag) => flag !== false)) {
    throw new Error('CRITICAL DATABASE SAFETY VIOLATION: connected database identity or role privileges are unsafe');
  }
  const marker = await query(`SELECT m.purpose, m.token,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner,
    has_schema_privilege(current_user, 'lumen_test_safety', 'CREATE') AS schema_write,
    has_table_privilege(current_user, 'lumen_test_safety.disposable_environment',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS marker_write
    FROM lumen_test_safety.disposable_environment m
    JOIN pg_catalog.pg_class c ON c.oid = 'lumen_test_safety.disposable_environment'::regclass;`);
  const proof = marker.rows[0];
  if (marker.rows.length !== 1 || proof.purpose !== 'lumen-disposable-integration-v1' || proof.token !== token ||
      proof.owner !== 'lumen_test_admin' || proof.schema_write !== false || proof.marker_write !== false) {
    throw new Error('CRITICAL DATABASE SAFETY VIOLATION: disposable marker is missing, mutable, or mismatched');
  }
}

export async function assertTestDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try { await assertTestConnection(client.query.bind(client) as SafetyQuery); }
  finally { client.release(); }
}

/** Each pool client checks safety before every statement; ROLLBACK remains available on failure. */
export function guardClient(client: Pick<PoolClient, 'query'>): void {
  const original = client.query.bind(client) as SafetyQuery;
  client.query = ((...args: any[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const execute = async () => {
      if (typeof text !== 'string') throw new Error('Test safety: unsupported query');
      if (!/^\s*ROLLBACK\s*;?\s*$/i.test(text)) await assertTestConnection(original);
      return await (original as any)(...args);
    };
    if (callback) { void execute().then((result) => callback(null, result), (error) => callback(error)); return; }
    return execute();
  }) as PoolClient['query'];
}

export class TestPool extends Pool {
  constructor(config: PoolConfig = {}) {
    assertTestEnvironment();
    for (const [key, expected] of Object.entries({ host: 'postgres-test', port: 5432, database: TEST_DATABASE, user: TEST_ROLE, password: process.env.PGPASSWORD })) {
      if (config[key as keyof PoolConfig] !== undefined && config[key as keyof PoolConfig] !== expected) {
        throw new Error(`Test safety: pool ${key} override is forbidden`);
      }
    }
    if (config.connectionString) throw new Error('Test safety: connection strings are forbidden');
    super({ ...config, host: 'postgres-test', port: 5432, database: TEST_DATABASE, user: TEST_ROLE, password: process.env.PGPASSWORD });
    this.on('connect', guardClient);
  }
}

export function createTestPool(config: PoolConfig = {}): Pool { return new TestPool(config); }
