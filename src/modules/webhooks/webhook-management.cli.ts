import { ProvisioningError, validateId, type DatabaseTarget } from '../auth/provisioning.service.js';
import type { ProvisioningIO } from '../auth/provisioning.cli.js';
import type { WebhookManagementService } from './webhook-management.service.js';
import { overlapHours, subscriptions, webhookUrl } from './webhook-security.js';

export const webhookUsage = `Usage: npm run provision -- webhook:<command> --database <database> --role <role> --project-id <uuid> [options]
  webhook:create --url https://hooks.example.com/lumen --events asset.ingested,rendition.ready
  webhook:list
  webhook:show --endpoint-id <uuid>
  webhook:enable --endpoint-id <uuid>
  webhook:disable --endpoint-id <uuid>
  webhook:rotate-secret --endpoint-id <uuid> [--overlap-hours <integer 1..24>]
  webhook:retire-previous-secret --endpoint-id <uuid>
All writes require interactive stdin/stdout and typed confirmation.
Signing secrets are revealed once after confirmed COMMIT. Configure the hostname allowlist and external AES keys first.`;
const commands = ['webhook:create','webhook:list','webhook:show','webhook:enable','webhook:disable',
  'webhook:rotate-secret','webhook:retire-previous-secret'] as const;
type CommandName = typeof commands[number];
export function parseWebhookArgs(args: string[]) {
  const command = args[0] as CommandName;
  if (!commands.includes(command)) throw new ProvisioningError('INVALID_ARGUMENTS');
  const allowed = ['database','role','project-id', ...(command === 'webhook:create' ? ['url','events'] :
    command === 'webhook:list' ? [] : ['endpoint-id']), ...(command === 'webhook:rotate-secret' ? ['overlap-hours'] : [])];
  const values = new Map<string,string>();
  for (let i = 1; i < args.length; i++) {
    const option = args[i]!, name = option.slice(2), value = args[++i];
    if (!option.startsWith('--') || !allowed.includes(name) || values.has(name) || !value || value.startsWith('--')) throw new ProvisioningError('INVALID_ARGUMENTS');
    values.set(name, value);
  }
  const database = values.get('database') ?? '', role = values.get('role') ?? '';
  if (![database,role].every(v => /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(v))) throw new ProvisioningError('EXPLICIT_DATABASE_TARGET_REQUIRED');
  const projectId = validateId(values.get('project-id') ?? '');
  const endpointId = command === 'webhook:create' || command === 'webhook:list' ? undefined : validateId(values.get('endpoint-id') ?? '');
  const events = command === 'webhook:create' ? subscriptions((values.get('events') ?? '').split(',')) : [];
  let url = values.get('url') ?? '';
  if (command === 'webhook:create') {
    // Reject unsafe authority/credentials before displaying any operator preview.
    // The service independently enforces the configured allowlist before persistence.
    try { url = webhookUrl(url, [new URL(url).hostname]); }
    catch { throw new ProvisioningError('WEBHOOK_URL_INVALID'); }
  }
  const rawHours = values.get('overlap-hours') ?? '24';
  if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(rawHours)) throw new ProvisioningError('WEBHOOK_OVERLAP_INVALID');
  return { command, target: { database, role }, projectId, endpointId, url, events, hours: overlapHours(Number(rawHours)) };
}
export interface WebhookSession {
  service: Pick<WebhookManagementService, 'verifyTarget'|'getProject'|'list'|'show'|'create'|'setEnabled'|'rotate'|'retirePrevious'>;
  endpoint: { host: string; port: number };
  close(): Promise<void>;
}
const messages: Record<string,string> = {
  INVALID_ARGUMENTS: 'Invalid webhook command or options. Use webhook:help.',
  EXPLICIT_DATABASE_TARGET_REQUIRED: 'Explicit database and role identifiers are required.',
  INVALID_UUID: 'Valid project and endpoint UUIDs are required.',
  DATABASE_IDENTITY_MISMATCH: 'Configured or connected database identity does not match the explicit target.',
  PROJECT_NOT_FOUND: 'The selected project does not exist.', PROJECT_INACTIVE: 'The selected project is inactive.',
  WEBHOOK_NOT_FOUND: 'The endpoint does not exist in the selected project.',
  WEBHOOK_UNMANAGED: 'Legacy or incomplete encryption metadata: endpoint is unavailable for management.',
  WEBHOOK_URL_INVALID: 'Destination must be an unambiguous HTTPS URL on port 443 with an explicitly allowlisted DNS hostname.',
  WEBHOOK_ALLOWLIST_REQUIRED: 'An explicit hostname allowlist is required.', WEBHOOK_ALLOWLIST_INVALID: 'Invalid exact hostname allowlist.',
  WEBHOOK_SUBSCRIPTIONS_INVALID: 'Choose a nonempty, duplicate-free selection of supported event types.',
  WEBHOOK_SLOTS_FULL: 'Five active version-1 endpoints already occupy this project’s slots.',
  WEBHOOK_ROTATION_OVERLAP: 'An overlap is still active. Wait for expiration or explicitly retire the previous secret.',
  WEBHOOK_OVERLAP_INVALID: 'Overlap must be an integer from 1 through 24 hours.',
  WEBHOOK_ENCRYPTION_CONFIG_INVALID: 'External encryption-key configuration is missing or invalid.',
  WEBHOOK_ENCRYPTION_KEY_UNAVAILABLE: 'A required external encryption key is unavailable.',
  WEBHOOK_DECRYPTION_FAILED: 'Stored signing-secret authentication failed. Check the external key configuration.',
  INTERACTIVE_TERMINAL_REQUIRED: 'Writes and secret reveal require interactive stdin and stdout terminals.',
  CONFIRMATION_CANCELLED: 'Cancelled before mutation.',
  COMMIT_OUTCOME_UNKNOWN: 'Commit outcome unknown. No secret is returned. Inspect recovery IDs; do not retry blindly.',
};
export async function runWebhookCli(args: string[], io: ProvisioningIO,
  connect: (target: DatabaseTarget) => Promise<WebhookSession>): Promise<number> {
  let session: WebhookSession | undefined;
  let committed: Record<string,string> | undefined;
  try {
    if (args.length === 1 && args[0] === 'webhook:help') { await io.write(webhookUsage); return 0; }
    const command = parseWebhookArgs(args), read = ['webhook:list','webhook:show'].includes(command.command);
    if (!read && !io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
    session = await connect(command.target);
    await session.service.verifyTarget();
    await io.write(`Database target: ${JSON.stringify({ ...session.endpoint, ...command.target })}`);
    await session.service.getProject(command.projectId, !read && ['webhook:create','webhook:enable','webhook:rotate-secret'].includes(command.command));
    const selected = { projectId: command.projectId, endpointId: command.endpointId! };
    if (command.command === 'webhook:list') { await io.write(JSON.stringify(await session.service.list(command.projectId))); return 0; }
    if (command.command === 'webhook:show') { await io.write(JSON.stringify(await session.service.show(selected))); return 0; }
    if (command.command !== 'webhook:create') await io.write(`Selected endpoint: ${JSON.stringify(await session.service.show(selected))}`);
    else await io.write(`Create endpoint: ${JSON.stringify({ projectId: command.projectId, url: command.url, subscriptions: command.events })}`);
    if (command.command === 'webhook:create' || command.command === 'webhook:rotate-secret') {
      await io.write('The signing secret will be displayed once. Disable terminal recording and keep this screen private.');
    }
    if (command.command === 'webhook:rotate-secret') await io.write(`Previous secret overlap: ${command.hours} hours; deploy the new secret before retiring the previous one.`);
    const phrase = `${command.command} ${command.target.database} ${command.target.role} ${command.projectId}${command.endpointId ? ` ${command.endpointId}` : ''}`;
    if (await io.question(`Type ${JSON.stringify(phrase)} to confirm: `) !== phrase) throw new ProvisioningError('CONFIRMATION_CANCELLED');
    if (!io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
    const result = command.command === 'webhook:create' ? await session.service.create({ projectId: command.projectId, url: command.url, subscriptions: command.events }) :
      command.command === 'webhook:rotate-secret' ? await session.service.rotate(selected, command.hours) :
      command.command === 'webhook:retire-previous-secret' ? await session.service.retirePrevious(selected) :
      await session.service.setEnabled(selected, command.command === 'webhook:enable');
    committed = { projectId: command.projectId, endpointId: result.id, signingKeyId: result.signingKeyId };
    if ('secret' in result) {
      const { secret, ...info } = result;
      await io.write(JSON.stringify(info));
      if (!io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
      await io.reveal(secret, 'Webhook signing secret');
    } else await io.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    const known = error instanceof ProvisioningError;
    io.error(committed ? 'Persistence committed, but result or secret delivery failed or is uncertain. Inspect recovery IDs; do not retry blindly.' :
      known ? messages[error.code] ?? 'Webhook management failed. Internal details suppressed.' : 'Webhook management failed. Internal details suppressed.');
    if (committed) io.error(`Recovery IDs: ${JSON.stringify(committed)}`);
    else if (known && error.recovery) io.error(`Recovery IDs: ${JSON.stringify(error.recovery)}`);
    return !committed && known && error.code === 'CONFIRMATION_CANCELLED' ? 2 : 1;
  } finally {
    if (session) try { await session.close(); } catch { io.error('Connection cleanup failed. Do not repeat writes blindly.'); return 1; }
  }
}
