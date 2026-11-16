import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateApiKey } from '../../shared/crypto.js';
import { runProvisioningCli, parseProvisioningArgs, type ProvisioningSession, type ProvisioningIO } from './provisioning.cli.js';
import { ProvisioningError } from './provisioning.service.js';

const accountId = '01900000-0000-7000-8000-000000000001';
const projectId = '01900000-0000-7000-8000-000000000002';
const keyId = '01900000-0000-7000-8000-000000000003';
const replacementId = '01900000-0000-7000-8000-000000000004';
const identityId = '01900000-0000-7000-8000-000000000005';
const clerkSubject = 'user_test123';
const targetArgs = ['--database', 'lumen', '--role', 'lumen'];
const issueArgs = ['key:issue', ...targetArgs, '--project-id', projectId, '--name', 'Local'];
const createArgs = ['project:create', ...targetArgs, '--email', 'dev@example.com', '--name', 'Example'];
const listArgs = ['key:list', ...targetArgs, '--project-id', projectId];
const revokeArgs = ['key:revoke', ...targetArgs, '--project-id', projectId, '--key-id', keyId];
const rotateArgs = ['key:rotate', ...targetArgs, '--project-id', projectId, '--key-id', keyId, '--name', 'Replacement'];
const linkArgs = ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'clerk', '--subject', clerkSubject];
const project = { id: projectId, account_id: accountId, name: 'Example', status: 'active' };

function fixture() {
  const output: string[] = [], errors: string[] = [], events: string[] = [], secrets: string[] = [];
  const key = generateApiKey();
  const metadata = { id: keyId, projectId, name: 'Predecessor', keyPrefix: key.keyPrefix,
    createdAt: new Date('2020-01-01T00:00:00Z'), expiresAt: null, revokedAt: null, status: 'active' as const };
  let interactive = true;
  let answer = `key:issue lumen lumen ${projectId}`;
  let issueError: Error | undefined;
  let revealFails = false;
  let questions = 0;
  const io: ProvisioningIO = {
    interactive: () => interactive,
    write: async message => { output.push(message); }, error: message => { errors.push(message); },
    question: async prompt => { output.push(prompt); questions++; return answer; },
    reveal: async secret => { if (revealFails) throw new Error(secret); events.push('reveal'); secrets.push(secret); },
  };
  const session: ProvisioningSession = {
    endpoint: { host: '127.0.0.1', port: 5432 },
    service: {
      verifyTarget: async () => { events.push('verify'); },
      getProject: async id => { assert.equal(id, projectId); events.push('preview'); return project; },
      createProject: async () => { events.push('create'); return project; },
      listProjects: async () => { events.push('list'); return [project]; },
      issueKey: async input => {
        events.push('issue'); assert.equal(input.projectId, projectId);
        if (issueError) throw issueError;
        events.push('committed');
        return { id: keyId, projectId, name: input.name, keyPrefix: key.keyPrefix, expiresAt: null, secret: key.apiKey };
      },
      listKeys: async id => { assert.equal(id, projectId); events.push('keys'); return [metadata]; },
      getKey: async input => { assert.equal(input.keyId, keyId); events.push('key-preview'); return metadata; },
      revokeKey: async input => {
        assert.equal(input.projectId, projectId); assert.equal(input.keyId, keyId); events.push('revoke');
        if (issueError) throw issueError;
        events.push('committed');
        return { ...metadata, status: 'revoked', revokedAt: new Date(), alreadyRevoked: false };
      },
      rotateKey: async input => {
        assert.equal(input.projectId, projectId); assert.equal(input.keyId, keyId); events.push('rotate');
        if (issueError) throw issueError;
        events.push('committed');
        return { id: replacementId, predecessorId: keyId, projectId, name: input.name,
          keyPrefix: key.keyPrefix, expiresAt: null, secret: key.apiKey };
      },
      linkIdentity: async input => {
        assert.equal(input.accountId, accountId); assert.equal(input.provider, 'clerk');
        assert.equal(input.subject, clerkSubject); events.push('link');
        if (issueError) throw issueError;
        events.push('committed');
        return { id: identityId, accountId: input.accountId, provider: input.provider,
          subject: input.subject, alreadyLinked: false };
      },
    },
    close: async () => { events.push('close'); },
  };
  const connect = async () => { events.push('connect'); return session; };
  return { output, errors, events, secrets, key, io, session, connect, questions: () => questions,
    setInteractive: (value: boolean) => { interactive = value; }, setAnswer: (value: string) => { answer = value; },
    setIssueError: (error: Error) => { issueError = error; }, failReveal: () => { revealFails = true; } };
}

