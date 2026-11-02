import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateUploadToken(): { token: string; hash: string } {
  const secret = randomBytes(24).toString('hex');
  const token = `lup_tok_${secret}`;
  const hash = hashSha256(token);
  return { token, hash };
}

export function generateApiKey(prefix = 'lumen_live'): { apiKey: string; keyPrefix: string; hash: string } {
  const secret = randomBytes(24).toString('hex');
  const keyPrefix = `${prefix}_${secret.slice(0, 8)}`;
  const apiKey = `${prefix}_${secret}`;
  const hash = hashSha256(apiKey);
  return { apiKey, keyPrefix, hash };
}

export function safeCompareHashes(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
