# Clerk browser integration foundation

Phase 8B adds the backend trust foundation; Phase 8C-A exposes project context.
Phase 8C-B adds Clerk-authenticated media registration, status, and thumbnails.
The existing project API-key routes and single-use upload-token flow are unchanged.

## Why Clerk identity is separate from project API keys

A Lumen project API key authorizes a project and remains a server-side secret.
A Clerk session JWT identifies a signed-in person. Phase 8B keeps these
boundaries explicit:

- `authenticateApiKey` continues to accept only project API keys.
- `authenticateClerk` accepts only a verified Clerk session JWT.
- A Clerk token cannot authenticate an existing project API-key route.
- A project API key is not accepted as a Clerk identity token.
- Upload tokens and their single-use semantics are unchanged.
- Project API keys must never be shipped to a browser. Use the dedicated
  `/v1/browser` endpoints with Clerk JWTs instead.

## CORS configuration

Set an explicit, comma-separated allowlist of exact browser origins:

```dotenv
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:4173
```

Rules:

- Only canonical `http`/`https` origins are accepted.
- Paths, queries, fragments, embedded credentials, wildcards, and `null` are
  rejected; the server fails at startup instead of widening the policy.
- Matching is exact, including scheme, host, and port. `localhost` and
  `127.0.0.1` are different origins.
- Missing or empty configuration means no browser origin is allowed. It does
  not mean "allow everything".
- Requests without an `Origin` header (CLI and server-to-server clients) are
  unaffected.
- Only `GET`, `POST`, and `PUT` are advertised. Only `Authorization` and
  `Content-Type` are advertised request headers. `x-api-key` is deliberately
  not a browser CORS header.
- Credentials are disabled. Browser requests must use the `Authorization:
  Bearer <Clerk JWT>` header rather than cookies.
- `OPTIONS` preflight is handled before authentication and does not require a
  Clerk token, project API key, or upload token.

Local loopback HTTP origins are acceptable for development only. Use the exact
frontend origin; do not use wildcard or substring matching in any environment.

## Clerk verification configuration

Clerk session tokens are verified with public keys only. Phase 8B does not use
`CLERK_SECRET_KEY`; only the public JWKS is needed.

```dotenv
CLERK_ISSUER=https://your-instance.clerk.accounts.dev
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:5173,http://127.0.0.1:4173
# Optional; must be https on the same origin as CLERK_ISSUER.
# CLERK_JWKS_URL=https://your-instance.clerk.accounts.dev/.well-known/jwks.json
# Optional bounded clock skew, default 5 seconds, range 0-60.
# CLERK_CLOCK_TOLERANCE_SECONDS=5
```

- `CLERK_ISSUER` is the Clerk Frontend API origin for one instance. It must be
  an exact HTTPS origin. Tokens from another Clerk application are rejected.
- The JWKS URL is derived as `<CLERK_ISSUER>/.well-known/jwks.json`. An explicit
  override is accepted only over HTTPS on the same issuer origin. A JWKS URL is
  never taken from a token claim.
- `CLERK_AUTHORIZED_PARTIES` must contain exact origins and must be nonempty.
  The token `azp` claim must be present and exactly match one entry in that
  allowlist. This rejects tokens minted for unlisted frontend origins. It does
  not bind `azp` to the current request's `Origin` header: with multiple
  allowlisted parties, a token minted for one allowlisted party is accepted
  from another allowlisted party. Bearer tokens are not origin-bound.
- Only `RS256` is accepted. Unsigned tokens and other algorithms are rejected.
- `exp` is required and validated; `nbf` is validated when present. Clock
  tolerance is bounded.
- `sub` must be a nonempty Clerk user subject of the form `user_<alphanumeric>`.
- Impersonation tokens containing an `act` claim are rejected.
- JWKS responses are cached, refreshed for a rotated key, and fetched with a
  bounded timeout. A provider outage fails closed.
- Partial Clerk configuration fails startup. A missing Clerk configuration
  makes the hook return `503 authentication_unavailable`, never a bypass.

The same verification hook protects all `/v1/browser` endpoints. The in-process
test service injection is not request-controlled and does not change production
issuer, JWKS, `azp`, algorithm, expiration, or runtime identity checks.

## Browser project context (Phase 8C-A)

Send `Authorization: Bearer <Clerk JWT>` to `GET /v1/browser/project`.
The API resolves the operator-linked account, then selects active projects using
only that resolved account ID. Query/body account or project IDs cannot select
a different project. No account or project is created automatically.

