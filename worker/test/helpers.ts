// Integration-test helpers: every call goes through the real Worker fetch handler and local D1.
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';

export const ORIGIN = 'https://cc.test';
export const PASSWORD = 'correct horse battery staple';
export const SETUP_TOKEN = env.SETUP_TOKEN as string;

let ipCounter = 0;
/** A fresh client IP per request keeps IP-based rate limits out of tests that are not about them. */
const nextIp = () => `198.51.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  token?: string;
  /** Defaults to ORIGIN on unsafe methods; null sends no Origin header. */
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field.
export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** "name=value" from Set-Cookie, ready to send back as a Cookie header. */
  cookie: string | null;
}

export async function call(method: string, path: string, opts: CallOptions = {}): Promise<Res> {
  const headers = new Headers(opts.headers);
  if ((opts.body !== undefined || opts.rawBody !== undefined) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  const origin = opts.origin === undefined ? (method === 'GET' ? null : ORIGIN) : opts.origin;
  if (origin !== null) headers.set('origin', origin);
  headers.set('cf-connecting-ip', opts.ip ?? nextIp());
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await exports.default.fetch(new Request(ORIGIN + path, { method, headers, body }));
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
    cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null,
  };
}

export function expectError(res: Res, status: number, code: string) {
  expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status, code });
}

/** Completes initial setup (once per test file; storage is per file) and opens registration. */
export async function setupInstance(): Promise<string> {
  const res = await call('POST', '/api/v1/setup', {
    body: { setup_token: SETUP_TOKEN, username: 'admin', password: PASSWORD, registration_mode: 'open' },
  });
  expect(res.status).toBe(201);
  return res.cookie as string;
}

let userCounter = 0;
export async function registerUser(prefix = 'user'): Promise<{ cookie: string; username: string; id: string }> {
  const username = `${prefix}${++userCounter}`;
  const res = await call('POST', '/api/v1/auth/register', { body: { username, password: PASSWORD } });
  expect(res.status).toBe(201);
  return { cookie: res.cookie as string, username, id: res.body.user.id };
}

/** Runs the full browser-approved pairing flow and returns the device credential. */
export async function pairDevice(cookie: string, name = 'Test Mac'): Promise<{ token: string; deviceId: string }> {
  const created = await call('POST', '/api/v1/pairings', { cookie });
  expect(created.status).toBe(201);
  const claim = await call('POST', '/api/v1/device/pairing/claim', {
    origin: null,
    body: { code: created.body.pairing.code, device_name: name, platform: 'macOS 15.0', app_version: '0.1.0' },
  });
  expect(claim.status).toBe(200);
  const approve = await call('POST', `/api/v1/pairings/${created.body.pairing.id}/approve`, { cookie });
  expect(approve.status).toBe(200);
  const token = await call('POST', '/api/v1/device/pairing/token', {
    origin: null,
    body: { poll_token: claim.body.poll_token },
  });
  expect(token.status).toBe(200);
  return { token: token.body.device_token, deviceId: token.body.device.id };
}

export async function uploadText(token: string, content: string, key = crypto.randomUUID()): Promise<Res> {
  return call('POST', '/api/v1/device/clipboard', {
    token,
    origin: null,
    body: { content, content_type: 'text/plain', idempotency_key: key },
  });
}
