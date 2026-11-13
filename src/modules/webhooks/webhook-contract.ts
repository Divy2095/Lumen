/** Version 1 describes ingestion and individual rendition outcomes, never aggregate readiness. */
export const WEBHOOK_EVENT_TYPES = ['asset.ingested', 'asset.failed', 'rendition.ready', 'rendition.failed'] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];
export const WEBHOOK_SCHEMA_VERSION = 1;

export const WEBHOOK_POLICY = Object.freeze({
  maxActiveEndpointsPerProject: 5,
  secretOverlapHours: 24,
  maxAttempts: 8,
  retryBaseMs: 60_000,
  retryCapMs: 3_600_000,
  maxDeliveryAgeMs: 86_400_000,
  httpDeadlineMs: 10_000,
  globalConcurrency: 4,
  perEndpointConcurrency: 1,
  maxRequestBytes: 65_536,
  maxResponseHeaderBytes: 16_384,
});

type AssetData = { asset_id: string; stage: 'ingestion' };
type RenditionData = { asset_id: string; job_id: string; profile: '360p' | '480p' | '720p' | '1080p' };
type Envelope<T extends WebhookEventType, D> = {
  id: string; type: T; schema_version: 1; created_at: string; project_id: string; data: D;
};
export type WebhookEvent =
  | Envelope<'asset.ingested', AssetData & { status: 'ready' }>
  | Envelope<'asset.failed', AssetData & { status: 'failed'; error: { code: 'INGESTION_FAILED' } }>
  | Envelope<'rendition.ready', RenditionData & { status: 'ready'; output_id: string; version: number }>
  | Envelope<'rendition.failed', RenditionData & { status: 'failed'; error: { code: 'TRANSCODING_FAILED' } }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error('Invalid webhook event contract'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
}
function id(value: unknown): void { if (typeof value !== 'string' || !uuid.test(value)) invalid(); }

/** Validates an allowlist, so raw errors, paths, secrets, and arbitrary metadata cannot be added. */
export function parseWebhookEvent(value: unknown): WebhookEvent {
  const event = object(value);
  exact(event, ['id', 'type', 'schema_version', 'created_at', 'project_id', 'data']);
  id(event.id); id(event.project_id);
  if (event.schema_version !== 1 || !WEBHOOK_EVENT_TYPES.includes(event.type as WebhookEventType)) invalid();
  if (typeof event.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.created_at)) invalid();
  const time = new Date(event.created_at);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== event.created_at || event.created_at.startsWith('0000')) invalid();
  const data = object(event.data);
  id(data.asset_id);
  if (event.type === 'asset.ingested' || event.type === 'asset.failed') {
    exact(data, ['asset_id', 'stage', 'status', ...(event.type === 'asset.failed' ? ['error'] : [])]);
    if (data.stage !== 'ingestion' || data.status !== (event.type === 'asset.ingested' ? 'ready' : 'failed')) invalid();
  } else {
    exact(data, ['asset_id', 'job_id', 'profile', 'status', ...(event.type === 'rendition.ready' ? ['output_id', 'version'] : ['error'])]);
    id(data.job_id);
    if (!['360p', '480p', '720p', '1080p'].includes(data.profile as string)) invalid();
    if (data.status !== (event.type === 'rendition.ready' ? 'ready' : 'failed')) invalid();
    if (event.type === 'rendition.ready') {
      id(data.output_id);
      if (typeof data.version !== 'number' || !Number.isSafeInteger(data.version) || data.version < 1 || data.version > 2_147_483_647) invalid();
    }
  }
  if (event.type === 'asset.failed' || event.type === 'rendition.failed') {
    const error = object(data.error); exact(error, ['code']);
    if (error.code !== (event.type === 'asset.failed' ? 'INGESTION_FAILED' : 'TRANSCODING_FAILED')) invalid();
  }
  return value as WebhookEvent;
}

/** Scope this key by project and event type in PostgreSQL; transport/attempt IDs never enter it. */
export function webhookDeduplicationKey(value: WebhookEvent): string {
  const event = parseWebhookEvent(value);
  switch (event.type) {
    case 'asset.ingested': return `asset:${event.data.asset_id}:ingested`;
    case 'asset.failed': return `asset:${event.data.asset_id}:failed`;
    case 'rendition.ready': return `rendition:${event.data.job_id}:ready`;
    case 'rendition.failed': return `rendition:${event.data.job_id}:failed`;
  }
}

// PostgreSQL materializes payload_bytes on INSERT. Future signing must use those
// persisted bytes, not JSON.stringify(payload) or a freshly constructed envelope.
