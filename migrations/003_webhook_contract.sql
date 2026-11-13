-- Up Migration

-- Existing rows remain version 0, without inferred subscriptions or fabricated
-- encryption/signing metadata. Only explicitly configured version 1 is dispatchable.
ALTER TABLE webhook_endpoints
  ADD COLUMN config_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN subscriptions TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN signing_key_id UUID NULL,
  ADD COLUMN previous_signing_key_id UUID NULL,
  ADD COLUMN previous_encrypted_secret BYTEA NULL,
  ADD COLUMN rotation_started_at TIMESTAMPTZ NULL,
  ADD COLUMN previous_secret_valid_until TIMESTAMPTZ NULL,
  ADD COLUMN active_slot SMALLINT NULL,
  ADD CONSTRAINT chk_webhook_endpoint_contract CHECK (
    (config_version = 0 AND cardinality(subscriptions) = 0 AND signing_key_id IS NULL
      AND active_slot IS NULL AND previous_signing_key_id IS NULL
      AND previous_encrypted_secret IS NULL AND rotation_started_at IS NULL AND previous_secret_valid_until IS NULL)
    OR
    (config_version = 1 AND signing_key_id IS NOT NULL AND octet_length(encrypted_secret) > 0
      AND array_ndims(subscriptions) = 1 AND array_position(subscriptions, NULL) IS NULL
      AND subscriptions <@ ARRAY['asset.ingested', 'asset.failed', 'rendition.ready', 'rendition.failed']::TEXT[]
      AND cardinality(subscriptions) =
        (('asset.ingested' = ANY(subscriptions))::INTEGER + ('asset.failed' = ANY(subscriptions))::INTEGER
        + ('rendition.ready' = ANY(subscriptions))::INTEGER + ('rendition.failed' = ANY(subscriptions))::INTEGER)
      AND cardinality(subscriptions) BETWEEN 1 AND 4
      AND ((enabled AND active_slot IS NOT NULL AND active_slot BETWEEN 1 AND 5) OR (NOT enabled AND active_slot IS NULL)))
  ),
  ADD CONSTRAINT chk_webhook_secret_overlap CHECK (
    (previous_signing_key_id IS NULL AND previous_encrypted_secret IS NULL
      AND rotation_started_at IS NULL AND previous_secret_valid_until IS NULL)
    OR
    (previous_signing_key_id IS NOT NULL AND previous_encrypted_secret IS NOT NULL
      AND rotation_started_at IS NOT NULL AND previous_secret_valid_until IS NOT NULL
      AND previous_signing_key_id <> signing_key_id AND octet_length(previous_encrypted_secret) > 0
      AND isfinite(rotation_started_at) AND isfinite(previous_secret_valid_until)
      AND previous_secret_valid_until > rotation_started_at
      AND previous_secret_valid_until <= rotation_started_at + INTERVAL '24 hours')
  ),
  ADD CONSTRAINT uq_webhook_endpoint_contract UNIQUE (project_id, id, config_version);

CREATE UNIQUE INDEX uq_webhook_endpoint_active_slot ON webhook_endpoints (project_id, active_slot)
  WHERE config_version = 1 AND enabled;
CREATE UNIQUE INDEX uq_webhook_endpoint_signing_key ON webhook_endpoints (signing_key_id)
  WHERE signing_key_id IS NOT NULL;

