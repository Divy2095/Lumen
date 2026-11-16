const controlCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Validates a single exact browser origin. Only canonical http/https origins
 * (scheme, host, optional port) are accepted; paths, queries, fragments,
 * credentials, wildcards, and normalized variants are rejected.
 */
export function exactOrigin(value: string, variable: string): string {
  if (typeof value !== 'string' || value === '' || value !== value.trim() ||
      value === '*' || value === 'null' || controlCharacters.test(value)) {
    throw new Error(`${variable} contains an invalid origin`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} contains an invalid origin`);
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      url.origin !== value) {
    throw new Error(`${variable} contains an invalid origin`);
  }

  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`${variable} must use https except for loopback development origins`);
  }

  return value;
}

/**
 * Parses a comma-separated origin allowlist. An absent or empty value yields
 * an empty list (no browser origins allowed), never a wildcard.
 */
export function originList(raw: string | undefined, variable: string): string[] {
  if (raw === undefined || raw.trim() === '') return [];

  const origins = raw.split(',').map(entry => entry.trim());
  if (origins.some(entry => entry === '')) {
    throw new Error(`${variable} contains an invalid origin`);
  }

  return [...new Set(origins.map(entry => exactOrigin(entry, variable)))];
}
