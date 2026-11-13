import { Client } from 'pg';
import { createInterface } from 'node:readline';
import { getDatabasePoolConfig } from '../database/pool.js';
import { ProvisioningError, ProvisioningService } from '../modules/auth/provisioning.service.js';
import { runProvisioningCli, type ProvisioningIO } from '../modules/auth/provisioning.cli.js';

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true;
function write(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${message}\n`, error => error ? reject(error) : resolve());
  });
}
// Handle stream errors without Node printing unsanitized connection/output details.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.stdin.on('error', () => {});
const io: ProvisioningIO = {
  interactive, write,
  error: message => { process.stderr.write(`${message}\n`); },
  question: prompt => new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.once('close', () => reject(new ProvisioningError('CONFIRMATION_CANCELLED')));
    rl.once('SIGINT', () => rl.close());
    rl.question(prompt, answer => { resolve(answer); rl.close(); });
  }),
  reveal: async secret => {
    if (!interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
    await write(`API key (shown once): ${secret}`);
  },
};

process.exitCode = await runProvisioningCli(process.argv.slice(2), io, async target => {
  const config = getDatabasePoolConfig();
  const host = config.host ?? '127.0.0.1';
  if (config.database !== target.database || config.user !== target.role ||
      !/^[A-Za-z0-9_./:\[\]-]{1,255}$/.test(host)) throw new ProvisioningError('DATABASE_IDENTITY_MISMATCH');
  const client = new Client({ ...config, application_name: 'lumen-operator-provisioning' });
  client.on('error', () => {});
  try { await client.connect(); } catch { await client.end().catch(() => {}); throw new ProvisioningError('DATABASE_OPERATION_FAILED'); }
  return { service: new ProvisioningService(client, target), endpoint: { host, port: config.port ?? 5432 }, close: () => client.end() };
});
