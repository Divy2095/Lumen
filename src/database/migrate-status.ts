import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';

async function checkMigrationStatus(): Promise<void> {
  const poolConfig: PoolConfig = {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE ?? 'lumen',
    user: process.env.PGUSER ?? 'lumen',
    password: process.env.PGPASSWORD,
  };

  const pool = new Pool(poolConfig);

  try {
    const migrationsDir = resolve(process.cwd(), 'migrations');
    let diskFiles: string[] = [];
    try {
      diskFiles = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') || file.endsWith('.ts') || file.endsWith('.js'))
        .sort();
    } catch {
      console.log('No migrations directory found.');
      return;
    }

    // Check if pgmigrations table exists
    const tableCheck = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'pgmigrations'
      );
    `);

    const tableExists = tableCheck.rows[0]?.exists ?? false;
    const appliedMap = new Map<string, Date>();

    if (tableExists) {
      const result = await pool.query<{ name: string; run_on: Date }>(`
        SELECT name, run_on FROM pgmigrations ORDER BY id ASC;
      `);
      for (const row of result.rows) {
        appliedMap.set(row.name, row.run_on);
      }
    }

    console.log('\n=== Database Migration Status ===');
    console.log(`Database: ${poolConfig.database} (${poolConfig.host}:${poolConfig.port})`);
    console.log(`Total on disk: ${diskFiles.length} | Total applied: ${appliedMap.size}\n`);

    if (diskFiles.length === 0) {
      console.log('No migration files found on disk.');
      return;
    }

    const rows = diskFiles.map((file) => {
      const migrationName = file.replace(/\.(sql|ts|js)$/, '');
      const runOn = appliedMap.get(migrationName);
      return {
        Migration: migrationName,
        Status: runOn ? 'APPLIED' : 'PENDING',
        AppliedAt: runOn ? runOn.toISOString() : '-',
      };
    });

    console.table(rows);
    console.log('');
  } catch (err) {
    console.error('Failed to retrieve migration status:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void checkMigrationStatus();
