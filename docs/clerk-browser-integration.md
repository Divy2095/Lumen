# Clerk browser integration foundation

Phase 8B adds the backend trust foundation for a future browser client. It does
**not** make browser uploads available. No session, media registration, upload,
thumbnail, or metadata routes are exposed to Clerk-authenticated browser clients
yet. The existing project API-key and upload-token flows are unchanged.

## Why Clerk identity is separate from project API keys

A Lumen project API key authorizes a project and remains a server-side secret.
A Clerk session JWT identifies a signed-in person. Phase 8B keeps these
boundaries explicit:

- `authenticateApiKey` continues to accept only project API keys.
- `authenticateClerk` accepts only a verified Clerk session JWT.
- A Clerk token cannot authenticate an existing project API-key route.
- A project API key is not accepted as a Clerk identity token.
- Upload tokens and their single-use semantics are unchanged.
- Project API keys must never be shipped to a browser. Phase 8C must keep using
  server-side API keys for project operations, or add a separately reviewed
  browser API.

## CORS configuration

Set an explicit, comma-separated allowlist of exact browser origins:

```dotenv
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:4173
```

Rules:

- Only canonical `http`/`https` origins are accepted.
- Paths, queries, fragments, embedded credentials, wildcards, and `null` are
  rejected; the server fails at startup instead of widening the policy.
- Matching is exact, including scheme, host, and port. `localhost` and
  `127.0.0.1` are different origins.
- Missing or empty configuration means no browser origin is allowed. It does
  not mean "allow everything".
- Requests without an `Origin` header (CLI and server-to-server clients) are
  unaffected.
- Only `GET`, `POST`, and `PUT` are advertised. Only `Authorization` and
  `Content-Type` are advertised request headers. `x-api-key` is deliberately
  not a browser CORS header.
- Credentials are disabled. Browser requests must use the `Authorization:
  Bearer <Clerk JWT>` header rather than cookies.
- `OPTIONS` preflight is handled before authentication and does not require a
  Clerk token, project API key, or upload token.

Local loopback HTTP origins are acceptable for development only. Use the exact
frontend origin; do not use wildcard or substring matching in any environment.

## Clerk verification configuration

Clerk session tokens are verified with public keys only. Phase 8B does not use
`CLERK_SECRET_KEY`; only the public JWKS is needed.

```dotenv
CLERK_ISSUER=https://your-instance.clerk.accounts.dev
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:5173,http://127.0.0.1:4173
# Optional; must be https on the same origin as CLERK_ISSUER.
# CLERK_JWKS_URL=https://your-instance.clerk.accounts.dev/.well-known/jwks.json
# Optional bounded clock skew, default 5 seconds, range 0-60.
# CLERK_CLOCK_TOLERANCE_SECONDS=5
```

- `CLERK_ISSUER` is the Clerk Frontend API origin for one instance. It must be
  an exact HTTPS origin. Tokens from another Clerk application are rejected.
- The JWKS URL is derived as `<CLERK_ISSUER>/.well-known/jwks.json`. An explicit
  override is accepted only over HTTPS on the same issuer origin. A JWKS URL is
  never taken from a token claim.
- `CLERK_AUTHORIZED_PARTIES` must contain exact origins and must be nonempty.
  The token `azp` claim must be present and exactly match one entry in that
  allowlist. This rejects tokens minted for unlisted frontend origins. It does
  not bind `azp` to the current request's `Origin` header: with multiple
  allowlisted parties, a token minted for one allowlisted party is accepted
  from another allowlisted party. Bearer tokens are not origin-bound.
- Only `RS256` is accepted. Unsigned tokens and other algorithms are rejected.
- `exp` is required and validated; `nbf` is validated when present. Clock
  tolerance is bounded.
- `sub` must be a nonempty Clerk user subject of the form `user_<alphanumeric>`.
- Impersonation tokens containing an `act` claim are rejected.
- JWKS responses are cached, refreshed for a rotated key, and fetched with a
  bounded timeout. A provider outage fails closed.
- Partial Clerk configuration fails startup. A missing Clerk configuration
  makes the hook return `503 authentication_unavailable`, never a bypass.

The verification service and hook are reusable but not attached to any route in
Phase 8B. This is intentional: no demonstration endpoint is exposed.

## Failure responses

- Missing or malformed `Authorization: Bearer` header: `401 unauthorized`.
- Invalid signature, wrong issuer, wrong `azp`, expired/not-yet-valid token,
  unsupported algorithm, unsigned token, or invalid/missing subject:
  `401 unauthorized`.
- Missing backend configuration or unavailable JWKS provider:
  `503 authentication_unavailable`.

Responses do not include tokens, claims, signing keys, JWKS URLs, internal
errors, or stack traces. Failure responses are sanitized.

## Operator identity linking

A Clerk subject is linked to an existing Lumen account only by an operator using
the provisioning CLI. There is no public linking endpoint, no automatic/JIT
account creation, and no email-based matching.

Example with placeholders:

```bash
npm run provision -- identity:link \
  --database lumen \
  --role lumen \
  --account-id 01900000-0000-7000-8000-000000000001 \
  --provider clerk \
  --subject user_2abcDEF123
```

The command:

- Requires the actual configured database/role identity and an interactive
  terminal.
- Requires an explicit existing account UUID.
- Accepts only provider `clerk`.
- Validates the subject shape but does not treat the shape as proof of identity.
  The subject must come from Clerk.
- Performs the insert transactionally under the unique
  `(provider, provider_subject)` constraint.
- Returns `alreadyLinked: true` for the same subject and same account.
- Rejects the same subject linked to another account with a conflict and no
  mapping change.
- Rejects unknown accounts and rolls back unexpected failures.
- Never links by account email; email remains unverified ownership metadata.

Concurrent attempts are serialized by the unique constraint: at most one
mapping for a given Clerk subject can commit.

## Identity resolution

`ClerkIdentityResolver.resolveAccountId()` accepts only a
`VerifiedClerkIdentity`, a branded type produced by successful Clerk session
token verification. Route handlers must never construct one from an arbitrary
request field. Phase 8C may use the resolved account ID only after
`authenticateClerk` has run and after its own authorization checks.

A verified subject with no mapping resolves to `null`. Phase 8B does not create
an account, project, or identity as a fallback.

## Database collation assumption

`account_identities.provider_subject` and its unique
`(provider, provider_subject)` constraint use the database's default collation.
The schema does **not** force case-sensitive comparison. With the usual
case-sensitive PostgreSQL locale, Clerk subject equality is exact and
case-sensitive. Under a case-insensitive collation, subjects that differ only by
case could compare as equal, causing a false conflict or incorrect account
resolution.

Phase 8B does not modify the migration or schema. Before production use, verify
that the database's collation is deterministic and case-sensitive. If that
cannot be guaranteed, a separate reviewed migration should apply an explicit
case-sensitive collation (for example `COLLATE "C"`) to the subject column and
its unique index, and identity lookup queries should use the same collation.
Alternatively, store a case-sensitive hash of the subject. Do not change this
schema without separate approval.

## Phase 8C handoff

Phase 8C can build on:

- The strict CORS allowlist.
- `authenticateClerk` for explicit browser-facing routes.
- `ClerkIdentityResolver` with a verified identity.
- The operator-only `identity:link` mapping.

Phase 8C still needs its own review of route authorization, account/project
selection, project API-key handling, upload-token issuance, and media
serialization. Phase 8B alone does not expose browser media routes.
