import { spawn } from 'node:child_process';
import { stat, unlink, open } from 'node:fs/promises';

export interface FFmpegOptions {
  ffmpegPath?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface ThumbnailResult {
  outputFilePath: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  mimeType: 'image/jpeg';
  timestamp: number;
}

export class FFmpegError extends Error {
  constructor(message: string, public readonly code?: string | undefined) {
    super(message);
    this.name = 'FFmpegError';
  }
}

export class FFmpegTimeoutError extends FFmpegError {
  constructor(message = 'FFmpeg process timed out') {
    super(message, 'TIMEOUT');
    this.name = 'FFmpegTimeoutError';
  }
}

export class FFmpegOutputLimitError extends FFmpegError {
  constructor(message = 'FFmpeg output exceeded maximum file size limit') {
    super(message, 'OUTPUT_LIMIT_EXCEEDED');
    this.name = 'FFmpegOutputLimitError';
  }
}

export class InvalidMediaError extends FFmpegError {
  constructor(message: string) {
    super(message, 'INVALID_MEDIA');
    this.name = 'InvalidMediaError';
  }
}

/**
 * Calculates a representative thumbnail timestamp from trusted duration metadata.
 * Uses 10% of duration by default, with sensible fallbacks for very short videos.
 */
export function calculateThumbnailTimestamp(
  durationSeconds: number,
  requestedOffset?: number | undefined
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  // If a requested offset is provided and lies within [0, durationSeconds), validate it
  if (requestedOffset !== undefined && Number.isFinite(requestedOffset)) {
    if (requestedOffset >= 0 && requestedOffset < durationSeconds) {
      return Math.round(requestedOffset * 1000) / 1000;
    }
  }

  // Default: seek to ~10% of duration
  let target = durationSeconds * 0.1;
  if (target >= durationSeconds) {
    target = 0;
  }

  return Math.round(target * 1000) / 1000;
}

/**
 * Parses image width and height directly from a JPEG buffer header.
 * Validates magic bytes (0xFF, 0xD8) and SOF markers (SOF0, SOF1, SOF2).
 */
export function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null; // Not a valid JPEG
  }

  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // Baseline DCT (0xC0), Extended sequential (0xC1), Progressive DCT (0xC2)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }

    // Skip variable-length marker segment
    if (offset + 3 < buffer.length) {
      const length = buffer.readUInt16BE(offset + 2);
      offset += 2 + length;
    } else {
      break;
    }
  }

  return null;
}

export class FFmpegService {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;

  constructor(options: FFmpegOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? (process.env.FFMPEG_PATH || 'ffmpeg');
    this.timeoutMs =
      options.timeoutMs ??
      (process.env.FFMPEG_TIMEOUT_MS ? parseInt(process.env.FFMPEG_TIMEOUT_MS, 10) : 10000);
    this.maxOutputBytes =
      options.maxOutputBytes ??
      (process.env.FFMPEG_MAX_OUTPUT_BYTES ? parseInt(process.env.FFMPEG_MAX_OUTPUT_BYTES, 10) : 5 * 1024 * 1024);
  }

  /**
   * Extracts a representative thumbnail from an MP4 video file using FFmpeg.
   *
   * Operates with:
   * - spawn with shell: false and fixed argument array (no shell interpolation).
   * - Bounded execution timeout.
   * - Bounded stderr capture and path redaction.
   * - Scaling preserving aspect ratio, capped at 640x360.
   * - Validates output file size and JPEG structure without loading the original video into memory.
   */
  async extractThumbnail(
    inputFilePath: string,
    outputFilePath: string,
    seekSeconds: number
  ): Promise<ThumbnailResult> {
    if (!inputFilePath || typeof inputFilePath !== 'string') {
      throw new Error('FFmpegService: valid inputFilePath is required');
    }
    if (!outputFilePath || typeof outputFilePath !== 'string') {
      throw new Error('FFmpegService: valid outputFilePath is required');
    }

    const seekTime = Math.max(0, Number.isFinite(seekSeconds) ? seekSeconds : 0);

    try {
      await this.executeFFmpeg(inputFilePath, outputFilePath, seekTime);
      return await this.validateAndInspectThumbnail(outputFilePath, seekTime);
    } catch (err) {
      await unlink(outputFilePath).catch(() => {});
      throw err;
    }
  }

