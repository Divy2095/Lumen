# Rendition file safety — stabilization Batch 2

Each attempt owns a UUID temporary path and a separate UUID rendition key. Existing
output versions are not reused or removed during retries. Lease renewal,
cancellation, redelivery, asset-row locking, and fencing from Batch 1 remain in use.

## Failure boundaries

| Boundary | Action |
| --- | --- |
| Path generation fails | No file has been created. |
| Semaphore wait, encoding, output probe, or cancellation fails | Service and worker remove the attempt's temporary file after the child has stopped. |
| Ownership refresh fails before promotion | Worker removes the temporary output. |
| Promotion fails before publication | Worker removes temp; existing destination is never replaced or deleted. |
| Publication succeeds but temp unlink fails | Publication remains successful; worker retries temp cleanup in its finalizer. |
| Cancellation/lease expiry after publication, connection acquisition, BEGIN, row locks, version allocation, demotion, insert, or completion update fails | Roll back if connected; delete only this attempt's published file and temp. |
| Rollback fails | Discard the connection, clean the never-committed attempt, preserve previous versions. No COMMIT was sent. |
| COMMIT returns success | Preserve the rendition. Remove any remaining temp link. |
| COMMIT was sent but its outcome is unknown | Preserve the rendition even if ROLLBACK subsequently succeeds. Request redelivery to inspect the authoritative job state. |
| Connection release fails after successful COMMIT | Preserve the rendition; temp cleanup still runs. |
| Retry observes a completed job | Acknowledge completion without encoding or deleting its output. |
| Retry follows a rolled-back attempt | Allocate fresh paths and version under the existing database lock. |

Local promotion uses a same-filesystem hard link followed by removal of the temp
link. Publication is atomic and refuses an existing destination. The destination
is readable only after encoding and probing have completed. A crash between link
and unlink leaves two names for the same complete file, not a partial rendition.
Filesystems must support hard links; no non-atomic copy fallback is attempted.

Cleanup is best effort on filesystem errors. PostgreSQL and the local filesystem
cannot share an atomic transaction. Crashes, failed unlinks, and uncertain COMMIT
outcomes can leave orphans. No reconciliation job is implemented in this batch.
These changes do not promise power-loss durability (file/directory fsync).

## Proposed bounded crash reconciliation

Start with a maintenance-only reconciler, rather than introducing an online
collector with races against in-flight publication:

1. Explicitly stop/drain all API upload, worker, and outbox writer processes that
   share the storage root. Refuse apply mode unless that maintenance condition is
   established; age alone does not prove that a file is orphaned.
2. Enumerate regular files only under `.tmp` and the rendition layout, using a
   resumable directory cursor. Bound each pass to 100 candidates and five seconds;
   never follow symlinks. Persist the cursor/report outside the scanned tree.
3. Consider only files older than 24 hours (or a larger operational grace period).
   Keep recent files and anything with uncertain ownership.
4. Check exact storage keys against **all** `media_outputs` versions, not just
   current outputs, and original keys in `media_assets`. Keep every referenced
   file. For temp files, retain active uploads and uncertain job ownership;
   draining writers is mandatory for legacy temp names without job identifiers.
5. Fail closed on any database, path, or metadata error. Produce a dry-run report
   before enabling deletion. Recheck references and inode/mtime immediately before
   unlinking each candidate while writers remain stopped.
6. Report candidates, retained references, deleted files, and errors. Never delete
   database output records as a side effect of filesystem reconciliation.

An eventual online reconciler would need coordinated asset/job locks, proof that
no valid lease can still publish the candidate, and a reference recheck under
those locks. A SELECT followed by unlink while writers run is insufficient.

## Storage trust boundary

Storage keys are relative; resolved internal absolute paths are accepted only by
storage helper methods and must still be inside the canonical root. Existing
components are checked with lstat; symlinks below the canonical root are rejected,
including links pointing inside the root and dangling links. Missing descendants
are allowed only beneath checked ancestors. A configured root symlink is resolved
and pinned to its canonical target; replacing that target cannot redirect later
operations. Temp stream creation is exclusive, and promotion rechecks both paths
after creating parent directories.

The storage root and its ancestors must be controlled by the service/operator.
Node path-based APIs do not provide an openat2-style, descriptor-relative
containment guarantee against a hostile local process racing symlink replacement
between validation and use. Hard-link aliases created by privileged external
writers are likewise outside this trust model.

## Encoder discovery

Discovery uses execFileSync with a literal executable path, one `-encoders`
argument, no shell, a three-second default timeout, SIGKILL on timeout, and a 1 MiB
stdout bound. It retains synchronous startup behavior and the encoder preference
libx264 → libopenh264 → h264. Failures retain the historical libx264 fallback but
are not cached; successful results are cached per executable path. The explicit
environment override remains first priority. Discovery does not run inside a
job's cancellable encoding phase; encoding cancellation remains unchanged.
