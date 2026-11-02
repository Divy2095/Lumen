import type { Pool } from 'pg';

export const REQUIRED_TEST_DATABASE = 'lumen_test';

/**
 * Fail-closed safety guard for test execution.
 * Ensures destructive test operations (such as TRUNCATE or DROP) can NEVER
 * execute against the development or production database ("lumen").
 *
 * @throws {Error} if the connected database is not "lumen_test".
 */
export async function assertTestDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ current_database: string }>('SELECT current_database();');
  const currentDb = result.rows[0]?.current_database;

  if (currentDb !== REQUIRED_TEST_DATABASE) {
    throw new Error(
      `CRITICAL DATABASE SAFETY VIOLATION: Refusing to run destructive operations on database "${currentDb}". Tests must strictly target "${REQUIRED_TEST_DATABASE}".`
    );
  }
}
