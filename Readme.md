# Lumen

Lumen is an API-first media processing backend. Developers register and upload
MP4 video, then retrieve processing state, thumbnails, and lower-resolution MP4
renditions. Processing runs asynchronously through a PostgreSQL transactional
outbox, Redis/BullMQ publisher, and background workers.

Milestone 3.5.3 implements rotation-aware transcoding without upscaling, validated
H.264/AAC output, renewed/fenced leases, safe redelivery, and contained local storage.
This is development software, not a production-readiness claim.

Milestone 3.6 adds local operator-controlled project provisioning and API-key
issuance, metadata listing, revocation, and staged rotation. See the
[developer onboarding guide](docs/developer-onboarding.md) for the first credential
and the [key lifecycle guide](docs/api-key-lifecycle.md) for recovery and rotation.

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
   `002_add_transcoding_config.sql`, `003_webhook_contract.sql`, then
   `004_webhook_encryption_key_metadata.sql`. Migrations 003/004
   prepare webhook contracts and encryption metadata; signed delivery is not implemented
   yet and their Down paths deliberately refuse to discard new history. See the
   [webhook schema design](docs/webhook-contract.md). Do not execute SQL files wholesale: they also
   contain destructive Down sections. `db:migrate:down` is destructive and requires
   deliberate authorization; it is not a test-reset command.
6. From a private interactive terminal, create ownership metadata and a project:
   `npm run provision -- project:create --database lumen --role lumen --name "Example project" --email developer@example.com`.
   Record the returned account/project UUIDs. Email ownership is not verified.
7. Issue a key using the actual returned project UUID:
   `npm run provision -- key:issue --database lumen --role lumen --project-id '<project-uuid>' --name "Development"`.
   Replace the quoted placeholder. Check the displayed database target and type the
   requested confirmation. The key is shown once after confirmed persistence;
   save it securely. Keys expire in 90 days unless an explicit override is supplied.
8. In separate terminals run `npm run dev`, `npm run outbox:publisher`, and
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
Provisioning is supported through `npm run provision -- --help`. Operator database
access is separate from media API-key authentication: possessing a project key
does not grant database access or permission to provision credentials. Provisioning
needs PostgreSQL only; the processing API additionally needs the services above.
There is no public signup, login, OAuth, session, or management HTTP API.

The CLI supports `project:create`, `project:list`, `key:issue`, `key:list`,
`key:revoke`, and `key:rotate`. Writes require interactive stdin/stdout and typed
confirmation. There is no unattended write/secret-output mode. Explicit
`--no-expiry` opts into a non-expiring key; `--expires-at` chooses a future UTC
timestamp. Rotation leaves the predecessor valid until explicitly revoked.
See [safe API examples and first-run commands](docs/developer-onboarding.md).

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
postdate that run; the full integration suite was not rerun during 3.5.3 finalization.

Milestone 3.6 Batch 3 subsequently verified the updated tree in a fresh disposable
project: **420 cases across 29 files and 2,858 assertion calls**, zero failures or
skips. Its 15 focused provisioning cases (94 assertion calls) exercised real
PostgreSQL transactions and both lock orderings, existing API authentication and
tenant isolation, and CLI reads/redirected-write refusal. Successful interactive
CLI secret delivery was not exercised against a live database. Batch 4A adds
documentation/security review and database-free verification, not another full
integration run. See [security and verification notes](docs/milestone-3.6-security-review.md).

Rootless Podman compatibility includes an internal network without published test
ports, tmpfs data, a private SELinux label on the test-only init-script mount, and
Podman-compatible runner tmpfs options. The guide describes context selection.

## Limitations and roadmap

- Onboarding is operator-controlled; public self-service identity/onboarding and
  management HTTP APIs are not implemented. Account emails are unverified metadata.
- Rotation is staged and not idempotent: duplicate/concurrent rotations can create
  separate replacements. No predecessor relationship is persisted. See
  [key recovery and limitations](docs/api-key-lifecycle.md).
- Live successful PTY secret reveal remains a coverage gap. Terminal recording,
  screen capture, and shoulder surfing are outside the CLI's protection.
- The locked migration-tool dependency chain has three moderate npm audit findings
  representing two underlying advisories; see the scoped
  [dependency review](docs/milestone-3.6-security-review.md). No automatic upgrade was applied.
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

Operator webhook endpoint management is available through `npm run provision -- webhook:help`.
See [endpoint management and external encryption keys](docs/webhook-endpoint-management.md).
This configures destinations and signing secrets; outbound delivery remains unimplemented.
