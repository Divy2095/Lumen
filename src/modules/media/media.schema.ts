import { getStorageConfig } from '../../config/storage.js';

export function registrationBodySchema() {
  return {
    type: 'object',
    required: ['original_filename', 'mime_type', 'file_size_bytes'],
    additionalProperties: false,
    properties: {
      original_filename: { type: 'string', minLength: 1, maxLength: 255 },
      mime_type: { type: 'string', enum: ['video/mp4'] },
      file_size_bytes: { type: 'integer', minimum: 1, maximum: getStorageConfig().maxUploadSizeBytes },
      transcoding: { type: 'object', additionalProperties: true },
    },
  };
}
