import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const integration = new Set(['database/schema.test.ts', 'modules/media/media.test.ts',
  'modules/auth/provisioning.integration.test.ts',
  'modules/media/ffmpeg.service.test.ts', 'modules/media/ffprobe.service.test.ts',
  'modules/media/transcoding.service.test.ts', 'modules/media/transcoding-scheduling.test.ts',
  'workers/outbox-publisher.test.ts', 'workers/pipeline.test.ts', 'workers/worker.test.ts']);
const safe = new Set(['modules/media/rendition-http.test.ts', 'config/redis.test.ts', 'modules/health/health.test.ts',
  'modules/auth/provisioning.service.test.ts', 'modules/auth/provisioning.cli.test.ts',
  'modules/auth/provisioning.lifecycle.test.ts',
  'modules/media/encoder-detection.test.ts', 'modules/media/resource-config.test.ts',
  'modules/media/transcoding-cancellation.test.ts', 'modules/media/transcoding-profiles.test.ts',
  'modules/media/transcoding-real-media.test.ts', 'modules/media/transcoding-validation.test.ts',
  'shared/storage/local-storage.service.test.ts', 'workers/job-lease.test.ts',
  'workers/processor-retry.test.ts', 'workers/rendition-cleanup.test.ts',
  'workers/repository-readiness.test.ts', 'test/integration-safety.test.ts', 'test/test-runner.test.ts']);
const mode = process.argv[2];
if (mode !== 'unit' && mode !== 'integration') throw new Error('Choose unit or integration test mode');
const all = (await readdir('src', { recursive: true })).filter((file) => file.endsWith('.test.ts')).sort();
if (all.some((file) => !safe.has(file) && !integration.has(file))) throw new Error('Unclassified test file: review its side effects first');
const files = all.filter((file) => mode === 'integration' || !integration.has(file)).map((file) => resolve('src', file));
if (mode === 'integration') {
  const { integrationPreflight } = await import('./preflight.js');
  await integrationPreflight();
}
const { runTestFiles } = await import('./test-runner.js');
if (!await runTestFiles(files, mode === 'integration')) process.exitCode = 1;
