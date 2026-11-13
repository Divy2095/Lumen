# Disposable integration testing

Batch 4A prepared this environment; Batch 4B subsequently verified it. Historical
results: 336 cases and 2,239 assertion calls, all passing, including the complete
authenticated upload-to-rendition pipeline. See batch-4b-verification.md. Each new
run still requires explicit authorization for infrastructure and destructive setup.

## Isolation architecture

Use **only** compose.test.yaml, never merge it with compose.yaml. Supply a unique
Compose project name per run. No service declares a fixed container/volume name,
external network, published port, development bind mount, or persistent data volume.
The project-scoped internal network contains:

- postgres-test:5432, PostgreSQL 17, database lumen_test. The bootstrap admin is
  lumen_test_admin; tests use lumen_test_runner, a separate login with no elevated
  flags or role memberships. It cannot connect to postgres/template1; no development
  database exists in this separate cluster. Only the admin owns the safety marker.
- redis-test:6379, Redis 7, DB 0, with independent authentication, persistence
  disabled, and a per-run identity marker. It is a different server from development.
- test-runner, Node 24 and packaged FFmpeg/FFprobe. Source is copied into the image;
  no host .env, credentials, development storage, or node_modules are mounted.

PostgreSQL data and Redis /data use tmpfs. Runner storage is a separate tmpfs at
/lumen-test-storage; /tmp also uses tmpfs. Container removal discards these files.
Image building needs network access for base images, apt packages, and npm ci.
This installs existing locked dependencies inside the test image, not on the host.

## Fail-closed preflight and connection checks

The integration runner and direct integration-file imports run preflight before
setup. Default npm test runs only explicitly reviewed database-free files and
never loads .env. Unknown test files require classification before running.

Integration requires all of:

1. LUMEN_ALLOW_DESTRUCTIVE_TESTS=1, exact allowlisted PostgreSQL/Redis endpoints,
   database lumen_test, role lumen_test_runner, Redis DB 0, and dedicated storage.
2. Independently generated 64-character lowercase hex credentials and token.
3. Connected database, current/session user, and server port match the allowlist.
   The role has no superuser, creation, replication, bypass-RLS, membership, or
   connection privileges to other connectable databases in this cluster.
4. Exactly one administrator-owned row in
   lumen_test_safety.disposable_environment with the expected purpose and token.
   The runner cannot modify the marker table or create objects in its schema.
5. The authenticated Redis server returns the same per-run token.
6. Canonical disposable storage and its token marker match. Fixture setup and
   recursive teardown reject roots, escapes, non-normalized paths, and symlinks.

TestPool wraps each physical pg client. Safety queries execute using that client's
original query method before each setup/teardown statement, including callback
queries. ROLLBACK alone remains available if configuration changes or a transaction
is aborted; it cannot be combined with destructive SQL to bypass the guard.
API/worker application pools retain production behavior; they run inside the
preflight-verified test-only network with restricted test credentials.

The marker is an accident-prevention boundary, not protection against an operator
who deliberately fabricates all credentials, markers, and infrastructure. Filesystem
checks likewise assume no hostile local writer racing the service-owned tmpfs.

## Test runner

npm test runs reviewed database-free files with normal process isolation and
concurrency 1. test:integration runs the complete discovered suite after preflight.
Each selected file must emit real named test cases and execute assertions; file
wrappers and empty/no-op files are insufficient. The preload counts the assertion
methods used by this repository (including calls inside rejection callbacks), not
logical propositions or assertions per individual test. New assertion APIs require
updating the instrumentation. Failures, missing real cases/assertions, and integration
skips produce a nonzero exit. The Node counts and aggregate assertion calls are printed.

The managed execution sandbox previously hid actual child tests behind file-level
successes; the new runner rejects that result. Run with working subprocess permissions.
Tests prove ordinary failure, no-op, and empty-file handling without real services.

## Migration readiness

The reviewed order is 001_initial_schema.sql, 002_add_transcoding_config.sql, then
003_webhook_contract.sql, then 004_webhook_encryption_key_metadata.sql
(Milestone 3.7 schema and encryption metadata preparation).
001 creates the 14 public application tables, keys, checks, and indexes. Its
PostgreSQL 17 gen_random_uuid() default requires no extension. 002 adds nullable
JSONB transcoding_config to media_assets. Both have node-pg-migrate Up/Down markers;
the destructive Down sections are excluded from the reviewed up plan. Migration
003 preserves legacy webhook rows, adds version-1 constraints/immutable bytes,
and intentionally refuses Down to preserve history. See the
[contract and migration design](webhook-contract.md).

