# Milestone 3.6 — Batch 4A security and verification review

Review date: 2026-11-13. This is a targeted source/dependency review, not a
penetration test or production-readiness certification. No dependency updates,
package-lock changes, migrations, or infrastructure startup were performed in 4A.

## Interactive credential delivery

Inspected `src/scripts/provision.ts`, `src/modules/auth/provisioning.cli.ts`,
`src/modules/auth/provisioning.service.ts`, and their regression tests.

- The actual entrypoint requires both `process.stdin.isTTY === true` and
  `process.stdout.isTTY === true`. Writes fail before connecting if either is false.
- The operator sees the configured host/port, database/role, selected project, and
  selected predecessor where applicable. Typed confirmation precedes mutation.
  TTY status is checked again after confirmation and immediately before reveal;
  the entrypoint's reveal implementation also rechecks it.
- The service returns a generated credential only after a successful COMMIT command
  response. A COMMIT error or unexpected command result becomes an uncertain outcome
  with non-secret recovery UUIDs, no returned credential, and no automatic retry.
- Plaintext is not passed to SQL or logging. The credential is written once to
  stdout through the dedicated reveal path; ordinary result JSON is an explicit
  metadata allowlist. There is no plaintext retrieval command.
- Output failures after persistence return a sanitized failure with the new key ID
  and, for rotation, the predecessor ID. Revocation-result delivery failures are
  distinguished from uncertain COMMIT. Database, stream, and connection-cleanup
  errors do not print raw exception details or connection URLs.
- EOF/interrupt during the confirmation prompt cancels without a requested write.
  Termination outside that prompt may interrupt a COMMIT or result delivery. A
  nonzero exit or lost terminal is not evidence of rollback; inspect listing/recovery
  metadata. No plaintext is recovered or automatically displayed again.

These controls protect against accidental piping/logging and unsafe retries. They
do not protect against terminal recording, shoulder surfing, screen capture,
privileged local process inspection, or malicious modification of the operator's
runtime. One-time reveal means one application emission, not erasure of scrollback
or a guarantee that output was fully received. Keep the terminal and machine private.

Database identity verification checks configured and connected database/current/
session role names on the mutation connection. It does not cryptographically bind
those names to a particular cluster. Operators must inspect the displayed endpoint
and protect `.env`/exported PG variables. There is no new globally privileged HTTP
credential or grant of provisioning rights to media keys.

## PTY evidence and explicit gap

Two bounded host standard-library PTY probes ran against the actual entrypoint:

1. Piped stdin with PTY stdout: rejected before database configuration.
2. PTY stdin with redirected stdout: rejected before database configuration.

Both exited with status 1 and the terminal-required error. Each had a five-second
deadline. No database, credential issuance, transcript file, or secret was used.
These manual negative checks are separate from Node test/assertion counts.

No successful live PTY issuance/rotation test was added or executed. Host PTY
allocation is available, but the existing isolated runner has no PTY automation
helper and its Dockerfile does not install Python or `script`. This batch kept
the runner/dependencies unchanged instead of adding a helper solely for this check.
A future capture-only host PTY harness around the isolated container command is
possible; it needs a separately reviewed implementation that never logs a secret
transcript and a fresh guarded disposable run. It must not publish database ports,
reuse development credentials, or weaken stdin/stdout TTY checks.

Successful interactive confirmation, terminal disconnects during delivery, and
actual terminal rendering/receipt remain live coverage limitations. Unit tests of
the injected I/O boundary and real service persistence do not substitute for them.

## Dependency advisory review

`npm audit --json --ignore-scripts` queried the registry on the review date, after
the sandbox's initial DNS restriction required network-capable execution. Result:
three moderate affected packages, zero high/critical findings. These represent
two underlying advisories and an inherited direct-dependency finding:

| Installed package | Dependency relationship | Advisory/fix |
| --- | --- | --- |
| `node-pg-migrate@9.0.0` | Direct production dependency; operational migration tooling | Inherits `glob` findings; no separate underlying advisory in this report |
| `glob@13.0.6` | Transitive through node-pg-migrate (`~13.0.0`) | GHSA-3g3m-2fjr-6pw4; patched in 14.0.2 |
| `minimatch@10.2.6` | Transitive through glob (`^10.2.2`) | GHSA-g3hv-75wg-m249; patched in 11.0.1 |

