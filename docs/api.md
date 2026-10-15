# API reference (v1)

All endpoints are under `/api/v1` on your instance, e.g. `https://clipstead.example.workers.dev/api/v1/health`.

## Conventions

- **Transport**: HTTPS only. Plain HTTP is refused (`403 https_required`) except on `localhost`.
- **Bodies**: JSON with `Content-Type: application/json` (otherwise `415`). Limit 16 KiB, or 2 MiB for uploads (`413`).
- **Timestamps**: integers, milliseconds since the Unix epoch.
- **IDs**: opaque strings (UUIDs). Knowing an ID never grants access.
- **Errors**: `{"error": {"code": "machine_readable_code", "message": "Human-readable text."}}`.
  `429` responses include `Retry-After` (seconds).
- **Responses** carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a `default-src 'none'` CSP.
  There are no CORS headers: the API is same-origin for browsers.

## Authentication

| Kind | Used by | How |
| --- | --- | --- |
| `public` | anyone | No credential. |
| `session` | the web app | Cookie `__Host-clipstead_session` (`clipstead_session` on `http://localhost`), set by setup, register and login. Unsafe methods (`POST`, `PATCH`, `DELETE`) must send an `Origin` header equal to the instance origin, which browsers do automatically. |
| `admin` | the web app | A session whose user is an administrator. |
| `device` | the Mac app | `Authorization: Bearer csd_…` (from pairing). |

Session cookies are ignored on device routes and device tokens are ignored on session routes.

Common errors: `401 unauthenticated` (no valid session), `401 invalid_device_token` (missing, revoked or
unknown device token), `403 forbidden` (not an admin), `403 cross_origin_forbidden`, `400 invalid_json`,
`400 invalid_request`, `404 not_found`, `429 rate_limited`, `500 internal_error`.

## Instance and setup

### `GET /health` (public)
`200 {"status":"ok"}` when the Worker can query D1.

### `GET /instance` (public)
`200 {"setup_required": false, "registration_mode": "closed" | "invite_only" | "open"}`

### `POST /setup` (public)
Creates the first administrator. Works once per instance.

```json
{ "setup_token": "…", "username": "admin", "password": "…", "registration_mode": "closed" }
```

`201 {"user": User}` plus a session cookie. Errors: `403 invalid_setup_token`, `409 already_initialized`,
`503 setup_token_not_configured` (no `SETUP_TOKEN` secret, or shorter than 32 characters), `400 invalid_username`,
`400 invalid_password`. Rate limit: 10 per 15 min per IP.

`User` is `{"id", "username", "is_admin": bool, "created_at"}`. Usernames: 3–32 characters, `a-z 0-9 . _ -`,
starting with a letter or digit, stored lowercase. Passwords: 12–256 characters, no composition rules.

## Accounts and sessions

### `POST /auth/register` (public)
`{"username", "password", "invite_code"?}` → `201 {"user": User}` plus a session cookie. Never creates
administrators. Errors: `409 setup_required`, `403 registration_closed`, `403 invalid_invite` (in `invite_only`
mode: missing, wrong, expired or used code), `409 username_unavailable`. Rate limit: 5 per hour per IP.

### `POST /auth/login` (public)
`{"username", "password"}` → `200 {"user": User}` plus a new session cookie. Error: `401 invalid_credentials` for
any failure (unknown user, wrong password, disabled account). Rate limits: 20 per 10 min per IP, 10 per 10 min
per username.

### `POST /auth/logout` (session)
Deletes the session on the server and clears the cookie. `204`.

### `GET /auth/me` (session)
```json
{
  "user": { "id": "…", "username": "alice", "is_admin": false, "created_at": 1760500000000 },
  "settings": { "retention_hours": 6 },
  "storage": { "used_bytes": 12345, "quota_bytes": 104857600 }
}
```

### `PATCH /account/settings` (session)
`{"retention_hours": 1..87600 | null}` → `200 {"settings": {...}}`. Entries older than this are hidden at once and
deleted within 15 minutes. The default is 6 hours; `null` keeps history forever.

### `POST /account/password` (session)
`{"current_password", "new_password"}` → `204`, with a new session cookie. All other sessions are signed out.
Errors: `403 incorrect_password`, `400 invalid_password`. Rate limit: 10 password confirmations per 15 min per account.

### `DELETE /account` (session)
`{"password"}` → `204`. Deletes the account and all of its data. Errors: `403 incorrect_password`,
`409 last_admin` (the only administrator cannot delete their account).

### `GET /sessions` (session)
`200 {"sessions": [{"id", "user_agent", "created_at", "last_seen_at", "expires_at", "current": bool}]}`.
`last_seen_at` has 5-minute resolution.

### `DELETE /sessions/:id` (session)
Signs out that session. `204`, or `404`. Revoking the current session also clears its cookie.

## Administration

### `PATCH /admin/instance` (admin)
`{"registration_mode": "closed" | "invite_only" | "open"}` → `200 {"registration_mode"}`. Stored in the
database, so deploys never change it.

### `GET /admin/invites` (admin)
`200 {"invites": [{"id", "created_at", "expires_at", "used_at", "used_by": username | null}]}`. Newest 100.

### `POST /admin/invites` (admin)
`201 {"invite": {"id", "code": "ABCD-EFGH-JKMN-PQRS", "expires_at"}}`. The code is shown only once (stored hashed)
and expires after 7 days. Invites work only in `invite_only` mode.

### `DELETE /admin/invites/:id` (admin)
Revokes an unused invite. `204` or `404`.

