# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clipstead is a self-hosted clipboard history. A macOS menu bar app (`apps/macos`) uploads copied text to a
Cloudflare Worker + D1 database (`worker/`) that each operator deploys to their own account. The same Worker
serves a dependency-free web app (`apps/web`) for browsing, searching and copying history. Many users per instance;
**no user may ever reach another user's data**. That invariant drives most of the design.

## Commands

The Worker and web app share one npm project in `worker/` (Node 22+). Run everything from there:

```sh
cd worker
npm ci
cp .dev.vars.example .dev.vars        # put a 32+ char SETUP_TOKEN in it
npm run db:migrate:local              # local D1 in .wrangler/state
npm run dev                           # http://localhost:8787; rebuilds apps/web on change
npm test                              # all integration tests (real Worker + local D1 inside workerd)
npx vitest run test/pairing.test.ts -t "replayed"   # one file / one test
npm run typecheck                     # wrangler types + tsc for worker, test/ and ../apps/web
npm run lint                          # Biome check + guard against innerHTML-style APIs in apps/web/src
npm run format                        # Biome autofix
npx wrangler deploy --dry-run --outdir dist         # bundle without deploying
```

Reset local data: `rm -rf .wrangler/state && npm run db:migrate:local`.

The macOS app is a Swift package (Swift 6 language mode, macOS 14+):

```sh
cd apps/macos
swift build && swift test
swift test --filter UploadQueueTests/testRetryNowSkipsTheBackoffWait
./scripts/build-app.sh                # build/Clipstead.app (universal, ad-hoc signed)
./scripts/package-dmg.sh              # build/Clipstead.dmg + .sha256, as the release workflow does
# Against a running `npm run dev` with an existing account:
CLIPSTEAD_TEST_SERVER=http://localhost:8787 CLIPSTEAD_TEST_USERNAME=admin CLIPSTEAD_TEST_PASSWORD='…' \
  swift test --filter IntegrationTests   # Swift client + upload queue against the real API
CLIPSTEAD_TEST_USERNAME=admin CLIPSTEAD_TEST_PASSWORD='…' ./scripts/e2e.sh   # real app + real clipboard
```

`e2e.sh` overwrites the system clipboard while it runs (it restores the text afterwards).

## Architecture

**Worker request path** (`worker/src/index.ts`): one route table of `[method, pattern, auth, handler]` tuples
gathered from `routes/*.ts`. Authentication is declared per route (`public` | `session` | `admin` | `device`) and
enforced in `dispatch()` before any handler runs. Handlers get the user only through `Ctx.user`
(`worker/src/auth.ts`), which throws if the router authenticated nobody. Session routes read only the cookie and
device routes read only `Authorization: Bearer csd_…`, so neither credential works on the other's routes. Unsafe
methods with a foreign `Origin` are refused, and cookie routes require `Origin`. Plain HTTP is refused except on
localhost. `/api/*` runs the Worker (`run_worker_first`); every other path is a static asset from
`apps/web/public`, with security headers from `apps/web/public/_headers`.

