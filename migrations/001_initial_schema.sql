-- Up Migration

-- 1. accounts
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_accounts_email ON accounts (LOWER(TRIM(email)));

-- 2. account_identities
CREATE TABLE account_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_account_identities_provider_subject UNIQUE (provider, provider_subject)
);

CREATE INDEX idx_account_identities_account_id ON account_identities (account_id);

-- 3. projects
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_projects_status CHECK (status IN ('active', 'deletion_pending'))
);

CREATE INDEX idx_projects_account_created ON projects (account_id, created_at DESC);

-- 4. api_keys
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(30) NOT NULL,
  key_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_api_keys_key_hash UNIQUE (key_hash)
);

CREATE INDEX idx_api_keys_project_id ON api_keys (project_id);

-- 5. media_assets
CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  original_filename TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  uploaded_bytes BIGINT NOT NULL DEFAULT 0,
  upload_token_hash VARCHAR(64) NULL,
  upload_token_expires_at TIMESTAMPTZ NULL,
  storage_key TEXT NOT NULL,
  duration_seconds NUMERIC(10, 3) NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  video_codec VARCHAR(50) NULL,
  audio_codec VARCHAR(50) NULL,
  bitrate BIGINT NULL,
  frame_rate NUMERIC(6, 2) NULL,
  metadata JSONB NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'uploading',
  deletion_requested_at TIMESTAMPTZ NULL,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_media_assets_status CHECK (status IN ('uploading', 'ready', 'failed', 'deleting', 'deleted')),
  CONSTRAINT chk_media_assets_file_size CHECK (file_size_bytes > 0),
  CONSTRAINT chk_media_assets_uploaded_bytes CHECK (uploaded_bytes >= 0 AND uploaded_bytes <= file_size_bytes),
  CONSTRAINT uq_media_assets_project_asset UNIQUE (project_id, id)
);

CREATE INDEX idx_media_assets_project_created ON media_assets (project_id, created_at DESC);
CREATE INDEX idx_media_assets_project_status ON media_assets (project_id, status);
CREATE INDEX idx_media_assets_upload_token ON media_assets (id, upload_token_expires_at) WHERE status = 'uploading';

-- 6. processing_jobs
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  media_asset_id UUID NOT NULL,
  operation VARCHAR(50) NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  locked_by VARCHAR(100) NULL,
  lease_token UUID NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  current_attempt_number INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT fk_processing_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_processing_jobs_project_asset FOREIGN KEY (project_id, media_asset_id) REFERENCES media_assets(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_processing_jobs_asset_job UNIQUE (media_asset_id, id),
  CONSTRAINT chk_processing_jobs_status CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT chk_processing_jobs_operation CHECK (operation IN ('extract_metadata', 'generate_thumbnail', 'transcode')),
  CONSTRAINT chk_processing_jobs_current_attempt CHECK (current_attempt_number >= 0 AND current_attempt_number <= 3)
);

CREATE INDEX idx_processing_jobs_project_created ON processing_jobs (project_id, created_at DESC);
CREATE INDEX idx_processing_jobs_status_created ON processing_jobs (status, created_at);
CREATE INDEX idx_processing_jobs_lease ON processing_jobs (status, lease_expires_at) WHERE status = 'processing';

-- 7. job_attempts
CREATE TABLE job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'processing',
  fencing_token UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  error_code VARCHAR(100) NULL,
  error_message TEXT NULL,
  CONSTRAINT chk_job_attempts_status CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT chk_job_attempts_number CHECK (attempt_number >= 1 AND attempt_number <= 3),
  CONSTRAINT uq_job_attempts_job_attempt UNIQUE (job_id, attempt_number)
);

CREATE INDEX idx_job_attempts_job_id ON job_attempts (job_id);

-- 8. media_outputs
CREATE TABLE media_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL,
  processing_job_id UUID NOT NULL,
  output_type VARCHAR(30) NOT NULL,
  logical_key VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  storage_key TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_media_outputs_media_asset FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_media_outputs_asset_job FOREIGN KEY (media_asset_id, processing_job_id) REFERENCES processing_jobs(media_asset_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_media_outputs_type CHECK (output_type IN ('rendition', 'thumbnail')),
  CONSTRAINT chk_media_outputs_version CHECK (version >= 1),
  CONSTRAINT chk_media_outputs_file_size CHECK (file_size_bytes > 0),
  CONSTRAINT uq_media_outputs_asset_key_version UNIQUE (media_asset_id, logical_key, version)
);

CREATE UNIQUE INDEX uq_media_outputs_current ON media_outputs (media_asset_id, logical_key) WHERE is_current = true;
CREATE INDEX idx_media_outputs_asset_created ON media_outputs (media_asset_id, created_at);
CREATE INDEX idx_media_outputs_job_id ON media_outputs (processing_job_id);

-- 9. webhook_endpoints
CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  encrypted_secret BYTEA NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_endpoints_project_endpoint UNIQUE (project_id, id)
);

CREATE INDEX idx_webhook_endpoints_project ON webhook_endpoints (project_id);

-- 10. webhook_events
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_events_project_event UNIQUE (project_id, id)
);

CREATE INDEX idx_webhook_events_project_created ON webhook_events (project_id, created_at DESC);

-- 11. webhook_deliveries
CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  event_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempts_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_webhook_deliveries_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_webhook_deliveries_project_event FOREIGN KEY (project_id, event_id) REFERENCES webhook_events(project_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_webhook_deliveries_project_endpoint FOREIGN KEY (project_id, endpoint_id) REFERENCES webhook_endpoints(project_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_webhook_deliveries_status CHECK (status IN ('pending', 'delivering', 'delivered', 'retrying', 'failed')),
  CONSTRAINT chk_webhook_deliveries_attempts CHECK (attempts_count >= 0),
  CONSTRAINT uq_webhook_deliveries_event_endpoint UNIQUE (event_id, endpoint_id)
);

CREATE INDEX idx_webhook_deliveries_project ON webhook_deliveries (project_id);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries (status, next_attempt_at) WHERE status IN ('pending', 'retrying');

-- 12. webhook_delivery_attempts
CREATE TABLE webhook_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  response_status INTEGER NULL,
  response_duration_ms INTEGER NULL,
  error_code VARCHAR(100) NULL,
  error_message TEXT NULL,
  CONSTRAINT chk_webhook_delivery_attempts_number CHECK (attempt_number >= 1),
  CONSTRAINT uq_webhook_delivery_attempts_attempt UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX idx_webhook_delivery_attempts_delivery ON webhook_delivery_attempts (delivery_id);

-- 13. outbox_events
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  locked_by VARCHAR(100) NULL,
  locked_until TIMESTAMPTZ NULL,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  CONSTRAINT chk_outbox_events_attempts CHECK (attempts_count >= 0)
);

CREATE INDEX idx_outbox_events_unpublished ON outbox_events (created_at ASC) WHERE published_at IS NULL;

-- 14. idempotency_keys
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NULL,
  response_body JSONB NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'locked',
  locked_until TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_idempotency_keys_status CHECK (status IN ('locked', 'completed', 'failed')),
  CONSTRAINT uq_idempotency_keys_project_key UNIQUE (project_id, idempotency_key)
);

CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys (expires_at);

-- Down Migration

DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS webhook_delivery_attempts;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS media_outputs;
DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS processing_jobs;
DROP TABLE IF EXISTS media_assets;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS account_identities;
DROP TABLE IF EXISTS accounts;
