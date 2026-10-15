import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  call,
  expectError,
  ORIGIN,
  PASSWORD,
  pairDevice,
  type Res,
  registerUser,
  SETUP_TOKEN,
  uploadText,
} from './helpers';

const setupBody = (overrides: Record<string, unknown> = {}) => ({
  setup_token: SETUP_TOKEN,
  username: 'admin',
  password: PASSWORD,
  ...overrides,
});

describe('initial setup', () => {
  it('reports that setup is required and refuses registration before it', async () => {
    expect((await call('GET', '/api/v1/instance')).body).toEqual({ setup_required: true, registration_mode: 'closed' });
    expectError(
      await call('POST', '/api/v1/auth/register', { body: { username: 'early', password: PASSWORD } }),
      409,
      'setup_required',
    );
  });

  it('rejects a missing or wrong setup token', async () => {
    expectError(
      await call('POST', '/api/v1/setup', { body: setupBody({ setup_token: 'nope' }) }),
      403,
      'invalid_setup_token',
    );
    expectError(
      await call('POST', '/api/v1/setup', { body: setupBody({ setup_token: undefined }) }),
      400,
      'invalid_request',
    );
  });

  it('creates exactly one administrator when setup requests race', async () => {
    const results = await Promise.all(
      ['racer1', 'racer2', 'racer3', 'racer4'].map((username) =>
        call('POST', '/api/v1/setup', { body: setupBody({ username, registration_mode: 'closed' }) }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const admins = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first('n');
    expect(admins).toBe(1);
    const winner = results.find((r) => r.status === 201);
    expect(winner?.body.user.is_admin).toBe(true);
    expect(winner?.cookie).toMatch(/^__Host-clipstead_session=/);
  });

  it('cannot be repeated once complete', async () => {
    expectError(
      await call('POST', '/api/v1/setup', { body: setupBody({ username: 'second' }) }),
      409,
      'already_initialized',
    );
    expect((await call('GET', '/api/v1/instance')).body.setup_required).toBe(false);
  });
});

describe('registration policy', () => {
  let admin: string;
  beforeAll(async () => {
    // Whichever racer won the setup race is the administrator.
    const username = await env.DB.prepare('SELECT username FROM users WHERE is_admin = 1').first<string>('username');
    admin = (await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } })).cookie as string;
  });

  const setMode = (registration_mode: string, cookie = admin) =>
    call('PATCH', '/api/v1/admin/instance', { cookie, body: { registration_mode } });

  it('defaults to closed and refuses registration', async () => {
    expect((await call('GET', '/api/v1/instance')).body.registration_mode).toBe('closed');
    expectError(
      await call('POST', '/api/v1/auth/register', { body: { username: 'closedtest', password: PASSWORD } }),
      403,
      'registration_closed',
    );
  });

  it('open registration creates non-admin users, ignoring any is_admin field', async () => {
    expect((await setMode('open')).status).toBe(200);
    const res = await call('POST', '/api/v1/auth/register', {
      body: { username: 'Sneaky', password: PASSWORD, is_admin: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: 'sneaky', is_admin: false });
    const me = await call('GET', '/api/v1/auth/me', { cookie: res.cookie as string });
    expect(me.body.user.is_admin).toBe(false);
    expectError(await setMode('closed', res.cookie as string), 403, 'forbidden');
  });

  it('rejects duplicate usernames, including case variants and concurrent attempts', async () => {
    expectError(
      await call('POST', '/api/v1/auth/register', { body: { username: 'SNEAKY', password: PASSWORD } }),
      409,
      'username_unavailable',
    );
    const racers = await Promise.all(
      [1, 2, 3].map(() => call('POST', '/api/v1/auth/register', { body: { username: 'dupe', password: PASSWORD } })),
    );
    expect(racers.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('validates usernames and passwords without composition rules', async () => {
    const reg = (username: string, password: string) =>
      call('POST', '/api/v1/auth/register', { body: { username, password } });
    expectError(await reg('a', PASSWORD), 400, 'invalid_username');
    expectError(await reg('bad name', PASSWORD), 400, 'invalid_username');
    expectError(await reg('<script>', PASSWORD), 400, 'invalid_username');
    expectError(await reg('shortpw', 'elevenchars'), 400, 'invalid_password');
    expect((await reg('longpw', 'all lowercase pass phrase')).status).toBe(201);
    expect((await reg('unicodepw', '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑')).status).toBe(201);
  });

  it('invite-only registration consumes each invite exactly once', async () => {
    expect((await setMode('invite_only')).status).toBe(200);
    expectError(
      await call('POST', '/api/v1/auth/register', { body: { username: 'noinvite', password: PASSWORD } }),
      403,
      'invalid_invite',
    );
    const invite = await call('POST', '/api/v1/admin/invites', { cookie: admin });
    expect(invite.status).toBe(201);
    const code: string = invite.body.invite.code;
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    const racers = await Promise.all(
      ['inv1', 'inv2', 'inv3'].map((username) =>
        call('POST', '/api/v1/auth/register', {
          body: { username, password: PASSWORD, invite_code: code.toLowerCase() },
        }),
      ),
    );
    expect(racers.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    const list = await call('GET', '/api/v1/admin/invites', { cookie: admin });
    expect(list.body.invites[0].used_by).toMatch(/^inv[123]$/);
  });

  it('expired invites are rejected and invites can be revoked', async () => {
    const expired = await call('POST', '/api/v1/admin/invites', { cookie: admin });
    await env.DB.prepare('UPDATE invites SET expires_at = 0 WHERE id = ?').bind(expired.body.invite.id).run();
    expectError(
      await call('POST', '/api/v1/auth/register', {
        body: { username: 'late', password: PASSWORD, invite_code: expired.body.invite.code },
      }),
      403,
      'invalid_invite',
    );
    const revoked = await call('POST', '/api/v1/admin/invites', { cookie: admin });
    expect((await call('DELETE', `/api/v1/admin/invites/${revoked.body.invite.id}`, { cookie: admin })).status).toBe(
      204,
    );
    expectError(
      await call('POST', '/api/v1/auth/register', {
        body: { username: 'revoked', password: PASSWORD, invite_code: revoked.body.invite.code },
      }),
      403,
      'invalid_invite',
    );
    await setMode('open');
  });

  it('a registration mode persists in the database, not in deploy configuration', async () => {
    await setMode('closed');
    expect(await env.DB.prepare('SELECT registration_mode FROM instance').first('registration_mode')).toBe('closed');
    expectError(await setMode('wide-open'), 400, 'invalid_request');
    await setMode('open');
  });
});

describe('login and sessions', () => {
  it('returns the same generic error for unknown users and wrong passwords', async () => {
    const { username } = await registerUser('login');
    const wrong = await call('POST', '/api/v1/auth/login', { body: { username, password: 'wrong password!!' } });
    const unknown = await call('POST', '/api/v1/auth/login', { body: { username: 'nobody-here', password: PASSWORD } });
    expectError(wrong, 401, 'invalid_credentials');
    expectError(unknown, 401, 'invalid_credentials');
    expect(wrong.body).toEqual(unknown.body);
  });

  it('issues HttpOnly, Secure, SameSite=Strict cookies and stores only a token hash', async () => {
    const { username } = await registerUser('cookie');
    const res = await call('POST', '/api/v1/auth/login', {
      body: { username: username.toUpperCase(), password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(
      /^__Host-clipstead_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
    );
    const token = (res.cookie as string).split('=')[1] as string;
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?')
      .bind(token)
      .first('n');
    expect(stored).toBe(0);
  });

  it('logout invalidates the session on the server, not just the cookie', async () => {
    const { cookie } = await registerUser('logout');
    expect((await call('GET', '/api/v1/auth/me', { cookie })).status).toBe(200);
    const out = await call('POST', '/api/v1/auth/logout', { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expectError(await call('GET', '/api/v1/auth/me', { cookie }), 401, 'unauthenticated');
  });

  it('rejects expired sessions', async () => {
    const { cookie, id } = await registerUser('expiry');
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .bind(Date.now() - 1, id)
      .run();
    expectError(await call('GET', '/api/v1/auth/me', { cookie }), 401, 'unauthenticated');
  });

  it('rejects disabled accounts with the generic error', async () => {
    const { cookie, username, id } = await registerUser('disabled');
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id).run();
    expectError(await call('GET', '/api/v1/auth/me', { cookie }), 401, 'unauthenticated');
    expectError(
      await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } }),
      401,
      'invalid_credentials',
    );
  });

  it('lists sessions and revokes a single one', async () => {
    const { cookie, username } = await registerUser('multi');
    const second = await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
    const list = await call('GET', '/api/v1/sessions', { cookie });
    expect(list.body.sessions).toHaveLength(2);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect((await call('DELETE', `/api/v1/sessions/${other.id}`, { cookie })).status).toBe(204);
    expectError(await call('GET', '/api/v1/auth/me', { cookie: second.cookie as string }), 401, 'unauthenticated');
    expect((await call('GET', '/api/v1/auth/me', { cookie })).status).toBe(200);
  });

  it('rate-limits login attempts per account, even from many IPs', async () => {
    const { username } = await registerUser('brute');
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push(await call('POST', '/api/v1/auth/login', { body: { username, password: `guess number ${i}!` } }));
    }
    expect(attempts.slice(0, 10).every((r) => r.status === 401)).toBe(true);
    expectError(attempts[10] as Res, 429, 'rate_limited');
    expect(Number(attempts[10]?.headers.get('retry-after'))).toBeGreaterThan(0);
    // Even the right password is refused while limited.
    expectError(
      await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } }),
      429,
      'rate_limited',
    );
  });

  it('rate-limits login attempts per IP across accounts', async () => {
    const ip = '203.0.113.77';
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      statuses.push(
        (await call('POST', '/api/v1/auth/login', { ip, body: { username: `spray${i}`, password: PASSWORD } })).status,
      );
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('rate-limits registration per IP', async () => {
    const ip = '2001:db8:1:2:aaaa::1';
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // Different addresses within one /64 share a limit.
      const sameNet = ip.replace('aaaa', String(1000 + i));
      statuses.push(
        (
          await call('POST', '/api/v1/auth/register', {
            ip: sameNet,
            body: { username: `burst${i}`, password: PASSWORD },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('password changes and account deletion', () => {
  it('requires the current password, rotates this session and signs out the others', async () => {
    const { cookie, username } = await registerUser('pwchange');
    const other = await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
    const next = 'a brand new passphrase';
    expectError(
      await call('POST', '/api/v1/account/password', {
        cookie,
        body: { current_password: 'not it at all', new_password: next },
      }),
      403,
      'incorrect_password',
    );
    const changed = await call('POST', '/api/v1/account/password', {
      cookie,
      body: { current_password: PASSWORD, new_password: next },
    });
    expect(changed.status).toBe(204);
    expect(changed.cookie).not.toBe(cookie);
    expectError(await call('GET', '/api/v1/auth/me', { cookie }), 401, 'unauthenticated');
    expectError(await call('GET', '/api/v1/auth/me', { cookie: other.cookie as string }), 401, 'unauthenticated');
    expect((await call('GET', '/api/v1/auth/me', { cookie: changed.cookie as string })).status).toBe(200);
    expectError(
      await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } }),
      401,
      'invalid_credentials',
    );
    expect((await call('POST', '/api/v1/auth/login', { body: { username, password: next } })).status).toBe(200);
  });

  it('upgrades password hashes stored with old parameters on login', async () => {
    const { username, id } = await registerUser('rehash');
    // Simulate a hash created with an older iteration count by re-hashing via the API's format.
    const old = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(id)
      .first<string>('password_hash');
    expect(old).toMatch(/^pbkdf2_sha256\$100000\$/);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, key, 256);
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    const legacy = `pbkdf2_sha256$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(legacy, id).run();
    expect((await call('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } })).status).toBe(200);
    const upgraded = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(id)
      .first<string>('password_hash');
    expect(upgraded).toMatch(/^pbkdf2_sha256\$100000\$/);
  });

  it('deletes the account and all of its data after password confirmation', async () => {
    const { cookie, id } = await registerUser('leaver');
    expectError(
      await call('DELETE', '/api/v1/account', { cookie, body: { password: 'wrong wrong wrong' } }),
      403,
      'incorrect_password',
    );
    expect((await call('DELETE', '/api/v1/account', { cookie, body: { password: PASSWORD } })).status).toBe(204);
    for (const table of ['users', 'sessions', 'devices', 'clipboard_entries', 'pairing_challenges']) {
      const column = table === 'users' ? 'id' : 'user_id';
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(id).first('n');
      expect(n, table).toBe(0);
    }
    expectError(await call('GET', '/api/v1/auth/me', { cookie }), 401, 'unauthenticated');
  });

  it('refuses to delete the only administrator', async () => {
    const admin = await env.DB.prepare('SELECT username FROM users WHERE is_admin = 1').first<string>('username');
    const login = await call('POST', '/api/v1/auth/login', { body: { username: admin, password: PASSWORD } });
    expectError(
      await call('DELETE', '/api/v1/account', { cookie: login.cookie as string, body: { password: PASSWORD } }),
      409,
      'last_admin',
    );
  });

  it('defaults to 6-hour retention and validates changes', async () => {
    const { cookie } = await registerUser('retention');
    const retention = async () => (await call('GET', '/api/v1/auth/me', { cookie })).body.settings.retention_hours;
    expect(await retention()).toBe(6);
    const set = (retention_hours: unknown) =>
      call('PATCH', '/api/v1/account/settings', { cookie, body: { retention_hours } });
    expect((await set(24)).status).toBe(200);
    expect(await retention()).toBe(24);
    expect((await set(null)).status).toBe(200);
    expect(await retention()).toBeNull();
    for (const bad of [0, -1, 1.5, '6', 87_601]) expectError(await set(bad), 400, 'invalid_request');
  });
});

describe('request hardening', () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = (await registerUser('harden')).cookie;
  });

  it('requires a same-origin Origin header for cookie-authenticated writes (CSRF)', async () => {
    expectError(await call('DELETE', '/api/v1/clipboard', { cookie, origin: null }), 403, 'cross_origin_forbidden');
    expectError(
      await call('DELETE', '/api/v1/clipboard', { cookie, origin: 'https://evil.example' }),
      403,
      'cross_origin_forbidden',
    );
    expectError(
      await call('POST', '/api/v1/auth/login', {
        origin: 'https://evil.example',
        body: { username: 'x', password: PASSWORD },
      }),
      403,
      'cross_origin_forbidden',
    );
    expect((await call('DELETE', '/api/v1/clipboard', { cookie, origin: ORIGIN })).status).toBe(204);
  });

  it('sends no CORS headers, so browsers block cross-origin reads', async () => {
    const res = await call('GET', '/api/v1/auth/me', { cookie, headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await call('OPTIONS', '/api/v1/clipboard', {
      origin: 'https://evil.example',
      headers: { 'access-control-request-method': 'DELETE' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects malformed, mistyped and oversized bodies', async () => {
    expectError(await call('POST', '/api/v1/auth/login', { rawBody: '{"username":' }), 400, 'invalid_json');
    expectError(await call('POST', '/api/v1/auth/login', { rawBody: '["array"]' }), 400, 'invalid_json');
    expectError(
      await call('POST', '/api/v1/auth/login', {
        rawBody: 'username=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
      415,
      'unsupported_media_type',
    );
    expectError(
      await call('POST', '/api/v1/auth/login', { body: { username: 'x', password: 'y'.repeat(20_000) } }),
      413,
      'payload_too_large',
    );
    expectError(
      await call('POST', '/api/v1/auth/login', { body: { username: 42, password: PASSWORD } }),
      400,
      'invalid_request',
    );
  });

  it('refuses plain HTTP except on localhost', async () => {
    const { exports } = await import('cloudflare:workers');
    const remote = await exports.default.fetch('http://cc.test/api/v1/health');
    expect(remote.status).toBe(403);
    const local = await exports.default.fetch('http://localhost:8787/api/v1/health');
    expect(local.status).toBe(200);
  });

  it('sets security headers and returns JSON errors for unknown routes', async () => {
    const res = await call('GET', '/api/v1/nope');
    expectError(res, 404, 'not_found');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('never writes passwords, tokens or clipboard content to logs, even on internal errors', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    const secrets: string[] = [PASSWORD, 'a wrong passphrase!', 'top secret clipboard text'];
    try {
      const user = await registerUser('logs');
      const { token } = await pairDevice(user.cookie);
      secrets.push(token, user.cookie.split('=')[1] as string);
      await uploadText(token, 'top secret clipboard text');
      await call('POST', '/api/v1/auth/login', { body: { username: user.username, password: 'a wrong passphrase!' } });
      await call('POST', '/api/v1/auth/login', { rawBody: '{"password": "a wrong passphrase!"' });
      // Force an unhandled database error mid-request: the response stays generic and the log names no secrets.
      await env.DB.prepare('ALTER TABLE rate_limits RENAME TO rate_limits_hidden').run();
      try {
        const res = await call('POST', '/api/v1/auth/login', { body: { username: user.username, password: PASSWORD } });
        expectError(res, 500, 'internal_error');
        expect(JSON.stringify(res.body)).not.toContain('rate_limits');
      } finally {
        await env.DB.prepare('ALTER TABLE rate_limits_hidden RENAME TO rate_limits').run();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0); // The internal error was logged...
    for (const secret of secrets) expect(logged.join('\n')).not.toContain(secret); // ...without any secret.
  });

  it('keeps admin endpoints away from regular users', async () => {
    expectError(await call('GET', '/api/v1/admin/invites', { cookie }), 403, 'forbidden');
    expectError(await call('POST', '/api/v1/admin/invites', { cookie }), 403, 'forbidden');
    expectError(
      await call('PATCH', '/api/v1/admin/instance', { cookie, body: { registration_mode: 'open' } }),
      403,
      'forbidden',
    );
    expectError(await call('GET', '/api/v1/admin/invites'), 401, 'unauthenticated');
  });
});