it('requires an explicit target and rejects unknown, duplicate, ambiguous, or invalid options', () => {
  for (const args of [[], ['key:list'], ['project:list'], ['project:list', ...targetArgs, '--yes'],
    [...issueArgs, '--name', 'Other'], [...issueArgs, '--project-id'], [...issueArgs, '--no-expiry', '--expires-at', '2090-01-01T00:00:00Z'],
    ['project:list', '--database', 'postgres://credentials', '--role', 'lumen'],
    [...createArgs, '--account-id', accountId], [...issueArgs, '--no-expiry=false'], [...issueArgs, '--expires-at', '']]) {
    assert.throws(() => parseProvisioningArgs(args));
  }
  assert.equal(parseProvisioningArgs(issueArgs).command, 'key:issue');
  const parsed = parseProvisioningArgs([...issueArgs, '--no-expiry']);
  assert.ok(parsed.command === 'key:issue' && parsed.input.noExpiry);
  const existing = parseProvisioningArgs(['project:create', ...targetArgs, '--account-id', accountId, '--name', 'Example']);
  assert.ok(existing.command === 'project:create' && existing.input.accountId === accountId);
});

it('parses identity:link only with an explicit account, supported provider, and Clerk-shaped subject', () => {
  const parsed = parseProvisioningArgs(linkArgs);
  assert.ok(parsed.command === 'identity:link');
  assert.deepEqual(parsed.input, { accountId, provider: 'clerk', subject: clerkSubject });
  for (const args of [
    ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'clerk'],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--subject', clerkSubject],
    ['identity:link', ...targetArgs, '--provider', 'clerk', '--subject', clerkSubject],
    ['identity:link', ...targetArgs, '--account-id', 'invalid', '--provider', 'clerk', '--subject', clerkSubject],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'github', '--subject', clerkSubject],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'clerk', '--subject', 'not-a-user'],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'clerk', '--subject', 'user_bad-name'],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--provider', 'clerk', '--subject', clerkSubject, '--yes'],
    ['identity:link', ...targetArgs, '--account-id', accountId, '--account-id', accountId, '--provider', 'clerk', '--subject', clerkSubject],
  ]) assert.throws(() => parseProvisioningArgs(args));
});

it('identifies database and project, confirms exact target, then reveals once only after commit', async () => {
  const f = fixture();
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'preview', 'issue', 'committed', 'reveal', 'close']);
  assert.equal(f.questions(), 1);
  assert.equal(f.secrets.length, 1);
  assert.ok(f.secrets[0] === f.key.apiKey);
  assert.ok(![...f.output, ...f.errors].join('\n').includes(f.key.apiKey));
  assert.ok(f.output.some(line => line.includes('127.0.0.1') && line.includes('lumen')));
  assert.ok(f.output.some(line => line.includes(accountId) && line.includes(projectId)));
});

it('creates ownership/project metadata only after confirmation and never reveals a key', async () => {
  const f = fixture(); f.setAnswer('project:create lumen lumen');
  assert.equal(await runProvisioningCli(createArgs, f.io, f.connect), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'create', 'close']);
  assert.equal(f.secrets.length, 0);
  assert.ok(f.output.some(line => line.includes('unverified')));
});

it('lists projects without a write prompt, even with redirected output', async () => {
  const f = fixture(); f.setInteractive(false);
  assert.equal(await runProvisioningCli(['project:list', ...targetArgs], f.io, f.connect), 0);
  assert.equal(f.questions(), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'list', 'close']);
  assert.equal(f.secrets.length, 0);
});

it('refuses noninteractive writes before connecting or generating credentials', async () => {
  for (const args of [issueArgs, createArgs]) {
    const f = fixture(); f.setInteractive(false);
    assert.equal(await runProvisioningCli(args, f.io, f.connect), 1);
    assert.equal(f.events.length, 0);
    assert.equal(f.secrets.length, 0);
  }
});

it('cancels mismatched confirmation with exit 2 and no mutation', async () => {
  for (const answer of ['', 'yes', 'key:issue other lumen ' + projectId, 'key:issue lumen lumen ' + accountId]) {
    const f = fixture(); f.setAnswer(answer);
    assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 2);
    assert.ok(!f.events.includes('issue'));
    assert.equal(f.events.at(-1), 'close');
    assert.equal(f.secrets.length, 0);
  }
});

it('rechecks terminal availability after confirmation before mutating', async () => {
  const f = fixture();
  f.io.question = async () => { f.setInteractive(false); return `key:issue lumen lumen ${projectId}`; };
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.ok(!f.events.includes('issue'));
});

