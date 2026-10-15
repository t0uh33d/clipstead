import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, expectError, pairDevice, registerUser, setupInstance, uploadText } from './helpers';

const claim = (code: string, extra: Record<string, unknown> = {}, ip?: string) =>
  call('POST', '/api/v1/device/pairing/claim', {
    origin: null,
    ip,
    body: { code, device_name: 'Work MacBook', platform: 'macOS 15.1', app_version: '0.1.0', ...extra },
  });
const exchange = (poll_token: string) =>
  call('POST', '/api/v1/device/pairing/token', { origin: null, body: { poll_token } });

describe('device pairing', () => {
  let cookie: string;
  beforeAll(async () => {
    await setupInstance();
  });
  // A fresh account per test: pairing creation is rate-limited per account.
  beforeEach(async () => {
    cookie = (await registerUser('pair')).cookie;
  });

  it('completes the full flow and shows the device to the approver', async () => {
    const created = await call('POST', '/api/v1/pairings', { cookie });
    expect(created.status).toBe(201);
    const { id, code } = created.body.pairing;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    // The code is stored only as a hash.
    const row = await env.DB.prepare('SELECT code_hash FROM pairing_challenges WHERE id = ?')
      .bind(id)
      .first<string>('code_hash');
    expect(row).not.toContain(code.replace('-', ''));

    const claimed = await claim(code.toLowerCase().replace('-', ' '), {}, '203.0.113.9');
    expect(claimed.status).toBe(200);
    expect(claimed.body.poll_token).toMatch(/^csp_/);

    expect((await exchange(claimed.body.poll_token)).status).toBe(202);

    const pending = await call('GET', `/api/v1/pairings/${id}`, { cookie });
    expect(pending.body.pairing).toMatchObject({
      status: 'claimed',
      device: { name: 'Work MacBook', platform: 'macOS 15.1', app_version: '0.1.0', ip: '203.0.113.9' },
    });

    expect((await call('POST', `/api/v1/pairings/${id}/approve`, { cookie })).body.pairing.status).toBe('approved');
    const issued = await exchange(claimed.body.poll_token);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({
      status: 'approved',
      device: { name: 'Work MacBook' },
      user: { username: 'pair1' },
    });
    expect(issued.body.device_token).toMatch(/^csd_[A-Za-z0-9_-]{43}$/);

    const me = await call('GET', '/api/v1/device/me', { token: issued.body.device_token });
    expect(me.body).toMatchObject({ device: { name: 'Work MacBook' }, user: { username: 'pair1' } });
    expect((await call('GET', `/api/v1/pairings/${id}`, { cookie })).body.pairing.status).toBe('completed');
    const devices = await call('GET', '/api/v1/devices', { cookie });
    expect(devices.body.devices.map((d: { name: string }) => d.name)).toContain('Work MacBook');
  });

  it('rejects replayed claims and replayed token exchanges', async () => {
    const { pairing } = (await call('POST', '/api/v1/pairings', { cookie })).body;
    const first = await claim(pairing.code);
    expectError(await claim(pairing.code), 400, 'invalid_code');
    await call('POST', `/api/v1/pairings/${pairing.id}/approve`, { cookie });
    expect((await exchange(first.body.poll_token)).status).toBe(200);
    expectError(await exchange(first.body.poll_token), 410, 'pairing_unavailable');
    expectError(await claim(pairing.code), 400, 'invalid_code');
  });

  it('issues exactly one credential when token exchanges race', async () => {
    const { pairing } = (await call('POST', '/api/v1/pairings', { cookie })).body;
    const claimed = await claim(pairing.code);
    await call('POST', `/api/v1/pairings/${pairing.id}/approve`, { cookie });
    const results = await Promise.all([1, 2, 3, 4].map(() => exchange(claimed.body.poll_token)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410, 410]);
    const devices = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM pairing_challenges WHERE id = ? AND device_id IS NOT NULL',
    )
      .bind(pairing.id)
      .first('n');
    expect(devices).toBe(1);
  });

  it('never issues a credential without approval, after denial, or after expiry', async () => {
    const denied = (await call('POST', '/api/v1/pairings', { cookie })).body.pairing;
    const deniedClaim = await claim(denied.code);
    expect((await call('DELETE', `/api/v1/pairings/${denied.id}`, { cookie })).status).toBe(204);
    expectError(await exchange(deniedClaim.body.poll_token), 410, 'pairing_unavailable');

    const expired = (await call('POST', '/api/v1/pairings', { cookie })).body.pairing;
    const expiredClaim = await claim(expired.code);
    await env.DB.prepare('UPDATE pairing_challenges SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expired.id)
      .run();
    expectError(
      await call('POST', `/api/v1/pairings/${expired.id}/approve`, { cookie }),
      409,
      'pairing_not_approvable',
    );
    expectError(await exchange(expiredClaim.body.poll_token), 410, 'pairing_unavailable');

    const unclaimed = (await call('POST', '/api/v1/pairings', { cookie })).body.pairing;
    await env.DB.prepare('UPDATE pairing_challenges SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, unclaimed.id)
      .run();
    expectError(await claim(unclaimed.code), 400, 'invalid_code');

    const notClaimed = (await call('POST', '/api/v1/pairings', { cookie })).body.pairing;
    expectError(
      await call('POST', `/api/v1/pairings/${notClaimed.id}/approve`, { cookie }),
      409,
      'pairing_not_approvable',
    );
  });

  it('starting a new pairing cancels the previous unfinished one', async () => {
    const old = (await call('POST', '/api/v1/pairings', { cookie })).body.pairing;
    await call('POST', '/api/v1/pairings', { cookie });
    expectError(await claim(old.code), 400, 'invalid_code');
  });

  it('rejects invalid codes generically and rate-limits guessing per IP', async () => {
    const ip = '203.0.113.200';
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await claim(`ZZZZ-ZZZ${i % 10}`, {}, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    // A valid code from a rate-limited IP is still refused.
    const { pairing } = (await call('POST', '/api/v1/pairings', { cookie })).body;
    expectError(await claim(pairing.code, {}, ip), 429, 'rate_limited');
  });

  it('validates device metadata, rejecting control and bidi-override characters', async () => {
    const { pairing } = (await call('POST', '/api/v1/pairings', { cookie })).body;
    expectError(await claim(pairing.code, { device_name: 'Mac‮koob' }), 400, 'invalid_request');
    expectError(await claim(pairing.code, { device_name: 'line\nbreak' }), 400, 'invalid_request');
    expectError(await claim(pairing.code, { device_name: '' }), 400, 'invalid_request');
    expectError(await claim(pairing.code, { platform: 'x'.repeat(65) }), 400, 'invalid_request');
    expect((await claim(pairing.code, { device_name: '🍎 Mac mini' })).status).toBe(200);
  });

  it('requires a signed-in browser to create, view or approve pairings', async () => {
    const { pairing } = (await call('POST', '/api/v1/pairings', { cookie })).body;
    expectError(await call('POST', '/api/v1/pairings'), 401, 'unauthenticated');
    expectError(await call('GET', `/api/v1/pairings/${pairing.id}`), 401, 'unauthenticated');
    expectError(await call('POST', `/api/v1/pairings/${pairing.id}/approve`), 401, 'unauthenticated');
  });
});

describe('device credentials', () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = (await registerUser('dev')).cookie;
  });

  it('revocation takes effect on the very next request', async () => {
    const { token, deviceId } = await pairDevice(cookie);
    expect((await uploadText(token, 'before revoke')).status).toBe(201);
    expect((await call('DELETE', `/api/v1/devices/${deviceId}`, { cookie })).status).toBe(204);
    expectError(await uploadText(token, 'after revoke'), 401, 'invalid_device_token');
    expectError(await call('GET', '/api/v1/device/me', { token }), 401, 'invalid_device_token');
    const row = await env.DB.prepare('SELECT token_hash, revoked_at FROM devices WHERE id = ?').bind(deviceId).first();
    expect(row).toMatchObject({ token_hash: null });
    const listed = await call('GET', '/api/v1/devices', { cookie });
    expect(listed.body.devices.map((d: { id: string }) => d.id)).not.toContain(deviceId);
    expectError(await call('DELETE', `/api/v1/devices/${deviceId}`, { cookie }), 404, 'not_found');
  });

  it('re-pairing issues a new, independent credential', async () => {
    const first = await pairDevice(cookie, 'Studio');
    const second = await pairDevice(cookie, 'Studio');
    expect(second.token).not.toBe(first.token);
    await call('DELETE', `/api/v1/devices/${first.deviceId}`, { cookie });
    expect((await uploadText(second.token, 'still works')).status).toBe(201);
  });

  it('a device can unpair itself', async () => {
    const { token } = await pairDevice(cookie);
    expect((await call('DELETE', '/api/v1/device/me', { token, origin: null })).status).toBe(204);
    expectError(await call('GET', '/api/v1/device/me', { token }), 401, 'invalid_device_token');
  });

  it('device tokens and session cookies are not interchangeable', async () => {
    const { token } = await pairDevice(cookie);
    // A device token is not a browser session...
    expectError(await call('GET', '/api/v1/clipboard', { token }), 401, 'unauthenticated');
    expectError(await call('GET', '/api/v1/devices', { token }), 401, 'unauthenticated');
    expectError(await call('POST', '/api/v1/pairings', { token, origin: null }), 403, 'cross_origin_forbidden');
    expectError(await call('POST', '/api/v1/pairings', { token }), 401, 'unauthenticated');
    // ...even when smuggled in as a cookie value.
    expectError(
      await call('GET', '/api/v1/clipboard', { cookie: `__Host-clipstead_session=${token}` }),
      401,
      'unauthenticated',
    );
    // And a session cookie cannot call device endpoints.
    expectError(await call('GET', '/api/v1/device/me', { cookie }), 401, 'invalid_device_token');
    const sessionToken = cookie.split('=')[1] as string;
    expectError(await call('GET', '/api/v1/device/me', { token: sessionToken }), 401, 'invalid_device_token');
  });

  it('renames devices and records last-seen activity', async () => {
    const { token, deviceId } = await pairDevice(cookie, 'Old name');
    await env.DB.prepare('UPDATE devices SET last_seen_at = 1 WHERE id = ?').bind(deviceId).run();
    await call('GET', '/api/v1/device/me', { token });
    const seen = await env.DB.prepare('SELECT last_seen_at FROM devices WHERE id = ?')
      .bind(deviceId)
      .first<number>('last_seen_at');
    expect(seen).toBeGreaterThan(1);
    const renamed = await call('PATCH', `/api/v1/devices/${deviceId}`, { cookie, body: { name: '  New name ' } });
    expect(renamed.body.device.name).toBe('New name');
    expectError(
      await call('PATCH', `/api/v1/devices/${deviceId}`, { cookie, body: { name: 'a\u0000b' } }),
      400,
      'invalid_request',
    );
  });

  it('rejects malformed device tokens', async () => {
    for (const token of ['csd_short', `csd_${'A'.repeat(43)}`, 'not-a-token']) {
      expectError(await call('GET', '/api/v1/device/me', { token }), 401, 'invalid_device_token');
    }
    expectError(await call('GET', '/api/v1/device/me'), 401, 'invalid_device_token');
  });
});
