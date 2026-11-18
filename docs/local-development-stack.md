# Local development stack

`scripts/dev-stack.sh` starts the local development environment with one command:

```bash
./scripts/dev-stack.sh start
```

It manages the existing development PostgreSQL and Redis Compose services, the
API, the outbox publisher, the media-processing worker, and the sibling Lumen Web
frontend. The outbox publisher is part of the worker layer: without it, committed
outbox events are not handed to BullMQ and no media job reaches the worker.

The launcher never uses `compose.test.yaml`, never applies migrations, and never
removes containers, volumes, databases, or storage.

## Prerequisites

- Node.js 24.22.1 or newer in the 24 line. The launcher reads
  `../Lumen-web/.node-version`, prefers a compatible Node 24 on `PATH`, and
  otherwise looks in the usual nvm/fnm/Volta locations. Override with
  `LUMEN_NODE_BIN=/path/to/node`.
- npm and installed dependencies in both repositories:
  ```bash
  (cd ~/Desktop/Lumen && npm ci)
  (cd ~/Desktop/Lumen-web && npm ci)
  ```
- FFmpeg and FFprobe on `PATH`, or literal paths in `FFMPEG_PATH` and
  `FFPROBE_PATH`. H.264 encoding, AAC, MP4, MPEG-4 decoding, and JPEG support
  are required by the existing processing pipeline.
- Docker Compose v2 through Docker, or rootless Podman exposed through a
  Docker-compatible context. This repository has historically used the Docker
  context named `rootless` backed by Podman.
- A sibling `~/Desktop/Lumen-web` checkout. Override with `LUMEN_WEB_DIR`.
- A private, ignored `.env` in the backend repository. Copy `.env.example` and
  replace both database-password placeholders. Do not reuse integration-test
  credentials.

## Environment variables