  private executeFFmpeg(
    inputFilePath: string,
    outputFilePath: string,
    seekSeconds: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Fixed argument array - never uses shell interpolation
      const args = [
        '-v',
        'error',
        '-ss',
        String(seekSeconds),
        '-i',
        inputFilePath,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(640,iw)':'min(360,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-f',
        'image2',
        '-vcodec',
        'mjpeg',
        '-update',
        '1',
        '-y',
        outputFilePath,
      ];

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(this.ffmpegPath, args, {
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err: any) {
        return reject(new FFmpegError(`Failed to spawn FFmpeg process: ${err?.message}`, err?.code));
      }

      let stderrAccumulator = '';
      let stderrBytes = 0;
      let isTimedOut = false;
      let isOutputExceeded = false;
      let isSettled = false;

      const timer = setTimeout(() => {
        isTimedOut = true;
        proc.kill('SIGKILL');
      }, this.timeoutMs);
      timer.unref();

      const sizeCheckInterval = setInterval(async () => {
        try {
          const s = await stat(outputFilePath);
          if (s.size > this.maxOutputBytes) {
            isOutputExceeded = true;
            cleanupMonitoring();
            proc.kill('SIGKILL');
          }
        } catch {
          // File may not exist yet during initial seeking
        }
      }, 50);
      sizeCheckInterval.unref();

      const cleanupMonitoring = () => {
        clearTimeout(timer);
        clearInterval(sizeCheckInterval);
      };

      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          // Bound stderr capture to 64 KB to prevent memory exhaustion
          if (stderrBytes <= 65536) {
            stderrAccumulator += chunk.toString('utf8');
          }
        });
      }

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (isSettled) return;
        isSettled = true;
        cleanupMonitoring();
        if (err.code === 'ENOENT') {
          reject(new FFmpegError(`FFmpeg executable not found at "${this.ffmpegPath}"`, 'ENOENT'));
        } else {
          reject(new FFmpegError(`FFmpeg process execution error: ${err.message}`, err.code));
        }
      });

      proc.on('close', (code) => {
        if (isSettled) return;
        isSettled = true;
        cleanupMonitoring();

        if (isOutputExceeded) {
          return reject(
            new FFmpegOutputLimitError(
              `Generated thumbnail exceeded maximum allowed size of ${this.maxOutputBytes} bytes`
            )
          );
        }

        if (isTimedOut) {
          return reject(
            new FFmpegTimeoutError(`FFmpeg process exceeded execution timeout of ${this.timeoutMs}ms`)
          );
        }

        if (code !== 0) {
          // Sanitize stderr to strip internal file paths
          const sanitizedStderr = stderrAccumulator
            .replace(new RegExp(inputFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[media-file]')
            .replace(new RegExp(outputFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[output-file]')
            .trim();

          return reject(
            new InvalidMediaError(
              `FFmpeg thumbnail extraction failed (exit code ${code}): ${
                sanitizedStderr || 'Invalid media input or corrupt container'
              }`
            )
          );
        }

        resolve();
      });
    });
  }

  private async validateAndInspectThumbnail(
    outputFilePath: string,
    seekSeconds: number
  ): Promise<ThumbnailResult> {
    let fileStat;
    try {
      fileStat = await stat(outputFilePath);
    } catch {
      throw new InvalidMediaError('FFmpeg completed but thumbnail output file was not found');
    }

    if (fileStat.size === 0) {
      await unlink(outputFilePath).catch(() => {});
      throw new InvalidMediaError('Generated thumbnail image is empty (0 bytes)');
    }

    if (fileStat.size > this.maxOutputBytes) {
      await unlink(outputFilePath).catch(() => {});
      throw new FFmpegOutputLimitError(
        `Generated thumbnail exceeded maximum allowed size of ${this.maxOutputBytes} bytes (${fileStat.size} bytes)`
      );
    }

    // Inspect JPEG header (first 4KB is ample for JPEG headers and SOF markers)
    let headerBuffer = Buffer.alloc(Math.min(4096, fileStat.size));
    let fileHandle;
    try {
      fileHandle = await open(outputFilePath, 'r');
      await fileHandle.read(headerBuffer, 0, headerBuffer.length, 0);
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }

    const dimensions = parseJpegDimensions(headerBuffer);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      await unlink(outputFilePath).catch(() => {});
      throw new InvalidMediaError('Generated file is not a valid JPEG image');
    }

    return {
      outputFilePath,
      width: dimensions.width,
      height: dimensions.height,
      fileSizeBytes: fileStat.size,
      mimeType: 'image/jpeg',
      timestamp: seekSeconds,
    };
  }
}

export const defaultFFmpegService = new FFmpegService();
