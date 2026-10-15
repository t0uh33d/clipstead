# Development

## Prerequisites

- Node.js 22+ (Wrangler 4 requires it; `.nvmrc` pins 24).
- For the Mac app: macOS 14+ and Xcode 16+ (Swift 6). Developed with Xcode 26.2 / Swift 6.2 on macOS 27; CI uses
  the `macos-15` runner.

## Worker and web app

```sh
cd worker
npm ci
cp .dev.vars.example .dev.vars              # then put a 32+ character SETUP_TOKEN in it
npm run db:migrate:local                    # creates the local D1 database in .wrangler/state
npm run dev                                 # http://localhost:8787 (rebuilds the web app on change)
```

Open http://localhost:8787 and complete setup with the token from `.dev.vars`. Locally the session cookie is
`clipstead_session` (no `__Host-` prefix), because browsers handle `Secure` cookies on `http://localhost`
inconsistently. HTTP is accepted only for localhost.

| Command (in `worker/`) | What it does |
| --- | --- |
| `npm test` | Integration tests: the real Worker against local D1 in `workerd` (Vitest + `@cloudflare/vitest-plugin`) |
| `npm run typecheck` | Generates runtime types (`wrangler types`), then type-checks the Worker, tests and web app |
| `npm run lint` | Biome (lint + formatting check) and a guard against HTML-injection APIs in the web app |
| `npm run format` | Applies Biome's fixes and formatting |
| `npm run build:web` | Compiles `apps/web/src/app.ts` to `apps/web/public/app.js` |
| `npx wrangler deploy --dry-run` | Bundles the Worker without deploying |

Each test file gets fresh storage. `test/setup.ts` applies the migrations, and helpers in `test/helpers.ts` drive
the API through `exports.default.fetch`. The setup token used in tests is a binding in `vitest.config.ts`.

To reset local data: `rm -rf worker/.wrangler/state && npm run db:migrate:local`.

## Mac app

```sh
cd apps/macos
swift build
swift test                          # unit tests; the integration test is skipped unless configured
swift run Clipstead                 # runs unbundled (shows a Dock icon; launch at login unavailable)
./scripts/build-app.sh              # build/Clipstead.app, universal, ad-hoc signed
./scripts/package-dmg.sh            # build/Clipstead.dmg (+ .sha256) from the app above, as releases do
```

Debug builds keep their device token under a separate Keychain service ("Clipstead device token (debug build)"),
so they never touch an installed copy's credential.

### Against a running local server

With `npm run dev` running and an account created:

```sh
export CLIPSTEAD_TEST_SERVER=http://localhost:8787 CLIPSTEAD_TEST_USERNAME=admin CLIPSTEAD_TEST_PASSWORD='…'
swift test --filter IntegrationTests    # API client and upload queue: pair, upload, retry, search, revoke
./scripts/e2e.sh                        # the real app and the real clipboard (see below)
```

`scripts/e2e.sh` starts the debug app with `-E2EPairingCode` (a hook compiled only into debug builds) so it pairs
itself. The script approves the pairing like a browser would, then copies text with `pbcopy` and checks the server.
It verifies plain text, formatting (HTML, and RTF converted on the Mac) and a real PNG image reaching the server, that
pre-existing and concealed clipboard content are skipped, deduplication, and the app's response to revocation. It overwrites your clipboard while it runs and restores its text at the end.

## Conventions

- Keep dependencies at zero for the Worker runtime and the web app. Prefer the platform (Web Crypto, D1, `URLSession`,
  `NSPasteboard`, Keychain Services).
- Every account-scoped query takes the authenticated user's ID. Add an isolation test for every new resource.
- Never log request bodies, headers, tokens, codes or clipboard content.
- Schema changes go in a new numbered file in `worker/migrations/`. Never edit a migration that is on `main`. Make
  each migration safe to apply while the previous Worker version is still serving.
- Web UI: build DOM with `h()`/`textContent`. `npm run lint` rejects `innerHTML` and friends.

## Release checklist

1. `cd worker && npm ci && npm run typecheck && npm run lint && npm test`
2. `cd apps/macos && swift test && ./scripts/build-app.sh`
3. With a local server: `swift test --filter IntegrationTests` and `./scripts/e2e.sh`.
4. Fresh-install check: new local state, `npm run db:migrate:local`, setup, pair, sync, revoke.
5. If migrations changed: apply them to a copy of production data (`wrangler d1 export` → new database) before
   deploying.
6. Check that no secrets are tracked: `git ls-files | grep -iE '\.dev\.vars$|\.env|secret|\.pem|\.p12'` prints nothing,
   and `git grep -nE 'csd_[A-Za-z0-9_-]{43}|SETUP_TOKEN=[^r]'` prints nothing.
7. Update the version in `worker/package.json` and the default `VERSION` in `apps/macos/scripts/build-app.sh`.
8. Wait for CI to pass on the commit, then tag and push: `git tag -a vX.Y.Z -m "Clipstead X.Y.Z" && git push origin vX.Y.Z`. The Release workflow
   (`.github/workflows/release.yml`) tests and builds the app on `macos-15`, packages `Clipstead.dmg` with
   `scripts/package-dmg.sh`, and publishes a GitHub release with the disk image, its SHA-256 and the notes in
   `.github/release-notes.md`. The README links to `releases/latest/download/Clipstead.dmg`, so it always gets the newest.
9. Not yet automated: signing with a Developer ID and notarizing (needs an Apple Developer account).
