// The core invariant: a user can never read or change another user's clipboard, devices, sessions or pairings,
// even when they know the other user's resource IDs.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, expectError, pairDevice, registerUser, setupInstance, uploadText } from './helpers';

describe('cross-user isolation', () => {
  let a: { cookie: string; id: string };
  let b: { cookie: string; id: string };
  let aToken: string;
  let bToken: string;
  let bDeviceId: string;
  let bEntryId: string;
  let bSessionId: string;

  beforeAll(async () => {
    await setupInstance();
    a = await registerUser('alice');
    b = await registerUser('bob');
    aToken = (await pairDevice(a.cookie, 'Alice Mac')).token;
    ({ token: bToken, deviceId: bDeviceId } = await pairDevice(b.cookie, 'Bob Mac'));
    await uploadText(aToken, 'alice shared phrase');
    bEntryId = (await uploadText(bToken, 'bob secret: shared phrase')).body.entry.id;
    bSessionId = (await call('GET', '/api/v1/sessions', { cookie: b.cookie })).body.sessions[0].id;
  });

  const bobStillHas = async () => {
    const res = await call('GET', `/api/v1/clipboard/${bEntryId}`, { cookie: b.cookie });
    expect(res.body.entry.content).toBe('bob secret: shared phrase');
  };

  it("A cannot retrieve B's entry by ID", async () => {
    expectError(await call('GET', `/api/v1/clipboard/${bEntryId}`, { cookie: a.cookie }), 404, 'not_found');
  });

  it("A's history and search never include B's entries", async () => {
    const all = await call('GET', '/api/v1/clipboard', { cookie: a.cookie });
    expect(all.body.entries.map((e: { preview: string }) => e.preview)).toEqual(['alice shared phrase']);
    const search = await call('GET', '/api/v1/clipboard?q=shared%20phrase', { cookie: a.cookie });
    expect(search.body.entries).toHaveLength(1);
    const secret = await call('GET', '/api/v1/clipboard?q=bob%20secret', { cookie: a.cookie });
    expect(secret.body.entries).toHaveLength(0);
  });

  it("A cannot page into B's history with a forged cursor", async () => {
    const forged = `${Date.now() + 86_400_000}.ffffffff-ffff-ffff-ffff-ffffffffffff`;
    const res = await call('GET', `/api/v1/clipboard?cursor=${forged}`, { cookie: a.cookie });
    expect(res.body.entries.map((e: { preview: string }) => e.preview)).toEqual(['alice shared phrase']);
  });

  it("A cannot fetch B's images or thumbnails", async () => {
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));
    const upload = await call('POST', '/api/v1/device/clipboard', {
      token: bToken,
      origin: null,
      body: { content: 'Image 1 × 1', image: png, image_type: 'image/png', idempotency_key: crypto.randomUUID() },
    });
    for (const kind of ['image', 'thumbnail']) {
      expectError(
        await call('GET', `/api/v1/clipboard/${upload.body.entry.id}/${kind}`, { cookie: a.cookie }),
        404,
        'not_found',
      );
    }
  });

  it("A cannot delete B's entry or clear B's history", async () => {
    expectError(await call('DELETE', `/api/v1/clipboard/${bEntryId}`, { cookie: a.cookie }), 404, 'not_found');
    expect((await call('DELETE', '/api/v1/clipboard', { cookie: a.cookie })).status).toBe(204);
    await bobStillHas();
  });

  it("A cannot see, rename or revoke B's devices", async () => {
    const list = await call('GET', '/api/v1/devices', { cookie: a.cookie });
    expect(list.body.devices.map((d: { name: string }) => d.name)).toEqual(['Alice Mac']);
    expectError(
      await call('PATCH', `/api/v1/devices/${bDeviceId}`, { cookie: a.cookie, body: { name: 'pwned' } }),
      404,
      'not_found',
    );
    expectError(await call('DELETE', `/api/v1/devices/${bDeviceId}`, { cookie: a.cookie }), 404, 'not_found');
    const me = await call('GET', '/api/v1/device/me', { token: bToken });
    expect(me.body.device.name).toBe('Bob Mac');
  });

  it("A cannot list or revoke B's sessions", async () => {
    const list = await call('GET', '/api/v1/sessions', { cookie: a.cookie });
    expect(list.body.sessions.map((s: { id: string }) => s.id)).not.toContain(bSessionId);
    expectError(await call('DELETE', `/api/v1/sessions/${bSessionId}`, { cookie: a.cookie }), 404, 'not_found');
    expect((await call('GET', '/api/v1/auth/me', { cookie: b.cookie })).status).toBe(200);
  });

  it("A cannot view, approve or cancel B's pairing request", async () => {
    const pairing = (await call('POST', '/api/v1/pairings', { cookie: b.cookie })).body.pairing;
    const claim = await call('POST', '/api/v1/device/pairing/claim', {
      origin: null,
      body: { code: pairing.code, device_name: 'Attacker box', platform: 'macOS' },
    });
    expectError(await call('GET', `/api/v1/pairings/${pairing.id}`, { cookie: a.cookie }), 404, 'not_found');
    expectError(await call('POST', `/api/v1/pairings/${pairing.id}/approve`, { cookie: a.cookie }), 404, 'not_found');
    expectError(await call('DELETE', `/api/v1/pairings/${pairing.id}`, { cookie: a.cookie }), 404, 'not_found');
    // Not approved by B, so the claimant gets nothing.
    expect(
      (
        await call('POST', '/api/v1/device/pairing/token', {
          origin: null,
          body: { poll_token: claim.body.poll_token },
        })
      ).status,
    ).toBe(202);
    expect((await call('GET', `/api/v1/pairings/${pairing.id}`, { cookie: b.cookie })).body.pairing.status).toBe(
      'claimed',
    );
  });

  it("A's device token only ever writes into A's account", async () => {
    // Even if A's device names B's device or user anywhere in the request, ownership comes from the token.
    const res = await call('POST', '/api/v1/device/clipboard', {
      token: aToken,
      origin: null,
      body: { content: 'injected?', idempotency_key: crypto.randomUUID(), user_id: b.id, device_id: bDeviceId },
    });
    expect(res.status).toBe(201);
    const owner = await env.DB.prepare('SELECT user_id FROM clipboard_entries WHERE id = ?')
      .bind(res.body.entry.id)
      .first('user_id');
    expect(owner).toBe(a.id);
    const bob = await call('GET', '/api/v1/clipboard?q=injected', { cookie: b.cookie });
    expect(bob.body.entries).toHaveLength(0);
  });

  it('the same idempotency key in two accounts creates two independent entries', async () => {
    const key = crypto.randomUUID();
    expect((await uploadText(aToken, 'same key a', key)).status).toBe(201);
    expect((await uploadText(bToken, 'same key b', key)).status).toBe(201);
  });

  it('client-supplied identity fields are ignored everywhere', async () => {
    const me = await call('GET', '/api/v1/auth/me', { cookie: a.cookie, headers: { 'x-user-id': b.id } });
    expect(me.body.user.id).toBe(a.id);
    await call('PATCH', '/api/v1/account/settings', { cookie: a.cookie, body: { retention_hours: 1, user_id: b.id } });
    const bob = await call('GET', '/api/v1/auth/me', { cookie: b.cookie });
    expect(bob.body.settings.retention_hours).toBe(6);
  });

  it("A's account deletion leaves B untouched", async () => {
    const carol = await registerUser('carol');
    const carolToken = (await pairDevice(carol.cookie)).token;
    await uploadText(carolToken, 'carol data');
    expect(
      (
        await call('DELETE', '/api/v1/account', {
          cookie: carol.cookie,
          body: { password: 'correct horse battery staple' },
        })
      ).status,
    ).toBe(204);
    expectError(await uploadText(carolToken, 'after delete'), 401, 'invalid_device_token');
    await bobStillHas();
  });
});
