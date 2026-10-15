// HTTP plumbing shared by every route: errors, JSON bodies, input validation, cookies.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });

export const noContent = (headers: HeadersInit = {}) => new Response(null, { status: 204, headers });

/** Reads a JSON object body. Enforces the content type and stops reading once `maxBytes` is exceeded. */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send a JSON body with Content-Type: application/json.');
  }
  const tooLarge = new HttpError(413, 'payload_too_large', `Request bodies are limited to ${maxBytes} bytes.`);
  if (Number(req.headers.get('content-length')) > maxBytes) throw tooLarge;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** A required string field of `min`..`max` UTF-16 code units. */
export function str(body: Record<string, unknown>, key: string, max: number, min = 1): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, 'invalid_request', `"${key}" must be a string of ${min} to ${max} characters.`);
  }
  return value;
}

// Control characters, and bidi overrides that could make a device name display as something else.
const UNSAFE_LABEL_CHARS = /[\p{Cc}‎‏‪-‮⁦-⁩]/u;

/** A short single-line label, such as a device name, that is shown to users. */
export function label(body: Record<string, unknown>, key: string, max: number): string {
  const value = str(body, key, max).trim();
  if (!value || UNSAFE_LABEL_CHARS.test(value)) {
    throw new HttpError(400, 'invalid_request', `"${key}" must be a single line of visible text.`);
  }
  return value;
}

export const isLocalhost = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

// The __Host- prefix makes browsers reject the cookie unless it is Secure, host-only and Path=/.
// Plain-HTTP requests are only accepted from localhost (see index.ts), where Secure cookies are unavailable in some browsers.
export const sessionCookieName = (url: URL) =>
  url.protocol === 'https:' ? '__Host-clipstead_session' : 'clipstead_session';

export function sessionCookie(url: URL, token: string, maxAgeSeconds: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${sessionCookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function getCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Rate-limit subject for the caller. IPv6 clients are grouped by /64, the block a single user usually controls. */
export function clientIp(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}