The [glob maintainer advisory](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)
describes continued filesystem traversal after AbortSignal cancellation. The
[minimatch maintainer advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
describes CPU/memory amplification from attacker-controlled patterns with
optimization level at least 2. Both are availability issues.

Installed-source reachability review:

- The packages are production-installed, not merely devDependencies. Their current
  Lumen use is migration tooling and guarded integration setup, not request handling.
- `node-pg-migrate/dist/legacy/migration.js` uses directory `readdir` by default;
  glob traversal is conditional on `useGlob`. The npm migration script does not
  enable `--use-glob`; the guarded runner sets `dir: 'migrations'` with no glob mode.
- No application/provisioning route accepts glob patterns or imports this migration
  tooling. The reviewed setup supplies trusted local migration paths. It does not
  rely on glob AbortSignal cancellation as a resource boundary.
- Glob itself configures minimatch optimization level 2. If migration glob mode
  were enabled with untrusted patterns, that dependency path would need reassessment.

Assessment: no attacker-controlled path to these vulnerable operations was found
in current Lumen usage. This is a static exposure assessment, not proof that the
installed packages are universally safe. Keep migration configuration/files trusted;
reassess if glob mode, external patterns, or other consumers are introduced.

Registry metadata confirmed that fixed glob 14.0.2 and minimatch 11.0.1 exist and
support Node 24. They cross the installed dependency ranges. The current published
node-pg-migrate version reported by the registry was 9.0.0 with glob `~13.0.0`.
The audit's automatic suggestion was node-pg-migrate 7.6.1, a major downgrade;
it is not a compatibility-reviewed fix for this project. No `npm audit fix`,
install, override, downgrade, or lockfile change was performed.

Prefer a compatible upstream migration-tool release incorporating fixed dependencies
when available, or a separately approved override/change with migration-regression
verification. These findings do not identify a current public API exploit or a
credential-disclosure blocker. Carry them explicitly into final commit review;
accepting this limited current exposure is different from resolving the advisories.

## Verification history and readiness limits

Milestone 3.6 Batch 3 used `lumen-it36-5850fbe733703d73` on the rootless Podman-backed
Docker context. It verified no published service ports, no development data mounts,
project-private internal networking, tmpfs data, fresh credentials, and database/
Redis/storage guards. The actual database was `lumen_test`, role
`lumen_test_runner`, PostgreSQL 17.11; migrations 001/002 were recorded in order.

- Focused live provisioning: 15 cases, 94 assertion calls, zero failures/skips.
- Complete guarded suite: 420 cases across 29 files, 2,858 assertion calls, zero
  failures/cancellations/skips. Included the existing upload-to-rendition pipeline.
- Both concurrency orderings observed real blocking through `pg_blocking_pids`.
  Revocation first rejected rotation; rotation first committed its replacement
  before waiting predecessor revocation. No model-only concurrency claim was used.
- Real CLI subprocesses covered listing, identity rejection, and redirected-write
  refusal; successful interactive writes/reveal were not covered.
- Targeted teardown removed that project's services/network, unique builder/cache,
  runner image, generated credentials, and helpers. Development container identity,
  stopped/start-stop state, mounts, and volume metadata matched the baseline.

Batch 4A verification completed:

- TypeScript typecheck passed.
- Complete database-free suite: 248 cases across 19 files, 2,065 assertion calls,
  zero failures/cancellations/skips.
- Focused provisioning: 62 cases across three files, 485 assertion calls, zero
  failures/cancellations/skips. These counts overlap the complete database-free run.
- Fourteen documented provisioning commands parsed against the real CLI parser
  after substituting synthetic valid UUIDs, without database access; local guide
  links were checked. Help behavior is covered by the provisioning tests.
- Two separate negative terminal probes passed as described above. No successful
  live PTY issuance or new live integration run was performed.
- Tracked and untracked-file whitespace checks passed; package-lock.json is unchanged.

The test runs used process-isolated execution outside the sandbox because of the
previously observed child-process capture EPERM restriction. No infrastructure
was started. Retain Batch 3 as historical live evidence, not as a rerun in 4A.

Final-review recommendation: the operator-only implementation is suitable for
commit review with the PTY coverage gap and dependency findings explicitly recorded.
No new code-level blocker was found in this targeted review. Do not equate that
recommendation with production readiness or authorization to stage/commit/push.
Staged rotation has no persisted predecessor relationship, issuance/rotation are
not idempotent, and revocation does not cancel in-flight work or upload tokens.
