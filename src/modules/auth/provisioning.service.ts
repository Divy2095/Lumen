import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { generateApiKey } from '../../shared/crypto.js';
import { clerkProvider, isClerkSubject } from './clerk-identity.js';

export class ProvisioningError extends Error {
  constructor(public readonly code: string, public readonly recovery?: Record<string, string>) {
    super(code);
    this.name = 'ProvisioningError';
  }
}

export interface DatabaseTarget { database: string; role: string }
export interface Project { id: string; account_id: string; name: string; status: string }
export type CreateProjectInput = { name: string } & ({ accountId: string; email?: never } | { email: string; accountId?: never });
export interface IssueKeyInput { projectId: string; name: string; expiresAt?: string; noExpiry?: boolean }
export interface SelectedKey { projectId: string; keyId: string }
export type RotateKeyInput = IssueKeyInput & SelectedKey;
export interface LinkIdentityInput { accountId: string; provider: typeof clerkProvider; subject: string }
export interface LinkedIdentity {
  id: string; accountId: string; provider: typeof clerkProvider; subject: string; alreadyLinked: boolean;
}
interface KeyRow {
  id: string; project_id: string; name: string; key_prefix: string;
  created_at: Date; expires_at: Date | null; revoked_at: Date | null;
}
const keyColumns = 'id, project_id, name, key_prefix, created_at, expires_at, revoked_at';
function keyMetadata(row: KeyRow, now: Date) {
  return { id: row.id, projectId: row.project_id, name: row.name, keyPrefix: row.key_prefix,
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
    status: row.revoked_at !== null ? 'revoked' as const :
      row.expires_at !== null && row.expires_at.getTime() <= now.getTime() ? 'expired' as const : 'active' as const };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export function validateId(value: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ProvisioningError('INVALID_UUID');
  return value.toLowerCase();
}
export function validateName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || [...value].length > 100 || controls.test(value)) {
    throw new ProvisioningError('INVALID_NAME');
  }
  return value;
}
export function validateProject(input: CreateProjectInput): CreateProjectInput {
  const name = validateName(input.name);
  if ((input.accountId !== undefined) === (input.email !== undefined)) throw new ProvisioningError('ACCOUNT_SELECTION_REQUIRED');
  if (input.accountId !== undefined) return { name, accountId: validateId(input.accountId) };
  const email = input.email;
  // Deliberately accept a conservative ASCII mailbox, not display names or ownership claims.
  if (typeof email !== 'string' || email.length > 255 || email !== email.trim() ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(email)) {
    throw new ProvisioningError('INVALID_EMAIL');
  }
  const [local, domain] = email.split('@') as [string, string];
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      domain.split('.').some(label => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    throw new ProvisioningError('INVALID_EMAIL');
  }
  return { name, email: email.toLowerCase() };
}
export function validateIdentityLink(input: LinkIdentityInput): LinkIdentityInput {
  if (input.provider !== clerkProvider) throw new ProvisioningError('UNSUPPORTED_PROVIDER');
  if (!isClerkSubject(input.subject)) throw new ProvisioningError('INVALID_SUBJECT');
  return { accountId: validateId(input.accountId), provider: clerkProvider, subject: input.subject };
}
export function keyExpiration(input: IssueKeyInput, now: Date): Date | null {
  validateId(input.projectId);
  validateName(input.name);
  if (input.noExpiry !== undefined && typeof input.noExpiry !== 'boolean') throw new ProvisioningError('INVALID_EXPIRATION');
  if (input.noExpiry && input.expiresAt !== undefined) throw new ProvisioningError('INVALID_EXPIRATION');
  if (input.noExpiry) return null;
  if (input.expiresAt === undefined) return new Date(now.getTime() + 90 * 86400000);
  // Require a complete UTC timestamp; reject date-only input and normalized invalid dates.
  if (typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.expiresAt)) {
    throw new ProvisioningError('INVALID_EXPIRATION');
  }
  const date = new Date(input.expiresAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime() ||
      date.toISOString().replace('.000Z', 'Z') !== input.expiresAt.replace('.000Z', 'Z')) {
    throw new ProvisioningError('INVALID_EXPIRATION');
  }
  return date;
}

export class ProvisioningService {
  constructor(private readonly db: Pick<Client, 'query'>, private readonly target: DatabaseTarget,
    private readonly generate = generateApiKey, private readonly now = () => new Date()) {}

