import { exactOrigin, originList } from './origin.js';

export interface ClerkConfig {
  issuer: string;
  jwksUrl: string;
  authorizedParties: readonly string[];
  clockToleranceSeconds: number;
}

const defaultClockToleranceSeconds = 5;
const maximumClockToleranceSeconds = 60;

function configured(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== '';
}

/**
 * Loads the public-key-only Clerk trust configuration. No secret key is
 * required or accepted. Partial configuration fails startup rather than
 * leaving authentication silently unavailable or permissive.
 */
export function getClerkConfig(env: NodeJS.ProcessEnv = process.env): ClerkConfig | null {
  if (!configured(env, 'CLERK_ISSUER')) {
    if (configured(env, 'CLERK_JWKS_URL') || configured(env, 'CLERK_AUTHORIZED_PARTIES') ||
        configured(env, 'CLERK_CLOCK_TOLERANCE_SECONDS')) {
      throw new Error('CLERK_ISSUER must be configured when other Clerk settings are present');
    }
    return null;
  }

  const issuer = exactOrigin(env.CLERK_ISSUER!, 'CLERK_ISSUER');
  if (new URL(issuer).protocol !== 'https:') {
    throw new Error('CLERK_ISSUER must be an https origin');
  }

  const authorizedParties = originList(env.CLERK_AUTHORIZED_PARTIES, 'CLERK_AUTHORIZED_PARTIES');
  if (authorizedParties.length === 0) {
    throw new Error('CLERK_AUTHORIZED_PARTIES must contain at least one exact origin');
  }

  const rawJwksUrl = env.CLERK_JWKS_URL;
  let jwksUrl = `${issuer}/.well-known/jwks.json`;
  if (rawJwksUrl !== undefined && rawJwksUrl !== '') {
    let parsed: URL;
    try {
      parsed = new URL(rawJwksUrl);
    } catch {
      throw new Error('CLERK_JWKS_URL must be a valid https URL');
    }
    if (rawJwksUrl !== rawJwksUrl.trim() || parsed.protocol !== 'https:' ||
        parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' ||
        parsed.pathname === '/' || parsed.origin !== issuer) {
      throw new Error('CLERK_JWKS_URL must be a trusted https URL on the CLERK_ISSUER origin');
    }
    jwksUrl = parsed.href;
  }

  const rawTolerance = env.CLERK_CLOCK_TOLERANCE_SECONDS;
  if (rawTolerance !== undefined && rawTolerance !== '' && rawTolerance !== rawTolerance.trim()) {
    throw new Error(`CLERK_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and ${maximumClockToleranceSeconds}`);
  }
  const clockToleranceSeconds = rawTolerance === undefined || rawTolerance === ''
    ? defaultClockToleranceSeconds : Number(rawTolerance);
  if (!Number.isInteger(clockToleranceSeconds) || clockToleranceSeconds < 0 ||
      clockToleranceSeconds > maximumClockToleranceSeconds) {
    throw new Error(`CLERK_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and ${maximumClockToleranceSeconds}`);
  }

  return { issuer, jwksUrl, authorizedParties, clockToleranceSeconds };
}