import { originList } from './origin.js';

export interface CorsConfig {
  allowedOrigins: readonly string[];
}

/**
 * CORS is opt-in per exact origin. Missing configuration leaves browser
 * origins disabled; malformed configuration fails startup instead of
 * accidentally allowing everything.
 */
export function getCorsConfig(env: NodeJS.ProcessEnv = process.env): CorsConfig {
  return { allowedOrigins: originList(env.CORS_ALLOWED_ORIGINS, 'CORS_ALLOWED_ORIGINS') };
}
