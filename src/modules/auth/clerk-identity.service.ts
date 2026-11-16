import type { Pool } from 'pg';
import { isVerifiedClerkIdentity, type VerifiedClerkIdentity } from './clerk.service.js';

/**
 * Resolves only a subject produced by ClerkService.verify(). Route handlers
 * must never construct VerifiedClerkIdentity from request-supplied values.
 * The runtime guard rejects plain objects, spread copies, and cast values.
 */
export class ClerkIdentityResolver {
  constructor(private readonly db: Pick<Pool, 'query'>) {}

  async resolveAccountId(identity: VerifiedClerkIdentity): Promise<string | null> {
    if (!isVerifiedClerkIdentity(identity)) {
      throw new TypeError('A verified Clerk identity is required');
    }
    const result = await this.db.query<{ account_id: string }>(
      "SELECT account_id FROM account_identities WHERE provider = 'clerk' AND provider_subject = $1",
      [identity.subject]);
    return result.rows[0]?.account_id ?? null;
  }
}