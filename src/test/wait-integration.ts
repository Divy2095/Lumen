import { waitForIntegrationServices } from './integration-readiness.js';

try {
  await waitForIntegrationServices();
  console.log('Client readiness only. Run test:integration:check before migrations or tests.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Disposable client readiness failed');
  process.exitCode = 1;
}
