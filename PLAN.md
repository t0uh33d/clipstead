# Clipstead: implementation plan

Clipstead is a self-hosted clipboard history: a native macOS menu bar app uploads text you copy to a
Cloudflare Worker + D1 database that you deploy to your own Cloudflare account, and a web app shows,
searches and copies your history from any browser. Multiple users per instance, with strict isolation.

## Architecture

```
 macOS menu bar app  ── HTTPS, device token ──▶  Cloudflare Worker  ◀── HTTPS, session cookie ──  Browser (web UI)
 (Swift, SwiftUI,                                 /api/v1/*  (TypeScript)                          static files served
  NSPasteboard, Keychain)                              │                                           by Workers assets
                                                       ▼
                                                  Cloudflare D1 (SQLite)
```

| Path | What |
| --- | --- |
| `worker/` | The whole deployable: API (`src/`), migrations, tests, `wrangler.jsonc`. One `npm install`. |
| `apps/web/` | Web UI: `public/` static files, `src/app.ts` compiled to `public/app.js` by the worker's build. |
| `apps/macos/` | Swift package: `ClipsteadCore` (logic, tested) + `Clipstead` (menu bar app) + bundling script. |
| `docs/` | Architecture, security model, self-hosting, API, development. |

## Decisions

- **Password hashing**: PBKDF2-HMAC-SHA256 via Web Crypto, 100,000 iterations, 16-byte salt. Cloudflare's
  production runtime has rejected higher counts (local workerd delegates the limit and does not enforce it; not
  verified on a real deployment), and 100k costs ~7 ms CPU, inside the Free plan's 10 ms budget. That is below OWASP's 600k, so we require 12+ character passwords. Parameters are
  stored per hash, and login rehashes when they change. Argon2id/scrypt (WASM) were rejected: tens of ms of CPU
  and 19+ MiB per hash do not fit Workers Free limits.
- **Sessions**: 256-bit random cookie value, only its SHA-256 stored. `__Host-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Strict`, 30-day absolute expiry. Logout deletes the server row. Password change deletes all
  sessions and issues a new one to the current browser.
- **CSRF**: SameSite=Strict, plus `Origin` must match on every unsafe cookie-authenticated request, plus
  JSON-only bodies (`Content-Type: application/json`). No CORS headers at all.
- **Pairing**: browser-initiated. Browser gets a 40-bit one-time code (10 min); the Mac claims it (first claim
  wins, atomically) and receives a secret poll token; the browser shows the device's name/platform/IP and the
  user approves; the Mac's next poll mints the device token exactly once (transactional). Codes, poll tokens
  and device tokens are stored hashed.
- **Device tokens**: `csd_` + 256 bits, stored hashed, least privilege (upload + self status/unpair only; a
  device cannot read history). Revocation clears the hash, effective on the next request.
- **Authorization**: the router declares auth per route (`public`/`session`/`admin`/`device`); handlers get
  the user only from the validated credential, and every query carries `user_id = ?`.
- **Rate limiting**: D1 fixed-window counters, one atomic UPSERT…RETURNING per check (no check-then-set race).
- **Uploads**: client idempotency key, `UNIQUE(user_id, idempotency_key)`, so retries never duplicate;
  re-copying identical text moves it to the top. Per-user storage quota maintained by SQL triggers.
- **Search**: `instr(lower(content), lower(?))`, a literal substring match. D1 caps LIKE patterns at 50 bytes.
- **Retention**: per-user `retention_hours`, default **6 hours** (or 1 hour to 1 year, or forever). Expired entries
  are hidden from reads immediately and deleted by a Cron Trigger every 15 minutes.
- **Web UI**: dependency-free TypeScript compiled by `tsc`, DOM built with `textContent` only (no
  `innerHTML`), strict CSP via `_headers`.
- **macOS app**: SwiftPM, macOS 14+, `MenuBarExtra`, polling `NSPasteboard.changeCount`, in-memory bounded
  upload queue (nothing written to disk), Keychain for the token, honours `org.nspasteboard.ConcealedType`.

## Milestones

- [x] 1. Repository, tooling inspection, plan, schema, API contract
- [x] 2. Multi-user backend: setup, registration modes, auth, sessions, isolation tests
- [x] 3. Device pairing, device credentials, revocation
- [x] 4. Clipboard API: upload, idempotency, history, search, pagination, deletion, retention (6 h default)
- [x] 5. Web interface (browser-tested in headless Chromium)
- [x] 6. Native macOS app
- [x] 7. End-to-end verification against a local Worker + D1
- [x] 8. Docs, CI workflow, security review, release checklist (`docs/development.md`)

## Verification (2026-10-15, macOS 27.0.1, Xcode 26.2 / Swift 6.2.3, Node 25.6, Wrangler 4.151)

| Check | Result |
| --- | --- |
| `npm run typecheck` (TypeScript 7, strict) | pass |
| `npm run lint` (Biome + HTML-injection guard) | pass |
| `npm test`: Worker + local D1 in workerd, 71 tests incl. 11 cross-user isolation | 71/71 pass |
| `wrangler d1 migrations apply --local` on an empty DB; `wrangler deploy --dry-run` | pass (bundle 40 KiB) |
| `swift build` (Swift 6 language mode) | pass, no warnings |
| `swift test`: URL rules, filter (real `NSPasteboard`), queue, API client, Keychain | 23/23 pass |
| `IntegrationTests` (Swift client + queue against `wrangler dev`) | pass |
| `scripts/e2e.sh` (real app binary, real clipboard, local server) | 10/10 checks pass |
| Browser QA of the web app (setup, login errors, pairing approval, history, XSS payload, copy, delete, settings, invites, revoke, 375 px layout) | pass; copy success path verified with a stubbed Clipboard API |

## Not verified

- Deployment to Cloudflare (no account access was authorised), including the production PBKDF2 limit, Free-plan
  CPU behaviour of sign-in, cron execution and `_headers` on the edge.
- The GitHub Actions workflow itself (no remote); its steps were run locally.
- Safari and Firefox; the real (unstubbed) browser clipboard write; screen readers.
- The SwiftUI menu and Settings window by eye, launch at login, excluded-app behaviour in the running app, and the
  Keychain prompt behaviour after rebuilding an ad-hoc signed app.

## Next steps

1. Deploy a test instance, run the browser and Mac flows against it, and confirm the PBKDF2 limit.
2. Push to GitHub and confirm CI on `ubuntu-latest` and `macos-15`.
3. Visual and accessibility pass on the Mac app's menu and Settings window; test Safari and Firefox.
4. Signed and notarised Mac releases.
5. Candidates: an iOS share extension, images via R2, optional end-to-end encryption.
