import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { ProvisioningError, ProvisioningService, validateId, type DatabaseTarget } from '../auth/provisioning.service.js';
import { overlapHours, subscriptions, webhookUrl, WebhookEncryption } from './webhook-security.js';

export interface WebhookSelection { projectId: string; endpointId: string }
export interface CreateWebhook { projectId: string; url: string; subscriptions: readonly string[] }
interface EndpointRow {
  id: string; project_id: string; url: string; enabled: boolean; config_version: number;
  subscriptions: string[]; active_slot: number | null; signing_key_id: string;
  encryption_key_id: string | null; encrypted_secret: Buffer;
  previous_signing_key_id: string | null; previous_encryption_key_id: string | null;
  previous_encrypted_secret: Buffer | null; rotation_started_at: Date | null;
  previous_secret_valid_until: Date | null; created_at: Date;
}
const columns = `id,project_id,url,enabled,config_version,subscriptions,active_slot,signing_key_id,
  encryption_key_id,encrypted_secret,previous_signing_key_id,previous_encryption_key_id,
  previous_encrypted_secret,rotation_started_at,previous_secret_valid_until,created_at`;
function metadata(row: EndpointRow) {
  return { id: row.id, projectId: row.project_id, url: row.url, enabled: row.enabled,
    subscriptions: row.subscriptions, signingKeyId: row.signing_key_id, encryptionKeyId: row.encryption_key_id,
    previousSigningKeyId: row.previous_signing_key_id, previousEncryptionKeyId: row.previous_encryption_key_id,
    rotationStartedAt: row.rotation_started_at, previousSecretValidUntil: row.previous_secret_valid_until, createdAt: row.created_at };
}
export class WebhookManagementService {
  private readonly operator: ProvisioningService;
  constructor(private readonly db: Pick<Client, 'query'>, target: DatabaseTarget,
    private readonly encryption: WebhookEncryption, private readonly allowlist: readonly string[]) {
    this.operator = new ProvisioningService(db, target);
  }
  verifyTarget() { return this.operator.verifyTarget(); }
  getProject(id: string, active = false) { return this.operator.getProject(id, active); }
  private validateRow(row: EndpointRow, projectId: string, endpointId?: string) {
    if (row.project_id !== projectId || (endpointId && row.id !== endpointId)) throw new ProvisioningError('WEBHOOK_IDENTITY_MISMATCH');
    if (row.config_version !== 1 || !row.encryption_key_id ||
        (!!row.previous_signing_key_id !== !!row.previous_encryption_key_id)) throw new ProvisioningError('WEBHOOK_UNMANAGED');
    // Authentication is required before using stored configuration, even for non-secret reads.
    this.encryption.decrypt(row.encrypted_secret, row.encryption_key_id,
      { projectId, endpointId: row.id, signingKeyId: row.signing_key_id }).fill(0);
    if (row.previous_signing_key_id) {
      if (!row.previous_encrypted_secret || !row.previous_secret_valid_until || !row.rotation_started_at) throw new ProvisioningError('WEBHOOK_UNMANAGED');
      this.encryption.decrypt(row.previous_encrypted_secret, row.previous_encryption_key_id!,
        { projectId, endpointId: row.id, signingKeyId: row.previous_signing_key_id }).fill(0);
    }
  }
  private async read(input: WebhookSelection, lock = false): Promise<EndpointRow> {
    const result = await this.db.query<EndpointRow>(`SELECT ${columns} FROM webhook_endpoints WHERE project_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [input.projectId, input.endpointId]);
    const row = result.rows[0];
    if (!row) throw new ProvisioningError('WEBHOOK_NOT_FOUND');
    this.validateRow(row, input.projectId, input.endpointId);
    return row;
  }
  private selection(input: WebhookSelection): WebhookSelection {
    return { projectId: validateId(input.projectId), endpointId: validateId(input.endpointId) };
  }
  async list(rawProjectId: string) {
    const projectId = validateId(rawProjectId);
    try {
      await this.getProject(projectId);
      const result = await this.db.query<EndpointRow>(`SELECT ${columns} FROM webhook_endpoints
        WHERE project_id=$1 AND config_version=1 AND encryption_key_id IS NOT NULL
        AND (previous_signing_key_id IS NULL OR previous_encryption_key_id IS NOT NULL) ORDER BY created_at,id`, [projectId]);
      return result.rows.map(row => { this.validateRow(row, projectId); return metadata(row); });
    } catch (error) { throw this.sanitize(error); }
  }
  async show(raw: WebhookSelection) {
    const input = this.selection(raw);
    try { await this.getProject(input.projectId); return metadata(await this.read(input)); }
    catch (error) { throw this.sanitize(error); }
  }
  private sanitize(error: unknown) {
    return error instanceof ProvisioningError ? error : new ProvisioningError('DATABASE_OPERATION_FAILED');
  }
  private async slot(projectId: string): Promise<number> {
    const result = await this.db.query<{ active_slot: number }>(`SELECT active_slot FROM webhook_endpoints
      WHERE project_id=$1 AND config_version=1 AND enabled`, [projectId]);
    for (let n = 1; n <= 5; n++) if (!result.rows.some(row => row.active_slot === n)) return n;
    throw new ProvisioningError('WEBHOOK_SLOTS_FULL');
  }
  async create(input: CreateWebhook) {
    const projectId = validateId(input.projectId), url = webhookUrl(input.url, this.allowlist), events = subscriptions(input.subscriptions);
    const endpointId = randomUUID(), signingKeyId = randomUUID();
    return this.operator.transaction({ projectId, endpointId, signingKeyId }, async () => {
      await this.operator.lockProject(projectId, true);
      const slot = await this.slot(projectId), secret = randomBytes(32);
      try {
        const wire = this.encryption.encrypt(secret, { projectId, endpointId, signingKeyId });
        const result = await this.db.query(`INSERT INTO webhook_endpoints
          (id,project_id,url,encrypted_secret,config_version,subscriptions,signing_key_id,active_slot,encryption_key_id)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [endpointId, projectId, url, wire, events, signingKeyId, slot, this.encryption.currentId]);
        if (result.rowCount !== 1) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
        return { id: endpointId, projectId, signingKeyId, secret: secret.toString('base64url') };
      } finally { secret.fill(0); }
    });
  }
  async setEnabled(raw: WebhookSelection, enabled: boolean) {
    const input = this.selection(raw);
    return this.operator.transaction({ ...input }, async () => {
      await this.operator.lockProject(input.projectId, enabled);
      const row = await this.read(input, true);
      if (enabled) { webhookUrl(row.url, this.allowlist); subscriptions(row.subscriptions); }
      if (row.enabled === enabled) return metadata(row);
      const slot = enabled ? await this.slot(input.projectId) : null;
      const result = await this.db.query(`UPDATE webhook_endpoints SET enabled=$3,active_slot=$4 WHERE project_id=$1 AND id=$2`,
        [input.projectId, input.endpointId, enabled, slot]);
      if (result.rowCount !== 1) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
      return metadata({ ...row, enabled, active_slot: slot });
    });
  }
  async rotate(raw: WebhookSelection, hours = 24) {
    const input = this.selection(raw); overlapHours(hours);
    const signingKeyId = randomUUID();
    return this.operator.transaction({ ...input, signingKeyId }, async () => {
      await this.operator.lockProject(input.projectId, true);
      const row = await this.read(input, true), now = await this.operator.databaseTime();
      if (row.previous_secret_valid_until && row.previous_secret_valid_until.getTime() > now.getTime()) throw new ProvisioningError('WEBHOOK_ROTATION_OVERLAP');
      const until = new Date(now.getTime() + hours * 3600000), secret = randomBytes(32);
      try {
        const wire = this.encryption.encrypt(secret, { ...input, signingKeyId });
        const result = await this.db.query(`UPDATE webhook_endpoints SET
          previous_signing_key_id=signing_key_id,previous_encrypted_secret=encrypted_secret,
          previous_encryption_key_id=encryption_key_id,rotation_started_at=$3,previous_secret_valid_until=$4,
          signing_key_id=$5,encrypted_secret=$6,encryption_key_id=$7 WHERE project_id=$1 AND id=$2`,
        [input.projectId, input.endpointId, now, until, signingKeyId, wire, this.encryption.currentId]);
        if (result.rowCount !== 1) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
        return { id: input.endpointId, projectId: input.projectId, signingKeyId,
          previousSigningKeyId: row.signing_key_id, previousSecretValidUntil: until, secret: secret.toString('base64url') };
      } finally { secret.fill(0); }
    });
  }
  async retirePrevious(raw: WebhookSelection) {
    const input = this.selection(raw);
    return this.operator.transaction({ ...input }, async () => {
      await this.operator.lockProject(input.projectId, false);
      const row = await this.read(input, true);
      if (!row.previous_signing_key_id) return metadata(row);
      const result = await this.db.query(`UPDATE webhook_endpoints SET previous_signing_key_id=NULL,
        previous_encrypted_secret=NULL,previous_encryption_key_id=NULL,rotation_started_at=NULL,
        previous_secret_valid_until=NULL WHERE project_id=$1 AND id=$2`, [input.projectId, input.endpointId]);
      if (result.rowCount !== 1) throw new ProvisioningError('DATABASE_OPERATION_FAILED');
      return metadata({ ...row, previous_signing_key_id: null, previous_encryption_key_id: null,
        previous_encrypted_secret: null, rotation_started_at: null, previous_secret_valid_until: null });
    });
  }
}
