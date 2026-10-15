// Authentication: browser sessions (cookie) and paired devices (bearer token). The two never overlap:
// session routes read only the cookie, device routes read only the Authorization header.
import { getCookie, HttpError, sessionCookie, sessionCookieName } from './http';
import { randomToken, sha256 } from './security';

export interface User {
  id: string;
  username: string;
  is_admin: number;
  retention_hours: number | null;
  storage_bytes: number;
  created_at: number;
}

export type Auth = 'public' | 'session' | 'admin' | 'device';
export type Handler = (c: Ctx) => Promise<Response>;
export type Route = [method: string, pattern: string, auth: Auth, handler: Handler];

export class Ctx {
  session?: { id: string; user: User };
  device?: { id: string; name: string; user: User };

  constructor(
    readonly req: Request,
    readonly env: Env,
    readonly url: URL,
    readonly params: Record<string, string>,
  ) {}

  get db(): D1Database {
    return this.env.DB;
  }

  /** The authenticated account. Throws unless the router authenticated the caller, so handlers fail closed. */
  get user(): User {
    const user = this.session?.user ?? this.device?.user;
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    return user;
  }
}

export const publicUser = (u: Pick<User, 'id' | 'username' | 'is_admin' | 'created_at'>) => ({
  id: u.id,
  username: u.username,
  is_admin: u.is_admin === 1,
  created_at: u.created_at,
});

const SESSION_TTL_MS = 30 * 86_400_000;
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000;
const USER_COLUMNS = 'u.id, u.username, u.is_admin, u.retention_hours, u.storage_bytes, u.created_at';

/** Creates a brand-new session (never reuses one) and returns its Set-Cookie header value. */
export async function createSession(c: Ctx, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await c.db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      await sha256(token),
      c.req.headers.get('user-agent')?.slice(0, 256) ?? null,
      now,
      now + SESSION_TTL_MS,
    )
    .run();
  return sessionCookie(c.url, token, SESSION_TTL_MS / 1000);
}

export const clearSessionCookie = (c: Ctx) => sessionCookie(c.url, '', 0);

export async function authenticateSession(c: Ctx): Promise<Ctx['session']> {
  const token = getCookie(c.req, sessionCookieName(c.url));
  if (!token) return;
  const now = Date.now();
  const row = await c.db
    .prepare(
      `SELECT s.id AS session_id, s.last_seen_at, ${USER_COLUMNS}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
    )
    .bind(await sha256(token), now)
    .first<User & { session_id: string; last_seen_at: number }>();
  if (!row) return;
  if (now - row.last_seen_at > LAST_SEEN_RESOLUTION_MS) {
    await c.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run();
  }
  const { session_id, last_seen_at: _, ...user } = row;
  return { id: session_id, user };
}

const DEVICE_AUTH = /^Bearer (csd_[A-Za-z0-9_-]{43})$/;

export async function authenticateDevice(c: Ctx): Promise<Ctx['device']> {
  const token = DEVICE_AUTH.exec(c.req.headers.get('authorization') ?? '')?.[1];
  if (!token) return;
  const now = Date.now();
  const row = await c.db
    .prepare(
      `SELECT d.id AS device_id, d.name AS device_name, d.last_seen_at, ${USER_COLUMNS}
       FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.status = 'active'`,
    )
    .bind(await sha256(token))
    .first<User & { device_id: string; device_name: string; last_seen_at: number | null }>();
  if (!row) return;
  if (now - (row.last_seen_at ?? 0) > LAST_SEEN_RESOLUTION_MS) {
    await c.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, row.device_id).run();
  }
  const { device_id, device_name, last_seen_at: _, ...user } = row;
  return { id: device_id, name: device_name, user };
}
