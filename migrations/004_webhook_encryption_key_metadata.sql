-- Up Migration

-- NULL IDs preserve historical ciphertext without guessing which AES key was used.
ALTER TABLE webhook_endpoints
  ADD COLUMN encryption_key_id VARCHAR(64) NULL,
  ADD COLUMN previous_encryption_key_id VARCHAR(64) NULL,
  ADD CONSTRAINT chk_webhook_encryption_metadata CHECK (
    (encryption_key_id IS NULL AND previous_encryption_key_id IS NULL)
    OR (config_version = 1 AND encryption_key_id IS NOT NULL
      AND encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      AND ((previous_signing_key_id IS NULL AND previous_encryption_key_id IS NULL)
        OR (previous_signing_key_id IS NOT NULL AND previous_encryption_key_id IS NOT NULL
          AND previous_encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')))
  );

CREATE FUNCTION webhook_endpoint_management_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.config_version = 1 AND (NEW.url IS DISTINCT FROM OLD.url OR NEW.config_version <> 1) THEN
      RAISE EXCEPTION 'Webhook destination is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  END IF;
  IF NEW.config_version = 1 AND NEW.encryption_key_id IS NULL THEN
    RAISE EXCEPTION 'Managed webhook endpoints require encryption-key metadata' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_webhook_endpoint_management BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoint_management_guard();

COMMENT ON COLUMN webhook_endpoints.encryption_key_id IS 'External AES key identifier, never key material. NULL historical rows are ineligible for management/delivery. New or changed version-1 rows require complete metadata.';
COMMENT ON COLUMN webhook_endpoints.previous_encryption_key_id IS 'External AES key for the previous signing secret; retain referenced external keys. Never infer an ID for historical ciphertext.';

-- Down Migration
DO $$ BEGIN
  RAISE EXCEPTION 'Migration 004 is forward-only: preserve encryption-key identifiers with a reviewed forward migration';
END $$;
