# Milestone 3.7 Batch 1B — live schema verification

Verified on 2026-11-13 using rootless Podman through Docker context `rootless`.
Disposable Compose project: `lumen-it37-7c8667c9ce747d3b`.

## Isolation and migration evidence

Compose and actual container inspection confirmed a project-owned internal
network, no published ports, no named data volumes, tmpfs PostgreSQL/Redis/storage,
and only the read-only test bootstrap bind mount. Fresh credentials were generated
in an ignored mode-0600 environment file. The existing development PostgreSQL and
Redis containers were stopped and were not used.

The existing preflight verified PostgreSQL identity, restricted-role privileges,
the administrator-owned disposable marker/run token, authenticated Redis marker,
and canonical test storage markers. TestPool retained same-connection checks.
The migration allowlist and all safety guards remained enforced.

`test:integration:migrate` applied 001, 002, and 003 in order. Readback identified
PostgreSQL 17.11, database `lumen_test`, role `lumen_test_runner`, all three migration
registry entries, and zero unvalidated webhook constraints.

## Live coverage

- Actual pre-003 upgrade: apply 001/002 in the dedicated fixture schema, insert
  seven legacy endpoints, two legacy events, one delivery, and one attempt; apply
  003. All original fields survived. Version-0 subscriptions, signing metadata,
  payload bytes, and lease metadata remained unconfigured. Attempt project
  ownership was backfilled; composite relationships and constraints validated.
  Unicode legacy payload text survived unchanged. All fixture work rolled back.
- Endpoint constraints: five active version-1 slots, sixth/duplicate rejection,
  subscription membership/uniqueness, complete rotation metadata, different key
  IDs, finite positive overlap, exactly 24 hours accepted and longer rejected.
- Event constraints: all four approved envelopes, public failure-code allowlists,
  malformed/extra fields and mismatched bytes rejected, logical deduplication,
  and immutable event identity/project/type/version/payload/bytes/time/logical key.
- Ownership/version FKs: cross-project endpoints and attempts rejected; version-1
  deliveries cannot reference legacy endpoints/events; delivery uniqueness kept.
  Lease ownership, finite expiry, attempt limits, and required fences checked.
- Real concurrency: two separate PostgreSQL connections contended for slot 5,
  with a third connection observing `pg_blocking_pids`. Owner COMMIT made the
  waiting insert fail with unique violation; owner ROLLBACK let it commit. Both
  finished with five active endpoints. Timeouts bounded lock waits and tests.
- Outbox: immediate default and future `available_at` persisted; catalog readback
  verified the partial `(available_at, created_at, id)` unpublished-row index.
  No webhook dispatch records or producers were added.

## Exact bytes

Persisted bytes matched a literal expected UTF-8 JSON string, including JSONB
field ordering and millisecond UTC `Z` timestamps. Reversed input field order and
Unicode escapes for ASCII digits normalized to identical stored bytes. Fatal
UTF-8 decoding succeeded; readback and a no-op update under a non-UTC session
timezone preserved every byte. Attempts to replace immutable fields were rejected,
including a replacement with otherwise valid payload, logical key, and bytes.

The approved version-1 fields contain ASCII UUIDs, enums, codes, and timestamps;
there is no free-text Unicode field. A non-ASCII replacement for an enum was
rejected; legacy Unicode text was separately preserved. Future signing must read
the stored bytes, not depend on reserializing JSONB in another process or version.
HMAC and encryption were not implemented or tested.

## Results

| Check | Cases | Assertion calls | Result |
| --- | ---: | ---: | --- |
| Focused live webhook schema file | 53 | 101 | Passed |
| Complete guarded suite, 33 files | 484 | 3,098 | Passed |
| Database-free suite, 22 files | 259 | 2,204 | Passed |

All suites reported zero failures, cancellations, or skips. The complete guarded
suite includes the authenticated upload → outbox → BullMQ → worker → FFprobe,
thumbnail and FFmpeg rendition path, plus provisioning/authentication/project
isolation regressions. Assertion calls are counted by the existing preload;
file wrappers are not counted as cases. Typecheck, migration-plan validation,
Compose validation, and whitespace checks also passed.

## Corrections and limits

The upgrade fixture originally required CREATE SCHEMA, which the restricted role
cannot perform. Disposable bootstrap now pre-creates one empty schema owned by
that role; the test checks it before use. No database privilege was broadened.
Only this run's initially empty services were recreated to load the fixture;
development resources were excluded. No live migration-003 failure required a
SQL correction.

This verifies the current schema on PostgreSQL 17.11, not arbitrary historical
data sizes or production migration lock duration. Endpoint management, encrypted
secret storage, signing, pinned-DNS transport, typed outbox routing, producers,
delivery workers, and retries remain future work. No signing readiness is inferred
from preserved legacy ciphertext.

## Teardown

Targeted teardown removed this project's containers/network, the two runner images
built for this run, and its dedicated buildx builder. The generated credential file
was removed. Before/after comparison confirmed the original development container
IDs, stopped states, start/finish times, mount attachments, and volume metadata
were unchanged. No development database connection or content inspection was used.
Downloaded base-image caches may remain; no broad resource cleanup was performed.
