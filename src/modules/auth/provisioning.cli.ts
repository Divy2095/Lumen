import {
  ProvisioningError, keyExpiration, validateId, validateIdentityLink, validateProject,
  type CreateProjectInput, type DatabaseTarget, type IssueKeyInput, type LinkIdentityInput,
  type ProvisioningService, type SelectedKey, type RotateKeyInput,
} from './provisioning.service.js';

export const provisioningUsage = `Usage: npm run provision -- <command> --database <database> --role <role> [options]
  project:create --name <name> (--email <ownership-email> | --account-id <uuid>)
  project:list
  key:issue --project-id <uuid> --name <name> [--expires-at <UTC timestamp> | --no-expiry]
  key:list --project-id <uuid>
  key:revoke --project-id <uuid> --key-id <uuid>
  key:rotate --project-id <uuid> --key-id <uuid> --name <name> [--expires-at <UTC timestamp> | --no-expiry]
  identity:link --account-id <uuid> --provider clerk --subject <clerk-user-id>
Webhook endpoint commands: npm run provision -- webhook:help
Writes require an interactive terminal and typed confirmation. No --yes or piped secret output.
Key lifetime defaults to 90 days. Account email ownership is not verified.
Identity linking requires an existing account and never matches by email.
Rotation only issues a replacement. Deploy and verify it, then explicitly revoke the predecessor.`;

type Command =
  | { command: 'project:create'; target: DatabaseTarget; input: CreateProjectInput }
  | { command: 'project:list'; target: DatabaseTarget }
  | { command: 'key:issue'; target: DatabaseTarget; input: IssueKeyInput }
  | { command: 'key:list'; target: DatabaseTarget; projectId: string }
  | { command: 'key:revoke'; target: DatabaseTarget; input: SelectedKey }
  | { command: 'key:rotate'; target: DatabaseTarget; input: RotateKeyInput }
  | { command: 'identity:link'; target: DatabaseTarget; input: LinkIdentityInput };

export function parseProvisioningArgs(args: string[]): Command {
  const command = args[0];
  const allowed = command === 'project:create' ? ['name', 'email', 'account-id'] :
    command === 'key:issue' ? ['project-id', 'name', 'expires-at', 'no-expiry'] :
    command === 'key:rotate' ? ['project-id', 'key-id', 'name', 'expires-at', 'no-expiry'] :
    command === 'key:revoke' ? ['project-id', 'key-id'] :
    command === 'key:list' ? ['project-id'] :
    command === 'identity:link' ? ['account-id', 'provider', 'subject'] :
      command === 'project:list' ? [] : null;
  if (!allowed) throw new ProvisioningError('INVALID_ARGUMENTS');
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const option = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !option || ![...allowed, 'database', 'role'].includes(option) || options.has(option)) {
      throw new ProvisioningError('INVALID_ARGUMENTS');
    }
    if (option === 'no-expiry') options.set(option, 'true');
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new ProvisioningError('INVALID_ARGUMENTS');
      options.set(option, value);
    }
  }
  const database = options.get('database');
  const role = options.get('role');
  if (!database || !role || ![database, role].every(x => /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(x))) {
    throw new ProvisioningError('EXPLICIT_DATABASE_TARGET_REQUIRED');
  }
  const target = { database, role };
  if (command === 'identity:link') {
    const provider = options.get('provider');
    if (provider !== 'clerk') throw new ProvisioningError('UNSUPPORTED_PROVIDER');
    return { command, target, input: validateIdentityLink({
      accountId: options.get('account-id') ?? '', provider, subject: options.get('subject') ?? '',
    }) };
  }
  if (command === 'project:list') return { command, target };
  if (command === 'key:list') return { command, target, projectId: validateId(options.get('project-id') ?? '') };
  if (command === 'key:revoke') return { command, target, input: {
    projectId: validateId(options.get('project-id') ?? ''), keyId: validateId(options.get('key-id') ?? ''),
  } };
  if (command === 'project:create') {
    const input = validateProject({ name: options.get('name') ?? '',
      ...(options.has('email') ? { email: options.get('email')! } : {}),
      ...(options.has('account-id') ? { accountId: options.get('account-id')! } : {}),
    } as CreateProjectInput);
    return { command, target, input };
  }
  const input: IssueKeyInput = { projectId: validateId(options.get('project-id') ?? ''), name: options.get('name') ?? '',
    ...(options.has('expires-at') ? { expiresAt: options.get('expires-at')! } : {}),
    ...(options.has('no-expiry') ? { noExpiry: true } : {}),
  };
  keyExpiration(input, new Date());
  if (command === 'key:rotate') return { command, target, input: { ...input, keyId: validateId(options.get('key-id') ?? '') } };
  return { command: 'key:issue', target, input };
}

