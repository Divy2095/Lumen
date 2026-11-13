import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ProvisioningError, validateId } from '../auth/provisioning.service.js';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './webhook-contract.js';

const fail = (code: string): never => { throw new ProvisioningError(code); };
const keyId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Exact ASCII DNS names only: no wildcards, Unicode mapping, trailing dot, or URL syntax.
const hostname = (value: string) => value.length <= 253 && !/[^a-z0-9.-]/.test(value) && value.includes('.') && !isIP(value) &&
  value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+$/.test(value.split('.').at(-1)!);
export function hostnameAllowlist(value: string | undefined): readonly string[] {
  if (!value) return fail('WEBHOOK_ALLOWLIST_REQUIRED');
  const names = value.split(',');
  if (names.length > 100 || names.some(name => !hostname(name)) || new Set(names).size !== names.length) fail('WEBHOOK_ALLOWLIST_INVALID');
  return Object.freeze(names);
}
export function webhookUrl(value: string, allowlist: readonly string[]): string {
  if (typeof value !== 'string' || !value || /[^\x21-\x7e]|\\|#/.test(value)) fail('WEBHOOK_URL_INVALID');
  // Validate the original authority too; WHATWG URL normalizes representations we reject.
  const match = /^https:\/\/([a-zA-Z0-9.-]+)(?::(443))?(\/[^]*)?$/.exec(value);
  if (!match || !hostname(match[1]!.toLowerCase())) return fail('WEBHOOK_URL_INVALID');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('WEBHOOK_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !allowlist.includes(parsed.hostname) || parsed.hostname !== match[1]!.toLowerCase()) fail('WEBHOOK_URL_INVALID');
  // Avoid normalization of dot segments or encoded separators in the destination path.
  if (/%(?:2e|2f|5c)|(?:^|\/)\.{1,2}(?:\/|$)/i.test(match[3] ?? '') || /%(?![0-9a-f]{2})/i.test(value)) fail('WEBHOOK_URL_INVALID');
  return parsed.href;
}
export function subscriptions(value: readonly string[]): WebhookEventType[] {
  if (!Array.isArray(value) || !value.length || value.length > 4 || new Set(value).size !== value.length ||
      value.some(type => !WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType))) fail('WEBHOOK_SUBSCRIPTIONS_INVALID');
  return WEBHOOK_EVENT_TYPES.filter(type => value.includes(type));
}
export function overlapHours(value = 24): number {
  if (!Number.isInteger(value) || value < 1 || value > 24) fail('WEBHOOK_OVERLAP_INVALID');
  return value;
}
export interface SecretContext { projectId: string; endpointId: string; signingKeyId: string }

export class WebhookEncryption {
  private readonly keys = new Map<string, Buffer>();
  constructor(readonly currentId: string, encoded: Readonly<Record<string, string>>) {
    if (!keyId.test(currentId) || /[^A-Za-z0-9_-]/.test(currentId) || !encoded || Array.isArray(encoded) || Object.keys(encoded).length > 16) fail('WEBHOOK_ENCRYPTION_CONFIG_INVALID');
    for (const [id, value] of Object.entries(encoded)) {
      if (!keyId.test(id) || /[^A-Za-z0-9_-]/.test(id) || typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) fail('WEBHOOK_ENCRYPTION_CONFIG_INVALID');
      this.keys.set(id, Buffer.from(value, 'hex'));
    }
    this.key(currentId);
  }
  static fromEnvironment(env: NodeJS.ProcessEnv): WebhookEncryption {
    try {
      const raw: unknown = JSON.parse(env.WEBHOOK_ENCRYPTION_KEYS ?? '');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('WEBHOOK_ENCRYPTION_CONFIG_INVALID');
      return new WebhookEncryption(env.WEBHOOK_ENCRYPTION_KEY_ID ?? '', raw as Record<string, string>);
    } catch { return fail('WEBHOOK_ENCRYPTION_CONFIG_INVALID'); }
  }
  private key(id: string): Buffer {
    if (!keyId.test(id) || !this.keys.has(id)) fail('WEBHOOK_ENCRYPTION_KEY_UNAVAILABLE');
    return this.keys.get(id)!;
  }
  private aad(id: string, context: SecretContext): Buffer {
    return Buffer.from(JSON.stringify(['lumen-webhook-secret', 1, id, validateId(context.projectId),
      validateId(context.endpointId), validateId(context.signingKeyId)]), 'utf8');
  }
  encrypt(secret: Buffer, context: SecretContext): Buffer {
    if (secret.length !== 32) fail('WEBHOOK_SECRET_INVALID');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(this.currentId), nonce);
    cipher.setAAD(this.aad(this.currentId, context));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }
  decrypt(wire: Buffer, id: string, context: SecretContext): Buffer {
    try {
      if (!Buffer.isBuffer(wire) || wire.length !== 61 || wire[0] !== 1) fail('WEBHOOK_DECRYPTION_FAILED');
      const decipher = createDecipheriv('aes-256-gcm', this.key(id), wire.subarray(1, 13));
      decipher.setAAD(this.aad(id, context)); decipher.setAuthTag(wire.subarray(13, 29));
      return Buffer.concat([decipher.update(wire.subarray(29)), decipher.final()]);
    } catch { return fail('WEBHOOK_DECRYPTION_FAILED'); }
  }
}
