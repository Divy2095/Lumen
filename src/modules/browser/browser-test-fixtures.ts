import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ClerkService } from '../auth/clerk.service.js';

const issuer = 'https://clerk.example.test';
export const browserOrigin = 'http://127.0.0.1:5173';
const pair = await generateKeyPair('RS256');
const key = { ...await exportJWK(pair.publicKey), kid: 'browser-media-test', alg: 'RS256', use: 'sig' };

export function testClerkService(unavailable = false) {
  return new ClerkService({
    issuer, jwksUrl: `${issuer}/.well-known/jwks.json`,
    authorizedParties: [browserOrigin], clockToleranceSeconds: 5,
  }, { fetch: async () => {
    if (unavailable) throw new TypeError('private provider failure');
    return new Response(JSON.stringify({ keys: [key] }));
  } });
}

export function browserToken(subject = 'user_linked', expired = false) {
  return new SignJWT({ azp: browserOrigin }).setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(issuer).setSubject(subject)
    .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? -60 : 300)).sign(pair.privateKey);
}
