// Instance setup, registration, login, account settings, sessions and the (deliberately small) admin API.
import { type Ctx, clearSessionCookie, createSession, publicUser, type Route } from '../auth';
import { clientIp, HttpError, json, noContent, readJson, str } from '../http';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeCode,
  randomCode,
  rateLimit,
  safeEqual,
  sha256,
  verifyPassword,
} from '../security';
import { storageQuotaBytes } from './clipboard';

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const REGISTRATION_MODES = ['closed', 'invite_only', 'open'] as const;
type RegistrationMode = (typeof REGISTRATION_MODES)[number];
const INVITE_TTL_MS = 7 * 86_400_000;

function username(body: Record<string, unknown>): string {
  const name = str(body, 'username', 64).trim().toLowerCase();
  if (!USERNAME.test(name)) {
    throw new HttpError(
      400,
      'invalid_username',
      'Usernames are 3-32 characters: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.',
    );
  }
  return name;
}

function newPassword(body: Record<string, unknown>, key: string): string {
  const password = str(body, key, 4 * MAX_PASSWORD_LENGTH);
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      'invalid_password',
      `Passwords must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long.`,
    );
  }
  return password;
}

function registrationMode(value: unknown): RegistrationMode {
  if (!REGISTRATION_MODES.includes(value as RegistrationMode)) {
    throw new HttpError(
      400,
      'invalid_request',
      `"registration_mode" must be one of: ${REGISTRATION_MODES.join(', ')}.`,
    );
  }
  return value as RegistrationMode;
}

const loadInstance = (c: Ctx) =>
  c.db
    .prepare('SELECT registration_mode, setup_completed_at FROM instance WHERE id = 1')
    .first<{ registration_mode: RegistrationMode; setup_completed_at: number | null }>();

const usernameTaken = (err: unknown) =>
  err instanceof Error && err.message.includes('UNIQUE constraint failed: users.username');

/** Re-authentication for sensitive account changes. Rate-limited so a stolen session cannot brute-force the password. */
async function confirmPassword(c: Ctx, password: string): Promise<void> {
  await rateLimit(c.db, `confirm-password:${c.user.id}`, 10, 900);
  const row = await c.db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(c.user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash)).ok) {
    throw new HttpError(403, 'incorrect_password', 'The password is incorrect.');
  }
}

async function getInstance(c: Ctx) {
  const instance = await loadInstance(c);
  return json({
    setup_required: !instance?.setup_completed_at,
    registration_mode: instance?.registration_mode ?? 'closed',
  });
}

