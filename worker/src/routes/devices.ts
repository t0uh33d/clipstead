// Device pairing and device management.
//
// Pairing is browser-initiated:
//   1. Browser (signed in) creates a challenge and shows a one-time code.          POST /pairings
//   2. The Mac submits the code with its name; it receives a secret poll token.   POST /device/pairing/claim
//   3. Browser shows the claiming device's details; the user approves or denies.  POST /pairings/:id/approve
//   4. The Mac polls with its poll token and receives its device token once.      POST /device/pairing/token
// The code alone grants nothing: only the account owner's approval releases a credential, and only to the
// holder of the poll token. Codes, poll tokens and device tokens are stored as SHA-256 hashes.
import type { Ctx, Route } from '../auth';
import { clientIp, HttpError, json, label, noContent, readJson, str } from '../http';
import { normalizeCode, randomCode, randomToken, rateLimit, sha256 } from '../security';
import { MAX_CONTENT_BYTES } from './clipboard';

const PAIRING_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 3000;
const CODE_LENGTH = 8; // 40 bits

interface Pairing {
  id: string;
  user_id: string;
  device_name: string | null;
  platform: string | null;
  app_version: string | null;
  claim_ip: string | null;
  claim_country: string | null;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  approved_at: number | null;
  completed_at: number | null;
}

function pairingView(p: Pairing) {
  const now = Date.now();
  const status = p.completed_at
    ? 'completed'
    : p.expires_at <= now
      ? 'expired'
      : p.approved_at
        ? 'approved'
        : p.claimed_at
          ? 'claimed'
          : 'waiting';
  return {
    id: p.id,
    status,
    expires_at: p.expires_at,
    device: p.claimed_at
      ? {
          name: p.device_name,
          platform: p.platform,
          app_version: p.app_version,
          ip: p.claim_ip,
          country: p.claim_country,
          claimed_at: p.claimed_at,
        }
      : null,
  };
}

const ownPairing = (c: Ctx) =>
  c.db
    .prepare('SELECT * FROM pairing_challenges WHERE id = ? AND user_id = ?')
    .bind(c.params.id, c.user.id)
    .first<Pairing>();

