const text = { type: 'string' };
const number = { type: 'number' };
const nullableNumber = { type: ['number', 'null'] };
const nullableText = { type: ['string', 'null'] };
const base = {
  id: text,
  status: { type: 'string', enum: ['uploading', 'ready', 'failed', 'deleting', 'deleted'] },
  original_filename: text,
  mime_type: text,
  file_size_bytes: number,
  uploaded_bytes: number,
  created_at: text,
};
const jobStates = ['queued', 'processing', 'completed', 'failed', 'cancelled'];

export const browserErrorResponses = {
  '4xx': {
    type: 'object', additionalProperties: false, required: ['error', 'message'],
    properties: { error: text, message: text },
  },
  '5xx': {
    type: 'object', additionalProperties: false, required: ['error', 'message'],
    properties: { error: text, message: text },
  },
};

export const browserRegistrationResponse = {
  type: 'object', additionalProperties: false,
  required: [...Object.keys(base), 'upload_token', 'upload_url', 'upload_expires_at'],
  properties: { ...base, upload_token: text, upload_url: text, upload_expires_at: text },
};

export const browserStatusResponse = {
  type: 'object', additionalProperties: false,
  required: [...Object.keys(base), 'updated_at', 'technical', 'thumbnail', 'processing'],
  properties: {
    ...base, updated_at: text,
    technical: {
      type: 'object', additionalProperties: false,
      required: ['duration_seconds', 'width', 'height', 'video_codec', 'audio_codec', 'bitrate', 'frame_rate'],
      properties: {
        duration_seconds: nullableNumber, width: nullableNumber, height: nullableNumber,
        video_codec: nullableText, audio_codec: nullableText, bitrate: nullableNumber, frame_rate: nullableNumber,
      },
    },
    thumbnail: {
      type: 'object', additionalProperties: false, required: ['status'],
      properties: { status: { type: 'string', enum: ['ready', 'not_found', ...jobStates] }, url: text },
    },
    processing: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['operation', 'status'],
        properties: {
          operation: { type: 'string', enum: ['extract_metadata', 'generate_thumbnail', 'transcode'] },
          status: { type: 'string', enum: jobStates },
        },
      },
    },
  },
};

export const browserAssetParams = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } },
};