## Pairing a device

1. Browser: `POST /pairings` → shows `code`.
2. Device: `POST /device/pairing/claim` with the code → keeps `poll_token`.
3. Browser: polls `GET /pairings/:id` until `status` is `claimed`, shows the device, then `POST /pairings/:id/approve`
   (or `DELETE /pairings/:id` to deny).
4. Device: polls `POST /device/pairing/token` every `poll_interval_ms` until it receives `device_token`.

### `POST /pairings` (session)
`201 {"pairing": {"id", "status": "waiting", "expires_at", "code": "ABCD-EFGH"}}`. Codes use Crockford base32 (no
I, L, O or U), expire after 10 minutes, and starting a new pairing cancels any unfinished one. Rate limit: 10 per
10 min per account.

### `GET /pairings/:id` (session)
```json
{
  "pairing": {
    "id": "…",
    "status": "waiting" | "claimed" | "approved" | "completed" | "expired",
    "expires_at": 1760500600000,
    "device": null | { "name", "platform", "app_version", "ip", "country", "claimed_at" }
  }
}
```

### `POST /pairings/:id/approve` (session)
`200 {"pairing": …}`. Errors: `404` (not yours or gone), `409 pairing_not_approvable` (not claimed yet, already
approved, or expired).

### `DELETE /pairings/:id` (session)
Denies or cancels. `204`. The device's next poll returns `410`.

### `POST /device/pairing/claim` (public)
```json
{ "code": "abcd efgh", "device_name": "Alice's MacBook", "platform": "macOS 15.1", "app_version": "0.1.0" }
```
Codes are case-insensitive and ignore spaces and dashes. Names are 1–64 visible characters (no control or bidi
override characters). `200 {"poll_token": "csp_…", "expires_at", "poll_interval_ms": 3000}`. Error:
`400 invalid_code` for unknown, expired and already-claimed codes alike. Rate limit: 10 per 10 min per IP.

### `POST /device/pairing/token` (public)
`{"poll_token"}` →
- `202 {"status": "pending", "poll_interval_ms": 3000}` until approved;
- `200 {"status": "approved", "device_token": "csd_…", "device": {"id", "name"}, "user": {"username"}}` exactly once;
- `410 pairing_unavailable` if expired, denied, already completed or unknown.

Rate limit: 300 per 10 min per IP.

## Devices

### `GET /devices` (session)
`200 {"devices": [{"id", "name", "platform", "created_at", "last_seen_at"}]}`. Revoked devices are not listed.

### `PATCH /devices/:id` (session)
`{"name"}` → `200 {"device": …}` or `404`.

### `DELETE /devices/:id` (session)
Revokes the device: its token stops working on the next request. `204` or `404`. To reconnect, pair again.

### `GET /device/me` (device)
`200 {"device": {"id", "name"}, "user": {"username"}, "limits": {"max_content_bytes": 1048576}}`. Updates the
device's last-seen time (5-minute resolution).

### `DELETE /device/me` (device)
The device revokes its own token (used by "Unpair This Mac"). `204`.

## Clipboard

### `POST /device/clipboard` (device)
```json
{ "content": "text", "content_type": "text/plain", "idempotency_key": "E621E1F8-C36C-495A-93FC-0C247A3E6E5F" }
```
- `content`: non-empty, valid Unicode, at most 1 MiB of UTF-8. Stored and returned verbatim, as text.
- `content_type`: only `text/plain` (default). Anything else gets `415 unsupported_content_type`.
- `idempotency_key`: 16–64 characters of `A-Z a-z 0-9 _ -`, unique per upload attempt. Retrying with the same key
  returns the original entry instead of creating another.

Responses:
- `201 {"entry": {"id", "created_at"}}`: stored. The entry is committed to D1 before this response is sent.
- `200 {"entry": …}`: the same key and content were already stored (a retry).
- `409 idempotency_key_reused`: the key was used for different content.
- `413 content_too_large`, `400 invalid_request`, `415`.
- `507 storage_quota_exceeded`: the user's quota (`STORAGE_QUOTA_MB`, default 100) is full.
- `401 invalid_device_token`: revoked or unknown; pair again.

If the user already has an entry with identical content, it is replaced, so re-copied text moves to the top
instead of being duplicated. Rate limit: 120 per minute per device.

### `GET /clipboard` (session)
Query parameters: `limit` (1–100, default 50), `cursor` (from the previous page), `q` (search, up to 200
characters: a literal, ASCII-case-insensitive substring match).

```json
{
  "entries": [
    {
      "id": "…", "content_type": "text/plain", "size_bytes": 2880, "created_at": 1760500000000,
      "device_id": "…", "device_name": "Alice's MacBook",
      "preview": "first 1000 characters…", "truncated": true
    }
  ],
  "next_cursor": "1760500000000.uuid" | null
}
```
Newest first, ordered by `(created_at, id)`, so pages never overlap or skip.

### `GET /clipboard/:id` (session)
`200 {"entry": {…, "content": "full text"}}` or `404`.

### `DELETE /clipboard/:id` (session)
`204` or `404`.

### `DELETE /clipboard` (session)
Deletes the user's whole history. `204`.

## Scheduled cleanup

A Cron Trigger runs every 15 minutes. It deletes entries older than each user's `retention_hours` (up to 10,000 per
run; the next run continues), plus expired sessions, pairing requests, unused expired invites and rate-limit
counters older than a day. Reads never return entries past retention, even before they are deleted.