async function createPairing(c: Ctx) {
  await rateLimit(c.db, `pairing-create:${c.user.id}`, 10, 600);
  const code = randomCode(CODE_LENGTH);
  const id = crypto.randomUUID();
  const now = Date.now();
  // One open pairing per account: starting a new one cancels any unfinished one.
  await c.db.batch([
    c.db.prepare('DELETE FROM pairing_challenges WHERE user_id = ? AND completed_at IS NULL').bind(c.user.id),
    c.db
      .prepare('INSERT INTO pairing_challenges (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, c.user.id, await sha256(code), now, now + PAIRING_TTL_MS),
  ]);
  return json(
    {
      pairing: {
        id,
        status: 'waiting',
        expires_at: now + PAIRING_TTL_MS,
        code: `${code.slice(0, 4)}-${code.slice(4)}`,
      },
    },
    201,
  );
}

async function getPairing(c: Ctx) {
  const pairing = await ownPairing(c);
  if (!pairing) throw new HttpError(404, 'not_found', 'Pairing request not found.');
  return json({ pairing: pairingView(pairing) });
}

async function approvePairing(c: Ctx) {
  if (!(await ownPairing(c))) throw new HttpError(404, 'not_found', 'Pairing request not found.');
  const now = Date.now();
  const approved = await c.db
    .prepare(
      `UPDATE pairing_challenges SET approved_at = ?1
       WHERE id = ?2 AND user_id = ?3 AND claimed_at IS NOT NULL AND approved_at IS NULL AND expires_at > ?1
       RETURNING *`,
    )
    .bind(now, c.params.id, c.user.id)
    .first<Pairing>();
  if (!approved) {
    throw new HttpError(409, 'pairing_not_approvable', 'This pairing request is not waiting for approval.');
  }
  return json({ pairing: pairingView(approved) });
}

/** Deny or cancel. The device's next poll fails and it never receives a credential. */
async function deletePairing(c: Ctx) {
  const { meta } = await c.db
    .prepare('DELETE FROM pairing_challenges WHERE id = ? AND user_id = ? AND completed_at IS NULL')
    .bind(c.params.id, c.user.id)
    .run();
  if (meta.changes !== 1) throw new HttpError(404, 'not_found', 'Pairing request not found.');
  return noContent();
}

async function claimPairing(c: Ctx) {
  await rateLimit(c.db, `pairing-claim:${clientIp(c.req)}`, 10, 600);
  const body = await readJson(c.req);
  const code = normalizeCode(str(body, 'code', 32));
  const deviceName = label(body, 'device_name', 64);
  const platform = label(body, 'platform', 64);
  const appVersion = body.app_version === undefined ? null : label(body, 'app_version', 32);
  const pollToken = randomToken('csp_');
  const now = Date.now();
  // Atomic first-claim-wins: a code can be claimed by exactly one device.
  const claimed = await c.db
    .prepare(
      `UPDATE pairing_challenges
       SET claimed_at = ?1, poll_token_hash = ?2, device_name = ?3, platform = ?4, app_version = ?5,
           claim_ip = ?6, claim_country = ?7
       WHERE code_hash = ?8 AND claimed_at IS NULL AND expires_at > ?1
       RETURNING expires_at`,
    )
    .bind(
      now,
      await sha256(pollToken),
      deviceName,
      platform,
      appVersion,
      c.req.headers.get('cf-connecting-ip'),
      typeof c.req.cf?.country === 'string' ? c.req.cf.country : null,
      await sha256(code),
    )
    .first<{ expires_at: number }>();
  // Same answer for unknown, expired and already-claimed codes: nothing about other accounts leaks.
  if (!claimed) throw new HttpError(400, 'invalid_code', 'This pairing code is invalid, expired or already used.');
  return json({ poll_token: pollToken, expires_at: claimed.expires_at, poll_interval_ms: POLL_INTERVAL_MS });
}

async function exchangePairing(c: Ctx) {
  await rateLimit(c.db, `pairing-poll:${clientIp(c.req)}`, 300, 600);
  const pollTokenHash = await sha256(str(await readJson(c.req), 'poll_token', 128));
  const now = Date.now();
  const pairing = await c.db
    .prepare('SELECT * FROM pairing_challenges WHERE poll_token_hash = ?')
    .bind(pollTokenHash)
    .first<Pairing>();
  const gone = new HttpError(
    410,
    'pairing_unavailable',
    'This pairing request expired, was denied or was already used.',
  );
  if (!pairing || pairing.completed_at || pairing.expires_at <= now) throw gone;
  if (!pairing.approved_at) return json({ status: 'pending', poll_interval_ms: POLL_INTERVAL_MS }, 202);

  const deviceId = crypto.randomUUID();
  const deviceToken = randomToken('csd_');
  // One transaction: the device is created only from an approved, unconsumed challenge, which is then consumed.
  // Concurrent polls serialize; the second finds completed_at set and creates nothing.
  const [created] = await c.db.batch([
    c.db
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, token_hash, created_at, last_seen_at)
         SELECT ?1, user_id, device_name, platform, ?2, ?3, ?3 FROM pairing_challenges
         WHERE id = ?4 AND approved_at IS NOT NULL AND completed_at IS NULL AND expires_at > ?3`,
      )
      .bind(deviceId, await sha256(deviceToken), now, pairing.id),
    c.db
      .prepare(
        `UPDATE pairing_challenges SET completed_at = ?1, device_id = ?2
         WHERE id = ?3 AND completed_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE id = ?2)`,
      )
      .bind(now, deviceId, pairing.id),
  ]);
  if (created?.meta.changes !== 1) throw gone;
  const owner = await c.db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(pairing.user_id)
    .first<string>('username');
  return json({
    status: 'approved',
    device_token: deviceToken,
    device: { id: deviceId, name: pairing.device_name },
    user: { username: owner },
  });
}

async function listDevices(c: Ctx) {
  const { results } = await c.db
    .prepare(
      `SELECT id, name, platform, created_at, last_seen_at FROM devices
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .bind(c.user.id)
    .all();
  return json({ devices: results });
}

async function renameDevice(c: Ctx) {
  const name = label(await readJson(c.req), 'name', 64);
  const device = await c.db
    .prepare(
      `UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
       RETURNING id, name, platform, created_at, last_seen_at`,
    )
    .bind(name, c.params.id, c.user.id)
    .first();
  if (!device) throw new HttpError(404, 'not_found', 'Device not found.');
  return json({ device });
}

const revoke = (c: Ctx, deviceId: string | undefined) =>
  c.db
    .prepare('UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), deviceId, c.user.id)
    .run();

async function revokeDevice(c: Ctx) {
  const { meta } = await revoke(c, c.params.id);
  if (meta.changes !== 1) throw new HttpError(404, 'not_found', 'Device not found.');
  return noContent();
}

async function deviceMe(c: Ctx) {
  return json({
    device: { id: c.device?.id, name: c.device?.name },
    user: { username: c.user.username },
    limits: { max_content_bytes: MAX_CONTENT_BYTES },
  });
}

/** Lets the Mac app unpair itself when the user clears its local state. */
async function deviceUnpair(c: Ctx) {
  await revoke(c, c.device?.id);
  return noContent();
}

export const routes: Route[] = [
  ['POST', '/api/v1/pairings', 'session', createPairing],
  ['GET', '/api/v1/pairings/:id', 'session', getPairing],
  ['POST', '/api/v1/pairings/:id/approve', 'session', approvePairing],
  ['DELETE', '/api/v1/pairings/:id', 'session', deletePairing],
  ['GET', '/api/v1/devices', 'session', listDevices],
  ['PATCH', '/api/v1/devices/:id', 'session', renameDevice],
  ['DELETE', '/api/v1/devices/:id', 'session', revokeDevice],
  ['POST', '/api/v1/device/pairing/claim', 'public', claimPairing],
  ['POST', '/api/v1/device/pairing/token', 'public', exchangePairing],
  ['GET', '/api/v1/device/me', 'device', deviceMe],
  ['DELETE', '/api/v1/device/me', 'device', deviceUnpair],
];
