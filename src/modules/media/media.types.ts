import type {
  TranscodingConfig,
  SkippedProfile,
  TranscodingProfileName,
} from './transcoding-profiles.js';

export interface RegisterMediaInput {
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  transcoding?: TranscodingConfig | undefined;
}

export interface RegisterMediaResponse {
  id: string;
  project_id: string;
  status: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  uploaded_bytes: number;
  upload_token: string;
  upload_url: string;
  upload_expires_at: string;
  created_at: string;
  transcoding_config?: TranscodingConfig | null | undefined;
}

export interface ThumbnailInfo {
  status: 'ready' | 'processing' | 'failed' | 'not_found';
  url?: string | undefined;
  mime_type?: string | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  file_size_bytes?: number | undefined;
  created_at?: string | undefined;
}

export interface TranscodingRenditionInfo {
  profile: TranscodingProfileName;
  status: string;
  target_width?: number | undefined;
  target_height?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  file_size_bytes?: number | undefined;
  mime_type?: string | undefined;
  version?: number | undefined;
  completed_at?: string | undefined;
  url?: string | undefined;
  job_id?: string | undefined;
}

export interface TranscodingStatusInfo {
  mode?: string | undefined;
  skipped: SkippedProfile[];
  renditions: TranscodingRenditionInfo[];
}

export interface MediaAssetPublic {
  id: string;
  project_id: string;
  status: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  uploaded_bytes: number;
  created_at: string;
  updated_at: string;
  thumbnail?: ThumbnailInfo | undefined;
  transcoding_config?: TranscodingConfig | null | undefined;
  transcoding?: TranscodingStatusInfo | undefined;
  skipped_profiles?: SkippedProfile[] | undefined;
}

export interface ClaimUploadResult {
  claimed: boolean;
  reason?: 'invalid_token' | 'expired' | 'already_uploaded' | 'in_progress_or_consumed';
  asset?: {
    id: string;
    projectId: string;
    fileSizeBytes: number;
    storageKey: string;
  };
}

export interface RenditionDeliveryResult {
  status: 'ready' | 'processing' | 'failed' | 'not_found' | 'asset_not_found' | 'invalid_profile';
  storageKey?: string | undefined;
  mimeType?: string | undefined;
  fileSizeBytes?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  version?: number | undefined;
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}
