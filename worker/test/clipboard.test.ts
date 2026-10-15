import { createScheduledController } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { call, expectError, ORIGIN, pairDevice, registerUser, setupInstance, uploadText } from './helpers';

describe('clipboard upload', () => {
  let cookie: string;
  let token: string;
  beforeAll(async () => {
    await setupInstance();
    cookie = (await registerUser('clip')).cookie;
    token = (await pairDevice(cookie)).token;
  });

  it('stores text and returns a stable id and timestamp', async () => {
    const res = await uploadText(token, 'hello world');
    expect(res.status).toBe(201);
    expect(res.body.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.body.entry.created_at).toBe('number');
    const entry = await call('GET', `/api/v1/clipboard/${res.body.entry.id}`, { cookie });
    expect(entry.body.entry).toMatchObject({
      content: 'hello world',
      content_type: 'text/plain',
      device_name: 'Test Mac',
    });
  });

  it('makes retries safe: the same idempotency key never creates a second entry', async () => {
    const key = crypto.randomUUID();
    const first = await uploadText(token, 'retry me', key);
    const again = await uploadText(token, 'retry me', key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.entry).toEqual(first.body.entry);
    const racing = await Promise.all([1, 2, 3].map(() => uploadText(token, 'race me', `race-${key}`)));
    expect(racing.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expectError(await uploadText(token, 'different content', key), 409, 'idempotency_key_reused');
  });

  it('moves repeated content to the top instead of duplicating it', async () => {
    const first = await uploadText(token, 'déjà vu');
    await uploadText(token, 'something else');
    const repeat = await uploadText(token, 'déjà vu');
    const list = await call('GET', '/api/v1/clipboard?q=d%C3%A9j%C3%A0', { cookie });
    expect(list.body.entries.map((e: { id: string }) => e.id)).toEqual([repeat.body.entry.id]);
    expectError(await call('GET', `/api/v1/clipboard/${first.body.entry.id}`, { cookie }), 404, 'not_found');
  });

  it('rejects empty, oversized, non-text and malformed uploads', async () => {
    expectError(await uploadText(token, ''), 400, 'invalid_request');
    expectError(await uploadText(token, 'x'.repeat(1024 * 1024 + 1)), 413, 'content_too_large');
    expectError(await uploadText(token, '\uD800 lone surrogate'), 400, 'invalid_request');
    expectError(await uploadText(token, 'ok', 'short'), 400, 'invalid_request');
    const asImage = await call('POST', '/api/v1/device/clipboard', {
      token,
      origin: null,
      body: { content: 'iVBOR', content_type: 'image/png', idempotency_key: crypto.randomUUID() },
    });
    expectError(asImage, 415, 'unsupported_content_type');
    const huge = await call('POST', '/api/v1/device/clipboard', {
      token,
      origin: null,
      rawBody: JSON.stringify({ content: 'y'.repeat(3 * 1024 * 1024), idempotency_key: crypto.randomUUID() }),
    });
    expectError(huge, 413, 'payload_too_large');
    expect((await uploadText(token, 'x'.repeat(1024 * 1024))).status).toBe(201);
  });

  it('stores HTML and script-like text verbatim, as data', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const res = await uploadText(token, payload);
    const entry = await call('GET', `/api/v1/clipboard/${res.body.entry.id}`, { cookie });
    expect(entry.body.entry.content).toBe(payload);
    expect(entry.headers.get('content-type')).toBe('application/json');
  });

  it('enforces the per-user storage quota', async () => {
    const quotaUser = await registerUser('quota');
    const quotaToken = (await pairDevice(quotaUser.cookie)).token;
    await env.DB.prepare('UPDATE users SET storage_bytes = ? WHERE id = ?')
      .bind(100 * 1024 * 1024 - 10, quotaUser.id)
      .run();
    expect((await uploadText(quotaToken, 'tiny')).status).toBe(201);
    expectError(await uploadText(quotaToken, 'this one does not fit'), 507, 'storage_quota_exceeded');
  });

  it('keeps storage accounting exact through inserts and deletes', async () => {
    const user = await registerUser('acct');
    const t = (await pairDevice(user.cookie)).token;
    const a = await uploadText(t, 'aaaa');
    await uploadText(t, 'bbbbbbbb');
    await uploadText(t, 'aaaa'); // replaces the first entry
    await call('DELETE', `/api/v1/clipboard/${a.body.entry.id}`, { cookie: user.cookie });
    const me = await call('GET', '/api/v1/auth/me', { cookie: user.cookie });
    expect(me.body.storage.used_bytes).toBe(12);
    await call('DELETE', '/api/v1/clipboard', { cookie: user.cookie });
    expect((await call('GET', '/api/v1/auth/me', { cookie: user.cookie })).body.storage.used_bytes).toBe(0);
  });

  it('rate-limits uploads per device', async () => {
    const user = await registerUser('flood');
    const t = (await pairDevice(user.cookie)).token;
    const statuses = [];
    for (let i = 0; i < 121; i++) statuses.push((await uploadText(t, `burst ${i}`)).status);
    expect(statuses.slice(0, 120).every((s) => s === 201)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe('clipboard history', () => {
  let cookie: string;
  let token: string;
  const ids: string[] = [];
  beforeAll(async () => {
    cookie = (await registerUser('hist')).cookie;
    token = (await pairDevice(cookie, 'History Mac')).token;
    for (let i = 0; i < 7; i++) ids.push((await uploadText(token, `entry number ${i}`)).body.entry.id);
    await uploadText(token, '100% literal_match \\ backslash');
    await uploadText(token, 'z'.repeat(1500));
  });

  it('pages newest-first with a stable cursor and no overlap', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { entries: { id: string }[]; next_cursor: string | null } } = await call(
        'GET',
        `/api/v1/clipboard?limit=4${cursor ? `&cursor=${cursor}` : ''}`,
        { cookie },
      );
      seen.push(...page.body.entries.map((e) => e.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(seen.slice(2)).toEqual([...ids].reverse());
  });

  it('returns previews for long content and the full text on request', async () => {
    const list = await call('GET', '/api/v1/clipboard?limit=1', { cookie });
    const [entry] = list.body.entries;
    expect(entry).toMatchObject({ truncated: true, size_bytes: 1500, device_name: 'History Mac' });
    expect(entry.preview).toHaveLength(1000);
    expect(entry.content).toBeUndefined();
    expect((await call('GET', `/api/v1/clipboard/${entry.id}`, { cookie })).body.entry.content).toHaveLength(1500);
  });

  it('searches case-insensitively and treats wildcards and SQL as literal text', async () => {
    const search = async (q: string) =>
      (await call('GET', `/api/v1/clipboard?q=${encodeURIComponent(q)}`, { cookie })).body.entries.length;
    expect(await search('ENTRY NUMBER')).toBe(7);
    expect(await search('number 3')).toBe(1);
    expect(await search('100%')).toBe(1);
    expect(await search('%')).toBe(1);
    expect(await search('_')).toBe(1);
    expect(await search('\\')).toBe(1);
    expect(await search("' OR 1=1 --")).toBe(0);
    expect(await search('%" OR user_id != "')).toBe(0);
    expect(await search('x'.repeat(200))).toBe(0);
    expectError(await call('GET', `/api/v1/clipboard?q=${'x'.repeat(201)}`, { cookie }), 400, 'invalid_request');
  });

  it('validates paging parameters', async () => {
    for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'cursor=garbage', "cursor=1.1' OR 1=1"]) {
      expectError(await call('GET', `/api/v1/clipboard?${qs}`, { cookie }), 400, 'invalid_request');
    }
  });

  it('deletes single entries and clears history', async () => {
    expect((await call('DELETE', `/api/v1/clipboard/${ids[0]}`, { cookie })).status).toBe(204);
    expectError(await call('DELETE', `/api/v1/clipboard/${ids[0]}`, { cookie }), 404, 'not_found');
    expect((await call('DELETE', '/api/v1/clipboard', { cookie })).status).toBe(204);
    expect((await call('GET', '/api/v1/clipboard', { cookie })).body).toEqual({ entries: [], next_cursor: null });
  });
});

describe('rich text', () => {
  let cookie: string;
  let token: string;
  beforeAll(async () => {
    cookie = (await registerUser('rich')).cookie;
    token = (await pairDevice(cookie)).token;
  });
  const uploadRich = (content: string, html: unknown) =>
    call('POST', '/api/v1/device/clipboard', {
      token,
      origin: null,
      body: { content, html, idempotency_key: crypto.randomUUID() },
    });

  it('stores formatting verbatim, as data, next to the plain text', async () => {
    const html = '<b>Bold</b> and <i>italic</i><script>alert(1)</script>';
    const res = await uploadRich('Bold and italic', html);
    expect(res.status).toBe(201);
    const [listed] = (await call('GET', '/api/v1/clipboard', { cookie })).body.entries;
    expect(listed).toMatchObject({ preview: 'Bold and italic', has_html: true, size_bytes: 15 + html.length });
    expect(listed.html).toBeUndefined();
    const entry = await call('GET', `/api/v1/clipboard/${res.body.entry.id}`, { cookie });
    expect(entry.body.entry).toMatchObject({ content: 'Bold and italic', html });
    expect(entry.headers.get('content-type')).toBe('application/json');

    const plain = await uploadText(token, 'no formatting here');
    expect((await call('GET', `/api/v1/clipboard/${plain.body.entry.id}`, { cookie })).body.entry.html).toBeNull();
  });

  it('searches the plain text, not the markup', async () => {
    await uploadRich('visible words', '<span title="markuponly">visible words</span>');
    expect((await call('GET', '/api/v1/clipboard?q=markuponly', { cookie })).body.entries).toHaveLength(0);
    expect((await call('GET', '/api/v1/clipboard?q=visible', { cookie })).body.entries).toHaveLength(1);
  });

  it('counts formatting toward the size limit and validates it', async () => {
    expectError(await uploadRich('x'.repeat(600 * 1024), 'y'.repeat(500 * 1024)), 413, 'content_too_large');
    for (const bad of ['', 42, '\uD800 lone surrogate']) {
      expectError(await uploadRich('text', bad), 400, 'invalid_request');
    }
    expect((await uploadRich('text', null)).status).toBe(201);
  });
});

describe('images', () => {
  let cookie: string;
  let token: string;
  beforeAll(async () => {
    cookie = (await registerUser('img')).cookie;
    token = (await pairDevice(cookie)).token;
  });
  // A real 1×1 PNG, plus fake images that only need the right signature (the server never decodes images).
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const b64 = (bytes: ArrayLike<number>) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  const fakePng = () =>
    b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...crypto.getRandomValues(new Uint8Array(32))]);
  const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const uploadImage = (fields: Record<string, unknown>, as = token) =>
    call('POST', '/api/v1/device/clipboard', {
      token: as,
      origin: null,
      body: { content: 'Image 1 × 1', idempotency_key: crypto.randomUUID(), ...fields },
    });
  const fetchBytes = async (path: string, as = cookie) => {
    const res = await exports.default.fetch(new Request(ORIGIN + path, { headers: { cookie: as } }));
    const data = new Uint8Array(await res.arrayBuffer());
    return { res, base64: b64(data) };
  };

  it('stores images and serves them back byte for byte, with a thumbnail', async () => {
    const res = await uploadImage({ image: PNG, image_type: 'image/png', thumbnail: JPEG });
    expect(res.status).toBe(201);
    const [listed] = (await call('GET', '/api/v1/clipboard', { cookie })).body.entries;
    expect(listed).toMatchObject({ preview: 'Image 1 × 1', has_image: true, image_type: 'image/png', has_html: false });
    const entry = (await call('GET', `/api/v1/clipboard/${res.body.entry.id}`, { cookie })).body.entry;
    expect(entry).toMatchObject({ has_image: true, image_type: 'image/png' });
    expect(entry.image).toBeUndefined();

    const image = await fetchBytes(`/api/v1/clipboard/${res.body.entry.id}/image`);
    expect(image.res.status).toBe(200);
    expect(image.base64).toBe(PNG);
    expect(image.res.headers.get('content-type')).toBe('image/png');
    expect(image.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.res.headers.get('content-security-policy')).toContain('sandbox');
    const thumb = await fetchBytes(`/api/v1/clipboard/${res.body.entry.id}/thumbnail`);
    expect([thumb.base64, thumb.res.headers.get('content-type')]).toEqual([JPEG, 'image/jpeg']);
  });

  it('serves the full image as the thumbnail when none was sent', async () => {
    const image = fakePng();
    const res = await uploadImage({ image, image_type: 'image/png' });
    const thumb = await fetchBytes(`/api/v1/clipboard/${res.body.entry.id}/thumbnail`);
    expect([thumb.base64, thumb.res.headers.get('content-type')]).toEqual([image, 'image/png']);
  });

  it('accepts only real PNG and JPEG data, never SVG', async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expectError(await uploadImage({ image: svg, image_type: 'image/svg+xml' }), 415, 'unsupported_content_type');
    expectError(await uploadImage({ image: svg, image_type: 'image/png' }), 415, 'unsupported_content_type');
    expectError(await uploadImage({ image: PNG, image_type: 'image/jpeg' }), 415, 'unsupported_content_type');
    expectError(
      await uploadImage({ image: PNG, image_type: 'image/png', thumbnail: PNG }),
      415,
      'unsupported_content_type',
    );
    expectError(await uploadImage({ image: '%%% not base64', image_type: 'image/png' }), 400, 'invalid_request');
    expectError(await uploadImage({ image: PNG, image_type: 'image/png', html: '<b>x</b>' }), 400, 'invalid_request');
    expectError(await uploadImage({ thumbnail: JPEG }), 400, 'invalid_request');
  });

  it('replaces an identical image instead of duplicating it', async () => {
    const image = fakePng();
    const first = await uploadImage({ image, image_type: 'image/png', content: 'Image first' });
    const again = await uploadImage({ image, image_type: 'image/png', content: 'Image again' });
    expectError(await call('GET', `/api/v1/clipboard/${first.body.entry.id}`, { cookie }), 404, 'not_found');
    expect((await call('GET', `/api/v1/clipboard/${again.body.entry.id}`, { cookie })).status).toBe(200);
  });

  it('counts image bytes toward the entry limit', async () => {
    const big = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(1024 * 1024)]);
    expectError(await uploadImage({ image: big, image_type: 'image/png', thumbnail: JPEG }), 413, 'content_too_large');
  });

  it('never serves an image to anyone but its owner', async () => {
    const res = await uploadImage({ image: fakePng(), image_type: 'image/png' });
    const other = await registerUser('imgother');
    for (const kind of ['image', 'thumbnail']) {
      const path = `/api/v1/clipboard/${res.body.entry.id}/${kind}`;
      expect((await fetchBytes(path, other.cookie)).res.status).toBe(404);
      expect((await fetchBytes(path, '')).res.status).toBe(401);
    }
  });
});

