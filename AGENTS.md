# Lumen - Agent Engineering Instructions

## Project Context

Lumen is an API-first media processing platform.

Current stack:
- Node.js 24+
- TypeScript (strict mode)
- Fastify 5
- PostgreSQL 17
- pg connection pool
- Docker Compose
- npm

Implemented processing components:
- Redis and BullMQ
- FFmpeg and FFprobe
- Contained local filesystem storage (S3 remains planned)

## Engineering Principles

1. Understand before implementing.
2. Inspect the existing codebase before modifying files.
3. Never assume a file, function, package, or architecture exists.
4. Prefer simple, maintainable solutions over unnecessary abstractions.
5. Use TypeScript. Do not introduce plain JavaScript application files.
6. Use ESM imports and preserve the existing project conventions.
7. Do not introduce dependencies without explaining why they are needed.
8. Do not introduce microservices prematurely.
9. Keep business logic separate from HTTP route handlers.
10. Never expose secrets, credentials, or internal errors to API clients.

## Agent Workflow

For every task:

1. Inspect relevant files and Git status.
2. Explain the current implementation and proposed approach.
3. Identify affected files and potential risks.
4. Implement only the requested scope.
5. Run relevant tests and TypeScript type checking.
6. Review the final diff.
7. Explain what changed and why.

Do not silently expand task scope.

Do not overwrite existing files without inspecting them.

Do not commit, push, delete files, install packages, or run destructive
commands without explicit approval.

If requirements are ambiguous, ask before implementing.

## Learning Requirements

The developer wants to understand the implementation.

For significant changes:
- Explain the underlying concept.
- Explain why the chosen approach is appropriate.
- Explain important trade-offs.
- Avoid dumping large amounts of generated code without explanation.

Do not claim tests passed unless they were actually executed.

## Current Development Stage

Milestone 3.5.3 implements video transcoding on the existing ingestion pipeline:
- Fastify API with API-key/project ownership checks and single-use upload tokens.
- PostgreSQL schema and migrations 001/002; transactional outbox scheduling.
- Redis/BullMQ publisher and workers; metadata, thumbnails, and MP4 renditions.
- Rotation-aware profiles without upscaling; validated H.264/AAC output.
- Renewed/fenced transcode leases, safe redelivery, contained storage, non-overwriting
  publication, temporary cleanup, and conservative uncertain-COMMIT handling.

Batch 4B historically passed 336 integration cases with 2,239 assertion calls in a
separate disposable cluster. Final HTTP corrections are checked with database-free
regressions; do not describe the historical suite as rerun after those changes.

Use npm test for explicitly classified database-free files. Guarded integration
commands require separate authorization to create disposable infrastructure and
execute destructive setup. Never reuse development databases, Redis, or storage.
See docs/isolated-integration-tests.md and docs/batch-4b-verification.md.

Credential provisioning has no supported public endpoint/CLI yet. Signed webhooks,
HTTP Range/206 support, orphan reconciliation, and production load verification
remain outstanding. Do not invent a next milestone number or implement these
without discussing scope. Discuss entities, constraints, and lifecycle requirements
before adding or changing schema/migrations.
