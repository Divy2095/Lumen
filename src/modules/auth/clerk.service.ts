import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  createRemoteJWKSet, customFetch, errors, jwtVerify,
  type FetchImplementation, type JWTPayload,
} from 'jose';
import { getClerkConfig, type ClerkConfig } from '../../config/clerk.js';
import { hasRejectedActorClaim, isClerkSubject } from './clerk-identity.js';

export type ClerkVerification =
  | { ok: true; identity: VerifiedClerkIdentity }
  | { ok: false; reason: 'invalid' | 'unavailable' };

const verifiedClerkIdentity: unique symbol = Symbol('verifiedClerkIdentity');
const verifiedClerkIdentities = new WeakSet<object>();

/**
 * A Clerk subject that has passed cryptographic session-token verification.
 * This type can only be produced by ClerkService.verify(); route handlers must
 * never construct it from request-supplied values.
 */
export interface VerifiedClerkIdentity {
  readonly subject: string;
  readonly sessionId: string | null;
  readonly [verifiedClerkIdentity]: true;
}

/**
 * Runtime guard for the private WeakSet brand. This is the authoritative check:
 * a plain object, a spread copy, or a structurally similar value is rejected
 * even if it is cast to VerifiedClerkIdentity at compile time.
 */
export function isVerifiedClerkIdentity(value: unknown): value is VerifiedClerkIdentity {
  return typeof value === 'object' && value !== null && verifiedClerkIdentities.has(value);
}

function verifiedIdentity(subject: string, sessionId: string | null): VerifiedClerkIdentity {
  const identity: VerifiedClerkIdentity = { subject, sessionId, [verifiedClerkIdentity]: true };
  // Keep the marker non-enumerable so object spread cannot copy even the symbol.
  // The WeakSet registration below is the actual runtime integrity check.
  Object.defineProperty(identity, verifiedClerkIdentity, { enumerable: false });
  Object.freeze(identity);
  verifiedClerkIdentities.add(identity);
  return identity;
}

export interface ClerkServiceOptions {
  fetch?: FetchImplementation;
  jwks?: { timeoutDuration?: number; cooldownDuration?: number; cacheMaxAge?: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    clerkIdentity?: VerifiedClerkIdentity;
  }

  interface FastifyInstance {
    authenticateClerk(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function unavailable(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  // Non-200 or unparseable JWKS responses and network failures are provider
  // availability problems. Signature, claim, and key-selection failures are
  // token failures.
  if (error instanceof errors.JOSEError) return error.code === 'ERR_JOSE_GENERIC';
  return error instanceof TypeError;
}

export class ClerkService {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ClerkConfig, options: ClerkServiceOptions = {}) {
    this.keys = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: options.jwks?.timeoutDuration ?? 5000,
      cooldownDuration: options.jwks?.cooldownDuration ?? 30000,
      cacheMaxAge: options.jwks?.cacheMaxAge ?? 600000,
      ...(options.fetch ? { [customFetch]: options.fetch } : {}),
    });
  }

  async verify(token: string): Promise<ClerkVerification> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        algorithms: ['RS256'],
        clockTolerance: this.config.clockToleranceSeconds,
      }));
    } catch (error) {
      return { ok: false, reason: unavailable(error) ? 'unavailable' : 'invalid' };
    }

    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
        (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))) ||
        !isClerkSubject(payload.sub) ||
        typeof payload.azp !== 'string' || !this.config.authorizedParties.includes(payload.azp) ||
        hasRejectedActorClaim(payload)) {
      return { ok: false, reason: 'invalid' };
    }

    return {
      ok: true,
      identity: verifiedIdentity(payload.sub, typeof payload.sid === 'string' ? payload.sid : null),
    };
  }
}

export function registerClerkAuth(fastify: FastifyInstance, service: ClerkService | null): void {
  fastify.decorate('authenticateClerk', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!service) {
      return reply.status(503).send({
        error: 'authentication_unavailable',
        message: 'Clerk authentication is not configured',
      });
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return reply.status(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid Clerk session token',
      });
    }

    const result = await service.verify(token);
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        return reply.status(503).send({
          error: 'authentication_unavailable',
          message: 'Authentication is temporarily unavailable',
        });
      }
      return reply.status(401).send({
        error: 'unauthorized',
        message: 'Invalid or expired Clerk session token',
      });
    }

    request.clerkIdentity = result.identity;
  });
}

const clerkAuth: FastifyPluginAsync = async (fastify) => {
  const config = getClerkConfig();
  registerClerkAuth(fastify, config ? new ClerkService(config) : null);
};

export const clerkAuthPlugin = fp(clerkAuth, {
  name: 'clerk-authenticate',
});

export default clerkAuthPlugin;