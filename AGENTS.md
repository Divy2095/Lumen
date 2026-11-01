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

Planned components:
- Redis and BullMQ
- FFmpeg and FFprobe
- Local filesystem initially, S3 later

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

The following are already implemented:
- Fastify application foundation
- Docker Compose PostgreSQL infrastructure
- PostgreSQL connection pool
- Fastify database plugin
- /health liveness endpoint
- /ready database readiness endpoint

The next planned milestone is database schema design.

Do not start implementing schema or migrations without first discussing
the entities, relationships, constraints, and lifecycle requirements.