it('identity mismatch prevents confirmation and writes', async () => {
  const f = fixture();
  f.session.service.verifyTarget = async () => { throw new ProvisioningError('DATABASE_IDENTITY_MISMATCH'); };
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.equal(f.questions(), 0);
  assert.ok(!f.events.includes('issue'));
  assert.equal(f.events.at(-1), 'close');
});

it('uncertain COMMIT returns recovery IDs but never reveals or automatically retries', async () => {
  const f = fixture();
  f.setIssueError(new ProvisioningError('COMMIT_OUTCOME_UNKNOWN', { projectId, keyId }));
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'issue').length, 1);
  assert.equal(f.secrets.length, 0);
  assert.ok(f.errors.some(line => line.includes('Do not retry blindly')));
  assert.ok(f.errors.some(line => line.includes(keyId)));
});

it('suppresses raw database errors and credential-bearing details', async () => {
  const f = fixture();
  f.setIssueError(new Error(`database detail ${f.key.apiKey}`));
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.ok(![...f.output, ...f.errors].join('\n').includes(f.key.apiKey));
  assert.equal(f.secrets.length, 0);
  assert.equal(f.events.at(-1), 'close');
  const g = fixture();
  assert.equal(await runProvisioningCli(issueArgs, g.io, async () => { throw new Error(g.key.apiKey); }), 1);
  assert.ok(!g.errors.join('').includes(g.key.apiKey));
});

it('reports persisted key identity when reveal fails without repeating secret or issuance', async () => {
  const f = fixture(); f.failReveal();
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'issue').length, 1);
  assert.ok(f.errors.some(line => line.includes(keyId)));
  assert.ok(f.errors.some(line => line.includes('Persistence succeeded')));
  assert.ok(!f.errors.join('').includes(f.key.apiKey));
});

it('suppresses secret output when terminal disappears after persistence', async () => {
  const f = fixture();
  const original = f.session.service.issueKey;
  f.session.service.issueKey = async input => { const result = await original(input); f.setInteractive(false); return result; };
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 1);
  assert.equal(f.secrets.length, 0);
  assert.ok(f.errors.some(line => line.includes(keyId)));
});

it('help does not connect or require credentials', async () => {
  const f = fixture(); f.setInteractive(false);
  assert.equal(await runProvisioningCli(['--help'], f.io, f.connect), 0);
  assert.equal(f.events.length, 0);
  assert.ok(f.output[0]!.includes('90 days'));
});

it('EOF or interrupt cancels before writes and closes the connection', async () => {
  const f = fixture();
  f.io.question = async () => { throw new ProvisioningError('CONFIRMATION_CANCELLED'); };
  assert.equal(await runProvisioningCli(issueArgs, f.io, f.connect), 2);
  assert.ok(!f.events.includes('issue'));
  assert.equal(f.events.at(-1), 'close');
});

it('reports committed project IDs if result output fails without repeating creation', async () => {
  const f = fixture(); f.setAnswer('project:create lumen lumen');
  f.io.write = async () => { if (f.events.includes('create')) throw new Error('output failed'); };
  assert.equal(await runProvisioningCli(createArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'create').length, 1);
  assert.ok(f.errors.some(line => line.includes('Project persistence succeeded')));
  assert.ok(f.errors.some(line => line.includes(projectId)));
});

it('connection cleanup failure returns a nonzero exit without retrying committed work', async () => {
  const f = fixture(); f.setAnswer('project:create lumen lumen');
  f.session.close = async () => { throw new Error(f.key.apiKey); };
  assert.equal(await runProvisioningCli(createArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'create').length, 1);
  assert.ok(f.errors.some(line => line.includes('may already have succeeded')));
  assert.ok(!f.errors.join('').includes(f.key.apiKey));
});

it('real CLI propagates exit codes and rejects piped issuance without opening a database', async () => {
  for (const [args, expected] of [[['--help'], 0], [issueArgs, 1], [revokeArgs, 1], [rotateArgs, 1], [linkArgs, 1]] as const) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.PGPASSWORD;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/provision.ts', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, expected);
    assert.ok(!output.includes('PGPASSWORD'));
    assert.ok(!output.includes('API key (shown once)'));
  }
});

it('parses lifecycle commands with explicit UUIDs and supported expiration choices only', () => {
  for (const args of [listArgs, revokeArgs, rotateArgs, [...rotateArgs, '--no-expiry'],
    [...rotateArgs, '--expires-at', '2090-01-01T00:00:00Z']]) assert.doesNotThrow(() => parseProvisioningArgs(args));
  for (const args of [listArgs.slice(0, -2), revokeArgs.slice(0, -2), rotateArgs.slice(0, -2),
    [...listArgs, '--key-id', keyId], [...revokeArgs, '--name', 'Unexpected'], [...rotateArgs, '--no-expiry', '--expires-at', '2090-01-01T00:00:00Z'],
    ['key:revoke', ...targetArgs, '--project-id', projectId, '--key-id', 'invalid']]) assert.throws(() => parseProvisioningArgs(args));
});

