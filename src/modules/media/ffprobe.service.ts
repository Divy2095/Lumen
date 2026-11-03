import { spawn } from 'node:child_process';

export interface FFprobeOptions {
  ffprobePath?: string | undefined;
  timeoutMs?: number | undefined;
  maxBufferBytes?: number | undefined;
}

export interface ExtractedMediaMetadata {
  containerFormat: string;
  durationSeconds: number;
  fileSizeBytes: number;
  bitrate: number | null;
  video: {
    codec: string;
    width: number;
    height: number;
    frameRate: number;
    pixelFormat: string;
    bitrate?: number | null | undefined;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    channelLayout?: string | undefined;
    bitrate?: number | null | undefined;
  } | undefined;
  rawMetadata?: Record<string, any> | undefined;
}

export class FFprobeError extends Error {
  constructor(message: string, public readonly code?: string | undefined) {
    super(message);
    this.name = 'FFprobeError';
  }
}

export class FFprobeTimeoutError extends FFprobeError {
  constructor(message = 'FFprobe process timed out') {
    super(message, 'TIMEOUT');
    this.name = 'FFprobeTimeoutError';
  }
}

export class FFprobeOutputLimitError extends FFprobeError {
  constructor(message = 'FFprobe output exceeded maximum buffer limit') {
    super(message, 'BUFFER_LIMIT_EXCEEDED');
    this.name = 'FFprobeOutputLimitError';
  }
}

export class InvalidMediaError extends FFprobeError {
  constructor(message: string) {
    super(message, 'INVALID_MEDIA');
    this.name = 'InvalidMediaError';
  }
}

/**
 * Parses fractional frame rate strings like "24/1" or "30000/1001" or decimal strings.
 */
export function parseFrameRate(rFrameRate?: string, avgFrameRate?: string): number {
  for (const rateStr of [rFrameRate, avgFrameRate]) {
    if (!rateStr || typeof rateStr !== 'string') continue;
    if (rateStr.includes('/')) {
      const parts = rateStr.split('/');
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (den && den > 0 && num && num > 0) {
        const val = num / den;
        if (Number.isFinite(val) && val > 0 && val <= 1000) {
          return Math.round(val * 100) / 100;
        }
      }
    } else {
      const val = parseFloat(rateStr);
      if (Number.isFinite(val) && val > 0 && val <= 1000) {
        return Math.round(val * 100) / 100;
      }
    }
  }
  return 0;
}

/**
 * Parses duration in seconds from container or video stream format.
 */
export function parseDuration(formatDuration?: string, streamDuration?: string): number {
  for (const durStr of [formatDuration, streamDuration]) {
    if (!durStr || typeof durStr !== 'string') continue;
    const val = parseFloat(durStr);
    if (Number.isFinite(val) && val > 0 && val <= 86400 * 7) {
      return Math.round(val * 1000) / 1000;
    }
  }
  throw new InvalidMediaError('Unable to determine valid media duration from container or video stream');
}

export class FFprobeService {
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;

  constructor(options: FFprobeOptions = {}) {
    this.ffprobePath = options.ffprobePath ?? (process.env.FFPROBE_PATH || 'ffprobe');
    this.timeoutMs = options.timeoutMs ?? (process.env.FFPROBE_TIMEOUT_MS ? parseInt(process.env.FFPROBE_TIMEOUT_MS, 10) : 10000);
    this.maxBufferBytes = options.maxBufferBytes ?? (process.env.FFPROBE_MAX_BUFFER_BYTES ? parseInt(process.env.FFPROBE_MAX_BUFFER_BYTES, 10) : 1024 * 1024);
  }

