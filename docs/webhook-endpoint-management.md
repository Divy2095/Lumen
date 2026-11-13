# Operator webhook endpoint management — Milestone 3.7 Batch 2

This is a local operator CLI, using PostgreSQL authority. Ordinary media API keys
cannot manage destinations. There is no public management HTTP API, sender,
signing implementation, event producer, retry scheduler, or delivery worker yet.
Accounts remain unverified ownership metadata, not authenticated identities.

## Setup

Review migrations 001–004 and apply them through the normal approved migration
procedure. Do not use development data for integration testing. Migration 003 is
unchanged from Batch 1B; 004 adds encryption-key identifiers and guarded management
admission. The guarded disposable migration plan now allowlists exactly 001–004.
No migrations were executed as part of Batch 2.

Configure the operator process with:

- `WEBHOOK_HOSTNAME_ALLOWLIST`: explicit, comma-separated, lower-case ASCII DNS
  hostnames. Exact matches only, no wildcards, ports, URLs, IP literals, or trailing
  dots. Punycode hostnames must be explicitly listed in their ASCII form.
- `WEBHOOK_ENCRYPTION_KEY_ID`: current external AES-key identifier, 1–64 ASCII
  letters/digits/underscore/hyphen, beginning with a letter or digit.
- `WEBHOOK_ENCRYPTION_KEYS`: JSON object mapping up to 16 identifiers to independent
  32-byte AES keys encoded as 64 lower-case hexadecimal characters. The current
  ID must exist. Generate key material securely outside this CLI and inject it
  through a secret manager or an ignored environment file with mode 0600.
  Do not paste keys into command arguments, shell history, tracked files or logs.

The CLI never generates or replaces an external AES key. Missing, unknown, wrong,
or malformed keys fail closed. Keep **every key referenced by current or previous
ciphertext** available; expiration alone does not delete previous ciphertext.
This batch does not re-encrypt stored secrets or retire external AES keys.
Webhook metadata reads also require valid encryption configuration and authenticate
stored ciphertext; they never reveal the decrypted secret or ciphertext.

## Commands

Examples use placeholders only. Use the intended database/role and explicit UUIDs.
For an authorized disposable test run these are `lumen_test`/`lumen_test_runner`,
not the development identities shown below.

```sh
npm run provision -- webhook:help
npm run provision -- webhook:create --database lumen --role lumen --project-id '<project-uuid>' --url https://hooks.example.com/lumen --events asset.ingested,rendition.ready
npm run provision -- webhook:list --database lumen --role lumen --project-id '<project-uuid>'
npm run provision -- webhook:show --database lumen --role lumen --project-id '<project-uuid>' --endpoint-id '<endpoint-uuid>'
npm run provision -- webhook:disable --database lumen --role lumen --project-id '<project-uuid>' --endpoint-id '<endpoint-uuid>'
npm run provision -- webhook:enable --database lumen --role lumen --project-id '<project-uuid>' --endpoint-id '<endpoint-uuid>'
npm run provision -- webhook:rotate-secret --database lumen --role lumen --project-id '<project-uuid>' --endpoint-id '<endpoint-uuid>' --overlap-hours 24
npm run provision -- webhook:retire-previous-secret --database lumen --role lumen --project-id '<project-uuid>' --endpoint-id '<endpoint-uuid>'
```

Replace angle-bracket placeholders before executing these shell examples.
Supported subscriptions are exactly `asset.ingested`, `asset.failed`,
`rendition.ready`, `rendition.failed`. Supply a nonempty comma-separated set without
repeats. The service stores subscriptions in contract order.

The configured database/user must match the explicit database/role, and the same
connected session must match current database, current role, and session role.
Writes require both stdin and stdout to be terminals and an exact typed phrase
containing the command, database, role, project ID and selected endpoint ID.
There is no unattended `--yes`. Reads may use redirected output, containing only
explicitly selected non-secret metadata.

## Creation, lifecycle and rotation

Creation requires an active project, valid destination/subscriptions and one free
slot among five active version-1 endpoints. It generates an independent 32-byte
signing secret and UUID signing-key ID. The secret is revealed as unpadded base64url
only after confirmed COMMIT. Future signing/receiver implementations must agree to
use the decoded 32 bytes, not the UTF-8 bytes of the displayed base64url string.

Disable clears the slot; enable rechecks the allowlist and obtains a free slot.
Both are idempotent. Create, enable and rotate require an active project; disable
and previous-secret retirement remain available for inactive projects. URLs are
immutable. Management never silently adopts version-0 or incomplete historical
version-1 rows. Listing excludes them; selection/mutation rejects them.
Future fanout must independently require enabled version 1 with complete encryption
metadata and an active project. No fanout is implemented in this batch.

