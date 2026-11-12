import assert from 'node:assert/strict';
let count = 0;
for (const name of ['doesNotThrow', 'doesNotMatch', 'deepEqual', 'deepStrictEqual', 'equal', 'match', 'notEqual', 'notStrictEqual', 'ok', 'rejects', 'strictEqual', 'throws'] as const) {
  const original = assert[name];
  (assert as any)[name] = (...args: unknown[]) => {
    if (/\.test\.ts:\d+/.test(new Error().stack ?? '')) count++;
    return Reflect.apply(original, assert, args);
  };
}
process.on('exit', () => {
  console.log(`LUMEN_TEST_ASSERTIONS ${count}`);
  if (count === 0) process.exitCode = 1;
});
