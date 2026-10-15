# Architecture

```
┌──────────────────────┐   HTTPS, Bearer csd_…    ┌─────────────────────────────────────────┐
│ macOS menu bar app   │ ───────────────────────▶ │ Cloudflare Worker  (worker/src)         │
│ apps/macos           │   /api/v1/device/*       │  • /api/v1/*: router, auth, handlers    │
└──────────────────────┘                          │  • everything else: static web app      │
┌──────────────────────┐   HTTPS, session cookie  │    (apps/web/public, Workers assets)    │
│ Browser (web app)    │ ───────────────────────▶ │  • cron every 15 min: cleanup           │
│ apps/web             │   /api/v1/*              └──────────────────┬──────────────────────┘
└──────────────────────┘                                             │ D1 binding
                                                          ┌──────────▼──────────┐
                                                          │ D1 (SQLite)         │
                                                          │ worker/migrations   │
                                                          └─────────────────────┘
```

## Repository

| Path | Contents |
| --- | --- |
| `worker/src/index.ts` | Entry point: route table, per-route authentication, CSRF/HTTPS checks, errors, security headers, cron handler |
| `worker/src/auth.ts` | Request context, session cookies, device tokens |
| `worker/src/security.ts` | Random tokens and codes, hashing, PBKDF2 passwords, D1 rate limiter |
| `worker/src/http.ts` | JSON body reading with size caps, validation helpers, cookies, client IP |
| `worker/src/routes/` | `account.ts` (setup, auth, settings, sessions, admin), `devices.ts` (pairing, devices), `clipboard.ts` (entries, cleanup) |
| `worker/migrations/` | Versioned D1 schema |
| `worker/test/` | Integration tests that run the real Worker against local D1 inside `workerd` |
| `apps/web/` | `public/` static files (HTML, CSS, `_headers`), `src/app.ts` compiled to `public/app.js` |
| `apps/macos/Sources/ClipsteadCore` | Testable logic: server URL rules, API client, clipboard filter, upload queue, Keychain |
| `apps/macos/Sources/Clipstead` | The app: `AppModel` (state and wiring), `ClipboardMonitor`, SwiftUI menu and settings |

The deliberately flat layout reflects the size of the code: one router, three route files, and no framework. The
Worker has no runtime dependencies, and neither does the web app.

## Request lifecycle (Worker)

1. Plain HTTP is refused unless the host is localhost.
2. The route table maps `method + path` to `(auth, handler)`. Auth is declared per route, never left to handlers.
3. For `POST`/`PATCH`/`DELETE`: a foreign `Origin` is refused, and session routes require `Origin` to be present.
4. `session`/`admin` routes resolve the cookie to a user (hash lookup, expiry, account status);
   `device` routes resolve `Authorization: Bearer` to a device and user.
5. The handler validates its input and runs parameterized queries, always constrained by the user's ID.
6. Errors become `{"error": {code, message}}`. Unexpected ones become a generic `500`, and only the error itself is
   logged. Security headers are added to every API response.

## Data model

```
instance (single row: registration_mode, setup_completed_at)
users ─┬─< sessions            (token_hash, expires_at)
       ├─< devices             (token_hash, cleared on revoke)
       ├─< pairing_challenges  (code_hash, poll_token_hash, state timestamps)
       ├─< invites             (code_hash; created_by)
       └─< clipboard_entries   (content, html, image, image_type, thumbnail, content_hash, size_bytes,
                                idempotency_key, device_id → devices)
rate_limits (hashed key, window_start, count)
```

`users.storage_bytes` is kept exact by `AFTER INSERT/DELETE` triggers on `clipboard_entries`, so the upload quota
check is a single conditional `INSERT`. Indexes: `(user_id, created_at DESC, id DESC)` for history and
`(user_id, content_hash)` for deduplication.

## Pairing

```
Browser (signed in)             Worker                              Mac app
POST /pairings ───────────────▶ code_hash stored, 10 min TTL
show ABCD-EFGH                                         ◀──────────── POST /device/pairing/claim {code, name…}
                                atomically claim (first wins),       keeps poll_token (csp_…)
                                store poll_token_hash, IP, country
GET /pairings/:id ◀───────────▶ status: claimed + device details
user checks details → POST /pairings/:id/approve
                                                       ◀──────────── POST /device/pairing/token {poll_token}
                                one transaction: create device       (polls every 3 s)
                                (token hash) + mark completed ─────▶ device_token (csd_…), once → Keychain
```

The device token is created at exchange time, so it is never stored in plaintext, not even briefly. Denying deletes
the challenge, and the next poll returns `410`.

## Upload path (Mac)

`ClipboardMonitor` polls `NSPasteboard.changeCount` (0.5–5 s, with timer tolerance), which is a cheap call. On a
change, `ClipboardFilter` checks the type identifiers for privacy markers and the frontmost app against exclusions
before reading any text, skips Finder file copies, then applies the size limit and consecutive-duplicate check. For
text, the formatted version is read too (`NSPasteboard.formattedHTML`: the app's HTML, or RTF/RTFD converted to HTML).
A copy with no text but an image becomes an image upload: `ClipboardImage.fitting` keeps the original PNG when it fits
in 1 MB, otherwise re-encodes smaller (off the main thread), and adds a 480-pixel JPEG thumbnail. Accepted text goes to
`UploadQueue`, an actor holding at most 20 items in memory. It uploads one at a time with a UUID idempotency key
that is reused across retries, so a retry never creates a second entry. Transient failures back off exponentially
with jitter (up to 8 attempts). Offline waits don't use up attempts, but items older than an hour are dropped. A
`401` empties the queue and makes the app forget its credential. Pausing clears the queue and cancels the request
in flight. Network changes (`NWPathMonitor`) and wake from sleep end any wait early.

## Decisions

The rationale for password hashing, sessions, CSRF, rate limiting and search is in [PLAN.md](../PLAN.md) and
[security.md](security.md).