  async verifyTarget(): Promise<void> {
    const { rows } = await this.db.query<{ database: string; role: string; session_role: string }>(
      'SELECT current_database() AS database, current_user AS role, session_user AS session_role');
    const row = rows[0];
    if (!row || row.database !== this.target.database || row.role !== this.target.role || row.session_role !== this.target.role) {
      throw new ProvisioningError('DATABASE_IDENTITY_MISMATCH');
    }
  }

  async transaction<T>(recovery: Record<string, string>, action: () => Promise<T>): Promise<T> {
    let committing = false;
    try {
      await this.db.query('BEGIN');
      await this.verifyTarget();
      const result = await action();
      committing = true;
      const committed = await this.db.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new ProvisioningError('COMMIT_NOT_CONFIRMED');
      return result;
    } catch (error) {
      try { await this.db.query('ROLLBACK'); } catch { /* Never replace the original outcome. */ }
      if (committing) throw new ProvisioningError('COMMIT_OUTCOME_UNKNOWN', recovery);
      if (error instanceof ProvisioningError) throw error;
      if ((error as { code?: string })?.code === '23505') throw new ProvisioningError('DUPLICATE_RECORD');
      throw new ProvisioningError('DATABASE_OPERATION_FAILED');
    }
  }

  async createProject(raw: CreateProjectInput): Promise<Project> {
    const input = validateProject(raw);
    const accountId = input.accountId ?? randomUUID();
    const projectId = randomUUID();
    return this.transaction({ accountId, projectId }, async () => {
      if (input.accountId !== undefined) {
        const account = await this.db.query('SELECT id FROM accounts WHERE id = $1 FOR KEY SHARE', [accountId]);
        if (!account.rows[0]) throw new ProvisioningError('ACCOUNT_NOT_FOUND');
      } else {
        await this.db.query('INSERT INTO accounts (id, email) VALUES ($1, $2)', [accountId, input.email]);
      }
      const result = await this.db.query<Project>(
        "INSERT INTO projects (id, account_id, name, status) VALUES ($1, $2, $3, 'active') RETURNING id, account_id, name, status",
        [projectId, accountId, input.name]);
      if (!result.rows[0]) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
      return result.rows[0];
    });
  }

  async listProjects(): Promise<Project[]> {
    await this.verifyTarget();
    return (await this.db.query<Project>('SELECT id, account_id, name, status FROM projects ORDER BY created_at, id')).rows;
  }

  async linkIdentity(raw: LinkIdentityInput): Promise<LinkedIdentity> {
    const input = validateIdentityLink(raw);
    return this.transaction({ accountId: input.accountId, provider: input.provider, subject: input.subject }, async () => {
      // Lock the account so it cannot disappear between existence check and FK insert.
      const account = await this.db.query('SELECT id FROM accounts WHERE id = $1 FOR KEY SHARE', [input.accountId]);
      if (!account.rows[0]) throw new ProvisioningError('ACCOUNT_NOT_FOUND');

      // The unique (provider, provider_subject) constraint is the concurrency
      // arbiter. The loser waits, then observes the winner's committed mapping.
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO account_identities (account_id, provider, provider_subject)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_subject) DO NOTHING
         RETURNING id`,
        [input.accountId, input.provider, input.subject]);
      if (inserted.rows[0]) return { id: inserted.rows[0].id, ...input, alreadyLinked: false };

      const existing = await this.db.query<{ id: string; account_id: string }>(
        'SELECT id, account_id FROM account_identities WHERE provider = $1 AND provider_subject = $2',
        [input.provider, input.subject]);
      const row = existing.rows[0];
      if (!row) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
      if (row.account_id !== input.accountId) throw new ProvisioningError('IDENTITY_CONFLICT');
      return { id: row.id, ...input, alreadyLinked: true };
    });
  }

  async getProject(id: string, requireActive = true): Promise<Project> {
    await this.verifyTarget();
    const result = await this.db.query<Project>('SELECT id, account_id, name, status FROM projects WHERE id = $1', [validateId(id)]);
    if (!result.rows[0]) throw new ProvisioningError('PROJECT_NOT_FOUND');
    if (result.rows[0].id !== validateId(id)) throw new ProvisioningError('PROJECT_IDENTITY_MISMATCH');
    if (requireActive && result.rows[0].status !== 'active') throw new ProvisioningError('PROJECT_INACTIVE');
    return result.rows[0];
  }

  async lockProject(projectId: string, requireActive: boolean): Promise<void> {
    const result = await this.db.query<Project>('SELECT id, account_id, name, status FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    const project = result.rows[0];
    if (!project) throw new ProvisioningError('PROJECT_NOT_FOUND');
    if (project.id !== projectId) throw new ProvisioningError('PROJECT_IDENTITY_MISMATCH');
    if (requireActive && project.status !== 'active') throw new ProvisioningError('PROJECT_INACTIVE');
  }

  private async readKey(projectId: string, keyId: string, lock = false): Promise<KeyRow> {
    const result = await this.db.query<KeyRow>(`SELECT ${keyColumns} FROM api_keys WHERE project_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [projectId, keyId]);
    const row = result.rows[0];
    if (!row) throw new ProvisioningError('KEY_NOT_FOUND');
    if (row.id !== keyId || row.project_id !== projectId) throw new ProvisioningError('KEY_IDENTITY_MISMATCH');
    return row;
  }