- Exactly one active project: `200 { "id": "...", "name": "..." }`.
- No identity mapping: `403 account_not_linked`.
- No active projects (including inactive-only accounts): `403 no_active_project`.
- Multiple active projects: `409 project_selection_ambiguous`; no arbitrary selection.
- Authentication errors remain `401` or `503` as described below.

Responses use `Cache-Control: no-store`. Account IDs, Clerk subjects, and API keys
are not returned. Accounts have no suspension/status column; this endpoint checks
project activity, not an invented account status. No database migration is included.

## Browser media contracts (Phase 8C-B)

All three endpoints require `Authorization: Bearer <Clerk JWT>` and resolve the
single active project again on each request. They share the project endpoint's
401/403/409/503 errors. Responses are `Cache-Control: no-store`; unexpected
database/storage failures produce sanitized 500 responses.

| Endpoint | Contract |
| --- | --- |
| `POST /v1/browser/media` | JSON: required `original_filename` (1–255 chars), `mime_type: "video/mp4"`, `file_size_bytes` (1–104857600); optional existing `transcoding` config. Returns 201 with `id`, `status`, filename/MIME/byte counts, `created_at`, `upload_token`, `upload_url`, `upload_expires_at`. No project/account IDs or API keys. |
| `GET /v1/browser/media/:id` | UUID required; 200 with `id`, upload-lifecycle `status`, filename/MIME/byte counts, timestamps, `technical`, `thumbnail`, and `processing`. Nonexistent/cross-project asset: 404. |
| `GET /v1/browser/media/:id/thumbnail` | UUID required; current project-owned JPEG bytes with `Content-Type: image/jpeg` and `Content-Length`. Missing/unfinished/cross-project thumbnail: 404. No public or permanent URL. |

Registration rejects account/project selection fields in the body or query
(`account_id`, `project_id`, and camel-case equivalents) before validation can
strip them. Status/thumbnail query IDs never affect authorization. Invalid MIME,
size, or transcoding configuration returns 400; no registration is inserted.
Filenames are stripped of directory components as in the existing API.

Status DTO example (technical fields are nullable before extraction):

```json
{
  "id": "01900000-0000-7000-8000-000000000001",
  "status": "ready",
  "original_filename": "sample.mp4",
  "mime_type": "video/mp4",
  "file_size_bytes": 12345,
  "uploaded_bytes": 12345,
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:01.000Z",
  "technical": {
    "duration_seconds": 2.5, "width": 640, "height": 360,
    "video_codec": "h264", "audio_codec": null,
    "bitrate": 500000, "frame_rate": 30
  },
  "thumbnail": { "status": "processing" },
  "processing": [
    { "operation": "extract_metadata", "status": "completed" },
    { "operation": "generate_thumbnail", "status": "processing" }
  ]
}
```

`status: "ready"` means upload ingestion completed, **not** that processing
finished. `processing` lists operation/state only: operations are
`extract_metadata`, `generate_thumbnail`, `transcode`; states are `queued`,
`processing`, `completed`, `failed`, `cancelled`. No percentages, internal job
payloads, job IDs, raw ffprobe JSON, storage paths/keys, or account IDs are exposed.
Multiple transcode jobs may have the same operation; playback/profile details
are outside this batch. Before jobs exist, `processing` is empty.

`thumbnail.status` is `ready` when a current output exists, otherwise the latest
thumbnail job state (except completed-without-output yields `not_found`).
When ready, its `url` is `/v1/browser/media/:id/thumbnail` and still requires
Clerk authorization. Status describes recorded output; delivery can return 404
if that file is missing. File containment and symlink checks remain enforced.

### Browser sequence

1. Sign in with Clerk; obtain a fresh session JWT.
2. Optionally fetch `/v1/browser/project`; never select authority by client IDs.
3. Register via `POST /v1/browser/media` using the Clerk JWT.
4. PUT the raw `File`/`Blob` (not JSON/FormData/base64) to the returned relative
   `upload_url`, using **the upload token**, not the Clerk JWT:
   `Authorization: Bearer <upload_token>` and `Content-Type: video/mp4`.
   Browsers provide `Content-Length` for a File/Blob; do not attempt to set this
   forbidden header manually. The byte length must equal `file_size_bytes`.
5. Poll `/v1/browser/media/:id` with a current Clerk JWT until the relevant jobs
   reach a terminal state; `ready` alone is not sufficient.