it('lists non-secret key metadata without a terminal or write confirmation', async () => {
  const f = fixture(); f.setInteractive(false);
  assert.equal(await runProvisioningCli(listArgs, f.io, f.connect), 0);
  assert.equal(f.questions(), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'keys', 'close']);
  assert.equal(f.secrets.length, 0);
  assert.ok(!f.output.join('').includes(f.key.apiKey));
  assert.ok(!f.output.join('').includes(f.key.hash));
});

it('revokes only after confirmation containing both project and key IDs without revealing a secret', async () => {
  const f = fixture(); f.setAnswer(`key:revoke lumen lumen ${projectId} ${keyId}`);
  assert.equal(await runProvisioningCli(revokeArgs, f.io, f.connect), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'preview', 'key-preview', 'revoke', 'committed', 'close']);
  assert.equal(f.secrets.length, 0);
  assert.ok(f.output.some(line => line.includes('"status":"revoked"')));
});

it('rotation displays predecessor/replacement IDs and overlap instructions, revealing only after commit', async () => {
  const f = fixture(); f.setAnswer(`key:rotate lumen lumen ${projectId} ${keyId}`);
  assert.equal(await runProvisioningCli(rotateArgs, f.io, f.connect), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'preview', 'key-preview', 'rotate', 'committed', 'reveal', 'close']);
  assert.equal(f.secrets.length, 1);
  assert.ok(f.output.some(line => line.includes(replacementId) && line.includes(keyId)));
  assert.ok(f.output.some(line => line.includes('deploy and verify') && line.includes('explicitly revoke')));
  assert.ok(!f.output.join('').includes(f.key.apiKey));
  assert.ok(!f.output.join('').includes(f.key.hash));
});

it('all lifecycle writes reject redirected output, wrong confirmation, or failed identity before mutation', async () => {
  for (const args of [revokeArgs, rotateArgs]) {
    const f = fixture(); f.setInteractive(false);
    assert.equal(await runProvisioningCli(args, f.io, f.connect), 1);
    assert.equal(f.events.length, 0);
    const g = fixture(); g.setAnswer(`key:revoke lumen lumen ${projectId}`);
    assert.equal(await runProvisioningCli(args, g.io, g.connect), 2);
    assert.ok(!g.events.includes('revoke') && !g.events.includes('rotate'));
    const h = fixture();
    h.session.service.verifyTarget = async () => { throw new ProvisioningError('DATABASE_IDENTITY_MISMATCH'); };
    assert.equal(await runProvisioningCli(args, h.io, h.connect), 1);
    assert.equal(h.questions(), 0);
  }
});

it('expired/revoked predecessor preview directs operators to key:issue without confirmation', async () => {
  for (const status of ['expired', 'revoked'] as const) {
    const f = fixture();
    const original = f.session.service.getKey;
    f.session.service.getKey = async input => ({ ...await original(input), status });
    assert.equal(await runProvisioningCli(rotateArgs, f.io, f.connect), 1);
    assert.equal(f.questions(), 0);
    assert.ok(!f.events.includes('rotate'));
    assert.ok(f.errors.some(line => line.includes('Use key:issue')));
  }
});

it('lifecycle failures are sanitized and uncertain commits never claim success or reveal/retry', async () => {
  for (const [args, command] of [[revokeArgs, 'revoke'], [rotateArgs, 'rotate']] as const) {
    for (const uncertain of [true, false]) {
      const f = fixture(); f.setAnswer(`key:${command} lumen lumen ${projectId} ${keyId}`);
      f.setIssueError(uncertain ? new ProvisioningError('COMMIT_OUTCOME_UNKNOWN', { projectId, keyId, predecessorId: keyId }) : new Error(f.key.apiKey));
      assert.equal(await runProvisioningCli(args, f.io, f.connect), 1);
      assert.equal(f.events.filter(x => x === command).length, 1);
      assert.equal(f.secrets.length, 0);
      assert.ok(![...f.errors, ...f.output].join('').includes(f.key.apiKey));
      if (uncertain) assert.ok(f.errors.some(line => line.includes('Commit outcome unknown')));
      assert.ok(!f.output.some(line => line.includes('"status":"revoked"') || line.includes('rotationIncomplete')));
    }
  }
});