export interface ProvisioningIO {
  interactive(): boolean;
  write(message: string): Promise<void>;
  error(message: string): void;
  question(prompt: string): Promise<string>;
  reveal(secret: string, label?: string): Promise<void>;
}
export interface ProvisioningSession {
  service: Pick<ProvisioningService, 'verifyTarget' | 'createProject' | 'listProjects' | 'getProject' | 'issueKey' |
    'listKeys' | 'getKey' | 'revokeKey' | 'rotateKey' | 'linkIdentity'>;
  endpoint: { host: string; port: number };
  close(): Promise<void>;
}

const messages: Record<string, string> = {
  INVALID_ARGUMENTS: 'Invalid command or options. Use --help.',
  EXPLICIT_DATABASE_TARGET_REQUIRED: 'Explicit --database and --role identifiers are required.',
  INVALID_UUID: 'A valid UUID is required.',
  INVALID_NAME: 'Names must contain 1–100 characters without surrounding whitespace or control characters.',
  INVALID_EMAIL: 'A valid ASCII ownership email is required; ownership is not verified.',
  ACCOUNT_SELECTION_REQUIRED: 'Choose exactly one of --email or --account-id.',
  INVALID_EXPIRATION: 'Choose a future UTC timestamp or explicit --no-expiry; these options are mutually exclusive.',
  DATABASE_IDENTITY_MISMATCH: 'Configured or connected database identity does not match the explicit target.',
  ACCOUNT_NOT_FOUND: 'The selected account does not exist.',
  INVALID_SUBJECT: 'The Clerk subject must be a Clerk user ID of the form user_<alphanumeric>.',
  UNSUPPORTED_PROVIDER: 'The only supported identity provider in this milestone is clerk.',
  IDENTITY_CONFLICT: 'That Clerk identity is already linked to a different account. No mapping was changed.',
  PROJECT_NOT_FOUND: 'The selected project does not exist.',
  PROJECT_INACTIVE: 'The selected project is inactive.',
  PROJECT_IDENTITY_MISMATCH: 'Project identity verification failed.',
  KEY_NOT_FOUND: 'The selected key does not exist in the selected project.',
  KEY_IDENTITY_MISMATCH: 'Key/project identity verification failed.',
  PREDECESSOR_INACTIVE: 'The predecessor is expired or revoked. Use key:issue to create a new key.',
  DUPLICATE_RECORD: 'A conflicting record exists. No account was silently reused.',
  INTERACTIVE_TERMINAL_REQUIRED: 'Writes and secret reveal require interactive stdin and stdout terminals.',
  CONFIRMATION_CANCELLED: 'Write cancelled; no mutation was requested.',
  COMMIT_OUTCOME_UNKNOWN: 'Commit outcome unknown. No secret is returned. Do not retry blindly; inspect recovery IDs first.',
  SECRET_DELIVERY_FAILED: 'Persistence succeeded but secret delivery failed or is uncertain. Do not retry blindly; retain the key ID for recovery.',
  RESULT_DELIVERY_FAILED: 'Project persistence succeeded but result delivery failed. Do not retry blindly; inspect recovery IDs first.',
  REVOCATION_DELIVERY_FAILED: 'Revocation committed but result delivery failed. Inspect the selected key with key:list.',
  IDENTITY_DELIVERY_FAILED: 'Identity link committed but result delivery failed. Inspect account_identities before retrying.',
};

