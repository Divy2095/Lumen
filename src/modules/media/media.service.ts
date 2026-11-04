import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { generateUploadToken, hashSha256 } from '../../shared/crypto.js';
import { getStorageConfig } from '../../config/storage.js';
import {
  type RegisterMediaInput,
  type RegisterMediaResponse,
  type MediaAssetPublic,
  type ClaimUploadResult,
  type ThumbnailInfo,
  InvalidStateTransitionError,
} from './media.types.js';

export class MediaService {
  constructor(private db: Pool) {}

  /**
   * Registers a new media asset upload intent and generates a single-use upload token.
   */
  async registerMedia(
    projectId: string,
    input: RegisterMediaInput
  ): Promise<RegisterMediaResponse> {
    const assetId = uuidv7();
    const config = getStorageConfig();
    const { token: uploadToken, hash: uploadTokenHash } = generateUploadToken();

    // Logical opaque storage key
    const storageKey = `media/${projectId}/${assetId}/original.mp4`;

    const expiresAt = new Date(Date.now() + config.uploadTokenTtlSeconds * 1000);

    const query = `
      INSERT INTO media_assets (
        id,
        project_id,
        original_filename,
        mime_type,
        file_size_bytes,
        uploaded_bytes,
        upload_token_hash,
        upload_token_expires_at,
        storage_key,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, 'uploading', NOW(), NOW())
      RETURNING id, project_id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes, created_at;
    `;

    const result = await this.db.query<{
      id: string;
      project_id: string;
      status: string;
      original_filename: string;
      mime_type: string;
      file_size_bytes: string;
      uploaded_bytes: string;
      created_at: Date;
    }>(query, [
      assetId,
      projectId,
      input.original_filename,
      input.mime_type,
      input.file_size_bytes,
      uploadTokenHash,
      expiresAt.toISOString(),
      storageKey,
    ]);

    const row = result.rows[0]!;

    return {
      id: row.id,
      project_id: row.project_id,
      status: row.status,
      original_filename: row.original_filename,
      mime_type: row.mime_type,
      file_size_bytes: Number(row.file_size_bytes),
      uploaded_bytes: Number(row.uploaded_bytes),
      upload_token: uploadToken,
      upload_url: `/v1/media/${row.id}/upload`,
      upload_expires_at: expiresAt.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  }

  /**
   * Preflight validation before consuming the token.
   * Ensures invalid tokens receive 401 without leaking asset existence or state.
   * Differentiates consumed tokens from invalid tokens.
   */
  async findAssetForUploadPreflight(
    assetId: string,
    rawUploadToken: string
  ): Promise<ClaimUploadResult> {
    const tokenHash = hashSha256(rawUploadToken);

    const query = `
      SELECT
        id,
        project_id,
        file_size_bytes,
        storage_key,
        status,
        upload_token_hash,
        upload_token_expires_at,
        metadata->>'consumed_token_hash' AS consumed_token_hash
      FROM media_assets
      WHERE id = $1;
    `;

    const result = await this.db.query<{
      id: string;
      project_id: string;
      file_size_bytes: string;
      storage_key: string;
      status: string;
      upload_token_hash: string | null;
      upload_token_expires_at: Date | null;
      consumed_token_hash: string | null;
    }>(query, [assetId]);

    const row = result.rows[0];
    if (!row) {
      // Do not leak whether asset exists to callers with invalid tokens
      return { claimed: false, reason: 'invalid_token' };
    }

    // Check active token match
    if (row.upload_token_hash && row.upload_token_hash === tokenHash) {
      if (row.upload_token_expires_at && row.upload_token_expires_at.getTime() <= Date.now()) {
        return { claimed: false, reason: 'expired' };
      }

      if (row.status !== 'uploading') {
        return { claimed: false, reason: 'in_progress_or_consumed' };
      }

      return {
        claimed: true,
        asset: {
          id: row.id,
          projectId: row.project_id,
          fileSizeBytes: Number(row.file_size_bytes),
          storageKey: row.storage_key,
        },
      };
    }

    // Check if this token was previously consumed for this asset
    if (row.consumed_token_hash && row.consumed_token_hash === tokenHash) {
      if (row.status === 'ready') {
        return { claimed: false, reason: 'already_uploaded' };
      }
      return { claimed: false, reason: 'in_progress_or_consumed' };
    }

    // Credential does not match active or consumed token for this asset
    return { claimed: false, reason: 'invalid_token' };
  }

  /**
   * Atomically claims an asset for upload and records the consumed token hash in metadata.
   */
  async claimUploadToken(
    assetId: string,
    rawUploadToken: string
  ): Promise<ClaimUploadResult> {
    const tokenHash = hashSha256(rawUploadToken);

    // Atomically consume token and persist hash in metadata for replay detection
    const query = `
      UPDATE media_assets
      SET upload_token_hash = NULL,
          upload_token_expires_at = NULL,
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{consumed_token_hash}', to_jsonb($2::text)),
          updated_at = NOW()
      WHERE id = $1
        AND upload_token_hash = $2
        AND upload_token_expires_at > NOW()
        AND status = 'uploading'
      RETURNING id, project_id, file_size_bytes, storage_key;
    `;

    const result = await this.db.query<{
      id: string;
      project_id: string;
      file_size_bytes: string;
      storage_key: string;
    }>(query, [assetId, tokenHash]);

    if (result.rows.length > 0) {
      const row = result.rows[0]!;
      return {
        claimed: true,
        asset: {
          id: row.id,
          projectId: row.project_id,
          fileSizeBytes: Number(row.file_size_bytes),
          storageKey: row.storage_key,
        },
      };
    }

    // Determine reason for failure
    return this.inspectClaimFailure(assetId, tokenHash);
  }

  private async inspectClaimFailure(assetId: string, tokenHash: string): Promise<ClaimUploadResult> {
    const checkQuery = `
      SELECT status, upload_token_expires_at, metadata->>'consumed_token_hash' AS consumed_token_hash
      FROM media_assets
      WHERE id = $1;
    `;
    const checkResult = await this.db.query<{
      status: string;
      upload_token_expires_at: Date | null;
      consumed_token_hash: string | null;
    }>(checkQuery, [assetId]);

    const row = checkResult.rows[0];
    if (!row) {
      return { claimed: false, reason: 'invalid_token' };
    }

    if (row.consumed_token_hash === tokenHash) {
      if (row.status === 'ready') {
        return { claimed: false, reason: 'already_uploaded' };
      }
      return { claimed: false, reason: 'in_progress_or_consumed' };
    }

    if (row.upload_token_expires_at && row.upload_token_expires_at.getTime() <= Date.now()) {
      return { claimed: false, reason: 'expired' };
    }

    return { claimed: false, reason: 'in_progress_or_consumed' };
  }

  /**
   * Finalizes successful upload of media asset atomically in a single PostgreSQL transaction.
   *
   * 1. Strictly enforces state transition: uploading -> ready.
   * 2. Creates the required background processing job records (extract_metadata, generate_thumbnail).
   * 3. Inserts corresponding transactional outbox event records for reliable queue dispatch.
   *
   * If any step fails, the entire transaction rolls back cleanly.
   */
  async finalizeUpload(assetId: string, uploadedBytes: number): Promise<MediaAssetPublic> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // 1. Transition media asset from 'uploading' to 'ready'
      const updateAssetQuery = `
        UPDATE media_assets
        SET status = 'ready',
            uploaded_bytes = $2,
            upload_token_hash = NULL,
            upload_token_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'uploading'
        RETURNING id, project_id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes, created_at, updated_at;
      `;

      const assetResult = await client.query<{
        id: string;
        project_id: string;
        status: string;
        original_filename: string;
        mime_type: string;
        file_size_bytes: string;
        uploaded_bytes: string;
        created_at: Date;
        updated_at: Date;
      }>(updateAssetQuery, [assetId, uploadedBytes]);

      if (assetResult.rowCount === 0) {
        throw new InvalidStateTransitionError(
          `Cannot finalize asset "${assetId}": asset is not in "uploading" status`
        );
      }

      const assetRow = assetResult.rows[0]!;

      // 2. Define processing jobs to create for the ingested video
      const initialJobs = [
        {
          id: uuidv7(),
          operation: 'extract_metadata',
          parameters: {},
        },
        {
          id: uuidv7(),
          operation: 'generate_thumbnail',
          parameters: { offset_seconds: 1.0 },
        },
      ];

      // 3. Insert processing job records
      const insertJobQuery = `
        INSERT INTO processing_jobs (
          id,
          project_id,
          media_asset_id,
          operation,
          parameters,
          status,
          current_attempt_number,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, 'queued', 0, NOW());
      `;

      // 4. Insert corresponding outbox event records
      const insertOutboxQuery = `
        INSERT INTO outbox_events (
          id,
          aggregate_type,
          aggregate_id,
          event_type,
          payload,
          created_at
        )
        VALUES ($1, 'processing_job', $2, 'processing_job.created', $3, NOW());
      `;

      for (const job of initialJobs) {
        await client.query(insertJobQuery, [
          job.id,
          assetRow.project_id,
          assetRow.id,
          job.operation,
          JSON.stringify(job.parameters),
        ]);

        const outboxEventId = uuidv7();
        const payload = {
          jobId: job.id,
          projectId: assetRow.project_id,
          mediaAssetId: assetRow.id,
          operation: job.operation,
          parameters: job.parameters,
        };

        await client.query(insertOutboxQuery, [
          outboxEventId,
          job.id,
          JSON.stringify(payload),
        ]);
      }

      await client.query('COMMIT');

      return {
        id: assetRow.id,
        project_id: assetRow.project_id,
        status: assetRow.status,
        original_filename: assetRow.original_filename,
        mime_type: assetRow.mime_type,
        file_size_bytes: Number(assetRow.file_size_bytes),
        uploaded_bytes: Number(assetRow.uploaded_bytes),
        created_at: assetRow.created_at.toISOString(),
        updated_at: assetRow.updated_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Checks current asset status in PostgreSQL.
   */
  async checkAssetStatus(assetId: string): Promise<string | null> {
    const result = await this.db.query<{ status: string }>(
      `SELECT status FROM media_assets WHERE id = $1;`,
      [assetId]
    );
    return result.rows[0]?.status ?? null;
  }

  /**
   * Checks whether an asset is currently in an active 'uploading' state.
   * Used during startup cleanup to guarantee active upload temp files are never deleted.
   */
  async isAssetActivelyUploading(assetId: string): Promise<boolean> {
    try {
      const query = `
        SELECT 1
        FROM media_assets
        WHERE id = $1
          AND status = 'uploading'
          AND updated_at > NOW() - INTERVAL '2 hours';
      `;
      const result = await this.db.query(query, [assetId]);
      return result.rowCount !== null && result.rowCount > 0;
    } catch {
      // Conservative fallback: on DB error, assume active to prevent accidental deletion
      return true;
    }
  }

  /**
   * Marks media asset as terminal failed and destroys any token.
   */
  async markUploadFailed(assetId: string): Promise<void> {
    const query = `
      UPDATE media_assets
      SET status = 'failed',
          upload_token_hash = NULL,
          upload_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1 AND status = 'uploading';
    `;
    await this.db.query(query, [assetId]);
  }

  /**
   * Retrieves public media asset metadata for a project.
   */
  async getMediaAsset(projectId: string, assetId: string): Promise<MediaAssetPublic | null> {
    const query = `
      SELECT
        id,
        project_id,
        status,
        original_filename,
        mime_type,
        file_size_bytes,
        uploaded_bytes,
        created_at,
        updated_at
      FROM media_assets
      WHERE id = $1 AND project_id = $2;
    `;

    const result = await this.db.query<{
      id: string;
      project_id: string;
      status: string;
      original_filename: string;
      mime_type: string;
      file_size_bytes: string;
      uploaded_bytes: string;
      created_at: Date;
      updated_at: Date;
    }>(query, [assetId, projectId]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    // Query media_outputs for current thumbnail
    const thumbQuery = `
      SELECT id, mime_type, file_size_bytes, width, height, created_at
      FROM media_outputs
      WHERE media_asset_id = $1 AND output_type = 'thumbnail' AND is_current = true;
    `;
    const thumbResult = await this.db.query<{
      id: string;
      mime_type: string;
      file_size_bytes: string;
      width: number | null;
      height: number | null;
      created_at: Date;
    }>(thumbQuery, [assetId]);

    let thumbnail: ThumbnailInfo | undefined = undefined;

    if (thumbResult.rows.length > 0) {
      const tRow = thumbResult.rows[0]!;
      thumbnail = {
        status: 'ready',
        url: `/v1/media/${assetId}/thumbnail`,
        mime_type: tRow.mime_type,
        width: tRow.width,
        height: tRow.height,
        file_size_bytes: Number(tRow.file_size_bytes),
        created_at: tRow.created_at.toISOString(),
      };
    } else {
      // Check if a thumbnail job is queued/processing or failed
      const jobQuery = `
        SELECT status
        FROM processing_jobs
        WHERE media_asset_id = $1 AND operation = 'generate_thumbnail'
        ORDER BY created_at DESC
        LIMIT 1;
      `;
      const jobResult = await this.db.query<{ status: string }>(jobQuery, [assetId]);
      if (jobResult.rows.length > 0) {
        const jStatus = jobResult.rows[0]!.status;
        if (jStatus === 'queued' || jStatus === 'processing') {
          thumbnail = { status: 'processing' };
        } else if (jStatus === 'failed') {
          thumbnail = { status: 'failed' };
        }
      }
    }

    const publicAsset: MediaAssetPublic = {
      id: row.id,
      project_id: row.project_id,
      status: row.status,
      original_filename: row.original_filename,
      mime_type: row.mime_type,
      file_size_bytes: Number(row.file_size_bytes),
      uploaded_bytes: Number(row.uploaded_bytes),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };

    if (thumbnail !== undefined) {
      publicAsset.thumbnail = thumbnail;
    }

    return publicAsset;
  }

  /**
   * Retrieves current thumbnail storage key and metadata for an authorized media asset.
   */
  async getThumbnail(projectId: string, assetId: string): Promise<{
    storageKey: string;
    mimeType: string;
    fileSizeBytes: number;
  } | null> {
    const query = `
      SELECT mo.storage_key, mo.mime_type, mo.file_size_bytes
      FROM media_outputs mo
      JOIN media_assets ma ON ma.id = mo.media_asset_id
      WHERE mo.media_asset_id = $1
        AND ma.project_id = $2
        AND mo.output_type = 'thumbnail'
        AND mo.is_current = true;
    `;
    const result = await this.db.query<{
      storage_key: string;
      mime_type: string;
      file_size_bytes: string;
    }>(query, [assetId, projectId]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      fileSizeBytes: Number(row.file_size_bytes),
    };
  }
}