All writes lock project before endpoint. Slot allocation and rotation decisions
are serialized for that project, with SQL uniqueness as an additional defense.
Rotation copies current ciphertext/signing ID/encryption-key ID into the previous
fields and encrypts a fresh independent secret under the configured current AES
key. Default overlap is 24 hours; explicit whole hours 1–24 are accepted. It uses
database clock time after locks, not the transaction start timestamp.
A second rotation during an active overlap is rejected. Explicit retirement may
end overlap early; do this only after deploying the new secret. At the exact expiry
instant a new rotation may replace expired previous metadata. No background expiry
cleanup occurs; future delivery must never use a previous secret at/after expiry.
The two stored ciphertexts may reference different external AES keys.

## Cryptographic storage

AES-256-GCM wire format: byte `0x01`, random 12-byte nonce, 16-byte authentication
tag, 32-byte ciphertext (61 bytes total). Authenticated additional data is UTF-8
`JSON.stringify` of this ordered array:

`["lumen-webhook-secret",1,encryptionKeyId,projectUuid,endpointUuid,signingKeyUuid]`

UUIDs are canonical lower-case. The format version and every key/ownership ID are
bound to authentication. Changing ciphertext, nonce, tag, external key, or any
AAD identity fails decryption. Encryption key IDs are non-secret metadata; AES
key material stays outside PostgreSQL. Secret buffers are cleared after use where
possible, but JavaScript strings and runtime copies cannot be reliably erased.

## Migration compatibility and recovery

004 adds nullable bounded current/previous encryption-key identifiers without
rewriting ciphertext or assigning IDs to old rows. CHECK constraints permit the
historical all-NULL state. A trigger distinguishes existing rows from new writes:
new or changed version-1 endpoints require complete metadata; no-op historical
updates are harmless. Current metadata requires matching previous metadata when
previous-secret rotation fields exist. Existing version-1 URLs cannot change or
be downgraded. 004's Down path refuses to discard key identifiers.

Historical endpoints with unknown encryption keys remain unusable. There is no
CLI repair/adoption command. Any resolution needs separate review and verified
key provenance; do not guess an identifier or label unknown bytes as ciphertext.

If COMMIT fails or its response is lost, no secret is revealed. Inspect the
reported project/endpoint/signing-key recovery IDs before another action; do not
retry blindly. If COMMIT succeeded but terminal output failed, IDs identify the
persisted record. There is no plaintext recovery command. For a lost newly created
secret, inspect and rotate it. For a lost replacement with an active overlap,
coordinate deployment/recovery before explicitly retiring previous metadata to
permit another rotation. Retiring the previous secret can remove the last usable
receiver credential. A failed reveal may have partially reached the terminal.
Disable recording and keep the terminal private; scrollback and shoulder surfing
remain risks. Batch 2B later verified successful webhook create/rotate reveal through a real
PTY; terminal recording and partial-output risks still apply.

## Destination and delivery boundary

Only literal `https://` URLs with DNS hostnames and default/explicit port 443 are
accepted. Credentials, fragments (including empty fragments), controls, whitespace,
backslashes, IP literals and alternate numeric IP forms, percent-encoded authority,
trailing-dot hosts, dot segments and encoded path separators are rejected. URLs
are canonicalized before storage. Queries are supported after a `/` path; do not
put credentials in destination URLs because URLs are operator-visible metadata.

An allowlist does **not** prevent DNS rebinding or DNS resolving to private/cloud
metadata addresses. This batch makes no outbound requests. Future transport must
independently validate all IPv4/IPv6 DNS results, pin the approved connection
address, verify TLS, prohibit redirects, and apply all agreed timeout/body/header
limits. Endpoint configuration alone is not evidence that delivery is safe.

## Verification

Database-free tests cover encryption/AAD/tampering/configuration, destinations,
subscriptions, service lifecycle and modeled lock ordering, terminal/confirmation
policy, recovery/redaction, and migration-plan safety. Modeled concurrency does
not prove PostgreSQL behavior.

Guarded `webhook-encryption.integration.test.ts` adds fresh registry/schema checks,
actual 001–003 → 004 upgrade with nonempty historical rows, immutable URLs, and
metadata constraints. `webhook-management.integration.test.ts` adds encrypted
persistence, project isolation, rotation/retirement, multiple AES IDs, real CLI
reads/nonterminal rejection, and a bounded real PostgreSQL lock-contention test.
These live tests were not executed in Batch 2. Batch 2B subsequently ran the
expanded cases on authorized disposable infrastructure; see
[the Batch 2B verification record](webhook-batch-2b-verification.md). Batch 1B's 484-case/3,098-assertion run
predates 004 and this service; it does not verify these additions.

Batch 2 database-free verification: 24 focused cases across four files with 239
assertion calls, and 281 complete cases across 25 files with 2,433 assertion calls.
Both reported zero failures, cancellations, or skips. Typecheck, migration-plan
validation, CLI parsing/help checks, and `git diff --check` passed. Process-isolated
tests required execution outside the sandbox's subprocess-capture restriction.
Batch 2 originally registered 15 live cases. Batch 2B executed all of them and
expanded the focused live set to 27 cases / 109 assertion calls. Its complete
guarded run passed 533 cases across 38 files with 3,436 assertion calls, and its
real PTY scenario exercised all seven commands. These are separate from the
Batch 2 database-free verification above.
