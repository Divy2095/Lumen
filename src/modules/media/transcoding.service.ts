import { spawn, execFileSync } from 'node:child_process';
import { open, stat, unlink } from 'node:fs/promises';
import { defaultFFprobeService, type FFprobeService, type ExtractedMediaMetadata } from './ffprobe.service.js';
import { normalizeSourceDimensions, resolveTranscodingProfiles, type TranscodingProfileName } from './transcoding-profiles.js';
import { executableSetting, integerInRange, integerSetting, MAX_CAPTURE_BYTES, MAX_FFMPEG_INTEGER, MAX_TIMER_MS } from '../../config/media-processing.js';

export interface TranscodingServiceOptions {
  ffmpegPath?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
  threads?: number | undefined;
  concurrencyLimit?: number | undefined;
  videoEncoder?: string | undefined;
  ffprobeService?: FFprobeService | undefined;
  semaphore?: AsyncSemaphore | undefined;
}

export interface TranscodeVideoOptions {
  inputFilePath: string;
  outputFilePath: string;
  targetWidth: number;
  targetHeight: number;
  bitrateKbps: number;
  hasAudio: boolean;
  signal?: AbortSignal | undefined;
  profile?: TranscodingProfileName | undefined;
}

export interface TranscodeResult {
  outputFilePath: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  mimeType: 'video/mp4';
  durationSeconds: number;
  bitrate: number;
  videoCodec: string;
  audioCodec?: string | null | undefined;
}

export class TranscodingError extends Error {
  constructor(message: string, public readonly code?: string | undefined) {
    super(message);
    this.name = 'TranscodingError';
  }
}

export class TranscodingTimeoutError extends TranscodingError {
  constructor(message = 'Transcoding process timed out') {
    super(message, 'TIMEOUT');
    this.name = 'TranscodingTimeoutError';
  }
}

export class TranscodingOutputLimitError extends TranscodingError {
  constructor(message = 'Transcoding output exceeded maximum allowed file size') {
    super(message, 'OUTPUT_LIMIT_EXCEEDED');
    this.name = 'TranscodingOutputLimitError';
  }
}

export class InvalidMediaError extends TranscodingError {
  constructor(message: string) {
    super(message, 'INVALID_MEDIA');
    this.name = 'InvalidMediaError';
  }
}

/**
 * Async semaphore to enforce a process-wide concurrency limit
 * on simultaneous FFmpeg transcoding instances.
 */
export class AsyncSemaphore {
  private current: number = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly maxConcurrency: number) {
    integerInRange('AsyncSemaphore maxConcurrency', maxConcurrency, 1, MAX_FFMPEG_INTEGER);
  }

  get activeCount(): number {
    return this.current;
  }

  get waitingCount(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.current < this.maxConcurrency) {
      this.current++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason);
      };
      const grant = () => {
        signal?.removeEventListener('abort', abort);
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      };
      this.queue.push(grant);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private release(): void {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next?.();
    }
  }
}

const cachedH264Encoders = new Map<string, string>();

/**
 * Determines the best available H.264 video encoder on the host.
 * Prefers libx264; falls back to libopenh264 or generic h264 if libx264 is not installed.
 */
