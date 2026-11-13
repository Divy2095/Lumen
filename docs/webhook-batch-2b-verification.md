# Milestone 3.7 Batch 2B — isolated verification and security review

## Isolation

Docker context `rootless` uses rootless Podman with SELinux. Run project:
`lumen-it37-2b-c872d8e8c458`. The development containers `lumen-postgres` and
`lumen-redis` were stopped at preflight; no development API, worker, or outbox
publisher process was found in the workspace. Existing development resources were
inventoried before creating test resources and were never used for test connections.

The test Compose configuration has an internal project-owned network, no published
ports, no named data volumes, and no development storage or credential mounts.
PostgreSQL data, Redis data, and runner storage use tmpfs. The sole host bind is the
read-only test bootstrap with SELinux labeling. Fresh independent test credentials
and a run token were generated in an ignored mode-0600 environment file. Test
identity is `postgres-test:5432`, database `lumen_test`, role `lumen_test_runner`;
Redis uses authenticated `redis-test:6379`, DB 0.

Existing guards remain required: explicit destructive-test opt-in, exact test
endpoints, connected current/session identity, restricted privileges/no access to
other databases, immutable administrator-owned marker/run token, Redis marker,
and canonical storage marker. TestPool checks each statement on the same physical
connection; only full ROLLBACK is exempt for recovery.

## Review boundaries

This batch adds verification, not destination delivery. No signing, DNS resolution,
HTTP transport, fanout, event producers, or retry scheduling is introduced.

Inspection confirmed that destination credentials are rejected before CLI previews;
allowlisting uses exact ASCII DNS names; IPv4/IPv6 literals, alternate numeric IP
representations, fragments, unsupported ports, and ambiguous authorities are
rejected. An allowlist is not DNS/SSRF protection: future delivery still needs
independent address validation, connection pinning, TLS verification, and no redirects.

AES keys remain outside PostgreSQL. Metadata output is explicitly selected and
excludes ciphertext/secrets. No plaintext persistence fallback or automatic write
retry is present. Missing/wrong keys and AAD authentication failures stop management.
Referenced external AES keys must remain available even after overlap expires until
previous ciphertext is retired or replaced. No external-key re-encryption/retirement
is implemented.

## Historical trigger policy

Migration 004 preserves historical ciphertext and leaves both new identifiers NULL.
Version-0 endpoint updates remain possible under the existing version-0 constraints.
No-op historical version-1 updates remain possible. Any changed historical version-1
row requires complete encryption metadata; this includes changing enabled/slot,
subscription, timestamps, signing metadata, or ciphertext. Its URL cannot change,
and it cannot be downgraded. Such rows are intentionally excluded from management
until provenance is explicitly resolved through a separately reviewed procedure.
No identifier is guessed, and there is no automatic CLI adoption path.

New version-1 inserts require complete metadata. Previously managed rows cannot
clear that metadata. SQL CHECK constraints pair previous encryption IDs with the
existing previous-secret fields. Ordinary insert-select, upsert, upgrade, downgrade,
metadata-clear, and URL-change paths are included in the live regression coverage.
These checks do not attempt to constrain a database owner deliberately disabling
triggers or rewriting the schema.

## PTY procedure

`infra/test/webhook-pty.py` is a host-only Python-standard-library harness. It requires
an authorized, existing isolated project and its ignored credentials file. It
checks isolation and executes the existing preflight before setup. Example for
this run (requires fresh authorization before repeating infrastructure operations):

```sh
python3 infra/test/webhook-pty.py --project lumen-it37-2b-c872d8e8c458 --env-file .env.integration.lumen-it37-2b-c872d8e8c458
```

It exercises the real CLI entrypoint and database with a real pseudo-terminal,
uses typed confirmation, captures transcripts only in memory, and prints no issued
secrets, ciphertext, or AES keys. Disposable AES keys and expected secrets travel
through subprocess environments, never process arguments or tracked files. Guarded
readback compares the revealed bytes with committed ciphertext. Test-owned projects,
accounts, and any leftover named runner containers are cleaned up specifically.
Python diagnostic checks are reported separately from Node assertion-call counts.

## Executed migration paths

Both ran on PostgreSQL 17.11 as `lumen_test_runner` in `lumen_test`:

1. Fresh main database: the existing guarded migration command applied 001, 002,
   003, 004 in order. Registry readback listed all four; no webhook constraint was
   unvalidated. The focused live cases and PTY scenario then passed.
2. Actual upgrade: after recreating only this run's disposable tmpfs services and
   repeating preflight, the same guarded client/migration plan applied only the
   first three migrations with node-pg-migrate's `count: 3`. Registry readback
   confirmed exactly 001–003. Three historical endpoints were seeded: version 0,
   version 1 without previous metadata, and version 1 with previous ciphertext.
   The normal guarded migration command applied only pending 004. SHA-256 hashes
   of all original endpoint fields (including exact ciphertext bytes) matched
   afterward; both new IDs remained NULL. Listing returned no managed rows, and
   selection of every historical endpoint returned `WEBHOOK_UNMANAGED`.

The registered schema test additionally upgrades a nonempty 001–003 fixture
inside the dedicated owned schema under full transaction rollback. Both old
version-1/legacy ciphertext and original fields survive, version-0 operational
updates and no-op version-1 updates succeed, and changed incomplete version-1
configuration is rejected. New managed inserts, partial current/previous metadata,
invalid/bounded identifiers, metadata clearing, URL changes, insert-select,
ON CONFLICT updates, attempted adoption, and downgrade constraints passed live.

No migration SQL correction was required. Migrations 003 and 004 are unchanged.

## Encryption, lifecycle, and concurrency results

