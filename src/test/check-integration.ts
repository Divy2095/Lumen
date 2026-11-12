import { integrationPreflight } from './preflight.js';
await integrationPreflight();
console.log('Disposable PostgreSQL identity/privileges/marker, Redis marker, and storage verified. No migrations or test cleanup executed.');
