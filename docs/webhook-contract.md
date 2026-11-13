# Milestone 3.7 Batch 1 — webhook contract and migration

Batch 2 adds operator endpoint management, AES-GCM storage, and additive migration
004; see [endpoint management](webhook-endpoint-management.md). The Batch 1
verification below is historical and does not cover these additions.

Batch 1 provided schema preparation only, without producers, endpoint commands,
encryption, transport, a sender, retry scheduling, or retention cleanup. Media
dispatch is unchanged. **Do not generate webhook outbox records:** the existing
publisher treats all unpublished rows as media jobs. Typed routing and delayed
publication must be implemented and verified before enabling webhook producers.

## Event contract

| Type | Durable meaning | Logical deduplication key |
| --- | --- | --- |
| asset.ingested | Original ingestion committed; metadata, thumbnails, and transcoding may be pending | asset:<asset UUID>:ingested |
| asset.failed | Ingestion state durably entered failed | asset:<asset UUID>:failed |
| rendition.ready | A specific rendition output/version committed | rendition:<job UUID>:ready |
| rendition.failed | A rendition job permanently exhausted retries | rendition:<job UUID>:failed |

No metadata/thumbnail events or aggregate processing-complete events are defined.
An HTTP error without a committed failed ingestion transition is not asset.failed.
Future producers must atomically commit business state, event, deliveries, and
dispatch records. Delivery is at least once, never exactly once.

Every version-1 envelope contains exactly `id`, `type`, `schema_version: 1`,
`created_at`, `project_id`, and `data`. UUIDs are lowercase canonical UUIDs (version
1–8, standard variant). Real UTC timestamps use `YYYY-MM-DDTHH:mm:ss.SSSZ`, years
0001–9999. Envelope ID/project/type/time must match the row columns.

Data is an exact allowlist:

- asset.ingested: `asset_id`, `stage: "ingestion"`, `status: "ready"`.
- asset.failed: `asset_id`, `stage: "ingestion"`, `status: "failed"`,
  `error: { code: "INGESTION_FAILED" }`.
- rendition.ready: `asset_id`, `job_id`, `profile`, `status: "ready"`, `output_id`,
  positive integer `version` no greater than 2,147,483,647.
- rendition.failed: `asset_id`, `job_id`, `profile`, `status: "failed"`,
  `error: { code: "TRANSCODING_FAILED" }`.

Profiles are 360p/480p/720p/1080p. There are no raw exceptions, paths, FFmpeg stderr,
arbitrary metadata, signing secrets, or API credentials. Producers must map internal
errors to these public codes. TypeScript and SQL enforce the same allowlists.

Logical uniqueness is `(project_id, event_type, deduplication_key)`, independent of
event/attempt/dispatch UUIDs and timestamps. Another processing job can generate
another rendition outcome. Preventing contradictory ready/failed outcomes for a
single job remains the future producer's fenced state-transition responsibility.

## Immutable bytes

New inserts explicitly supply schema version 1, matching envelope/row fields, and
the canonical deduplication key. Omit `payload_bytes`: PostgreSQL materializes
`convert_to(payload::text, 'UTF8')` once on INSERT. If supplied, bytes must match
that representation exactly. A raw body with contradictory/duplicate JSON keys
cannot be substituted for the stored envelope. The maximum is 64 KiB.

This format is PostgreSQL JSONB text, not JavaScript JSON.stringify or a universal
canonical JSON standard. Future HMAC signing/retries must read persisted BYTEA
verbatim. Version-1 event updates, downgrades, and legacy UPDATE promotion are
rejected; no-op updates are allowed. Database upgrade/restore procedures must
preserve and verify these bytes rather than regenerate them.

## Migration 003 and compatibility

Historical IDs, URLs, ciphertext, payloads, timestamps, statuses, attempt counts,
and error records are preserved. The migration does not assume empty tables.

- Existing endpoints become config version 0 with empty subscriptions and no key
  metadata/slot. Their original enabled flag is not rewritten.
- Existing events become schema version 0 with NULL deduplication keys and bytes.
  No historical envelope is relabeled or fabricated.