  /**
   * Probes an MP4 media file on disk using FFprobe with fixed argument arrays.
   * Extracts container and stream metadata without loading media into memory.
   */
  async probe(filePath: string): Promise<ExtractedMediaMetadata> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('FFprobeService: valid filePath is required');
    }

    const stdoutText = await this.executeFFprobe(filePath);
    return this.parseMetadata(stdoutText, filePath);
  }

  private executeFFprobe(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Fixed argument array - never uses shell interpolation
      const args = [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        filePath,
      ];

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(this.ffprobePath, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        return reject(new FFprobeError(`Failed to spawn FFprobe process: ${err?.message}`, err?.code));
      }

      let stdoutAccumulator = '';
      let stderrAccumulator = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let isTimedOut = false;
      let isOutputExceeded = false;
      let isSettled = false;

      const timer = setTimeout(() => {
        isTimedOut = true;
        proc.kill('SIGKILL');
      }, this.timeoutMs);
      timer.unref();

      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > this.maxBufferBytes) {
            isOutputExceeded = true;
            proc.kill('SIGKILL');
            return;
          }
          stdoutAccumulator += chunk.toString('utf8');
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          // Bound stderr capture to 64 KB
          if (stderrBytes <= 65536) {
            stderrAccumulator += chunk.toString('utf8');
          }
        });
      }

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new FFprobeError(`FFprobe executable not found at "${this.ffprobePath}"`, 'ENOENT'));
        } else {
          reject(new FFprobeError(`FFprobe process execution error: ${err.message}`, err.code));
        }
      });

      proc.on('close', (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);

        if (isTimedOut) {
          return reject(new FFprobeTimeoutError(`FFprobe process exceeded execution timeout of ${this.timeoutMs}ms`));
        }

        if (isOutputExceeded) {
          return reject(new FFprobeOutputLimitError(`FFprobe output exceeded maximum buffer limit of ${this.maxBufferBytes} bytes`));
        }

        if (code !== 0) {
          // Sanitize stderr to strip internal file paths
          const sanitizedStderr = stderrAccumulator
            .replace(new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[media-file]')
            .trim();

          return reject(
            new InvalidMediaError(
              `FFprobe inspection failed (exit code ${code}): ${sanitizedStderr || 'Invalid media input or corrupt container'}`
            )
          );
        }

        resolve(stdoutAccumulator);
      });
    });
  }

  /**
   * Validates and parses raw JSON output from FFprobe.
   */
  parseMetadata(stdoutJson: string, _filePath?: string): ExtractedMediaMetadata {
    let parsed: any;
    try {
      parsed = JSON.parse(stdoutJson);
    } catch {
      throw new InvalidMediaError('Malformed FFprobe output: output is not valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.format || !Array.isArray(parsed.streams)) {
      throw new InvalidMediaError('Malformed FFprobe JSON structure: missing format or streams array');
    }

    // 1. Validate video stream presence
    const videoStreams = parsed.streams.filter((s: any) => s && s.codec_type === 'video');
    if (videoStreams.length === 0) {
      throw new InvalidMediaError('Media validation failed: media file contains no video stream');
    }

    const videoStream = videoStreams[0];

    // 2. Validate video dimensions
    const width = Number(videoStream.width);
    const height = Number(videoStream.height);
    if (!Number.isInteger(width) || width <= 0 || width > 16384) {
      throw new InvalidMediaError(`Invalid video width: ${videoStream.width}`);
    }
    if (!Number.isInteger(height) || height <= 0 || height > 16384) {
      throw new InvalidMediaError(`Invalid video height: ${videoStream.height}`);
    }

    // 3. Validate video codec
    if (!videoStream.codec_name || typeof videoStream.codec_name !== 'string') {
      throw new InvalidMediaError('Missing or invalid video codec');
    }
    const videoCodec = videoStream.codec_name.slice(0, 50);

    // 4. Validate duration
    const durationSeconds = parseDuration(parsed.format.duration, videoStream.duration);

    // 5. Parse frame rate
    const frameRate = parseFrameRate(videoStream.r_frame_rate, videoStream.avg_frame_rate);

    // 6. Parse bitrate
    let bitrate: number | null = null;
    const rawBitrate = parsed.format.bit_rate ?? videoStream.bit_rate;
    if (rawBitrate) {
      const parsedBitrate = parseInt(String(rawBitrate), 10);
      if (Number.isFinite(parsedBitrate) && parsedBitrate > 0) {
        bitrate = parsedBitrate;
      }
    }

    // 7. Parse file size
    let fileSizeBytes = 0;
    if (parsed.format.size) {
      const parsedSize = parseInt(String(parsed.format.size), 10);
      if (Number.isFinite(parsedSize) && parsedSize > 0) {
        fileSizeBytes = parsedSize;
      }
    }

    // 8. Parse audio stream if present
    const audioStream = parsed.streams.find((s: any) => s && s.codec_type === 'audio');
    let audioMetadata: ExtractedMediaMetadata['audio'] = undefined;
    if (audioStream && audioStream.codec_name) {
      const sampleRate = audioStream.sample_rate ? parseInt(String(audioStream.sample_rate), 10) : 0;
      const channels = typeof audioStream.channels === 'number'
        ? audioStream.channels
        : (audioStream.channels ? parseInt(String(audioStream.channels), 10) : 0);
      const audioBitrate = audioStream.bit_rate ? parseInt(String(audioStream.bit_rate), 10) : null;

      audioMetadata = {
        codec: String(audioStream.codec_name).slice(0, 50),
        sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0,
        channels: Number.isFinite(channels) && channels > 0 ? channels : 0,
        channelLayout: audioStream.channel_layout ? String(audioStream.channel_layout).slice(0, 50) : undefined,
        bitrate: audioBitrate && Number.isFinite(audioBitrate) ? audioBitrate : null,
      };
    }

    const containerFormat = String(parsed.format.format_name || 'unknown').slice(0, 100);
    const pixelFormat = String(videoStream.pix_fmt || 'unknown').slice(0, 50);

    const rawMetadata: Record<string, any> = {
      format_name: containerFormat,
      pixel_format: pixelFormat,
      size_bytes: fileSizeBytes,
      video: {
        codec: videoCodec,
        profile: videoStream.profile ?? null,
        width,
        height,
        aspect_ratio: videoStream.display_aspect_ratio ?? null,
        pixel_format: pixelFormat,
        r_frame_rate: videoStream.r_frame_rate ?? null,
      },
      audio: audioMetadata ? {
        codec: audioMetadata.codec,
        sample_rate: audioMetadata.sampleRate,
        channels: audioMetadata.channels,
        channel_layout: audioMetadata.channelLayout ?? null,
      } : null,
      probed_at: new Date().toISOString(),
    };

    return {
      containerFormat,
      durationSeconds,
      fileSizeBytes,
      bitrate,
      video: {
        codec: videoCodec,
        width,
        height,
        frameRate,
        pixelFormat,
        bitrate: videoStream.bit_rate ? parseInt(String(videoStream.bit_rate), 10) : null,
      },
      audio: audioMetadata,
      rawMetadata,
    };
  }
}

export const defaultFFprobeService = new FFprobeService();