6. Fetch `thumbnail.url` with the Clerk Authorization header, call
   `response.blob()`, and render `URL.createObjectURL(blob)`. Revoke that blob URL
   when replaced/unmounted. A plain `<img src>` cannot attach the Bearer header.

Upload credentials remain single-use, asset-bound, and expire after one hour.
Existing Content-Length/container/timeout checks and failure handling are
unchanged; consumed-token replay returns 409. The upload endpoint remains a
bearer-capability endpoint, not a Clerk endpoint: possession grants upload even
if project context subsequently changes. Keep both token types out of logs,
URLs, and persistent browser storage. Registration is not idempotent; do not
blindly retry an uncertain registration or consumed upload.

For local development configure the exact Web origin in both
`CORS_ALLOWED_ORIGINS` and `CLERK_AUTHORIZED_PARTIES`, including its port.
Use `credentials: "omit"`; preflight requires no authentication. `localhost`
and `127.0.0.1` are distinct. Use the returned relative URLs against the API
origin, not the frontend origin.

## Failure responses

- Missing or malformed `Authorization: Bearer` header: `401 unauthorized`.
- Invalid signature, wrong issuer, wrong `azp`, expired/not-yet-valid token,
  unsupported algorithm, unsigned token, or invalid/missing subject:
  `401 unauthorized`.
- Missing backend configuration or unavailable JWKS provider:
  `503 authentication_unavailable`.

Responses do not include tokens, claims, signing keys, JWKS URLs, internal
errors, or stack traces. Failure responses are sanitized.

## Operator identity linking

A Clerk subject is linked to an existing Lumen account only by an operator using
the provisioning CLI. There is no public linking endpoint, no automatic/JIT
account creation, and no email-based matching.

Example with placeholders:

```bash
npm run provision -- identity:link \
  --database lumen \
  --role lumen \
  --account-id 01900000-0000-7000-8000-000000000001 \
  --provider clerk \
  --subject user_2abcDEF123
```

The command:

- Requires the actual configured database/role identity and an interactive
  terminal.
- Requires an explicit existing account UUID.
- Accepts only provider `clerk`.
- Validates the subject shape but does not treat the shape as proof of identity.
  The subject must come from Clerk.
- Performs the insert transactionally under the unique
  `(provider, provider_subject)` constraint.
- Returns `alreadyLinked: true` for the same subject and same account.
- Rejects the same subject linked to another account with a conflict and no
  mapping change.
- Rejects unknown accounts and rolls back unexpected failures.
- Never links by account email; email remains unverified ownership metadata.

Concurrent attempts are serialized by the unique constraint: at most one
mapping for a given Clerk subject can commit.

## Identity resolution

`ClerkIdentityResolver.resolveAccountId()` accepts only a
`VerifiedClerkIdentity`, a branded type produced by successful Clerk session
token verification. Route handlers must never construct one from an arbitrary
request field. Phase 8C may use the resolved account ID only after
`authenticateClerk` has run and after its own authorization checks.

A verified subject with no mapping resolves to `null`. Phase 8B does not create
an account, project, or identity as a fallback.

## Database collation assumption

`account_identities.provider_subject` and its unique
`(provider, provider_subject)` constraint use the database's default collation.
The schema does **not** force case-sensitive comparison. With the usual
case-sensitive PostgreSQL locale, Clerk subject equality is exact and
case-sensitive. Under a case-insensitive collation, subjects that differ only by
case could compare as equal, causing a false conflict or incorrect account
resolution.

Phase 8B does not modify the migration or schema. Before production use, verify
that the database's collation is deterministic and case-sensitive. If that
cannot be guaranteed, a separate reviewed migration should apply an explicit
case-sensitive collation (for example `COLLATE "C"`) to the subject column and
its unique index, and identity lookup queries should use the same collation.
Alternatively, store a case-sensitive hash of the subject. Do not change this
schema without separate approval.

## Phase 8D handoff and limits

Frontend integration is not implemented. Phase 8C-B has deterministic,
database-free coverage and a guarded integration test prepared for a separately
authorized disposable run; do not treat prepared tests as a live verification.
The API, outbox publisher, and worker must use the same database/Redis and
service-controlled storage root. No new services are required.

Operators must link the exact Clerk subject to an existing account with exactly
one active project. Multiple active projects fail closed; accounts have no
independent suspension flag. Database collation must be checked as described
above. There is no browser playback/rendition route, retry API, rate-limit/quota
system, or new progress telemetry in this batch.
