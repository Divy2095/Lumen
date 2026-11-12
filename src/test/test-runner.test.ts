import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

it('runner counts real cases/assertions and rejects failures, no-op tests, and empty files', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-runner-'));
  try {
    for (const [name, body, success] of [
      ['pass', "it('actual case', () => assert.equal(1, 1));", true],
      ['fail', "it('actual case', () => assert.equal(1, 2));", false],
      ['noop', "it('actual case', () => {});", false],
      ['empty', '', false],
    ] as const) {
      const file = join(directory, `${name}.test.ts`);
      await writeFile(file, `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
      const code = `import { runTestFiles } from ${JSON.stringify(pathToFileURL(resolve('src/test/test-runner.ts')).href)};
process.exitCode = await runTestFiles([${JSON.stringify(file)}]) ? 0 : 1;`;
      const driver = join(directory, `${name}-driver.mts`);
      await writeFile(driver, code);
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--import', 'tsx', driver], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject); child.on('close', resolve);
      });
      assert.equal(exitCode === 0, success, output);
      if (success) {
        assert.match(output, /Executed 1 real test cases across 1\/1 files/);
        assert.match(output, /Counted 1 assertion calls/);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
