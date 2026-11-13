# Operator API-key lifecycle (Milestone 3.6)

Start with the [first-run provisioning guide](developer-onboarding.md) to obtain
the first project and key. This guide covers subsequent lifecycle operations.

Run from the repository root. `npm run provision` loads the ignored `.env` using
the existing PostgreSQL configuration. `--database` and `--role` must explicitly
match both that configuration and the connected database/session identities.
No HTTP management endpoints or provisioning powers are granted to media API keys.

```sh
npm run provision -- key:list --database lumen --role lumen --project-id '<project-uuid>'
npm run provision -- key:revoke --database lumen --role lumen --project-id '<project-uuid>' --key-id '<key-uuid>'
npm run provision -- key:rotate --database lumen --role lumen --project-id '<project-uuid>' --key-id '<predecessor-uuid>' --name 'Replacement'
```

Replace the UUID placeholders. Lists contain only key IDs, project IDs, names,
display prefixes, dates, and derived active/expired/revoked status, ordered by
creation date and UUID. Revoked takes precedence over expired. Status describes
the key itself; an active key still cannot authenticate an inactive project.
Missing projects fail; existing projects without keys return an empty list.
Listing and revocation are allowed on inactive projects. Revocation preserves the
original timestamp when repeated, and never accepts a key from another project.

Writes require interactive stdin/stdout and a typed confirmation identifying the
database, role, project, and selected key. Rotation requires an active project and
an unexpired, unrevoked predecessor. Otherwise use `key:issue` for a new key.
Replacement lifetime defaults to 90 days. `--expires-at` accepts a complete future
UTC timestamp, for example `2090-01-01T00:00:00Z`; explicit `--no-expiry` permits a
non-expiring replacement. These options are mutually exclusive.

Rotation is staged: issue the replacement, securely deploy it, verify that it
works, then explicitly revoke the predecessor. Both credentials remain usable
during overlap. Rotation does not revoke the predecessor automatically. Record
both IDs; no predecessor relationship or rotation-completion state is persisted
in the existing schema. Repeating rotation can create additional keys.

Secrets are generated with the existing random-key helper, stored only as hashes,
and displayed once after confirmed COMMIT. Redirected secret output is refused.
Keep the terminal private and disable recording; the CLI cannot prevent screen
capture or recover a lost plaintext key. Listings never return hashes or secrets.

Every write rechecks database identity on the same transaction connection. Writes
lock project then key in a consistent order. Rotation checks the database clock
after acquiring the locks. If revocation wins, rotation rejects the predecessor;
if rotation wins, it commits before revocation proceeds. Revocation still targets
only the predecessor, not an already committed replacement. Concurrent rotations
may both succeed sequentially, creating separate replacements.

Normal issuance also creates a fresh key on every confirmed invocation. Neither
issuance nor rotation is idempotent. A project-wide row lock serializes these
operator writes; it does not deduplicate requests. No migration or durable
predecessor mapping was added. Track both key IDs in the operator's secure records.

An uncertain COMMIT is not success: the CLI returns failure, recovery IDs, no secret,
and never retries automatically. Use `key:list` to inspect those IDs. If a replacement
exists but its secret was lost or delivery was uncertain, explicitly revoke that
replacement and issue another only after inspection. Keep the predecessor until
a usable replacement is deployed and verified. Confirmed revocation with failed
result delivery is reported separately and can be inspected through `key:list`.

For a lost initial key, inspect `key:list` and explicitly revoke the lost key ID
before issuing another. Plaintext cannot be recovered from its hash. For an
uncertain project creation, inspect `project:list` and the returned project/account
recovery UUIDs; select a committed account only through `--account-id`. Do not
retry creation by email and assume reuse. If the process was killed before it
printed recovery IDs, inspect project/key metadata and confirm the prior session
has ended before deciding what to do. There is no automatic crash reconciliation.

Exit status 0 indicates completed CLI execution, 2 indicates cancelled confirmation,
and 1 indicates an operational error. Signals can terminate the process with other
statuses. A nonzero exit after COMMIT does not imply rollback: check the reported
recovery IDs. A terminal disconnect may leave a committed key whose secret was
not delivered, or was only partially delivered; never automatically repeat reveal
or assume a failed display means the credential does not exist.

Revocation affects subsequent API-key authentication checks. It does not cancel
in-flight requests, processing jobs, or separately issued upload tokens.
Batch 3 verified real PostgreSQL lock ordering and existing API authentication in a
disposable cluster (15 focused cases/94 assertion calls; complete suite 420 cases/
2,858 assertion calls). CLI database reads and noninteractive refusal were exercised.
Successful live PTY confirmation/reveal remains untested. Batch 4A reviewed the
actual output path and checked piped-input/redirected-output refusal independently
with bounded host PTYs, without a database or issued credential. See the
[security review](milestone-3.6-security-review.md) for evidence and limitations.