async function setup(c: Ctx) {
  await rateLimit(c.db, `setup:${clientIp(c.req)}`, 10, 900);
  if ((await loadInstance(c))?.setup_completed_at) {
    throw new HttpError(409, 'already_initialized', 'This instance has already been set up.');
  }
  const expected = c.env.SETUP_TOKEN;
  if (!expected || expected.length < 32) {
    throw new HttpError(
      503,
      'setup_token_not_configured',
      'The operator must set a SETUP_TOKEN secret of at least 32 characters before setup.',
    );
  }
  const body = await readJson(c.req);
  if (!(await safeEqual(str(body, 'setup_token', 512), expected))) {
    throw new HttpError(403, 'invalid_setup_token', 'The setup token is incorrect.');
  }
  const name = username(body);
  const passwordHash = await hashPassword(newPassword(body, 'password'));
  const mode = registrationMode(body.registration_mode ?? 'closed');
  const id = crypto.randomUUID();
  const now = Date.now();
  // One transaction: concurrent setups serialize, and only the first can see setup_completed_at IS NULL.
  const [created] = await c.db.batch([
    c.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
         SELECT ?1, ?2, ?3, 1, ?4, ?4 WHERE (SELECT setup_completed_at FROM instance WHERE id = 1) IS NULL`,
      )
      .bind(id, name, passwordHash, now),
    c.db
      .prepare(
        'UPDATE instance SET setup_completed_at = ?1, registration_mode = ?2 WHERE id = 1 AND setup_completed_at IS NULL',
      )
      .bind(now, mode),
  ]);
  if (created?.meta.changes !== 1) {
    throw new HttpError(409, 'already_initialized', 'This instance has already been set up.');
  }
  const cookie = await createSession(c, id);
  return json({ user: publicUser({ id, username: name, is_admin: 1, created_at: now }) }, 201, {
    'Set-Cookie': cookie,
  });
}

async function register(c: Ctx) {
  await rateLimit(c.db, `register:${clientIp(c.req)}`, 5, 3600);
  const instance = await loadInstance(c);
  if (!instance?.setup_completed_at)
    throw new HttpError(409, 'setup_required', 'This instance has not been set up yet.');
  if (instance.registration_mode === 'closed') {
    throw new HttpError(403, 'registration_closed', 'Registration is closed on this instance.');
  }
  const body = await readJson(c.req);
  const name = username(body);
  const password = newPassword(body, 'password');
  const inviteHash =
    instance.registration_mode === 'invite_only'
      ? await sha256(normalizeCode(typeof body.invite_code === 'string' ? body.invite_code.slice(0, 64) : ''))
      : null;
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  const now = Date.now();
  // New accounts are never administrators. With invites, consuming the invite and creating the user is one
  // transaction: the user row is only inserted while the invite is unused, and the invite is then marked used.
  const statements = inviteHash
    ? [
        c.db
          .prepare(
            `INSERT INTO users (id, username, password_hash, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?4 WHERE EXISTS
               (SELECT 1 FROM invites WHERE code_hash = ?5 AND used_at IS NULL AND expires_at > ?4)`,
          )
          .bind(id, name, passwordHash, now, inviteHash),
        c.db
          .prepare(
            'UPDATE invites SET used_at = ?1, used_by = ?2 WHERE code_hash = ?3 AND used_at IS NULL AND expires_at > ?1',
          )
          .bind(now, id, inviteHash),
      ]
    : [
        c.db
          .prepare(
            'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
          )
          .bind(id, name, passwordHash, now),
      ];
  let created: D1Result | undefined;
  try {
    [created] = await c.db.batch(statements);
  } catch (err) {
    if (usernameTaken(err)) throw new HttpError(409, 'username_unavailable', 'That username is not available.');
    throw err;
  }
  if (created?.meta.changes !== 1) {
    throw new HttpError(403, 'invalid_invite', 'The invite code is invalid, expired or already used.');
  }
  const cookie = await createSession(c, id);
  return json({ user: publicUser({ id, username: name, is_admin: 0, created_at: now }) }, 201, {
    'Set-Cookie': cookie,
  });
}

async function login(c: Ctx) {
  const body = await readJson(c.req);
  const name = str(body, 'username', 64).trim().toLowerCase();
  const password = str(body, 'password', 4 * MAX_PASSWORD_LENGTH);
  await rateLimit(c.db, `login-ip:${clientIp(c.req)}`, 20, 600);
  await rateLimit(c.db, `login-user:${name}`, 10, 600);
  const user = await c.db
    .prepare('SELECT id, username, password_hash, is_admin, status, created_at FROM users WHERE username = ?')
    .bind(name)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      is_admin: number;
      status: string;
      created_at: number;
    }>();
  const { ok, rehash } = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok || user.status !== 'active') {
    throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
  }
  if (rehash) {
    await c.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(password), Date.now(), user.id)
      .run();
  }
  const cookie = await createSession(c, user.id);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
}

async function logout(c: Ctx) {
  await c.db.prepare('DELETE FROM sessions WHERE id = ?').bind(c.session?.id).run();
  return noContent({ 'Set-Cookie': clearSessionCookie(c) });
}

async function me(c: Ctx) {
  const { user } = c;
  return json({
    user: publicUser(user),
    settings: { retention_hours: user.retention_hours },
    storage: { used_bytes: user.storage_bytes, quota_bytes: storageQuotaBytes(c.env) },
  });
}

async function updateSettings(c: Ctx) {
  const body = await readJson(c.req);
  const hours = body.retention_hours;
  if (hours !== null && !(Number.isInteger(hours) && (hours as number) >= 1 && (hours as number) <= 87_600)) {
    throw new HttpError(400, 'invalid_request', '"retention_hours" must be null (keep forever) or 1 to 87600.');
  }
  await c.db
    .prepare('UPDATE users SET retention_hours = ?, updated_at = ? WHERE id = ?')
    .bind(hours, Date.now(), c.user.id)
    .run();
  return json({ settings: { retention_hours: hours } });
}

/** Changing the password signs out every browser session and issues a fresh one here. Devices stay paired. */
async function changePassword(c: Ctx) {
  const body = await readJson(c.req);
  await confirmPassword(c, str(body, 'current_password', 4 * MAX_PASSWORD_LENGTH));
  const passwordHash = await hashPassword(newPassword(body, 'new_password'));
  await c.db.batch([
    c.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, Date.now(), c.user.id),
    c.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(c.user.id),
  ]);
  return noContent({ 'Set-Cookie': await createSession(c, c.user.id) });
}

async function deleteAccount(c: Ctx) {
  const body = await readJson(c.req);
  await confirmPassword(c, str(body, 'password', 4 * MAX_PASSWORD_LENGTH));
  if (c.user.is_admin) {
    const admins = await c.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'")
      .first<number>('n');
    if ((admins ?? 0) <= 1) {
      throw new HttpError(409, 'last_admin', 'The only administrator cannot delete their account.');
    }
  }
  // Sessions, devices, pairing requests, invites and clipboard entries cascade.
  await c.db.prepare('DELETE FROM users WHERE id = ?').bind(c.user.id).run();
  return noContent({ 'Set-Cookie': clearSessionCookie(c) });
}

async function listSessions(c: Ctx) {
  const { results } = await c.db
    .prepare(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions
       WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 100`,
    )
    .bind(c.user.id, Date.now())
    .all<{ id: string }>();
  return json({ sessions: results.map((s) => ({ ...s, current: s.id === c.session?.id })) });
}

async function revokeSession(c: Ctx) {
  const { meta } = await c.db
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .bind(c.params.id, c.user.id)
    .run();
  if (meta.changes !== 1) throw new HttpError(404, 'not_found', 'Session not found.');
  return noContent(c.params.id === c.session?.id ? { 'Set-Cookie': clearSessionCookie(c) } : {});
}

async function updateInstance(c: Ctx) {
  const mode = registrationMode((await readJson(c.req)).registration_mode);
  await c.db.prepare('UPDATE instance SET registration_mode = ? WHERE id = 1').bind(mode).run();
  return json({ registration_mode: mode });
}

async function listInvites(c: Ctx) {
  const { results } = await c.db
    .prepare(
      `SELECT i.id, i.created_at, i.expires_at, i.used_at, u.username AS used_by
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`,
    )
    .all();
  return json({ invites: results });
}

async function createInvite(c: Ctx) {
  const code = randomCode(16); // 80 bits
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.db
    .prepare('INSERT INTO invites (id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256(code), c.user.id, now, now + INVITE_TTL_MS)
    .run();
  const display = code.match(/.{4}/g)?.join('-');
  return json({ invite: { id, code: display, expires_at: now + INVITE_TTL_MS } }, 201);
}

async function deleteInvite(c: Ctx) {
  const { meta } = await c.db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').bind(c.params.id).run();
  if (meta.changes !== 1) throw new HttpError(404, 'not_found', 'Invite not found or already used.');
  return noContent();
}

export const routes: Route[] = [
  ['GET', '/api/v1/instance', 'public', getInstance],
  ['POST', '/api/v1/setup', 'public', setup],
  ['POST', '/api/v1/auth/register', 'public', register],
  ['POST', '/api/v1/auth/login', 'public', login],
  ['POST', '/api/v1/auth/logout', 'session', logout],
  ['GET', '/api/v1/auth/me', 'session', me],
  ['PATCH', '/api/v1/account/settings', 'session', updateSettings],
  ['POST', '/api/v1/account/password', 'session', changePassword],
  ['DELETE', '/api/v1/account', 'session', deleteAccount],
  ['GET', '/api/v1/sessions', 'session', listSessions],
  ['DELETE', '/api/v1/sessions/:id', 'session', revokeSession],
  ['PATCH', '/api/v1/admin/instance', 'admin', updateInstance],
  ['GET', '/api/v1/admin/invites', 'admin', listInvites],
  ['POST', '/api/v1/admin/invites', 'admin', createInvite],
  ['DELETE', '/api/v1/admin/invites/:id', 'admin', deleteInvite],
];