CREATE FUNCTION webhook_contract_uuid(value JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string' AND value #>> '{}' ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
$$;

CREATE FUNCTION webhook_v1_payload_valid(p JSONB, event_id UUID, project UUID, kind TEXT, occurred TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d JSONB; fields TEXT[];
BEGIN
  IF jsonb_typeof(p) <> 'object' OR NOT p ?& ARRAY['id','type','schema_version','created_at','project_id','data']
    OR p - ARRAY['id','type','schema_version','created_at','project_id','data'] <> '{}'::JSONB
    OR NOT webhook_contract_uuid(p->'id') OR NOT webhook_contract_uuid(p->'project_id')
    OR p->>'id' <> event_id::TEXT OR p->>'project_id' <> project::TEXT
    OR p->>'type' IS DISTINCT FROM kind OR p->'schema_version' <> '1'::JSONB
    OR jsonb_typeof(p->'created_at') <> 'string'
    OR p->>'created_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR (p->>'created_at')::TIMESTAMPTZ <> occurred
    OR to_char(occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p->>'created_at'
  THEN RETURN false; END IF;
  d := p->'data';
  IF jsonb_typeof(d) <> 'object' OR NOT webhook_contract_uuid(d->'asset_id') THEN RETURN false; END IF;
  CASE kind
    WHEN 'asset.ingested' THEN
      fields := ARRAY['asset_id','stage','status'];
      IF d->>'stage' IS DISTINCT FROM 'ingestion' OR d->>'status' IS DISTINCT FROM 'ready' THEN RETURN false; END IF;
    WHEN 'asset.failed' THEN
      fields := ARRAY['asset_id','stage','status','error'];
      IF d->>'stage' IS DISTINCT FROM 'ingestion' OR d->>'status' IS DISTINCT FROM 'failed'
        OR d->'error' <> '{"code":"INGESTION_FAILED"}'::JSONB THEN RETURN false; END IF;
    WHEN 'rendition.ready' THEN
      fields := ARRAY['asset_id','job_id','profile','status','output_id','version'];
      IF d->>'status' IS DISTINCT FROM 'ready' OR NOT webhook_contract_uuid(d->'output_id')
        OR jsonb_typeof(d->'version') <> 'number' OR d->>'version' !~ '^[1-9][0-9]*$'
        OR (d->>'version')::BIGINT NOT BETWEEN 1 AND 2147483647 THEN RETURN false; END IF;
    WHEN 'rendition.failed' THEN
      fields := ARRAY['asset_id','job_id','profile','status','error'];
      IF d->>'status' IS DISTINCT FROM 'failed' OR d->'error' <> '{"code":"TRANSCODING_FAILED"}'::JSONB THEN RETURN false; END IF;
    ELSE RETURN false;
  END CASE;
  IF kind LIKE 'rendition.%' AND (NOT webhook_contract_uuid(d->'job_id')
    OR d->>'profile' IS NULL OR d->>'profile' NOT IN ('360p','480p','720p','1080p')) THEN RETURN false; END IF;
  RETURN COALESCE(d ?& fields AND d - fields = '{}'::JSONB, false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE webhook_events
  ADD COLUMN schema_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN deduplication_key TEXT NULL,
  ADD COLUMN payload_bytes BYTEA NULL,
  ADD CONSTRAINT chk_webhook_event_contract CHECK (
    (schema_version = 0 AND deduplication_key IS NULL AND payload_bytes IS NULL)
    OR
    (schema_version = 1 AND deduplication_key IS NOT NULL AND payload_bytes IS NOT NULL
      AND COALESCE(webhook_v1_payload_valid(payload, id, project_id, event_type, created_at), false)
      AND octet_length(payload_bytes) BETWEEN 1 AND 65536
      AND payload_bytes = convert_to(payload::TEXT, 'UTF8')
      AND deduplication_key = CASE event_type
        WHEN 'asset.ingested' THEN 'asset:' || (payload->'data'->>'asset_id') || ':ingested'
        WHEN 'asset.failed' THEN 'asset:' || (payload->'data'->>'asset_id') || ':failed'
        WHEN 'rendition.ready' THEN 'rendition:' || (payload->'data'->>'job_id') || ':ready'
        WHEN 'rendition.failed' THEN 'rendition:' || (payload->'data'->>'job_id') || ':failed'
      END)
  ),
  ADD CONSTRAINT uq_webhook_event_contract UNIQUE (project_id, id, schema_version);

CREATE UNIQUE INDEX uq_webhook_event_logical ON webhook_events (project_id, event_type, deduplication_key)
  WHERE schema_version = 1;

CREATE FUNCTION webhook_event_wire_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE wire BYTEA;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.schema_version = 1 OR NEW.schema_version = 1) AND OLD IS DISTINCT FROM NEW THEN
      RAISE EXCEPTION 'Version 1 webhook events are immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.schema_version = 1 THEN
    wire := convert_to(NEW.payload::TEXT, 'UTF8');
    IF NEW.payload_bytes IS NOT NULL AND NEW.payload_bytes <> wire THEN
      RAISE EXCEPTION 'Webhook payload bytes do not match the stored envelope' USING ERRCODE = '23514';
    END IF;
    NEW.payload_bytes := wire;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_webhook_event_wire BEFORE INSERT OR UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION webhook_event_wire_guard();

ALTER TABLE webhook_deliveries
  ADD COLUMN contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN lease_owner VARCHAR(100) NULL,
  ADD COLUMN lease_token UUID NULL,
  ADD COLUMN lease_expires_at TIMESTAMPTZ NULL,
  ADD CONSTRAINT chk_webhook_delivery_contract CHECK (
    (contract_version = 0 AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (contract_version = 1 AND attempts_count <= 8 AND
      ((status = 'delivering' AND lease_owner IS NOT NULL AND length(btrim(lease_owner)) > 0
        AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND isfinite(lease_expires_at))
      OR (status <> 'delivering' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)))
  ),
  ADD CONSTRAINT uq_webhook_delivery_contract UNIQUE (project_id, id, contract_version),
  ADD CONSTRAINT fk_webhook_delivery_event_contract FOREIGN KEY (project_id, event_id, contract_version)
    REFERENCES webhook_events(project_id, id, schema_version) ON DELETE CASCADE,
  ADD CONSTRAINT fk_webhook_delivery_endpoint_contract FOREIGN KEY (project_id, endpoint_id, contract_version)
    REFERENCES webhook_endpoints(project_id, id, config_version) ON DELETE CASCADE;

CREATE INDEX idx_webhook_delivery_expired_lease ON webhook_deliveries (lease_expires_at, id)
  WHERE contract_version = 1 AND status = 'delivering';
CREATE INDEX idx_webhook_delivery_due ON webhook_deliveries (next_attempt_at, id)
  WHERE contract_version = 1 AND status IN ('pending','retrying');

ALTER TABLE webhook_delivery_attempts
  ADD COLUMN project_id UUID NULL,
  ADD COLUMN contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN fencing_token UUID NULL;
-- Backfill only the new ownership column using the already-enforced delivery FK.
-- Original IDs, payloads, ciphertext, statuses, timestamps, and errors are untouched.
UPDATE webhook_delivery_attempts a SET project_id = d.project_id
  FROM webhook_deliveries d WHERE a.delivery_id = d.id;
ALTER TABLE webhook_delivery_attempts
  ALTER COLUMN project_id SET NOT NULL,
  ADD CONSTRAINT chk_webhook_attempt_contract CHECK (
    (contract_version = 0 AND fencing_token IS NULL)
    OR (contract_version = 1 AND fencing_token IS NOT NULL AND attempt_number <= 8)
  ),
  ADD CONSTRAINT fk_webhook_attempt_project_delivery FOREIGN KEY (project_id, delivery_id, contract_version)
    REFERENCES webhook_deliveries(project_id, id, contract_version) ON DELETE CASCADE;

ALTER TABLE outbox_events
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT chk_outbox_available_at CHECK (isfinite(available_at));
CREATE INDEX idx_outbox_available ON outbox_events (available_at, created_at, id) WHERE published_at IS NULL;

COMMENT ON COLUMN webhook_endpoints.config_version IS '0: preserved legacy, never dispatch; 1: explicit subscriptions/key metadata. Future management must validate HTTPS:443, hostname allowlist, and AES-256-GCM ciphertext.';
COMMENT ON COLUMN webhook_endpoints.active_slot IS 'Slots 1..5 enforce at most five dispatchable active endpoints per project; legacy rows are not adopted automatically.';
COMMENT ON COLUMN webhook_events.payload_bytes IS 'Immutable UTF-8 JSONB text materialized once on INSERT; future HMAC-SHA256 signing uses these exact persisted bytes with an attempt timestamp.';
COMMENT ON COLUMN outbox_events.available_at IS 'Future typed routing must honor this timestamp. Current media publisher is unchanged; do not generate webhook dispatch rows until routing is implemented.';

-- Down Migration
DO $$ BEGIN
  RAISE EXCEPTION 'Migration 003 is forward-only: use a reviewed forward migration to preserve webhook history and signing metadata';
END $$;