The test-only migration command audits that exact file set, verifies environment,
PostgreSQL, Redis, and storage, then calls node-pg-migrate in up direction using the
same guarded client. It has no reset/down mode. Migration 004 preserves historical
NULL encryption-key IDs and admits new/changed version-1 endpoints only with complete
metadata. These tests were not executed in Batch 2. Batch 2B subsequently
verified both fresh 001–004 and actual 001–003 → 004 upgrade paths, plus 533 guarded
cases / 3,436 assertion calls and a separate real webhook CLI PTY scenario. See
[the Batch 2B record](webhook-batch-2b-verification.md) and
[endpoint management](webhook-endpoint-management.md). Migrations 001/002 and restricted-role
grants were verified historically in 3.5.3 Batch 4B. Milestone 3.6 Batch 3 later
verified the updated tree with 420 cases and 2,858 assertion calls. Neither run
included migration 003. Milestone 3.7 Batch 1B subsequently applied 001/002/003 in a
fresh disposable cluster and passed 484 cases with 3,098 assertion calls, including
the legacy upgrade and live schema concurrency checks. See
[the Batch 1B verification record](webhook-schema-verification.md).
Never substitute development services.

The disposable bootstrap also creates an empty `lumen_test_webhook_upgrade`
schema owned by the restricted test role. The legacy-upgrade test verifies its
ownership and emptiness before creating the pre-003 schema and data inside a
rolled-back transaction. This avoids granting database-level CREATE privileges.

## Repeatable authorized-run procedure

Obtain approval for image builds/downloads, starting disposable services and tmpfs data,
bootstrap role/marker creation, up migrations, and destructive integration tests.
Use Bash from the repository root. Select a working engine explicitly: Batch 4B
used the Docker `rootless` context backed by Podman because Docker Desktop was
unavailable. The commands below use that context; choose your verified context
on other hosts. Never switch context or project identity midway through a run.

```bash
# Creates an ignored file; fails if it already exists. Does not load development .env.
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; const keys=["LUMEN_TEST_ADMIN_PASSWORD","LUMEN_TEST_DB_PASSWORD","LUMEN_TEST_REDIS_PASSWORD","LUMEN_TEST_DISPOSABLE_TOKEN"]; writeFileSync(".env.integration", keys.map(k=>k+"="+randomBytes(32).toString("hex")).join("\n")+"\nLUMEN_ALLOW_DESTRUCTIVE_TESTS=0\n", {flag:"wx",mode:0o600});'
export LUMEN_TEST_PROJECT="lumen-it-$(date +%s)-$$"
# Enable only after destructive-test approval. This overrides the template's disabled value.
export LUMEN_ALLOW_DESTRUCTIVE_TESTS=1

docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml config --quiet
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml build test-runner
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml up -d --wait postgres-test redis-test
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml run --rm --no-deps test-runner npm run test:integration:check
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml run --rm --no-deps test-runner npm run test:integration:migrate
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml run --rm --no-deps test-runner npm run test:integration
# Removes only this uniquely named test project. Requires retaining the correct project variable.
docker --context rootless compose --project-name "$LUMEN_TEST_PROJECT" --env-file .env.integration -f compose.test.yaml down
unset LUMEN_ALLOW_DESTRUCTIVE_TESTS
```

Use a fresh project and fresh token for a subsequent run. Do not substitute the
legacy db:migrate command, add compose.yaml, attach development networks, publish
ports, bind host storage, or reuse credentials. Cleanup must still run after test
failure, using the retained test project name. No down -v or broad Docker cleanup
is necessary; data is tmpfs, not named volumes.

Inspect preflight results and migration records on each fresh run. Batch 4B
verified the complete API → outbox → BullMQ → worker → rendition path, including
project authentication and cross-project denial. It remains short-media evidence,
not production load or exhaustive crash-recovery verification.

The image uses node:24-bookworm-slim with explicit FFmpeg/Git installation. The
test-only init-script bind uses ro,Z for private SELinux relabeling; do not extend
that mount to development data. Runner storage uses container-private tmpfs mode
1777 for Podman Docker-API compatibility; marker files are mode 0600. No host
storage or persistent data volumes are shared.

Use a failure-safe cleanup trap or equivalent operator finally step after startup.
Before teardown verify the project labels, resource names, selected context, and
private network against the retained unique project name. Never use prune or broad
cleanup. The Batch 4B build-helper cleanup was based on a before/after inventory;
do not remove a default/shared builder merely because that run did so.