- Existing deliveries/attempts become contract version 0. Historical delivering
  states without lease metadata and attempt counts above eight remain valid.
- Only the new attempt project_id is backfilled, from its existing enforced
  delivery FK, before NOT NULL and composite ownership constraints are installed.
- Outbox available_at defaults to migration/current transaction time, so existing
  records are immediately due and new media inserts retain immediate defaults.
  The current publisher ignores this field; scheduling is not implemented yet.

Future senders must require version 1 throughout. New composite foreign keys match
project, event/endpoint/delivery identity, and contract version. Existing project
FKs and unique event/endpoint and delivery/attempt constraints remain intact.
Legacy records remain history, never an implicit dispatch backlog.

Re-enroll legacy destinations as new version-1 rows with fresh authenticated
ciphertext. Do not reinterpret old ciphertext. Historical references deliberately
prevent in-place parent version changes; no automatic legacy adoption is provided.

A version-1 enabled endpoint needs slot 1–5, unique per project; disabled endpoints
have no slot. This enforces five dispatchable active endpoints without a count race.
Legacy enabled rows are not enrolled/dispatched and are not assigned slots.
Subscriptions are a nonempty, one-dimensional, duplicate-free subset of supported
types, without NULL elements. Current/previous key identifiers differ. Previous
key ID, ciphertext, start, and expiry are all-or-none; timestamps are finite,
strictly increasing, and at most 24 hours apart. The schema validates nonempty
ciphertext bytes only, not cryptographic authenticity; Batch 2 adds application-level
AES-GCM authentication and migration 004 metadata admission.

Version-1 delivering rows require owner/token/finite lease expiry; other states
require cleared lease fields. New counters/attempt numbers are bounded by eight.
Attempts require fencing metadata and composite ownership. Checking live lease
ownership and atomically renewing/completing attempts remain worker responsibilities.

Indexes cover logical uniqueness, active slots, signing-key IDs, due deliveries,
expired delivery leases, FK targets, and available unpublished outbox records.

Down deliberately raises an exception: removing wire/rotation/ownership metadata
would discard history. Rollback requires a reviewed forward migration. Up takes
table/index/validation locks and backfills a new column; obtain a backup and plan
a maintenance window for large tables. No migration was applied in this batch.

## Approved future security and defaults

- HMAC-SHA256 timestamped signatures over stored bytes; stable event identifiers.
- AES-256-GCM secrets with encryption key outside PostgreSQL, no plaintext fallback;
  bounded 24-hour dual-secret overlap.
- Operator management only; no public management HTTP API or media-key privileges.
- HTTPS port 443, hostname allowlist, no redirects, DNS validation and socket pinning.
  Storing a URL does not approve its destination; validation is future transport work.
- Eight attempts; exponential jittered backoff, one-minute base/one-hour cap;
  delivery age at most 24 hours.
- Ten-second HTTP deadline; global concurrency four, per endpoint one.
- Request at most 64 KiB; response headers at most 16 KiB.

The immutable TypeScript policy constants record defaults only; no delivery,
encryption, endpoint management, or automatic retention behavior is activated.

## Verification boundaries

Database-free tests cover event validation, public errors, logical keys, policy,
migration allowlisting, Up/Down separation, and static schema contracts. They do
not execute SQL or prove PostgreSQL constraints/triggers.

Guarded `src/database/webhook-schema.integration.test.ts` adds nonempty 001/002-to-003
upgrade checks in a dedicated empty fixture schema, original-field preservation,
wire-byte/immutability tests, deduplication, slots/overlap, ownership/fencing, and
outbox availability. It retains disposable preflight/TestPool guards and uses full
ROLLBACK after expected SQL failures. Bootstrap creates the fixture schema owned by
the restricted test role; the test verifies ownership and emptiness, applies
001/002, seeds legacy data, and applies 003 inside one rolled-back transaction.
It does not require granting CREATE on the database.

Batch 1B executed these tests against disposable PostgreSQL 17.11: 53 cases and
101 assertion calls passed, including two real concurrent slot conflicts. The
complete guarded suite passed 484 cases across 33 files with 3,098 assertion
calls. See [the verification record](webhook-schema-verification.md).
