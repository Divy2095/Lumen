import { readdir, readFile } from 'node:fs/promises';

export async function readTestMigrationPlan(directory = 'migrations'): Promise<Array<{ name: string; up: string }>> {
  const names = (await readdir(directory)).filter((name) => /\.(sql|ts|js)$/.test(name)).sort();
  const expected = ['001_initial_schema.sql', '002_add_transcoding_config.sql', '003_webhook_contract.sql', '004_webhook_encryption_key_metadata.sql'];
  if (names.join(',') !== expected.join(',')) throw new Error('Test migration plan requires review: expected migrations 001, 002, 003, and 004 only');
  return await Promise.all(names.map(async (name) => {
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    const up = sql.match(/^\s*-- Up Migration\s*\n([\s\S]*?)^\s*-- Down Migration/m)?.[1];
    if (!up?.trim() || /^\s*(DROP|TRUNCATE|DELETE)\b/im.test(up)) throw new Error(`Unsafe or missing up section in ${name}`);
    return { name, up };
  }));
}