The launcher reads the existing `.env`; it does not create, rewrite, or print it.
Exported shell variables take precedence, matching the application's
`--env-file-if-exists` behavior.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Development Compose database bootstrap |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | API, worker, publisher, and migration-status connection |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_PASSWORD` | API/worker Redis connection. A non-empty `REDIS_PASSWORD` is refused because the development container starts without authentication |
| `HOST`, `PORT` | API bind address and port. The launcher defaults `HOST` to `127.0.0.1` when unset |
| `CORS_ALLOWED_ORIGINS` | Exact browser origins; missing means no browser origin is allowed |
| `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`, optional `CLERK_JWKS_URL` | Clerk session-token verification (public keys only) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Media binaries |
| `STORAGE_BASE_DIR` | Optional shared absolute storage path for API and workers |
| `LUMEN_NODE_BIN` | Explicit compatible Node binary |
| `LUMEN_CONTAINER_ENGINE` | `docker` or `podman` (default: auto-detect) |
| `LUMEN_COMPOSE_CONTEXT` | Docker context (default: `rootless` when it exists, else `default`) |
| `LUMEN_COMPOSE_PROJECT` | Compose project name (default: `lumen`) |
| `LUMEN_WEB_DIR` | Frontend checkout (default: `../Lumen-web`) |
| `LUMEN_WEB_PORT` | Frontend port (default: `5173`) |
| `LUMEN_DEV_STACK_DRY_RUN=1` | Same as `start --dry-run` |

The development Compose services publish PostgreSQL and Redis only on loopback.
The launcher validates that `PGPORT`/`REDIS_PORT` match those published ports and
that the `POSTGRES_*` database/user match `PG*`. It refuses configurations that
would silently create or connect to a different database.

For browser requests, the exact frontend origin must be allowlisted. With the
default port:

```dotenv
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173
CLERK_ISSUER=https://your-instance.clerk.accounts.dev
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:5173
```

`localhost:5173` and `127.0.0.1:5173` are different origins. Only the Clerk
publishable key belongs in Lumen Web's ignored `.env.local`; never copy a Clerk
secret key or a project API key into `VITE_*` variables.

## First-time setup

1. Install dependencies and configure `.env` as described above.
2. Review the launcher plan without changing anything:
   ```bash
   ./scripts/dev-stack.sh start --dry-run
   ```
3. Start the stack:
   ```bash
   ./scripts/dev-stack.sh start
   ```
4. If migrations are pending, startup stops **before** starting application
   processes and prints the required commands. The launcher does not apply them:
   ```bash
   npm run db:migrate:status   # inspect the target and pending list
   npm run db:migrate          # explicitly apply reviewed up migrations
   ./scripts/dev-stack.sh start
   ```
   `db:migrate:down`, database resets, and `compose down -v` are destructive and
   are not part of this workflow. If the launcher started the database, it leaves
   the infrastructure running so the migration command can connect.
5. Create an operator-owned project and issue a project API key:
   ```bash
   npm run provision -- project:create --database lumen --role lumen \
     --name 'Local development' --email developer@example.com
   npm run provision -- key:issue --database lumen --role lumen \
     --project-id '<project-uuid>' --name 'Local development'
   ```
   These are interactive commands. Replace placeholders and save the revealed key
   once; it cannot be retrieved later. See
   [developer onboarding](developer-onboarding.md) and
   [API-key lifecycle](api-key-lifecycle.md).

The launcher creates `.lumen-dev/` (ignored) for PID records, non-secret state,
and logs. Process identity includes PID, process group, kernel start time, and a
launcher-specific environment marker. A reused or stale PID is never trusted.

## Commands

```bash
./scripts/dev-stack.sh start
./scripts/dev-stack.sh stop
./scripts/dev-stack.sh restart
./scripts/dev-stack.sh status
./scripts/dev-stack.sh logs
./scripts/dev-stack.sh logs api
./scripts/dev-stack.sh logs worker --no-follow
```

Commands work from any working directory. `start` prevents duplicate launches.
`stop` signals only verified launcher process groups and stops only containers
whose IDs and Compose labels match the recorded launcher state. Containers that
already existed and were adopted are left running. PostgreSQL/Redis data volumes
and logs are never removed.

A failed application startup stops the application processes it started but
leaves recorded infrastructure running for diagnosis. Ctrl+C during startup does
the same. Use `stop` to tear down launcher-owned infrastructure. If a required
port belongs to an unrelated process, the launcher reports the conflict and
exits; it does not use `killall`, `pkill -f`, or broad process matching.

Logs are separated as `api.log`, `worker.log`, `publisher.log`, `web.log`, and
`infrastructure.log` under `.lumen-dev/logs/`. The previous start is kept with a
`.prev` suffix.

## Local URLs

- API: `http://127.0.0.1:3000`
- API liveness: `http://127.0.0.1:3000/health`
- API database readiness: `http://127.0.0.1:3000/ready`
- Web: `http://127.0.0.1:5173/lumen-web/`
- PostgreSQL/Redis: loopback only, as configured by `compose.yaml`

The API is loopback-only by default. Setting a non-loopback `HOST` is an explicit
operator choice; the launcher warns but does not widen CORS or authentication.

## Testing API endpoints with Bruno or Postman

The existing media API uses project API keys. Keep the key in the client's local
environment/secret store, never in a committed collection and never in frontend
variables. For curl, the onboarding guide shows a header-file/stdin pattern that
keeps the key out of shell arguments.

- `GET /health` and `GET /ready` need no authentication.
- `POST /v1/media` needs `Authorization: Bearer <project-key>` and registers an
  MP4 upload intent. It returns the asset ID and a separate single-use upload
  token.
- `PUT /v1/media/:id/upload` uses the upload token, not the project key, and sends
  raw `video/mp4` bytes with the exact declared size. The limit is 100 MiB.
- Subsequent `GET /v1/media/:id`, thumbnail, and rendition requests use the
  project key and project ownership rules.

