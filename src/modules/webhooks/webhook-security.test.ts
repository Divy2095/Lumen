import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostnameAllowlist, webhookUrl, subscriptions, overlapHours, WebhookEncryption } from './webhook-security.js';

const context = { projectId: randomUUID(), endpointId: randomUUID(), signingKeyId: randomUUID() };
const key = () => randomBytes(32).toString('hex');
it('encrypts 32-byte secrets with randomized versioned authenticated ciphertext', () => {
  const encryption = new WebhookEncryption('local-a', { 'local-a': key() }), secret = randomBytes(32);
  const one = encryption.encrypt(secret, context), two = encryption.encrypt(secret, context);
  assert.equal(one.length, 61); assert.equal(one[0], 1); assert.ok(!one.equals(two));
  assert.ok(!one.equals(secret)); assert.ok(encryption.decrypt(one, 'local-a', context).equals(secret));
  assert.ok(encryption.decrypt(two, 'local-a', context).equals(secret));
});
it('rejects tampering of format, nonce, tag, ciphertext, lengths, every AAD identity and external key', () => {
  const raw = key(), encryption = new WebhookEncryption('a', { a: raw, b: raw });
  const wire = encryption.encrypt(randomBytes(32), context);
  for (const offset of [0,1,13,29,60]) { const modified = Buffer.from(wire); modified[offset] = modified[offset]! ^ 1; assert.throws(() => encryption.decrypt(modified,'a',context), /WEBHOOK_DECRYPTION_FAILED/); }
  for (const field of ['projectId','endpointId','signingKeyId']) assert.throws(() => encryption.decrypt(wire,'a',{ ...context, [field]: randomUUID() }));
  assert.throws(() => encryption.decrypt(wire,'b',context));
  assert.throws(() => new WebhookEncryption('a',{ a:key() }).decrypt(wire,'a',context));
  assert.throws(() => encryption.decrypt(wire,'missing',context));
  assert.throws(() => encryption.decrypt(wire.subarray(1),'a',context));
  assert.throws(() => encryption.encrypt(Buffer.alloc(31),context));
});
it('fails closed on missing, malformed, unknown or ambiguous key configuration without echoing it', () => {
  for (const env of [{}, { WEBHOOK_ENCRYPTION_KEY_ID:'a', WEBHOOK_ENCRYPTION_KEYS:'bad' },
    { WEBHOOK_ENCRYPTION_KEY_ID:'a', WEBHOOK_ENCRYPTION_KEYS:'[]' },
    { WEBHOOK_ENCRYPTION_KEY_ID:'a', WEBHOOK_ENCRYPTION_KEYS:'{}' },
    { WEBHOOK_ENCRYPTION_KEY_ID:'a', WEBHOOK_ENCRYPTION_KEYS:JSON.stringify({ a:'bad' }) }]) {
    assert.throws(() => WebhookEncryption.fromEnvironment(env), /^ProvisioningError: WEBHOOK_ENCRYPTION_CONFIG_INVALID$/);
  }
  assert.equal(WebhookEncryption.fromEnvironment({ WEBHOOK_ENCRYPTION_KEY_ID:'a', WEBHOOK_ENCRYPTION_KEYS:JSON.stringify({ a:key() }) }).currentId,'a');
});
it('canonicalizes explicit HTTPS:443 destinations using exact operator DNS allowlisting', () => {
  const allowed = hostnameAllowlist('hooks.example.com,other.example.com');
  assert.equal(webhookUrl('https://HOOKS.example.com:443',allowed),'https://hooks.example.com/');
  assert.equal(webhookUrl('https://hooks.example.com/a?b=c',allowed),'https://hooks.example.com/a?b=c');
});
it('rejects allowlist bypasses, IP representations, credentials, fragments and ambiguous URLs', () => {
  const allowed = hostnameAllowlist('hooks.example.com');
  for (const url of ['http://hooks.example.com/', 'https://hooks.example.com:444/', 'https://hooks.example.com:0443/',
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/',
    'https://hooks.example.com.evil.test/', 'https://evil.test/hooks.example.com',
    'https://hooks.example.com@evil.test/', 'https://x:secret@hooks.example.com/',
    'https://hooks.example.com./', 'https://hooks%2eexample.com/', 'https://hooks.example.com/#',
    'https://hooks.example.com/#fragment', 'https://hooks.example.com\\evil',
    ' https://hooks.example.com/', 'https://hooks.example.com/\n', 'https:///hooks.example.com/',
    'https://hooks.example.com/a/../b', 'https://hooks.example.com/%2e/b',
    'https://hooks.example.com/%2F', 'https://hooks.example.com/%GG', 'https://hооks.example.com/']) {
    assert.throws(() => webhookUrl(url,allowed), /WEBHOOK_URL_INVALID/);
  }
  for (const value of [undefined, '', '*.example.com', 'hooks.example.com,', '127.0.0.1', 'localhost', 'EXAMPLE.com', 'hooks.example.com,hooks.example.com']) assert.throws(() => hostnameAllowlist(value));
});
it('validates explicit subscriptions and bounded integer overlap', () => {
  assert.deepEqual(subscriptions(['rendition.ready','asset.ingested']),['asset.ingested','rendition.ready']);
  for (const value of [[], ['asset.ingested','asset.ingested'], ['asset.ready'], [''], ['asset.ingested','rendition.ready','asset.failed','rendition.failed','unknown']]) assert.throws(() => subscriptions(value));
  assert.equal(overlapHours(),24); assert.equal(overlapHours(1),1);
  for (const value of [0,-1,1.5,25,Infinity,NaN]) assert.throws(() => overlapHours(value));
});
