// Clipboard history. Devices upload; signed-in browsers read, search and delete. Every query is scoped by user_id.
import type { Ctx, Route } from '../auth';
import { HttpError, json, noContent, readJson, str } from '../http';
import { rateLimit, sha256 } from '../security';

export const MAX_CONTENT_BYTES = 1024 * 1024;
const PREVIEW_CHARS = 1000;
const MAX_SEARCH_CHARS = 200;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})$/;

export const storageQuotaBytes = (env: Env) => Math.max(1, Number(env.STORAGE_QUOTA_MB) || 100) * 1024 * 1024;

/** Entries created at or before this time are past the user's retention: hidden now, deleted by the next cleanup. */
const retentionCutoff = (c: Ctx) =>
  c.user.retention_hours === null ? 0 : Date.now() - c.user.retention_hours * 3_600_000;

async function upload(c: Ctx) {
  const deviceId = c.device?.id;
  await rateLimit(c.db, `upload:${deviceId}`, 120, 60);
  // JSON escaping can grow text, so the body may be larger than the content limit.
  const body = await readJson(c.req, 2 * MAX_CONTENT_BYTES);
  if ((body.content_type ?? 'text/plain') !== 'text/plain') {
    throw new HttpError(415, 'unsupported_content_type', 'Only text/plain clipboard content is supported.');
  }
  const content = body.content;
  if (typeof content !== 'string' || content.length === 0 || !content.isWellFormed()) {
    throw new HttpError(400, 'invalid_request', '"content" must be a non-empty string of valid Unicode text.');
  }
  const key = str(body, 'idempotency_key', 64);
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new HttpError(400, 'invalid_request', '"idempotency_key" must be 16-64 characters of [A-Za-z0-9_-].');
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    throw new HttpError(413, 'content_too_large', `Clipboard content is limited to ${MAX_CONTENT_BYTES} bytes.`);
  }
  const hash = await sha256(bytes);
  const userId = c.user.id;
  const id = crypto.randomUUID();
  const now = Date.now();
  const [inserted] = await c.db.batch([
    // Inserts unless the idempotency key was already used (a retry) or the user would exceed their quota.
    c.db
      .prepare(
        `INSERT INTO clipboard_entries
           (id, user_id, device_id, idempotency_key, content_type, content, content_hash, size_bytes, created_at)
         SELECT ?1, ?2, ?3, ?4, 'text/plain', ?5, ?6, ?7, ?8
         WHERE (SELECT storage_bytes FROM users WHERE id = ?2) + ?7 <= ?9
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      )
      .bind(id, userId, deviceId, key, content, hash, bytes.byteLength, now, storageQuotaBytes(c.env)),
    // Copying the same text again moves it to the top instead of duplicating it. Runs only if the insert did.
    c.db
      .prepare(
        `DELETE FROM clipboard_entries WHERE user_id = ?1 AND content_hash = ?2 AND id != ?3
         AND EXISTS (SELECT 1 FROM clipboard_entries WHERE id = ?3)`,
      )
      .bind(userId, hash, id),
  ]);
  // RETURNING, not meta.changes: D1 counts the storage trigger's writes in meta.changes.
  if (inserted?.results.length === 1) return json({ entry: { id, created_at: now } }, 201);

  const previous = await c.db
    .prepare('SELECT id, created_at, content_hash FROM clipboard_entries WHERE user_id = ? AND idempotency_key = ?')
    .bind(userId, key)
    .first<{ id: string; created_at: number; content_hash: string }>();
  if (previous?.content_hash === hash) return json({ entry: { id: previous.id, created_at: previous.created_at } });
  if (previous) {
    throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key was already used for different content.');
  }
  throw new HttpError(507, 'storage_quota_exceeded', 'Storage quota reached. Delete history or shorten retention.');
}

const ENTRY_COLUMNS = `e.id, e.content_type, e.size_bytes, e.created_at,
  e.device_id, d.name AS device_name`;
const ENTRY_FROM = 'clipboard_entries e LEFT JOIN devices d ON d.id = e.device_id AND d.user_id = e.user_id';

async function list(c: Ctx) {
  const params = c.url.searchParams;
  const query = params.get('q')?.trim() ?? '';
  if (query.length > MAX_SEARCH_CHARS) {
    throw new HttpError(400, 'invalid_request', `Search is limited to ${MAX_SEARCH_CHARS} characters.`);
  }
  const limit = Number(params.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'invalid_request', '"limit" must be an integer from 1 to 100.');
  }
  const cursorParam = params.get('cursor');
  const cursor = cursorParam === null ? null : CURSOR.exec(cursorParam);
  if (cursorParam !== null && !cursor) throw new HttpError(400, 'invalid_request', 'Invalid cursor.');

  let sql = `SELECT ${ENTRY_COLUMNS}, substr(e.content, 1, ?) AS preview, length(e.content) > ? AS truncated
    FROM ${ENTRY_FROM} WHERE e.user_id = ? AND e.created_at > ?`;
  const args: unknown[] = [PREVIEW_CHARS, PREVIEW_CHARS, c.user.id, retentionCutoff(c)];
  if (query) {
    // Literal, ASCII-case-insensitive substring match. instr() instead of LIKE: no wildcards to escape, and
    // D1 caps LIKE patterns at 50 bytes. ponytail: scans the user's rows; add FTS5 if histories grow large.
    sql += ' AND instr(lower(e.content), lower(?)) > 0';
    args.push(query);
  }
  if (cursor) {
    sql += ' AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))';
    args.push(Number(cursor[1]), Number(cursor[1]), cursor[2]);
  }
  sql += ' ORDER BY e.created_at DESC, e.id DESC LIMIT ?';
  args.push(limit + 1);

  const { results } = await c.db
    .prepare(sql)
    .bind(...args)
    .all<{ id: string; created_at: number; truncated: number }>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return json({
    entries: page.map((e) => ({ ...e, truncated: e.truncated === 1 })),
    next_cursor: results.length > limit && last ? `${last.created_at}.${last.id}` : null,
  });
}

async function get(c: Ctx) {
  const entry = await c.db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}, e.content FROM ${ENTRY_FROM} WHERE e.id = ? AND e.user_id = ? AND e.created_at > ?`,
    )
    .bind(c.params.id, c.user.id, retentionCutoff(c))
    .first();
  if (!entry) throw new HttpError(404, 'not_found', 'Entry not found.');
  return json({ entry });
}

async function remove(c: Ctx) {
  const deleted = await c.db
    .prepare('DELETE FROM clipboard_entries WHERE id = ? AND user_id = ? RETURNING id')
    .bind(c.params.id, c.user.id)
    .first();
  if (!deleted) throw new HttpError(404, 'not_found', 'Entry not found.');
  return noContent();
}

async function clear(c: Ctx) {
  await c.db.prepare('DELETE FROM clipboard_entries WHERE user_id = ?').bind(c.user.id).run();
  return noContent();
}

/** Scheduled cleanup: retention plus expired auth artifacts. Bounded per run; the next run continues. */
export async function cleanup(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM clipboard_entries WHERE id IN (
         SELECT e.id FROM clipboard_entries e JOIN users u ON u.id = e.user_id
         WHERE u.retention_hours IS NOT NULL AND e.created_at <= ?1 - u.retention_hours * 3600000 LIMIT 10000)`,
    ).bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM pairing_challenges WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86_400_000),
  ]);
}

export const routes: Route[] = [
  ['POST', '/api/v1/device/clipboard', 'device', upload],
  ['GET', '/api/v1/clipboard', 'session', list],
  ['GET', '/api/v1/clipboard/:id', 'session', get],
  ['DELETE', '/api/v1/clipboard/:id', 'session', remove],
  ['DELETE', '/api/v1/clipboard', 'session', clear],
];
