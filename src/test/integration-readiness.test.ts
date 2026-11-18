import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readinessFailure, waitForService, waitForIntegrationServices } from './integration-readiness.js';

it('classifies DNS, refused connections, startup, authentication, and timeout errors without leaking details', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', '57P03']) {
    assert.equal(readinessFailure({ code, message: 'secret password' }), code);
  }
  for (const code of ['28P01', '28000']) assert.equal(readinessFailure({ code }), 'authentication_failed');
  assert.equal(readinessFailure(new Error('Connection timeout: private endpoint')), 'timeout');
  assert.equal(readinessFailure(new Error('private SQL details')), 'unexpected_client_failure');
});

it('requires a successful client probe, retrying transient startup errors', async () => {
  let attempts = 0;
  await waitForService('test-service', async () => {
    if (++attempts === 1) throw Object.assign(new Error('private'), { code: 'ECONNREFUSED' });
  }, 2000);
  assert.equal(attempts, 2);
});

it('fails closed on authentication errors without retrying or exposing credentials', async () => {
  let attempts = 0;
  await assert.rejects(waitForService('test-service', async () => {
    attempts++;
    throw Object.assign(new Error('password secret'), { code: '28P01' });
  }), { message: 'test-service: readiness failed (authentication_failed)' });
  assert.equal(attempts, 1);
});

it('bounds unsuccessful readiness and reports the sanitized error class', async () => {
  await assert.rejects(waitForService('test-service', async () => {
    throw Object.assign(new Error('private address'), { code: 'ENOTFOUND' });
  }, 1), { message: 'test-service: readiness deadline exceeded (ENOTFOUND)' });
});

it('checks the existing exact environment allowlist before opening connections', async () => {
  const previous = process.env;
  process.env = {};
  try {
    await assert.rejects(waitForIntegrationServices(), /explicit destructive-test opt-in/);
  } finally { process.env = previous; }
});
