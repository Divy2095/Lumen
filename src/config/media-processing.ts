import { constants as bufferConstants } from 'node:buffer';

export const MAX_TIMER_MS = 2_147_483_647;
export const MAX_FFMPEG_INTEGER = 2_147_483_647;
export const MAX_CAPTURE_BYTES = bufferConstants.MAX_STRING_LENGTH;

export function integerInRange(name: string, value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Defaults apply only to absent values, never malformed or empty configuration. */
export function integerSetting(name: string, option: unknown, fallback: number, max: number, min = 1): number {
  if (option !== undefined) return integerInRange(name, option, min, max);
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a decimal integer`);
  return integerInRange(name, Number(raw.trim()), min, max);
}

export function executableSetting(name: string, option: unknown, fallback: string): string {
  const value = option !== undefined ? option : process.env[name] ?? fallback;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty executable name or path without NUL bytes`);
  }
  return value;
}
