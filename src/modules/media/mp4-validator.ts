import { Transform, type TransformCallback } from 'node:stream';

/**
 * Recognized ISO/IEC 14496-12 MP4 major and compatible brand signatures.
 */
const RECOGNIZED_MP4_BRANDS = new Set([
  'isom', // MP4 Base Media v1
  'iso2', // MP4 Base Media v2
  'mp41', // MP4 v1
  'mp42', // MP4 v2
  'avc1', // Advanced Video Coding
  'M4V ', // Apple Video
  'M4A ', // Apple Audio
  'qt  ', // Apple QuickTime
  'dash', // MPEG-DASH
]);

export interface Mp4InspectResult {
  isMp4: boolean;
  brand?: string;
  bytesReceived: number;
}

export class Mp4StreamInspector extends Transform {
  private headerBuffer: Buffer = Buffer.alloc(0);
  private headerChecked = false;
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    super();
    this.maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.length;

    if (this.totalBytes > this.maxBytes) {
      const err = new Error(`Payload size exceeded limit of ${this.maxBytes} bytes`);
      (err as any).code = 'ERR_PAYLOAD_TOO_LARGE';
      callback(err);
      return;
    }

    if (!this.headerChecked) {
      this.headerBuffer = Buffer.concat([this.headerBuffer, chunk]);

      // Need at least 12 bytes to inspect 4-byte box size + 4-byte 'ftyp' box type + 4-byte major_brand
      if (this.headerBuffer.length >= 12) {
        const boxType = this.headerBuffer.subarray(4, 8).toString('ascii');
        const majorBrand = this.headerBuffer.subarray(8, 12).toString('ascii');

        if (boxType !== 'ftyp') {
          const err = new Error('Invalid media container: missing required MP4 ftyp box');
          (err as any).code = 'ERR_INVALID_CONTAINER';
          callback(err);
          return;
        }

        if (!RECOGNIZED_MP4_BRANDS.has(majorBrand)) {
          // Check compatible brands if available (from byte 16 onwards)
          let compatibleBrandFound = false;
          if (this.headerBuffer.length >= 16) {
            const boxSize = this.headerBuffer.readUInt32BE(0);
            const maxHeaderSearch = Math.min(boxSize, Math.min(this.headerBuffer.length, 64));
            for (let offset = 16; offset + 4 <= maxHeaderSearch; offset += 4) {
              const brand = this.headerBuffer.subarray(offset, offset + 4).toString('ascii');
              if (RECOGNIZED_MP4_BRANDS.has(brand)) {
                compatibleBrandFound = true;
                break;
              }
            }
          }

          if (!compatibleBrandFound) {
            const err = new Error(`Invalid MP4 brand: "${majorBrand}" is not a recognized MP4 container brand`);
            (err as any).code = 'ERR_INVALID_CONTAINER';
            callback(err);
            return;
          }
        }

        this.headerChecked = true;
      }
    }

    this.push(chunk);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.headerChecked) {
      const err = new Error('Invalid media container: file is too small to contain a valid MP4 header');
      (err as any).code = 'ERR_INVALID_CONTAINER';
      callback(err);
      return;
    }
    callback();
  }

  getBytesReceived(): number {
    return this.totalBytes;
  }
}
