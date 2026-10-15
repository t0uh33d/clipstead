// Worker entry point: routing, authentication, CSRF and transport checks, error handling.
import { authenticateDevice, authenticateSession, Ctx, type Route } from './auth';
import { HttpError, isLocalhost, json } from './http';
import { routes as accountRoutes } from './routes/account';
import { cleanup, routes as clipboardRoutes } from './routes/clipboard';
import { routes as deviceRoutes } from './routes/devices';

const routes: Route[] = [
  [
    'GET',
    '/api/v1/health',
    'public',
    async (c) => {
      await c.db.prepare('SELECT 1').first();
      return json({ status: 'ok' });
    },
  ],
  ...accountRoutes,
  ...deviceRoutes,
  ...clipboardRoutes,
];

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// API responses are never cached, sniffed, framed or rendered as documents.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = got[i] ?? '';
    else if (part !== got[i]) return null;
  }
  return params;
}

async function dispatch(req: Request, env: Env, url: URL): Promise<Response> {
  for (const [method, pattern, auth, handler] of routes) {
    const params = method === req.method ? match(pattern, url.pathname) : null;
    if (!params) continue;
    const c = new Ctx(req, env, url, params);
    if (UNSAFE_METHODS.has(req.method)) {
      // CSRF defence in depth (cookies are also SameSite=Strict): browsers send Origin on every unsafe
      // request, so a foreign Origin is always refused, and cookie-authenticated routes require it.
      const origin = req.headers.get('origin');
      const cookieAuth = auth === 'session' || auth === 'admin';
      if (origin === null ? cookieAuth : origin !== url.origin) {
        throw new HttpError(403, 'cross_origin_forbidden', 'Cross-origin requests are not allowed.');
      }
    }
    if (auth === 'session' || auth === 'admin') {
      c.session = await authenticateSession(c);
      if (!c.session) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
      if (auth === 'admin' && c.session.user.is_admin !== 1) {
        throw new HttpError(403, 'forbidden', 'Administrator access is required.');
      }
    } else if (auth === 'device') {
      c.device = await authenticateDevice(c);
      if (!c.device) {
        throw new HttpError(401, 'invalid_device_token', 'This device is not paired or its access was revoked.');
      }
    }
    return handler(c);
  }
  throw new HttpError(404, 'not_found', 'Not found.');
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
  }
  // Log only the error itself: never request bodies, headers, tokens or clipboard content.
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
    }),
  );
  return json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let res: Response;
    try {
      if (url.protocol !== 'https:' && !isLocalhost(url)) {
        throw new HttpError(403, 'https_required', 'This API is only available over HTTPS.');
      }
      res = await dispatch(req, env, url);
    } catch (err) {
      res = errorResponse(err);
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!res.headers.has(name)) res.headers.set(name, value);
    }
    return res;
  },

  async scheduled(_controller, env) {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
