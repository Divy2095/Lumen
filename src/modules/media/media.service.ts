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
  type TranscodingStatusInfo,
  type TranscodingRenditionInfo,
  type RenditionDeliveryResult,
  InvalidStateTransitionError,
} from './media.types.js';
import {
  validateTranscodingConfig,
  InvalidTranscodingConfigError,
  type TranscodingConfig,
  type SkippedProfile,
  type TranscodingProfileName,
} from './transcoding-profiles.js';

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
    const expiresAt = new Date(Date.now() + config.uploadTokenTtlSeconds * 1000);
    const storageKey = `media/${projectId}/${assetId}/original.mp4`;

    // Validate transcoding configuration if supplied
    let transcodingConfig: TranscodingConfig | null = null;
    if (input.transcoding !== undefined) {
      const validation = validateTranscodingConfig(input.transcoding);
      if (!validation.valid) {
        throw new InvalidTranscodingConfigError(validation.error!);
      }
      transcodingConfig = validation.config ?? null;
    }

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
        transcoding_config,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, 'uploading', NOW(), NOW())
      RETURNING id, project_id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes, transcoding_config, created_at;
    `;

    const result = await this.db.query<{
      id: string;
      project_id: string;
      status: string;
      original_filename: string;
      mime_type: string;
      file_size_bytes: string;
      uploaded_bytes: string;
      transcoding_config: TranscodingConfig | null;
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
      transcodingConfig ? JSON.stringify(transcodingConfig) : null,
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
      transcoding_config: row.transcoding_config ?? undefined,
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
    if (row.upload_token_hash === tokenHash) {
      if (row.upload_token_expires_at && row.upload_token_expires_at.getTime() <= Date.now()) {
        return { claimed: false, reason: 'expired' };
      }
      if (row.status !== 'uploading') {
        return {
          claimed: false,
          reason: row.status === 'ready' ? 'already_uploaded' : 'in_progress_or_consumed',
        };
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

    // Check if token was already consumed
    if (row.consumed_token_hash === tokenHash) {
      return {
        claimed: false,
        reason: row.status === 'ready' ? 'already_uploaded' : 'in_progress_or_consumed',
      };
    }

    // Neither matches: invalid token
    return { claimed: false, reason: 'invalid_token' };
  }

  /**
   * Atomically claims an upload token.
   * Invalidates upload_token_hash and records consumed_token_hash in metadata.
   * Returns false with specific reason if the token is invalid, expired, or already consumed.
   */
  async claimUploadToken(assetId: string, rawUploadToken: string): Promise<ClaimUploadResult> {
    const tokenHash = hashSha256(rawUploadToken);

    const query = `
      UPDATE media_assets
      SET
        upload_token_hash = NULL,
        upload_token_expires_at = NULL,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{consumed_token_hash}',
          to_jsonb($2::text)
        ),
        updated_at = NOW()
      WHERE
        id = $1
        AND status = 'uploading'
        AND upload_token_hash = $2
        AND (upload_token_expires_at IS NULL OR upload_token_expires_at > NOW())
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

    // Determine why claim failed
    return this.inspectClaimFailure(assetId, tokenHash);
  }

  private async inspectClaimFailure(assetId: string, tokenHash: string): Promise<ClaimUploadResult> {
    const inspectQuery = `
      SELECT
        id,
        status,
        upload_token_hash,
        upload_token_expires_at,
        metadata->>'consumed_token_hash' AS consumed_token_hash
      FROM media_assets
      WHERE id = $1;
    `;

    const result = await this.db.query<{
      id: string;
      status: string;
      upload_token_hash: string | null;
      upload_token_expires_at: Date | null;
      consumed_token_hash: string | null;
    }>(inspectQuery, [assetId]);

    const row = result.rows[0];
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
        SET status = 'ready',\
            uploaded_bytes = $2,\
            upload_token_hash = NULL,\
            upload_token_expires_at = NULL,\
            updated_at = NOW()\
        WHERE id = $1 AND status = 'uploading'
        RETURNING id, project_id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes, transcoding_config, created_at, updated_at;
      `;

      const assetResult = await client.query<{
        id: string;
        project_id: string;
        status: string;
        original_filename: string;
        mime_type: string;
        file_size_bytes: string;
        uploaded_bytes: string;
        transcoding_config: TranscodingConfig | null;
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

      const publicAsset: MediaAssetPublic = {
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

      if (assetRow.transcoding_config !== null && assetRow.transcoding_config !== undefined) {
        publicAsset.transcoding_config = assetRow.transcoding_config;
      }

      return publicAsset;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Checks current asset status.
   */
  async checkAssetStatus(assetId: string): Promise<string | null> {
    const query = `
      SELECT status
      FROM media_assets
      WHERE id = $1;
    `;
    const result = await this.db.query<{ status: string }>(query, [assetId]);
    return result.rows[0]?.status ?? null;
  }

  /**
   * Checks whether an asset is actively in 'uploading' status.
   */
  async isAssetActivelyUploading(assetId: string): Promise<boolean> {
    const query = `
      SELECT 1
      FROM media_assets
      WHERE id = $1
        AND status = 'uploading';
    `;
    const result = await this.db.query(query, [assetId]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Transitions an asset from 'uploading' to 'failed' on unrecoverable stream error.
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
        transcoding_config,
        metadata,
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
      transcoding_config: TranscodingConfig | null;
      metadata: Record<string, any> | null;
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

    // Query processing_jobs for transcode operations
    const transcodeJobsQuery = `
      SELECT id, status, parameters, completed_at
      FROM processing_jobs
      WHERE media_asset_id = $1 AND operation = 'transcode'
      ORDER BY created_at ASC;
    `;
    const transcodeJobsResult = await this.db.query<{
      id: string;
      status: string;
      parameters: any;
      completed_at: Date | null;
    }>(transcodeJobsQuery, [assetId]);

    // Query current rendition outputs from media_outputs
    const currentOutputsRes = await this.db.query<{
      logical_key: string;
      version: number;
      storage_key: string;
      mime_type: string;
      file_size_bytes: string;
      width: number | null;
      height: number | null;
      created_at: Date;
    }>(
      `SELECT logical_key, version, storage_key, mime_type, file_size_bytes, width, height, created_at
       FROM media_outputs
       WHERE media_asset_id = $1 AND output_type = 'rendition' AND is_current = true;`,
      [assetId]
    );

    const currentOutputsMap = new Map(
      currentOutputsRes.rows.map((r) => [r.logical_key, r])
    );

    const meta = row.metadata;
    const transcodeMeta = meta?.transcoding;
    const skippedProfiles = (transcodeMeta?.skipped ?? meta?.skipped_profiles) as SkippedProfile[] | undefined;

    let transcoding: TranscodingStatusInfo | undefined = undefined;

    if (transcodeJobsResult.rows.length > 0 || (skippedProfiles && skippedProfiles.length > 0) || transcodeMeta) {
      const renditions: TranscodingRenditionInfo[] = transcodeJobsResult.rows.map((r) => {
        const params = typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters;
        const profile = params?.profile as TranscodingProfileName;
        const matchingOutput = currentOutputsMap.get(`rendition_${profile}`);

        const rendition: TranscodingRenditionInfo = {
          profile,
          status: r.status,
          target_width: params?.targetWidth,
          target_height: params?.targetHeight,
          job_id: r.id,
        };

        if (matchingOutput && r.status === 'completed') {
          rendition.width = matchingOutput.width ?? undefined;
          rendition.height = matchingOutput.height ?? undefined;
          rendition.file_size_bytes = Number(matchingOutput.file_size_bytes);
          rendition.mime_type = matchingOutput.mime_type;
          rendition.version = matchingOutput.version;
          rendition.completed_at = r.completed_at
            ? r.completed_at.toISOString()
            : matchingOutput.created_at.toISOString();
          rendition.url = `/v1/media/${assetId}/renditions/${profile}`;
        }

        return rendition;
      });

      transcoding = {
        mode: transcodeMeta?.mode,
        skipped: skippedProfiles ?? [],
        renditions,
      };
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

    if (row.transcoding_config !== null && row.transcoding_config !== undefined) {
      publicAsset.transcoding_config = row.transcoding_config;
    }

    if (thumbnail !== undefined) {
      publicAsset.thumbnail = thumbnail;
    }

    if (transcoding !== undefined) {
      publicAsset.transcoding = transcoding;
    }

    if (skippedProfiles && skippedProfiles.length > 0) {
      publicAsset.skipped_profiles = skippedProfiles;
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

  /**
   * Retrieves current rendition delivery info and metadata for an authorized media asset.
   */
  async getRendition(
    projectId: string,
    assetId: string,
    profile: string
  ): Promise<RenditionDeliveryResult> {
    const validProfiles = ['360p', '480p', '720p', '1080p'];
    if (!validProfiles.includes(profile)) {
      return { status: 'invalid_profile' };
    }

    // Verify media asset exists and belongs to project
    const assetRes = await this.db.query<{ id: string }>(
      `SELECT id FROM media_assets WHERE id = $1 AND project_id = $2;`,
      [assetId, projectId]
    );
    if (!assetRes.rows[0]) {
      return { status: 'asset_not_found' };
    }

    const logicalKey = `rendition_${profile}`;

    // Query current output and transcode job status
    const outputQuery = `
      SELECT
        mo.storage_key,
        mo.mime_type,
        mo.file_size_bytes,
        mo.width,
        mo.height,
        mo.version,
        pj.status AS job_status
      FROM processing_jobs pj
      LEFT JOIN media_outputs mo ON mo.media_asset_id = pj.media_asset_id
                                 AND mo.logical_key = $2
                                 AND mo.is_current = true
      WHERE pj.media_asset_id = $1
        AND pj.operation = 'transcode'
        AND pj.parameters->>'profile' = $3
      ORDER BY pj.created_at DESC
      LIMIT 1;
    `;

    const result = await this.db.query<{
      storage_key: string | null;
      mime_type: string | null;
      file_size_bytes: string | null;
      width: number | null;
      height: number | null;
      version: number | null;
      job_status: string;
    }>(outputQuery, [assetId, logicalKey, profile]);

    const row = result.rows[0];
    if (!row) {
      return { status: 'not_found' };
    }

    if (row.storage_key && row.file_size_bytes) {
      return {
        status: 'ready',
        storageKey: row.storage_key,
        mimeType: row.mime_type ?? 'video/mp4',
        fileSizeBytes: Number(row.file_size_bytes),
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        version: row.version ?? undefined,
      };
    }

    if (row.job_status === 'queued' || row.job_status === 'processing') {
      return { status: 'processing' };
    }

    if (row.job_status === 'failed') {
      return { status: 'failed' };
    }

    return { status: 'not_found' };
  }
}
