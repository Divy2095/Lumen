export interface RegisterMediaInput {
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
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

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}
