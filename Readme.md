# Lumen

Lumen is an API-first media processing backend. Developers register and upload
MP4 video, then retrieve processing state, thumbnails, and lower-resolution MP4
renditions. Processing runs asynchronously through a PostgreSQL transactional
outbox, Redis/BullMQ publisher, and background workers.

Milestone 3.5.3 implements rotation-aware transcoding without upscaling, validated
H.264/AAC output, renewed/fenced leases, safe redelivery, and contained local storage.
This is development software, not a production-readiness claim.

## Requirements

- Node.js 24+ and npm; dependencies are locked in package-lock.json.
- PostgreSQL 17 and Redis 7.
- FFmpeg and FFprobe on PATH, or literal paths in FFMPEG_PATH/FFPROBE_PATH.
- FFmpeg H.264 encoding (libx264 preferred, libopenh264 fallback), AAC, MP4,
  MPEG-4 decoding, and JPEG support. Numeric/encoder settings are described in
  [transcoding validation](docs/transcoding-validation.md).
- Docker Compose, or a working Podman-compatible Docker context, for containerized
  infrastructure. The application itself runs on the host for local development.

## Local development

These are operator setup instructions; they are separate from disposable tests.
Development Compose persists data and publishes PostgreSQL/Redis only on loopback.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`; replace both database-password placeholders with
   your chosen matching credential. Do not commit .env or reuse test credentials.
   For an existing cluster, editing .env does not rotate its database password.
3. Choose an available engine/context. For example, use `docker --context rootless`
   in place of `docker` when that context points to your Podman socket. Check the
   selected engine before running any infrastructure command.
4. Start development services with
   `docker compose --env-file .env -f compose.yaml up -d`.
5. Review `npm run db:migrate:status`, then explicitly apply pending migrations
   with `npm run db:migrate`. Order: `001_initial_schema.sql`, then
   `002_add_transcoding_config.sql`. Do not execute SQL files wholesale: they also
   contain destructive Down sections. `db:migrate:down` is destructive and requires
   deliberate authorization; it is not a test-reset command.
6. In separate terminals run `npm run dev`, `npm run outbox:publisher`, and
   `npm run worker`. All three load .env and must use the same database and Redis.

Use the **same absolute STORAGE_BASE_DIR** for API and workers. Run from the
repository root when relying on the relative `storage` default. Workers must see
uploaded originals and share the same filesystem as API delivery. `.tmp` and final
files must support same-filesystem hard links; no copy fallback is implemented.
Keep the root and its ancestors service-controlled. S3 storage is not implemented.

HOST defaults to 0.0.0.0 and PORT to 3000; set HOST=127.0.0.1 for local-only access.
Check `/health` for liveness and `/ready` for database readiness.

## HTTP API and authentication

Project API keys are accepted as `Authorization: Bearer <key>` or `X-API-Key`.
Expired/revoked keys and inactive projects are rejected. Only key hashes are stored.
**No supported public project/API-key provisioning endpoint or CLI exists yet.**
Integration tests seed their own credentials in disposable databases; that is not
an operational provisioning workflow.

| Endpoint | Authorization / behavior |
| --- | --- |
| GET /health | Public liveness |
| GET /ready | Public database readiness |
| POST /v1/media | Project key; register original_filename, video/mp4 mime_type, file_size_bytes; optional transcoding configuration |
| PUT /v1/media/:id/upload | Returned single-use upload token as Bearer authorization; raw MP4 bytes, maximum 100 MiB |
| GET /v1/media/:id | Project key; asset and thumbnail/rendition state |
| GET /v1/media/:id/thumbnail | Project key; generated JPEG |
| GET /v1/media/:id/renditions/:profile | Project key; complete generated MP4, never HTTP 206 |

Profiles are 360p, 480p, 720p, and 1080p bounding boxes. Rotation and aspect ratio
influence actual dimensions; profiles that would not reduce the source are skipped.
Registration accepts `transcoding: { enabled?: boolean, profiles?: string[] }`;
false disables transcoding, and an empty profile list requests none.

Rendition IDs are validated as UUIDs (malformed IDs return 400). Missing/inaccessible
assets, unsupported/unconfigured profiles, and missing files return 404; unfinished
or failed renditions return distinct 409 errors. Valid requests require project
ownership. Successful rendition responses use `video/mp4`, complete Content-Length,
and `Cache-Control: no-store`. Range requests receive the full 200 response;
Accept-Ranges and Content-Range are not advertised. Byte-range support is not implemented.

## Tests and verification

- `npm run typecheck`: strict TypeScript checking.
- `npm test`: complete classified database-free suite, with real test/ assertion
  counting and process isolation. Includes small real FFmpeg/FFprobe tests; binaries
  must be available. No .env is loaded and no live PostgreSQL/Redis is required.
- `test:integration:check`, `test:integration:migrate`, and `test:integration`:
  guarded disposable-only commands; follow the
  [isolated integration guide](docs/isolated-integration-tests.md), never development
  migration/reset commands. Starting infrastructure and destructive test setup
  require explicit authorization.

[Batch 4B](docs/batch-4b-verification.md) historically passed **336 integration
cases and 2,239 assertion calls**, with zero failures/skips after two stale test
assertions were corrected. Migrations 001/002 and the complete authenticated HTTP
upload → outbox → BullMQ → worker → rendition flow were verified. Its project was
removed and development resources preserved. Final HTTP/documentation corrections
postdate that run; the full integration suite was not rerun during finalization.

Rootless Podman compatibility includes an internal network without published test
ports, tmpfs data, a private SELinux label on the test-only init-script mount, and
Podman-compatible runner tmpfs options. The guide describes context selection.

## Limitations and roadmap

- Credential provisioning/onboarding remains incomplete.
- Signed completion/failure webhooks remain in the MVP roadmap.
- Range/206 support, HLS, resumable uploads, SDKs, S3, and usage analytics are planned.
- Crash orphan reconciliation is a [proposal](docs/rendition-file-safety.md), not an
  implemented collector. Unknown COMMIT outcomes preserve files conservatively.
- Path containment assumes no hostile local writer racing filesystem operations.
  Power-loss durability and production load/soak behavior are not verified.
- Short-media integration success does not establish public-release readiness.

## Repository layout

- `src/modules`: authentication, health, ingestion, probing, profiles, transcoding.
- `src/workers`: BullMQ worker, outbox publisher, lease ownership and retry handling.
- `src/shared/storage`: contained local storage and atomic non-overwriting publication.
- `src/test`: fail-closed integration safeguards, migration tooling, and test runner.
- `migrations`: ordered PostgreSQL schema changes.
- `infra/test`, `compose.test.yaml`: isolated disposable integration infrastructure.
- `docs`: acceptance criteria, safety design, setup, and verification evidence.