See the endpoint table in the [README](../Readme.md#http-api-and-authentication).
There is no public signup, login, session, or management HTTP API.

## Testing video upload and processing

This backend workflow is implemented and can be exercised with curl, Bruno, or
Postman while the launcher is running:

1. Register an MP4 with `POST /v1/media`, keeping the API key server-side.
2. Upload the file with the returned single-use token to the returned upload URL.
3. Poll `GET /v1/media/:id` with the project key. The API commits an outbox event;
   the outbox publisher moves it to Redis/BullMQ; the worker runs FFprobe,
   thumbnail generation, and configured MP4 renditions.
4. Retrieve the JPEG at `GET /v1/media/:id/thumbnail` and renditions at
   `GET /v1/media/:id/renditions/:profile`.

`./scripts/dev-stack.sh status` should show the worker and outbox publisher
running. If they are not, jobs remain pending. Processing needs FFmpeg/FFprobe and
the shared storage directory.

### Frontend status: implemented versus planned

Lumen Web is currently a prerendered marketing/documentation site and does not
perform API requests. Phase 8C-A provides only the backend
`GET /v1/browser/project` route using verified Clerk session tokens. Browser media
registration, upload, metadata, and thumbnail routes, and the corresponding web
upload/processing UI, are planned Phase 8C/8D work.

Consequently, the launcher can start the real video-processing backend and the
frontend site, but it cannot provide an end-to-end browser upload workflow until
that integration exists. Use curl/Bruno/Postman for the implemented media
workflow. Project API keys must not be shipped to the browser as a shortcut.

## Troubleshooting

### Node version

The launcher prints the selected Node version in dry-run and fails with the
required minimum if none is compatible. If nvm is installed:

```bash
nvm install 24.22.1
nvm use 24.22.1
```

Or set `LUMEN_NODE_BIN=/absolute/path/to/node`. Do not point it at the system
Node 22.

### FFmpeg/FFprobe

```bash
ffmpeg -version
ffprobe -version
```

Install both or set literal `FFMPEG_PATH`/`FFPROBE_PATH` values. A worker that
starts but fails jobs usually has a missing encoder or binary; check
`.lumen-dev/logs/worker.log`.

### Docker or Podman

Check the selected context before starting:

```bash
docker --context rootless version
docker --context rootless compose version
```

Use `LUMEN_CONTAINER_ENGINE` and `LUMEN_COMPOSE_CONTEXT` to select another
verified engine/context. The launcher uses `inspect`, `stop`, and Compose
`up -d --no-recreate`; it does not depend on Compose `exec`, so rootless Podman's
exec/healthcheck limitations do not affect readiness checks. Never point this
launcher at `compose.test.yaml` or a disposable integration project.

### Ports already in use

The launcher checks the API and frontend ports before launching, and checks the
PostgreSQL and Redis loopback ports before it starts those containers (or reports
that an existing container is already serving them). It reports conflicts without
killing anything. Inspect with your normal tools, for example `ss -ltnp`, and stop
the unrelated process yourself.

### Database password or existing volume

Changing `.env` does not rotate the password inside an existing PostgreSQL
volume. Do not reset the database to work around it. Use the credential the
volume was initialized with, or perform a separately reviewed migration. The
launcher validates DB/user names but cannot verify that `PGPASSWORD` matches the
stored container password.

### CORS

Browser calls need an exact `CORS_ALLOWED_ORIGINS` entry. A wildcard, path,
trailing slash, or `localhost` versus `127.0.0.1` mismatch will not match. The API
reads CORS at startup, so restart the stack after editing `.env`. CLI requests
without an `Origin` header are unaffected.

### Clerk identity linking

Clerk verifies session tokens with public JWKS only. Configure `CLERK_ISSUER` and
`CLERK_AUTHORIZED_PARTIES` in the backend `.env`; keep only the publishable key in
the frontend. An operator must link an existing account to a Clerk subject; there
is no automatic or email-based linking:

```bash
npm run provision -- identity:link --database lumen --role lumen \
  --account-id '<account-uuid>' --provider clerk --subject '<clerk-user-id>'
```

A verified user with no mapping receives `403 account_not_linked`; multiple
active projects return `409 project_selection_ambiguous`. See
[Clerk browser integration](clerk-browser-integration.md). Do not copy Clerk
secret keys into frontend variables.

### Migrations or stale state

Use `status` and `logs infrastructure` first. Pending migrations are reported by
`start` and by `npm run db:migrate:status`; the launcher deliberately refuses to
apply them. If startup failed, the next `start` reuses recorded infrastructure
ownership. `stop` retries any resources it could not stop and keeps state when a
resource is still alive.
