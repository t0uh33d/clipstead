// Secrets, hashing and rate limiting. Uses only the Web Crypto API built into the Workers runtime.
import { HttpError } from './http';

const encoder = new TextEncoder();

export const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** Decodes standard base64 (throws on invalid input). A plain loop is fast enough for megabyte images. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A 256-bit random secret, base64url-encoded, with an optional type prefix (e.g. "csd_"). */
export function randomToken(prefix = ''): string {
  const b64 = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return prefix + b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// Crockford base32 without I, L, O and U. 32 symbols, so `byte & 31` has no modulo bias: 5 bits per character.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const randomCode = (length: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => CODE_ALPHABET[b & 31]).join('');

/** Canonical form of a user-typed code: case-insensitive, ignores spaces and dashes, maps look-alikes. */
export const normalizeCode = (input: string) =>
  input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

export async function sha256(data: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
}

/** Constant-time string comparison that does not leak length. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(x as ArrayBuffer, y as ArrayBuffer);
}

// Passwords: PBKDF2-HMAC-SHA256, the strongest OWASP-listed algorithm available natively in Workers.
// 100,000 iterations: Cloudflare's production runtime has rejected higher counts (local workerd does not enforce the
// limit, so verify on a deployment before raising it). OWASP recommends 600,000; see docs/security.md.
// The parameters are stored in every hash, and login re-hashes when they differ from these values.
const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const [scheme, iterations, salt, hash] = stored.split('$');
  const count = Number(iterations);
  if (scheme !== 'pbkdf2_sha256' || !Number.isInteger(count) || count < 1 || !salt || !hash) {
    return { ok: false, rehash: false };
  }
  const expected = fromBase64(hash);
  const actual = await pbkdf2(password, fromBase64(salt), count);
  const ok = actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
  return { ok, rehash: ok && count !== PBKDF2_ITERATIONS };
}

/** Verified against when a username does not exist, so the response time does not reveal it. */
export const DUMMY_PASSWORD_HASH = `pbkdf2_sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$${'A'.repeat(43)}=`;

/**
 * Fixed-window rate limit backed by D1. The increment and the read are one atomic UPSERT, so
 * concurrent requests cannot both slip under the limit. The window resets at a fixed boundary, so a
 * client can make up to 2x `limit` requests across a boundary. See docs/security.md.
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(await sha256(key), windowStart)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
      'Retry-After': String(retryAfter),
    });
  }
}
