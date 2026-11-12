import { resolve } from 'node:path';
import { run } from 'node:test';

export async function runTestFiles(files: string[], integrationMode = false): Promise<boolean> {
  const observed = new Set<string>();
  let cases = 0;
  let failures = 0;
  let assertions = 0;
  const stream = run({ files, isolation: 'process', concurrency: 1,
    execArgv: ['--import', 'tsx', '--import', resolve('src/test/assertion-preload.ts'), ...(integrationMode ? ['--import', resolve('src/test/integration-preload.ts')] : [])] });
  for await (const event of stream) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const data = event.data;
      // A child-file wrapper has the file path as its name. It is not a real test case.
      if ('skip' in data && data.skip && integrationMode) failures++;
      if (data.file && data.name !== data.file && data.name !== resolve(data.file) && data.details.type !== 'suite') {
        cases++;
        observed.add(resolve(data.file));
      }
      if (event.type === 'test:fail') {
        failures++;
        console.error('FAIL', data.name, data.details.error);
      }
    }
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      process.stdout.write(event.data.message);
      const count = event.data.message.match(/LUMEN_TEST_ASSERTIONS (\d+)/);
      if (count) assertions += Number(count[1]);
    }
    if (event.type === 'test:summary' && event.data.file === undefined) console.log('Node test summary:', JSON.stringify(event.data.counts));
  }
  const missing = files.filter((file) => !observed.has(file));
  console.log(`Executed ${cases} real test cases across ${observed.size}/${files.length} files; ${failures} failure events.`);
  if (!cases || !assertions || failures || missing.length) {
    if (missing.length) console.error('No real test cases observed in:', missing.join(', '));
    return false;
  }

  console.log(`Counted ${assertions} assertion calls.`);
  return true;
}
