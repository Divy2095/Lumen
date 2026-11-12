# Milestone 3.5.3 — Batch 4B live verification

Project: `lumen-it-5a8ff43b2b855a86`.
Engine: existing Docker `rootless` context backed by Podman. Docker Desktop was unavailable.
Existing stopped development containers and their named volumes were inspected and preserved.

## Isolation and safety evidence

- Fresh, mutually distinct test credentials differed from development credentials; the generated file was ignored, mode 0600, and removed after teardown.
- Actual container inspection confirmed the unique Compose project label, one project-private internal network, no port bindings, and tmpfs data mounts. The only bind was the read-only test initialization script.
- Preflight verified PostgreSQL database/session role/port, restricted privileges, no connection privilege to other connectable databases, the administrator-owned immutable marker/token, authenticated Redis marker, and canonical marked storage.
- Connection-level guards stayed enabled for migrations and test SQL. No guard was bypassed.
- Database readback: `lumen_test`, role `lumen_test_runner`; migration records `001_initial_schema`, `002_add_transcoding_config`; column `media_assets.transcoding_config` is JSONB.
- Runtime: Node v24.22.3; FFmpeg 5.1.9-0+deb12u1.

## Results

Initial complete run: 336 cases, 334 passed, 2 failed, 0 skipped.
Final complete run: **336 cases, 336 passed, 0 failed/cancelled/skipped/TODO; 44 suites across 24 files; 2,239 assertion calls**. Exit status 0.

The two failures were stale assertions: source probing now raises the FFprobe INVALID_MEDIA error for corrupt input, and a concurrent delivery must request retry while the first worker owns an unfinished job. Assertions were updated to verify those accepted semantics, including acknowledgement only after completion. No production code or guards changed.

## Full pipeline coverage

`src/workers/pipeline.test.ts` passed with 15 assertion calls. It seeds two test projects/API keys, then uses real HTTP authentication, media registration and upload-token issuance, MP4 upload validation, PostgreSQL outbox publication, Redis/BullMQ queue delivery, real worker/FFprobe metadata extraction, thumbnail generation, profile scheduling, FFmpeg transcoding, current-output persistence, authenticated MP4/thumbnail retrieval, unauthenticated denial and cross-project denial. Source media is generated inside disposable storage.

This is a short-media integration test, not a production load/soak test or proof of every crash-recovery scenario.

## Infrastructure fixes

- Use node:24-bookworm-slim with explicit FFmpeg/Git packages to reduce the base-image download.
- Add a private SELinux label (`Z`) to the test-only initialization-script bind on this SELinux-enabled host.
- Replace unsupported Podman-compatible tmpfs uid/gid options with mode 1777 inside the container-private storage mount. Token files remain mode 0600; no host storage is mounted. This does not permit access from other containers.

## Teardown

Compose down removed only this project's PostgreSQL/Redis containers and private network. Data was tmpfs; no named test data volume existed. The exact build-helper container and cache volume newly created by this run, plus the tagged test-runner image, were removed individually. No broad cleanup was used. Downloaded/base-image cache may remain.

Readback confirmed no containers/networks remained for this project; original development containers remained stopped and original named data volumes still existed. Generated credentials were removed. No stage/commit/push or website changes occurred.

## Test files

- `src/config/redis.test.ts`
- `src/database/schema.test.ts`
- `src/modules/health/health.test.ts`
- `src/modules/media/encoder-detection.test.ts`
- `src/modules/media/ffmpeg.service.test.ts`
- `src/modules/media/ffprobe.service.test.ts`
- `src/modules/media/media.test.ts`
- `src/modules/media/resource-config.test.ts`
- `src/modules/media/transcoding-cancellation.test.ts`
- `src/modules/media/transcoding-profiles.test.ts`
- `src/modules/media/transcoding-real-media.test.ts`
- `src/modules/media/transcoding-scheduling.test.ts`
- `src/modules/media/transcoding-validation.test.ts`
- `src/modules/media/transcoding.service.test.ts`
- `src/shared/storage/local-storage.service.test.ts`
- `src/test/integration-safety.test.ts`
- `src/test/test-runner.test.ts`
- `src/workers/job-lease.test.ts`
- `src/workers/outbox-publisher.test.ts`
- `src/workers/pipeline.test.ts`
- `src/workers/processor-retry.test.ts`
- `src/workers/rendition-cleanup.test.ts`
- `src/workers/repository-readiness.test.ts`
- `src/workers/worker.test.ts`
