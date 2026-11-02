import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { generateUploadToken, hashSha256 } from '../../shared/crypto.js';
import { getStorageConfig } from '../../config/storage.js';
import {
  type RegisterMediaInput,
  type RegisterMediaResponse,
  type MediaAssetPublic,
  type ClaimUploadResult,
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
   * Finalizes successful upload of media asset.
   * Strictly enforces state transition: uploading -> ready.
   * Throws InvalidStateTransitionError if the asset is not in 'uploading' status.
   */
  async finalizeUpload(assetId: string, uploadedBytes: number): Promise<MediaAssetPublic> {
    const query = `
      UPDATE media_assets
      SET status = 'ready',
          uploaded_bytes = $2,
          upload_token_hash = NULL,
          upload_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1 AND status = 'uploading'
      RETURNING id, project_id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes, created_at, updated_at;
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
    }>(query, [assetId, uploadedBytes]);

    if (result.rowCount === 0) {
      throw new InvalidStateTransitionError(
        `Cannot finalize asset "${assetId}": asset is not in "uploading" status`
      );
    }

    const row = result.rows[0]!;
    return {
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

    return {
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
  }
}
