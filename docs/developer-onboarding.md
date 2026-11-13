# Developer onboarding through the operator CLI

Lumen 3.6 supports local operator provisioning. A trusted operator controls the
database connection and creates credentials for a developer's project. Ordinary
project API keys authorize the existing media API only. Do not distribute the
operator's database password or `.env` alongside a project key.

There is no public signup, login, OAuth, session, dashboard, organization management,
or credential-management HTTP API. An `accounts` row is ownership metadata, not a
login identity; entering an email does not verify ownership of that mailbox.

## 1. Configure the operator database connection

Follow [local development setup](../Readme.md#local-development): install the locked
dependencies, configure PostgreSQL 17, and copy `.env.example` to ignored `.env`.
Use a strong database password. Keep `.env` private (for example mode 0600).
For an existing PostgreSQL volume, changing `.env` alone does not rotate its password.
Do not reset or recreate a database to obtain credentials.

The CLI uses `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and required `PGPASSWORD`.
The npm command loads `.env`, while already exported environment variables take
precedence. `--database` and `--role` are mandatory expected identities; they do
not change the configured connection. The connected database, current role, and
session role must match. Check the displayed host/port too: database/role names
alone do not uniquely identify a cluster. This is an operator target check, not
the disposable integration environment's stronger marker/token guard.

The operator needs appropriate SELECT/INSERT and row-lock/update permissions on
accounts, projects, and API keys. The CLI neither creates database roles nor grants
privileges. Database access remains a privileged trust boundary across projects.
Do not treat development bootstrap-role credentials as a production least-privilege
deployment design. Provisioning itself needs PostgreSQL, not Redis or FFmpeg.

## 2. Apply migrations in order

```sh
npm run db:migrate:status
# After reviewing the intended connection and pending migrations:
npm run db:migrate
```

Order is `001_initial_schema.sql`, then `002_add_transcoding_config.sql`.
No migration is added by 3.6. Do not execute the SQL files wholesale: they include
destructive Down sections. These commands operate on the configured installation;
they are not integration-test reset commands.

## 3. Create ownership metadata and a project

Use a private terminal with interactive stdin and stdout; do not pipe confirmation
or redirect output. Disable terminal recording and keep scrollback/screens private.

```sh
npm run provision -- --help
npm run provision -- project:create --database lumen --role lumen \
  --name 'Example project' --email developer@example.com
npm run provision -- project:list --database lumen --role lumen
```

These examples match `.env.example`'s database and role. Substitute your actual
configured identities when different. Check the displayed target and type the
exact confirmation requested. Record the returned project and account UUIDs.
Names contain 1–100 characters without surrounding whitespace/control characters.
Ownership emails use conservative ASCII mailbox syntax.

To create another project for an existing account, replace the quoted placeholder
with that account's actual UUID:

```sh
npm run provision -- project:create --database lumen --role lumen \
  --name 'Second project' --account-id '<account-uuid>'
```

Choose exactly one of `--email` and `--account-id`. Existing accounts can be selected
only by explicit UUID. Duplicate emails cause rollback rather than silent reuse.
The account and project are created atomically, with the project initially active.

## 4. Issue the first project key

Replace `<project-uuid>` with the UUID printed above. Keys are issued only for an
explicit existing active project. Key names follow the same validation as project names.

```sh
npm run provision -- key:issue --database lumen --role lumen \
  --project-id '<project-uuid>' --name 'Development'
```

Check the selected project's name/owner/UUID, target connection, and expiration.
Type the exact confirmation to authorize persistence and one-time terminal reveal.
The CLI generates a random credential and stores its SHA-256 verifier and non-secret
metadata. It reveals the plaintext only after COMMIT is confirmed. Save it in a
secure secret manager; it cannot be retrieved later. Do not use `tee`, output
redirection, screenshots, recorded terminals, or shell commands containing the key.
TTY checks cannot prevent a privileged local observer or terminal capture.

New keys expire in 90 days by default. A future UTC timestamp overrides that
default; only explicit `--no-expiry` permits a non-expiring key:

```sh
npm run provision -- key:issue --database lumen --role lumen \
  --project-id '<project-uuid>' --name 'Time-limited' --expires-at '2090-01-01T00:00:00Z'
npm run provision -- key:issue --database lumen --role lumen \
  --project-id '<project-uuid>' --name 'Explicit non-expiring' --no-expiry
```

Choose one expiration mode per invocation. Explicit timestamps must include UTC
`Z`, seconds, and optionally exactly three fractional digits. The examples create
additional keys; do not run all of them unless that is intended.

## 5. Use the existing media API

Start API, publisher, and worker as described in README, sharing the same storage.
The API accepts `Authorization: Bearer <key>` or `X-API-Key`. A key belongs to one
project and does not grant access to another project even under the same account.

This Bash example disables shell tracing, reads the key privately without exporting
it, and sends the authorization header through
curl's stdin ([documented header-file behavior](https://curl.se/docs/manpage.html#-H)),
keeping it out of command arguments and shell history. Use a private
local machine. Adjust `file_size_bytes` to the actual MP4 size before registering:

```bash
set +x
export -n LUMEN_PROJECT_API_KEY
read -r -s -p 'Project API key: ' LUMEN_PROJECT_API_KEY
printf '\n'
printf 'Authorization: Bearer %s\n' "$LUMEN_PROJECT_API_KEY" |
  curl --silent --show-error --header @- \
    --header 'Content-Type: application/json' \
    --data '{"original_filename":"clip.mp4","mime_type":"video/mp4","file_size_bytes":1024}' \
    http://127.0.0.1:3000/v1/media
unset LUMEN_PROJECT_API_KEY
```

The registration response includes the asset ID and a separate single-use upload
token; treat that response as sensitive. Upload raw MP4 bytes to the returned upload
URL using that upload token as Bearer authorization. Subsequent metadata, thumbnail,
and rendition requests use the project API key. See [the endpoint table](../Readme.md#http-api-and-authentication).
For remote deployment use authenticated HTTPS; loopback HTTP here is local development.

## 6. List, rotate, and revoke

```sh
npm run provision -- key:list --database lumen --role lumen --project-id '<project-uuid>'
npm run provision -- key:rotate --database lumen --role lumen \
  --project-id '<project-uuid>' --key-id '<predecessor-uuid>' --name 'Replacement'
# Only after deploying and verifying the replacement:
npm run provision -- key:revoke --database lumen --role lumen \
  --project-id '<project-uuid>' --key-id '<predecessor-uuid>'
```

Listing is read-only and returns metadata, never secrets or hashes. Revocation is
idempotent and preserves its first timestamp. Rotation is incomplete until the
replacement is deployed and verified and the predecessor explicitly revoked.
Expired/revoked predecessors cannot be rotated; use `key:issue` instead.

Read [lifecycle recovery](api-key-lifecycle.md) before retrying any failed write.
Unknown COMMIT outcomes return no secret. Inspect recovery UUIDs using the listing
commands; a failed display or process exit does not prove rollback. Revoke an
unusable committed key before issuing another. Issuance/rotation are not idempotent,
and no predecessor relationship is persisted; duplicate/concurrent requests can
produce multiple replacements. Revocation does not cancel in-flight requests,
background jobs, or separately issued upload tokens.

## Development versus disposable verification

Development settings use persistent data and the operator's actual database authority.
Do not run destructive tests against them. `npm test` is database-free and does not
load `.env`. Guarded integration commands use a separate cluster, role, Redis, network,
and marked disposable storage; follow the [isolated guide](isolated-integration-tests.md)
with explicit approval for a new run. Inside that runner the expected identities are
`--database lumen_test --role lumen_test_runner`, not the development examples above.
Never change guards or publish its database merely to automate terminal testing.

Batch 3 verified the live service and noninteractive CLI boundaries. Successful
interactive secret delivery against a live database remains unverified. See
[the readiness/security review](milestone-3.6-security-review.md).