  async databaseTime(): Promise<Date> {
    const result = await this.db.query<{ checked_at: Date }>('SELECT clock_timestamp() AS checked_at');
    const time = result.rows[0]?.checked_at;
    if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
    return time;
  }

  async listKeys(rawProjectId: string) {
    const projectId = validateId(rawProjectId);
    try {
      await this.getProject(projectId, false);
      const result = await this.db.query<KeyRow & { checked_at: Date }>(
        `SELECT ${keyColumns}, statement_timestamp() AS checked_at FROM api_keys WHERE project_id = $1 ORDER BY created_at, id`, [projectId]);
      return result.rows.map(row => {
        if (row.project_id !== projectId) throw new ProvisioningError('KEY_IDENTITY_MISMATCH');
        return keyMetadata(row, row.checked_at);
      });
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError('DATABASE_OPERATION_FAILED');
    }
  }

  async getKey(input: SelectedKey) {
    const projectId = validateId(input.projectId), keyId = validateId(input.keyId);
    try {
      await this.verifyTarget();
      const row = await this.readKey(projectId, keyId);
      return keyMetadata(row, await this.databaseTime());
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError('DATABASE_OPERATION_FAILED');
    }
  }

  async revokeKey(input: SelectedKey) {
    const projectId = validateId(input.projectId), keyId = validateId(input.keyId);
    return this.transaction({ projectId, keyId }, async () => {
      // All lifecycle writes use project -> key lock order, including inactive projects.
      await this.lockProject(projectId, false);
      const row = await this.readKey(projectId, keyId, true);
      const alreadyRevoked = row.revoked_at !== null;
      if (alreadyRevoked) return { ...keyMetadata(row, await this.databaseTime()), alreadyRevoked };
      const result = await this.db.query<KeyRow>(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE project_id = $1 AND id = $2 RETURNING ${keyColumns}`,
        [projectId, keyId]);
      const updated = result.rows[0];
      if (result.rowCount !== 1 || !updated || updated.id !== keyId || updated.project_id !== projectId || updated.revoked_at === null) {
        throw new ProvisioningError('DATABASE_OPERATION_FAILED');
      }
      return { ...keyMetadata(updated, await this.databaseTime()), alreadyRevoked };
    });
  }

  async rotateKey(input: RotateKeyInput) {
    keyExpiration(input, this.now());
    const projectId = validateId(input.projectId), predecessorId = validateId(input.keyId);
    const keyId = randomUUID();
    return this.transaction({ projectId, keyId, predecessorId }, async () => {
      await this.lockProject(projectId, true);
      const predecessor = await this.readKey(projectId, predecessorId, true);
      // NOW() is fixed at BEGIN; use the database clock after any lock waits instead.
      const now = await this.databaseTime();
      if (keyMetadata(predecessor, now).status !== 'active') throw new ProvisioningError('PREDECESSOR_INACTIVE');
      return { ...await this.insertKey(input, projectId, keyId, now), predecessorId };
    });
  }

  private async insertKey(input: IssueKeyInput, projectId: string, keyId: string, now: Date) {
    const expiresAt = keyExpiration(input, now);
    const key = this.generate();
    const inserted = await this.db.query('INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [keyId, projectId, input.name, key.keyPrefix, key.hash, expiresAt]);
    if (inserted.rowCount !== 1) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
    return { id: keyId, projectId, name: input.name, keyPrefix: key.keyPrefix, expiresAt, secret: key.apiKey };
  }

  async issueKey(input: IssueKeyInput) {
    keyExpiration(input, this.now());
    const projectId = validateId(input.projectId);
    const keyId = randomUUID();
    return this.transaction({ projectId, keyId }, async () => {
      await this.lockProject(projectId, true);
      return this.insertKey(input, projectId, keyId, this.now());
    });
  }
}