export async function runProvisioningCli(args: string[], io: ProvisioningIO,
  connect: (target: DatabaseTarget) => Promise<ProvisioningSession>): Promise<number> {
  let session: ProvisioningSession | undefined;
  let persistedKeyId: string | undefined;
  let predecessorId: string | undefined;
  let revokedKey: SelectedKey | undefined;
  let persistedProject: { projectId: string; accountId: string } | undefined;
  let linkedIdentity: { accountId: string; provider: string; subject: string } | undefined;
  try {
    if (args.length === 1 && args[0] === '--help') { await io.write(provisioningUsage); return 0; }
    const command = parseProvisioningArgs(args);
    if (command.command !== 'project:list' && command.command !== 'key:list' && !io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
    session = await connect(command.target);
    await session.service.verifyTarget();
    await io.write(`Database target: ${JSON.stringify({ ...session.endpoint, ...command.target })}`);
    if (command.command === 'project:list') {
      await io.write(JSON.stringify(await session.service.listProjects()));
      return 0;
    }
    if (command.command === 'key:list') {
      await io.write(JSON.stringify(await session.service.listKeys(command.projectId)));
      return 0;
    }
    if (command.command === 'identity:link') {
      const { accountId, provider, subject } = command.input;
      await io.write(`Link Clerk identity to existing account: ${JSON.stringify(command.input)}`);
      const phrase = `identity:link ${command.target.database} ${command.target.role} ${accountId} ${provider} ${subject}`;
      const answer = await io.question(`Type ${JSON.stringify(phrase)} to confirm identity linking: `);
      if (answer !== phrase) throw new ProvisioningError('CONFIRMATION_CANCELLED');
      if (!io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
      const result = await session.service.linkIdentity(command.input);
      linkedIdentity = { accountId, provider, subject };
      await io.write(JSON.stringify(result));
      return 0;
    }
    if (command.command !== 'project:create') {
      const project = await session.service.getProject(command.input.projectId, command.command !== 'key:revoke');
      await io.write(`Selected project: ${JSON.stringify(project)}`);
      if (command.command !== 'key:issue') {
        const key = await session.service.getKey(command.input);
        if (command.command === 'key:rotate' && key.status !== 'active') throw new ProvisioningError('PREDECESSOR_INACTIVE');
        await io.write(`Selected key: ${JSON.stringify(key)}`);
      }
      if (command.command !== 'key:revoke') {
        await io.write(`Key metadata: ${JSON.stringify({ name: command.input.name, expiresAt: keyExpiration(command.input, new Date()) })}`);
        await io.write('The key will be displayed once on this terminal. Disable terminal recording and keep this screen private.');
        if (command.command === 'key:rotate') await io.write('Rotation is incomplete: deploy and verify the replacement, then explicitly revoke the predecessor. It is not revoked automatically.');
      }
    } else await io.write(`Create ownership/project metadata (email is unverified): ${JSON.stringify(command.input)}`);
    const phrase = `${command.command} ${command.target.database} ${command.target.role}` +
      (command.command !== 'project:create' ? ` ${command.input.projectId}` : '') +
      (command.command === 'key:rotate' || command.command === 'key:revoke' ? ` ${command.input.keyId}` : '');
    const answer = await io.question(`Type ${JSON.stringify(phrase)} to confirm${command.command === 'key:issue' || command.command === 'key:rotate' ? ' issuance and one-time secret reveal' : ''}: `);
    if (answer !== phrase) throw new ProvisioningError('CONFIRMATION_CANCELLED');
    if (!io.interactive()) throw new ProvisioningError('INTERACTIVE_TERMINAL_REQUIRED');
    if (command.command === 'project:create') {
      const project = await session.service.createProject(command.input);
      persistedProject = { projectId: project.id, accountId: project.account_id };
      await io.write(JSON.stringify(project));
    } else if (command.command === 'key:revoke') {
      const result = await session.service.revokeKey(command.input);
      revokedKey = command.input;
      await io.write(JSON.stringify(result));
    } else {
      const key = command.command === 'key:rotate' ? await session.service.rotateKey(command.input) : await session.service.issueKey(command.input);
      persistedKeyId = key.id;
      predecessorId = command.command === 'key:rotate' ? command.input.keyId : undefined;
      await io.write(JSON.stringify({ id: key.id, projectId: key.projectId, name: key.name, keyPrefix: key.keyPrefix, expiresAt: key.expiresAt,
        ...(predecessorId ? { predecessorId, rotationIncomplete: true } : {}) }));
      if (!io.interactive()) throw new ProvisioningError('SECRET_DELIVERY_FAILED');
      try { await io.reveal(key.secret); } catch { throw new ProvisioningError('SECRET_DELIVERY_FAILED'); }
    }
    return 0;
  } catch (error) {
    const known = error instanceof ProvisioningError;
    const code = persistedKeyId ? 'SECRET_DELIVERY_FAILED' : revokedKey ? 'REVOCATION_DELIVERY_FAILED' :
      linkedIdentity ? 'IDENTITY_DELIVERY_FAILED' : persistedProject ? 'RESULT_DELIVERY_FAILED' : known ? error.code : 'DATABASE_OPERATION_FAILED';
    io.error(messages[code] ?? 'Provisioning failed. Internal details have been suppressed.');
    if (known && error.recovery) io.error(`Recovery IDs: ${JSON.stringify(error.recovery)}`);
    if (persistedKeyId) io.error(`Persisted key ID: ${persistedKeyId}`);
    if (predecessorId) io.error(`Predecessor key ID: ${predecessorId}; rotation remains incomplete until explicit revocation.`);
    if (revokedKey) io.error(`Recovery IDs: ${JSON.stringify(revokedKey)}`);
    if (linkedIdentity) io.error(`Recovery IDs: ${JSON.stringify(linkedIdentity)}`);
    if (persistedProject) io.error(`Recovery IDs: ${JSON.stringify(persistedProject)}`);
    return code === 'CONFIRMATION_CANCELLED' ? 2 : 1;
  } finally {
    if (session) {
      try { await session.close(); }
      catch { io.error('Connection cleanup failed. An operation may already have succeeded; do not repeat it blindly.'); return 1; }
    }
  }
}