export function getAvailableH264Encoder(ffmpegPath = 'ffmpeg', timeoutMs = 3000): string {
  executableSetting('FFMPEG_PATH', ffmpegPath, 'ffmpeg');
  integerInRange('Encoder detection timeout', timeoutMs, 1, MAX_TIMER_MS);
  if (process.env.FFMPEG_VIDEO_ENCODER !== undefined) {
    return executableSetting('FFMPEG_VIDEO_ENCODER', undefined, 'libx264');
  }
  const cached = cachedH264Encoders.get(ffmpegPath);
  if (cached) return cached;

  try {
    const output = execFileSync(ffmpegPath, ['-encoders'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    let encoder: string;

    if (output.includes('libx264')) {
      encoder = 'libx264';
    } else if (output.includes('libopenh264')) {
      encoder = 'libopenh264';
    } else {
      encoder = 'h264';
    }
    cachedH264Encoders.set(ffmpegPath, encoder);
    return encoder;
  } catch {
    // Preserve the historical fallback, but retry detection after transient failures.
    return 'libx264';
  }
}

export class TranscodingService {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
  readonly threads: number;
  readonly semaphore: AsyncSemaphore;
  readonly videoEncoder: string;
  readonly ffprobeService: FFprobeService;

  constructor(options: TranscodingServiceOptions = {}) {
    this.ffmpegPath = executableSetting('FFMPEG_PATH', options.ffmpegPath, 'ffmpeg');
    this.timeoutMs = integerSetting('TRANSCODING_TIMEOUT_MS', options.timeoutMs, 120000, MAX_TIMER_MS);
    this.maxOutputBytes = integerSetting('TRANSCODING_MAX_OUTPUT_BYTES', options.maxOutputBytes, 500 * 1024 * 1024, Number.MAX_SAFE_INTEGER);
    this.maxStderrBytes = integerSetting('TRANSCODING_MAX_STDERR_BYTES', options.maxStderrBytes, 64 * 1024, MAX_CAPTURE_BYTES, 0);
    this.threads = integerSetting('TRANSCODING_THREADS', options.threads, 2, MAX_FFMPEG_INTEGER, 0);
    const concurrencyLimit = integerSetting('TRANSCODING_CONCURRENCY', options.concurrencyLimit, 2, MAX_FFMPEG_INTEGER);
    this.semaphore = options.semaphore ?? new AsyncSemaphore(concurrencyLimit);
    integerInRange('AsyncSemaphore maxConcurrency', this.semaphore.maxConcurrency, 1, MAX_FFMPEG_INTEGER);
    this.videoEncoder = options.videoEncoder !== undefined
      ? executableSetting('FFMPEG_VIDEO_ENCODER', options.videoEncoder, 'libx264')
      : getAvailableH264Encoder(this.ffmpegPath);
    this.ffprobeService = options.ffprobeService ?? defaultFFprobeService;
  }

  /**
   * Transcodes an input video into an MP4 rendition with bounded resource limits,
   * aspect-ratio preserving scaling, even dimensions, AAC audio, and +faststart.
   */
  async transcodeVideo(options: TranscodeVideoOptions): Promise<TranscodeResult> {
    const { inputFilePath, outputFilePath, targetWidth, targetHeight, bitrateKbps, hasAudio } = options;

    if (!inputFilePath || typeof inputFilePath !== 'string') {
      throw new Error('TranscodingService: valid inputFilePath is required');
    }
    if (!outputFilePath || typeof outputFilePath !== 'string') {
      throw new Error('TranscodingService: valid outputFilePath is required');
    }
    integerInRange('targetWidth', targetWidth, 2, 16384);
    integerInRange('targetHeight', targetHeight, 2, 16384);
    if (targetWidth % 2 || targetHeight % 2) throw new Error('Target dimensions must be even');
    integerInRange('bitrateKbps', bitrateKbps, 1, Math.floor(MAX_FFMPEG_INTEGER / 2000));
    if (typeof hasAudio !== 'boolean') throw new Error('hasAudio must be a boolean');

    // Acquire concurrency permit
    const release = await this.semaphore.acquire(options.signal);
    try {
      options.signal?.throwIfAborted();
      const source = await this.ffprobeService.probe(inputFilePath);
      options.signal?.throwIfAborted();
      const sourceDimensions = normalizeSourceDimensions(source.video);
      if (targetWidth > sourceDimensions.effectiveWidth || targetHeight > sourceDimensions.effectiveHeight) {
        throw new InvalidMediaError('Rendition would upscale the source');
      }
      if (options.profile !== undefined) {
        const expected = resolveTranscodingProfiles({ source: source.video, config: { profiles: [options.profile] } }).eligible[0];
        if (!expected || targetWidth !== expected.targetWidth || targetHeight !== expected.targetHeight) {
          throw new InvalidMediaError('Rendition dimensions do not match the source profile');
        }
      }
      const expectAudio = hasAudio && Boolean(source.audio);
      await this.executeFFmpeg(inputFilePath, outputFilePath, targetWidth, targetHeight, bitrateKbps, expectAudio, options.signal);
      options.signal?.throwIfAborted();
      const result = await this.validateAndInspectOutput(outputFilePath, targetWidth, targetHeight, expectAudio, source);
      options.signal?.throwIfAborted();
      return result;
    } catch (err) {
      // Ensure failed/partial output file is removed
      await unlink(outputFilePath).catch(() => {});
      throw err;
    } finally {
      release();
    }
  }

  private executeFFmpeg(
    inputFilePath: string,
    outputFilePath: string,
    targetWidth: number,
    targetHeight: number,
    bitrateKbps: number,
    hasAudio: boolean,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      abortSignal?.throwIfAborted();
      // Build fixed argument array (no shell interpolation)
      const args: string[] = [
        '-v', 'error',
        '-y',
        '-i', inputFilePath,
        '-vf', `scale=${targetWidth}:${targetHeight}`,
        '-c:v', this.videoEncoder,
      ];

      // Add preset if supported (e.g. libx264)
      if (this.videoEncoder === 'libx264') {
        args.push('-preset', 'fast');
      }

      args.push(
        '-b:v', `${bitrateKbps}k`,
        '-maxrate', `${Math.round(bitrateKbps * 1.5)}k`,
        '-bufsize', `${bitrateKbps * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart'
      );

      if (this.threads > 0) {
        args.push('-threads', String(this.threads));
      }

      if (hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
      } else {
        args.push('-an');
      }

      // Explicitly specify format 'mp4' to support temp files without .mp4 extension
      args.push('-f', 'mp4', outputFilePath);

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(this.ffmpegPath, args, {
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err: any) {
        return reject(new TranscodingError(`Failed to spawn FFmpeg process: ${err?.message}`, err?.code));
      }

      let stderrAccumulator = '';
      let stderrBytes = 0;
      let isTimedOut = false;
      let isOutputExceeded = false;
      let isSettled = false;
      let abortKillTimer: NodeJS.Timeout | undefined;
      const abort = () => {
        proc.kill('SIGTERM');
        abortKillTimer = setTimeout(() => proc.kill('SIGKILL'), 1000);
        abortKillTimer.unref();
      };
      abortSignal?.addEventListener('abort', abort, { once: true });
      if (abortSignal?.aborted) abort();

      const timer = setTimeout(() => {
        isTimedOut = true;
        proc.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 1000);
        killTimer.unref();
      }, this.timeoutMs);
      timer.unref();

      const sizeCheckInterval = setInterval(async () => {
        try {
          const s = await stat(outputFilePath);
          if (s.size > this.maxOutputBytes) {
            isOutputExceeded = true;
            cleanupMonitoring();
            proc.kill('SIGTERM');
            const killTimer = setTimeout(() => {
              try {
                proc.kill('SIGKILL');
              } catch {}
            }, 1000);
            killTimer.unref();
          }
        } catch {
          // File may not exist yet during initial encoding
        }
      }, 100);
      sizeCheckInterval.unref();

      const cleanupMonitoring = () => {
        abortSignal?.removeEventListener('abort', abort);
        clearTimeout(abortKillTimer);
        clearTimeout(timer);
        clearInterval(sizeCheckInterval);
      };

      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < this.maxStderrBytes) {
          const remaining = this.maxStderrBytes - stderrBytes;
          const slice = chunk.subarray(0, remaining);
          stderrAccumulator += slice.toString('utf8');
          stderrBytes += slice.length;
        }
      });

      proc.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        cleanupMonitoring();
        reject(new TranscodingError(`FFmpeg process execution failed: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        if (isSettled) return;
        isSettled = true;
        cleanupMonitoring();

        if (abortSignal?.aborted) return reject(abortSignal.reason);

        if (isOutputExceeded) {
          return reject(
            new TranscodingOutputLimitError(
              `Transcoding output exceeded maximum allowed size of ${this.maxOutputBytes} bytes`
            )
          );
        }

        if (isTimedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
          return reject(
            new TranscodingTimeoutError(`Transcoding process exceeded timeout of ${this.timeoutMs}ms`)
          );
        }

        if (code !== 0) {
          // Sanitize internal file paths from stderr
          const sanitizedStderr = stderrAccumulator
            .replace(new RegExp(inputFilePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'g'), '[media-file]')
            .replace(new RegExp(outputFilePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'g'), '[output-file]')
            .trim();

          return reject(
            new InvalidMediaError(
              `FFmpeg transcoding failed (exit code ${code}): ${
                sanitizedStderr || 'Invalid media input or corrupt container'
              }`
            )
          );
        }

        resolve();
      });
    });
  }

  private async validateAndInspectOutput(
    outputFilePath: string,
    expectedWidth: number,
    expectedHeight: number,
    expectAudio: boolean,
    source: ExtractedMediaMetadata,
  ): Promise<TranscodeResult> {
    let fileStat;
    try {
      fileStat = await stat(outputFilePath);
    } catch {
      throw new InvalidMediaError('FFmpeg completed but output file was not found');
    }

    if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size === 0) {
      await unlink(outputFilePath).catch(() => {});
      throw new InvalidMediaError('Generated video must be a nonempty regular file');
    }

    if (fileStat.size > this.maxOutputBytes) {
      await unlink(outputFilePath).catch(() => {});
      throw new TranscodingOutputLimitError(
        `Generated video exceeded maximum allowed size of ${this.maxOutputBytes} bytes (${fileStat.size} bytes)`
      );
    }

    // Inspect output using ffprobe to verify valid container, video stream, and dimensions
    try {
      const file = await open(outputFilePath, 'r');
      try {
        const read = await file.read(Buffer.alloc(1), 0, 1, 0);
        if (read.bytesRead !== 1) throw new InvalidMediaError('Generated video is unreadable');
      } finally { await file.close(); }
      const probeRes = await this.ffprobeService.probe(outputFilePath);
      if (!probeRes || typeof probeRes.containerFormat !== 'string' ||
          !probeRes.containerFormat.split(',').map((name) => name.trim()).includes('mp4') || probeRes.containerBrand === 'qt') {
        throw new InvalidMediaError('Transcoded output is not an MP4 container');
      }
      if (!probeRes.video || probeRes.video.codec !== 'h264') {
        throw new InvalidMediaError('Transcoded output must contain H.264 video');
      }
      const dimensions = normalizeSourceDimensions(probeRes.video);
      const sourceDimensions = normalizeSourceDimensions(source.video);
      if (dimensions.effectiveWidth !== expectedWidth || dimensions.effectiveHeight !== expectedHeight ||
          dimensions.effectiveWidth > sourceDimensions.effectiveWidth || dimensions.effectiveHeight > sourceDimensions.effectiveHeight) {
        throw new InvalidMediaError('Transcoded dimensions do not match the expected rendition or would upscale the source');
      }
      if ((expectAudio && probeRes.audio?.codec !== 'aac') || (!expectAudio && probeRes.audio !== undefined)) {
        throw new InvalidMediaError('Transcoded audio does not match the expected AAC or video-only output');
      }
      if (!Number.isFinite(probeRes.durationSeconds) || probeRes.durationSeconds <= 0) {
        throw new InvalidMediaError('Transcoded output has no valid duration');
      }

      return {
        outputFilePath,
        width: dimensions.effectiveWidth,
        height: dimensions.effectiveHeight,
        fileSizeBytes: fileStat.size,
        mimeType: 'video/mp4',
        durationSeconds: probeRes.durationSeconds,
        bitrate: probeRes.bitrate ?? Math.round((fileStat.size * 8) / (probeRes.durationSeconds || 1)),
        videoCodec: probeRes.video.codec,
        audioCodec: probeRes.audio?.codec ?? null,
      };
    } catch (probeErr: any) {
      if (probeErr instanceof TranscodingError) throw probeErr;
      throw new InvalidMediaError(
        `Failed to validate transcoded video file: ${probeErr?.message || 'corrupt container'}`
      );
    }
  }
}

export const defaultTranscodingService = new TranscodingService();
