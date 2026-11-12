-- Up Migration
ALTER TABLE media_assets
  ADD COLUMN transcoding_config JSONB NULL;

COMMENT ON COLUMN media_assets.transcoding_config IS 'Original client transcoding configuration ({ enabled?: boolean, profiles?: string[] })';

-- Down Migration
ALTER TABLE media_assets
  DROP COLUMN IF EXISTS transcoding_config;
