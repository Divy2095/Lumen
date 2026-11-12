# Transcoding validation — stabilization Batch 3

## Acceptance before promotion

The service probes the source after acquiring its concurrency permit, then probes
the completed output. Both probes run under the existing job lease. The extra
source probe intentionally avoids trusting stale queue dimensions or audio state.

A rendition is accepted only when:

- Source and target dimensions are positive integer pixels within the existing
  16,384-pixel FFprobe limit; target dimensions are even and do not exceed source
  display dimensions. Quarter-turn rotation swaps display width and height.
- When a worker supplies a profile, the target exactly matches the existing
  rotation-aware profile resolver, and that profile actually reduces dimensions.
- The output is a readable, nonempty regular file within the configured byte limit.
  Filesystem size is authoritative; optional FFprobe size metadata is not.
- FFprobe parses the output, reports an MP4-capable format name, and does not
  explicitly identify the QuickTime `qt` brand. The shared MOV/MP4 demuxer reports
  a family of names, so a specific complete format-name string is not required.
- A valid H.264 video stream exists and its effective display dimensions exactly
  match the requested dimensions without exceeding the probed source.
- Audio, when requested and present in the source, exists as AAC. A source without
  audio needs no audio stream. Explicit video-only service calls must produce no
  audio; workers enable audio processing and let the source probe determine presence.
- Duration is finite and positive. Stream duration may substitute for unavailable
  format duration. Missing frame-rate, channel-layout, brand, or optional bitrate
  metadata does not itself invalidate a rendition.

The extension, FFmpeg exit status, codec encoder name, and bitrate target are not
proof of validity. Validation does not promise a full decode of every output frame
or require exact bitrate, duration equality, color tags, or AAC channel layout.

Rejection uses the existing service/worker temporary cleanup and fenced job retry
path. It occurs before promotion, version allocation, or current-output demotion.
No parent ingestion-state update is introduced. Batch 2's uncertain-COMMIT and
non-overwriting publication handling remain unchanged.

## Configuration rules

Only absent settings select defaults. Environment numbers must be whole decimal
integers (surrounding whitespace is allowed). Empty values, suffixes, exponent or
hex notation, fractions, nonfinite numbers, unsafe integers, and out-of-range
values are rejected. Explicit numeric options must be numbers, not strings.
Options take precedence over environment values.

| Setting | Default | Accepted bounds |
| --- | --- | --- |
| TRANSCODING_CONCURRENCY | 2 | 1 .. 2,147,483,647 |
| TRANSCODING_TIMEOUT_MS | 120,000 | 1 .. 2,147,483,647 ms |
| TRANSCODING_MAX_OUTPUT_BYTES | 524,288,000 | 1 .. Number.MAX_SAFE_INTEGER |
| TRANSCODING_MAX_STDERR_BYTES | 65,536 | 0 .. runtime buffer.constants.MAX_STRING_LENGTH; 0 disables capture |
| TRANSCODING_THREADS | 2 | 0 .. 2,147,483,647; 0 retains FFmpeg automatic threading |
| FFPROBE_TIMEOUT_MS | 10,000 | 1 .. 2,147,483,647 ms |
| FFPROBE_MAX_BUFFER_BYTES | 1,048,576 | 1 .. runtime buffer.constants.MAX_STRING_LENGTH |
| PostgreSQL leaseDurationMs option | 60,000 | 1 .. 2,147,483,647 ms |
| Encoder discovery timeout argument | 3,000 | 1 .. 2,147,483,647 ms |
| Worker concurrency | 5 | 1 .. 2,147,483,647 |
| BullMQ lockDuration | 30,000 | 2 .. 2,147,483,647 ms |
| BullMQ lockRenewTime | half lockDuration, floored | 1 .. lockDuration - 1 ms |

Explicit BullMQ stalledInterval and maximumRateLimitDelay values must be positive
integer milliseconds within the timer range. runRetryDelay permits zero;
drainDelay uses positive finite seconds, including fractions, bounded so its
millisecond conversion fits the timer range. PostgreSQL lease renewal remains
one-third of the lease with a minimum one-millisecond scheduling interval.
Cancellation's one-second termination grace and the 100 ms size-poll interval
remain fixed and unchanged.

Executable names/paths and encoder overrides must be nonblank strings without NUL
bytes. Literal spaces are retained, and no shell is involved. An unavailable
binary still follows existing spawn-error or encoder-discovery fallback behavior;
malformed configuration now throws instead of silently selecting a fallback.

These are numeric/runtime bounds, not operational capacity recommendations.
Operators must choose concurrency, threads, timeouts, and memory captures suitable
for the host. Source/output probing can each take up to the FFprobe timeout;
FFprobe cancellation still waits for the existing bounded probe operation.

## Verification limits

Isolated tests cover malformed probe responses, validation failures through a fake
database-backed worker, resource bounds, and prior safety behavior. A real-media
test generates temporary landscape, rotated, and video-only sources and produces
H.264/AAC renditions without PostgreSQL or Redis.

The historical database-backed transcoding suite now generates a suitably sized
temporary source instead of upscaling its 320x240 seed. That suite subsequently passed in Batch 4B, whose complete run recorded 336
cases and 2,239 assertion calls. Final HTTP fixes were checked separately with
database-free tests; no full integration rerun followed those fixes.
No migrations, HTTP Range handling, or orphan reconciliation are part of Batch 3.
