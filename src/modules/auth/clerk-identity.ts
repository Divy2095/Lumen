import type { JWTPayload } from 'jose';

export const clerkProvider = 'clerk' as const;

const clerkSubject = /^user_[A-Za-z0-9]{1,250}$/;

/**
 * Validates the shape of a Clerk user subject. Shape is not proof of identity;
 * only a verified session token may be used for authorization.
 */
export function isClerkSubject(value: unknown): value is string {
  return typeof value === 'string' && clerkSubject.test(value);
}

export function hasRejectedActorClaim(payload: JWTPayload): boolean {
  return payload.act !== undefined;
}