it('failed replacement delivery retains both recovery IDs and does not repeat rotation', async () => {
  const f = fixture(); f.setAnswer(`key:rotate lumen lumen ${projectId} ${keyId}`); f.failReveal();
  assert.equal(await runProvisioningCli(rotateArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'rotate').length, 1);
  assert.ok(f.errors.some(line => line.includes(replacementId)));
  assert.ok(f.errors.some(line => line.includes(keyId) && line.includes('incomplete')));
  assert.ok(!f.errors.join('').includes(f.key.apiKey));
});

it('failed revocation result delivery reports committed state and selected recovery IDs', async () => {
  const f = fixture(); f.setAnswer(`key:revoke lumen lumen ${projectId} ${keyId}`);
  f.io.write = async () => { if (f.events.includes('committed')) throw new Error('delivery failed'); };
  assert.equal(await runProvisioningCli(revokeArgs, f.io, f.connect), 1);
  assert.ok(f.errors.some(line => line.includes('Revocation committed')));
  assert.ok(f.errors.some(line => line.includes(projectId) && line.includes(keyId)));
  assert.equal(f.events.filter(x => x === 'revoke').length, 1);
});

it('links an identity only after exact confirmation and never reveals a secret', async () => {
  const f = fixture(); f.setAnswer(`identity:link lumen lumen ${accountId} clerk ${clerkSubject}`);
  assert.equal(await runProvisioningCli(linkArgs, f.io, f.connect), 0);
  assert.deepEqual(f.events, ['connect', 'verify', 'link', 'committed', 'close']);
  assert.equal(f.secrets.length, 0);
  assert.equal(f.questions(), 1);
  assert.ok(f.output.some(line => line.includes(accountId) && line.includes(clerkSubject)));
  assert.ok(f.output.some(line => line.includes('"alreadyLinked":false')));
});

it('reports an identical repeated link as already linked without another write', async () => {
  const f = fixture(); f.setAnswer(`identity:link lumen lumen ${accountId} clerk ${clerkSubject}`);
  f.session.service.linkIdentity = async input => ({ id: identityId, accountId: input.accountId,
    provider: input.provider, subject: input.subject, alreadyLinked: true });
  assert.equal(await runProvisioningCli(linkArgs, f.io, f.connect), 0);
  assert.ok(f.output.some(line => line.includes('"alreadyLinked":true')));
  assert.equal(f.events.filter(x => x === 'link').length, 0);
});

it('rejects conflicting, unknown-account, and database identity failures with sanitized errors', async () => {
  for (const [code, message] of [
    ['IDENTITY_CONFLICT', 'already linked to a different account'],
    ['ACCOUNT_NOT_FOUND', 'does not exist'],
    ['DATABASE_IDENTITY_MISMATCH', 'does not match the explicit target'],
  ] as const) {
    const f = fixture(); f.setAnswer(`identity:link lumen lumen ${accountId} clerk ${clerkSubject}`);
    f.session.service.linkIdentity = async () => { throw new ProvisioningError(code); };
    assert.equal(await runProvisioningCli(linkArgs, f.io, f.connect), 1);
    assert.ok(f.errors.some(line => line.includes(message)));
    assert.equal(f.secrets.length, 0);
    assert.ok(![...f.output, ...f.errors].join('').includes(f.key.apiKey));
  }
});

it('refuses noninteractive identity writes before connecting and cancels mismatched confirmation', async () => {
  const f = fixture(); f.setInteractive(false);
  assert.equal(await runProvisioningCli(linkArgs, f.io, f.connect), 1);
  assert.equal(f.events.length, 0);

  const g = fixture(); g.setAnswer(`identity:link lumen lumen ${accountId} clerk user_wrong`);
  assert.equal(await runProvisioningCli(linkArgs, g.io, g.connect), 2);
  assert.ok(!g.events.includes('link'));
  assert.equal(g.events.at(-1), 'close');
});

it('reports a committed identity link if result delivery fails without repeating the write', async () => {
  const f = fixture(); f.setAnswer(`identity:link lumen lumen ${accountId} clerk ${clerkSubject}`);
  f.io.write = async () => { if (f.events.includes('committed')) throw new Error('delivery failed'); };
  assert.equal(await runProvisioningCli(linkArgs, f.io, f.connect), 1);
  assert.equal(f.events.filter(x => x === 'link').length, 1);
  assert.ok(f.errors.some(line => line.includes('Identity link committed')));
  assert.ok(f.errors.some(line => line.includes(accountId) && line.includes(clerkSubject)));
  assert.ok(!f.errors.join('').includes(f.key.apiKey));
});
