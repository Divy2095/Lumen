import type { Pool } from 'pg';
import type { MediaService } from '../media/media.service.js';

export type ProcessingState = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export interface BrowserJobState {
  operation: 'extract_metadata' | 'generate_thumbnail' | 'transcode';
  status: ProcessingState;
}

interface BrowserAssetRow {
  id: string;
  status: 'uploading' | 'ready' | 'failed' | 'deleting' | 'deleted';
  original_filename: string;
  mime_type: string;
  file_size_bytes: string;
  uploaded_bytes: string;
  created_at: Date;
  updated_at: Date;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: string | null;
  frame_rate: string | null;
}

const numeric = (value: string | number | null) => value === null ? null : Number(value);

export class BrowserMediaService {
  constructor(private readonly db: Pick<Pool, 'query'>, private readonly media: Pick<MediaService, 'getThumbnail'>) {}

  async getStatus(projectId: string, assetId: string) {
    const assets = await this.db.query<BrowserAssetRow>(
      `SELECT id, status, original_filename, mime_type, file_size_bytes, uploaded_bytes,
              created_at, updated_at, duration_seconds, width, height, video_codec,
              audio_codec, bitrate, frame_rate
       FROM media_assets WHERE id = $1 AND project_id = $2`, [assetId, projectId]);
    const asset = assets.rows[0];
    if (!asset) return null;

    const jobs = await this.db.query<BrowserJobState>(
      `SELECT operation, status FROM processing_jobs
       WHERE media_asset_id = $1 AND project_id = $2 ORDER BY created_at, id`, [assetId, projectId]);
    const thumbnail = await this.media.getThumbnail(projectId, assetId);
    const thumbnailJob = jobs.rows.filter(job => job.operation === 'generate_thumbnail').at(-1);
    const thumbnailStatus = thumbnail ? 'ready' :
      thumbnailJob && thumbnailJob.status !== 'completed' ? thumbnailJob.status : 'not_found';

    return {
      id: asset.id,
      status: asset.status,
      original_filename: asset.original_filename,
      mime_type: asset.mime_type,
      file_size_bytes: Number(asset.file_size_bytes),
      uploaded_bytes: Number(asset.uploaded_bytes),
      created_at: asset.created_at.toISOString(),
      updated_at: asset.updated_at.toISOString(),
      technical: {
        duration_seconds: numeric(asset.duration_seconds),
        width: asset.width,
        height: asset.height,
        video_codec: asset.video_codec,
        audio_codec: asset.audio_codec,
        bitrate: numeric(asset.bitrate),
        frame_rate: numeric(asset.frame_rate),
      },
      thumbnail: thumbnail
        ? { status: thumbnailStatus, url: `/v1/browser/media/${asset.id}/thumbnail` }
        : { status: thumbnailStatus },
      processing: jobs.rows.map(job => ({ operation: job.operation, status: job.status })),
    };
  }
}