describe('retention', () => {
  it('hides entries the moment they pass retention (6 hours by default) and cleanup deletes them', async () => {
    const user = await registerUser('short'); // default retention
    const keeper = await registerUser('keep');
    const token = (await pairDevice(user.cookie)).token;
    const keeperToken = (await pairDevice(keeper.cookie)).token;
    await call('PATCH', '/api/v1/account/settings', { cookie: keeper.cookie, body: { retention_hours: null } });
    const old = (await uploadText(token, 'seven hours old')).body.entry.id;
    const recent = (await uploadText(token, 'five hours old')).body.entry.id;
    const kept = (await uploadText(keeperToken, 'kept forever')).body.entry.id;
    const hoursAgo = (hours: number) => Date.now() - hours * 3_600_000;
    await env.DB.prepare('UPDATE clipboard_entries SET created_at = ? WHERE id IN (?, ?)')
      .bind(hoursAgo(7), old, kept)
      .run();
    await env.DB.prepare('UPDATE clipboard_entries SET created_at = ? WHERE id = ?').bind(hoursAgo(5), recent).run();

    // Hidden immediately, before any cleanup has run.
    const list = await call('GET', '/api/v1/clipboard', { cookie: user.cookie });
    expect(list.body.entries.map((e: { id: string }) => e.id)).toEqual([recent]);
    expectError(await call('GET', `/api/v1/clipboard/${old}`, { cookie: user.cookie }), 404, 'not_found');
    expect((await call('GET', '/api/v1/clipboard', { cookie: keeper.cookie })).body.entries).toHaveLength(1);

    await env.DB.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').bind(keeper.id).run();
    // Run the real scheduled handler, as the 15-minute cron trigger would.
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *' }), env);

    const remaining = await env.DB.prepare('SELECT id FROM clipboard_entries WHERE id IN (?, ?, ?)')
      .bind(old, recent, kept)
      .all<{ id: string }>();
    expect(remaining.results.map((r) => r.id).sort()).toEqual([recent, kept].sort());
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .bind(keeper.id)
      .first('n');
    expect(sessions).toBe(0);
    const me = await call('GET', '/api/v1/auth/me', { cookie: user.cookie });
    expect(me.body.storage.used_bytes).toBe('five hours old'.length);
  });
});
