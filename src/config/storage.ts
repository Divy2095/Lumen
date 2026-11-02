import { resolve } from 'node:path';

export interface StorageConfig {
  baseDir: string;
  tempDir: string;
  maxUploadSizeBytes: number;
  uploadTokenTtlSeconds: number;
  maxUploadDurationMs: number;
  uploadInactivityTimeoutMs: number;
}

export function getStorageConfig(): StorageConfig {
  const baseDir = resolve(process.env.STORAGE_BASE_DIR ?? 'storage');
  const tempDir = resolve(baseDir, '.tmp');
  const maxUploadSizeBytes = 100 * 1024 * 1024; // 100 MB MVP limit
  const uploadTokenTtlSeconds = 3600; // 1 hour token lifetime
  const maxUploadDurationMs = process.env.STORAGE_MAX_UPLOAD_DURATION_MS
    ? parseInt(process.env.STORAGE_MAX_UPLOAD_DURATION_MS, 10)
    : 15 * 60 * 1000; // 15 minutes default transfer time
  const uploadInactivityTimeoutMs = process.env.STORAGE_INACTIVITY_TIMEOUT_MS
    ? parseInt(process.env.STORAGE_INACTIVITY_TIMEOUT_MS, 10)
    : 30 * 1000; // 30 seconds default inactivity timeout

  return {
    baseDir,
    tempDir,
    maxUploadSizeBytes,
    uploadTokenTtlSeconds,
    maxUploadDurationMs,
    uploadInactivityTimeoutMs,
  };
}