**Data** (`worker/migrations/`): every account table has `user_id … ON DELETE CASCADE`. Secrets (session cookies,
device tokens, pairing codes, poll tokens, invites) are stored only as SHA-256. `users.storage_bytes` is maintained
by triggers on `clipboard_entries` and enforced by a conditional `INSERT … SELECT … WHERE quota` in the upload
handler. Rate limiting is a D1 fixed-window counter: one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`
(`worker/src/security.ts`). Multi-step invariants (one-time setup, invite consumption, issuing a device token
exactly once) rely on `db.batch()` being one serialized transaction, so they are written as conditional
statements, never as check-then-write.

**Pairing** is browser-initiated: the browser creates a code; the Mac claims it (first claim wins) and gets a poll
token; the signed-in owner approves after seeing the device's details; the Mac's next poll mints the device token,
once. Device tokens may only upload and manage themselves. They cannot read history.

**Rich content**: an entry is text (`content`), optionally with formatting (`html`), or an image (`image`,
`image_type`, `thumbnail`; `content` is then a label). All of it is data: the web app never renders HTML (it only
hands it to the clipboard API), and images are accepted only as PNG/JPEG with matching signature bytes and served raw
from `/clipboard/:id/image|thumbnail`. The Mac reads formatting via `NSPasteboard.formattedHTML` (app HTML, else
RTF→HTML) and images via `ClipboardImage.fitting` (original PNG if it fits in 1 MiB, else re-encoded).

**Retention**: per-user `retention_hours` (default 6). Reads filter out expired entries immediately; the cron
(`*/15 * * * *`) deletes them via `cleanup()` in `routes/clipboard.ts`.

**Web app** (`apps/web/src/app.ts`, compiled by the worker's `tsc` to `public/app.js`, which is gitignored): one file,
hash routing, DOM built only through `h()` and text nodes.

**macOS app**: `ClipsteadCore` holds all testable logic: `ServerURL` (https only, except localhost),
`APIClient` (maps HTTP failures to `APIError`), `ClipboardFilter` (privacy markers and excluded apps are checked
*before* the text is read), and `UploadQueue` (an actor: bounded, serial, idempotency key reused across retries,
backoff with jitter, offline waits, `clear()` cancels the in-flight upload). The `Clipstead` target is the SwiftUI
app. `AppModel` wires pasteboard polling, filter, queue, pairing and Keychain, and a `401` there makes the app
forget its credential.

## Rules specific to this repo

- Any new account-scoped query must include `user_id = ?` from `c.user`, and any new resource needs a cross-user
  case in `worker/test/isolation.test.ts`.
- Never log request bodies, headers, tokens, codes or clipboard text (Worker or app). The Worker logs only
  unhandled errors; `auth.test.ts` asserts that no secrets reach the console.
- No runtime dependencies in the Worker or the web app.
- Migrations are append-only: add a new numbered file in `worker/migrations/`; never edit one that is on `main`.
- Keep PBKDF2 at 100,000 iterations unless a higher count is verified on a real Cloudflare deployment (see below).

## Gotchas found the hard way

- D1's `meta.changes` includes rows written by triggers. Use `RETURNING` to detect affected rows on
  `clipboard_entries`.
- D1 caps LIKE/GLOB patterns at 50 bytes, so search uses `instr(lower(content), lower(?))`.
- Local workerd does not enforce Cloudflare production's PBKDF2 iteration cap (historically 100,000), so tests
  pass with values that would fail when deployed.
- Vitest storage is isolated per test *file*: tests in one file share the database and rate-limit counters. Use
  fresh users (`registerUser()`) and per-call client IPs (`call()` does this) to avoid cross-test limits.
- Vitest is pinned to 4.1 because vitest 5 does not support Node 25. Tests get 30 s each (`vitest.config.ts`):
  some make 100+ real requests, which is slow on GitHub's runners.
- `wrangler dev` computes static-asset ETags at startup. The `watch_dir` build in `wrangler.jsonc` refreshes them;
  if the UI looks stale, restart `npm run dev`.
- D1 returns BLOB columns as `ArrayBuffer` or `number[]`; `new Uint8Array(value)` handles both. In tests, don't spread
  large arrays into `String.fromCharCode(...)`: it overflows the stack.
- Releases: pushing a `v*` tag runs `.github/workflows/release.yml` (DMG via `apps/macos/scripts/package-dmg.sh`).
  `hdiutil` prints deprecation warnings on macOS 27; they are harmless.
- In Swift, `URL.appending(path:)` percent-encodes `?`. Build URLs with query strings another way.
- Reading a Keychain item created by another process (for example the `security` CLI) makes macOS show an access
  prompt and blocks the app. That is why `e2e.sh` lets the debug app pair itself via the debug-only
  `-E2EPairingCode` launch argument. Debug builds use the Keychain service "Clipstead device token (debug build)".