The real database stored versioned AES-GCM ciphertext and the configured key IDs,
not the signing plaintext. Correct-key decryption matched the issued bytes.
Wrong/missing AES keys, modified ciphertext and incorrect project/endpoint/signing
UUIDs failed authentication. Metadata output excluded secret/ciphertext values,
and existing-project cross-project selection/mutation was denied. Rotation using
a different current AES ID retained the old ID/ciphertext for overlap.

Separate PostgreSQL sessions contended under bounded statement/lock timeouts:

- Rotation held project then endpoint locks. Query coordination recorded that
  exact order and the database-clock check after both locks. The competing session
  was observed blocked via `pg_blocking_pids`; one rotation committed and the other
  rejected active overlap.
- With four active endpoints, competing creations were coordinated at the project
  lock. PostgreSQL blocking was observed; one obtained the fifth slot, the other
  rejected `WEBHOOK_SLOTS_FULL`, and exactly five active endpoints remained.
- Existing schema-level concurrent slot tests also passed with owner COMMIT and
  owner ROLLBACK. These are live tests, distinct from database-free lock models.

Expired overlap was replaced, active overlap rejected, retirement cleared previous
eligibility, and persisted intervals of one and 24 hours matched policy. Stored
start time was bounded by database clock readbacks. Values above 24 hours were
rejected. A failure injected after a real SQL rotation update rolled back current
and previous ciphertext together.

Fault-injection tests ran the real CLI logic with a terminal IO adapter and guarded
PostgreSQL. A post-insert failure rolled back to zero endpoint rows; a failure
injected after PostgreSQL had executed COMMIT left one committed row. Both returned
no secret, performed only one insert, and suppressed internal diagnostics. The
uncertain outcome returned recovery IDs. This tests deterministic response loss
through a query adapter, not a physical network outage or process crash.

The successful host PTY scenario exercised all seven actual commands, typed
confirmation, cancellation, identity mismatch, nonterminal rejection, overlap
rejection, and idempotent retirement. Create and rotate each revealed exactly once;
guarded readback verified the revealed bytes matched committed ciphertext. No
prior secret, ciphertext, AES key, or credential-bearing URL appeared in captured
metadata/error output. Transcripts were never printed or written to files.
The scenario also passed on the upgraded database. The final harness reported
135 Python diagnostic checks (independent of PTY read chunking), including
explicit per-AES-key output checks, counted separately below.
This closes successful PTY coverage for webhook commands; it does not constitute
a successful live PTY test of Milestone 3.6 API-key issuance.

## Actual results

| Run | Files | Cases | Assertion calls | Result |
| --- | ---: | ---: | ---: | --- |
| Focused database-free | 4 | 24 | 239 | Passed |
| Complete database-free | 25 | 281 | 2,433 | Passed |
| Focused live schema/lifecycle | 2 | 27 | 109 | Passed |
| Complete guarded suite | 38 | 533 | 3,436 | Passed |

The original 15 Batch 2 live cases all executed; 12 additional live cases expanded
coverage. All Node runs reported zero failures, cancellations, skips, or todos.
The complete guarded suite includes the focused cases; counts are not additive.
It also rechecked the existing authenticated upload/finalization → outbox → BullMQ
→ worker → FFprobe/thumbnail/FFmpeg rendition path and provisioning/authentication.
Process-isolated runner counts exclude file wrappers and require assertion calls.
The separate final PTY scenario's 135 checks are not Node test cases/assertion calls.

TypeScript typecheck, migration-plan validation, Compose configuration/runtime
isolation validation, CLI parsing/help checks, Python syntax validation, and
`git diff --check` passed. Database-free process-isolated checks required minimal
sandbox escalation for subprocess capture. No host dependencies were installed.
Image building used `npm ci` and existing packaged FFmpeg requirements only.

## Security findings, scope, and remaining limits

No confirmed Batch 2 production defect required remediation. Only regression
tests, a host-only PTY harness, and verification documentation changed in this
batch. The harness explicitly pins credentials from this run's ignored file,
validates project/network/mount identity, bounds execution/output, and limits
cleanup to its own UUID-scoped test rows and uniquely named runner containers.

This is not production-scale or adversarial migration-load verification. Tests do
not exhaust arbitrary historical data or migration lock duration. Failed writes
were injected at query boundaries; physical connection loss and process crashes
were not forced. Terminal recordings/scrollback and operator/host compromise remain
outside the CLI's confidentiality guarantees. Database owners can intentionally
bypass schema controls; ordinary insert/update paths cannot bypass tested guards.
No new dependency upgrades were performed; the existing migration-tool advisory
limitations remain documented separately.

## Cleanup and final inventory

Targeted teardown removed only this project's PostgreSQL/Redis containers,
internal network, two runner images built during the run, and dedicated buildx
builder/cache volume. The generated credential file, temporary orchestration,
manifest, and Python bytecode were removed. Download caches/base-image layers may
remain; no broad cleanup command was used.

Baseline comparison passed for the existing development container IDs, stopped
states, start/finish timestamps, mount attachments and volume metadata. Final
inventory contains only `lumen-postgres`, `lumen-redis`, their original named data
volumes, and the original `bridge`/`lumen_default` networks. No development API,
worker or outbox publisher was running afterward. Development contents were not
read or reset to produce this comparison; no development connection was used.

Exact files changed in Batch 2B (earlier uncommitted batch files remain preserved):

- `src/database/webhook-encryption.integration.test.ts`
- `src/modules/webhooks/webhook-management.integration.test.ts`
- `infra/test/webhook-pty.py` (new)
- `docs/webhook-batch-2b-verification.md` (new)
- `docs/webhook-endpoint-management.md`
- `docs/isolated-integration-tests.md`

No files were staged, committed, or pushed. No signing secret, external AES key,
private key, or generated test credentials were added to source files.
Batch 3 was not started.
