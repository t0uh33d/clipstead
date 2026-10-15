# Security model

Clipstead stores what you copy, which can include passwords, one-time codes, private messages and API keys.
This document describes what Clipstead protects, against whom, how, and what it does **not** protect.
To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundaries

```
 Browser ──HTTPS + session cookie──▶ ┐
                                     ├─▶ Worker (/api/v1) ──▶ D1 database
 Mac app ──HTTPS + device token────▶ ┘        (your Cloudflare account)
```

| Party | Trusted with | Notes |
| --- | --- | --- |
| Instance operator (owner of the Cloudflare account) | Everything | Can read all clipboard content in D1. Clipstead cannot protect users from the operator. |
| Cloudflare | Everything the operator is | Runs the code and stores the database. |
| Administrator (in-app role) | Registration settings and invites | Has **no** access to other users' clipboards, devices or sessions through the app. |
| Signed-in user | Their own account only | Every query is scoped to the authenticated user. |
| Paired device | Uploading to its owner's account | Cannot read history. |
| Anyone else on the internet | Nothing | Can reach only the public endpoints listed in [api.md](api.md). |

## The core invariant: users never see each other's data

- The router declares the authentication of every route (`public`, `session`, `admin`, `device`) in one table
  (`worker/src/index.ts`). A handler can only obtain the user from the validated credential (`Ctx.user` throws
  otherwise). User IDs in bodies, query strings, paths or headers are never used for authorization.
- Every query on account data includes `user_id = ?` bound to the authenticated user, including lookups by
  resource ID. Another user's resource ID gives the same `404` as a nonexistent one.
- Foreign keys tie sessions, devices, pairing requests, invites and entries to exactly one user and cascade on
  account deletion.
- `worker/test/isolation.test.ts` runs two users against the real Worker and D1 and checks read, search, page
  (with forged cursors), delete, clear, rename, revoke, session listing, pairing approval, and attempts to
  smuggle `user_id`/`device_id` into requests.

## Threats and mitigations

| # | Threat | Mitigation | Tests |
| --- | --- | --- | --- |
| 1 | A user reads another user's clipboard | Ownership condition in every query, identity only from the credential, random IDs as defence in depth only | `isolation.test.ts` |
| 2 | A user revokes or renames another user's device | Same; device updates are `WHERE id = ? AND user_id = ?` | `isolation.test.ts` |
| 3 | Password or pairing-code guessing | PBKDF2 (below); login limited to 20/10 min per IP (IPv6 grouped by /64) and 10/10 min per account; pairing codes are 40 bits, single-use, expire in 10 minutes, claims limited to 10/10 min per IP; invites are 80 bits | `auth.test.ts`, `pairing.test.ts` |
| 4 | Replayed pairing request | A code can be claimed once (atomic `UPDATE … WHERE claimed_at IS NULL`); the poll token yields a credential once (transactional); expired, denied and completed requests return `410` | `pairing.test.ts` |
| 5 | Leaked device token | Tokens are 256-bit, stored only as SHA-256, scoped to one device and one user, cannot read history or act as a browser session, and stop working on the next request after revocation. Residual risk: until revoked, the holder can add entries to that account | `pairing.test.ts` |
| 6 | Stolen session or CSRF | Cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`; only its hash is stored; unsafe requests need a matching `Origin`; bodies must be JSON; no CORS; logout deletes the server-side session | `auth.test.ts` |
| 7 | Oversized or malformed requests | Bodies are read with a hard cap (16 KiB, 2 MiB for uploads); strict JSON and type validation; content limited to 1 MiB of valid Unicode `text/plain`; per-user storage quota; upload rate limit 120/min per device | `clipboard.test.ts`, `auth.test.ts` |
| 8 | SQL injection | Every value is a bound parameter. Search uses `instr()` with a bound needle, so `%`, `_` and quotes are literal text | `clipboard.test.ts` |
| 9 | Unauthorized initial setup | Requires the `SETUP_TOKEN` secret (32+ characters, set by the operator, compared in constant time, rate-limited). Setup is one transaction that only succeeds while no setup has completed, so concurrent attempts create exactly one administrator | `auth.test.ts` |
| 10 | A revoked device keeps uploading | Revocation clears the stored token hash (enforced by a `CHECK` constraint); every request re-checks the database. The Mac app stops syncing and deletes its Keychain item on `401` | `pairing.test.ts`, `apps/macos/scripts/e2e.sh` |
| 11 | Secrets in logs | The Worker logs only unhandled errors (error name and message, never request data). The Mac app logs state changes only. A test spies on all console output across a full flow, including a forced internal error | `auth.test.ts` |
| 12 | Permissive CORS or plain HTTP | No CORS headers. The Worker refuses plain HTTP except on localhost; the Mac app refuses `http://` except for localhost; HSTS is sent; `*.workers.dev` is HTTPS-only in browsers | `auth.test.ts`, `ServerURLTests` |
| 13 | A compromised operator reads clipboard content | **Not mitigated.** Content is stored in plaintext. See below | — |
| 14 | Clipboard content rendered as HTML | The web UI builds the DOM with `createElement` and text nodes only (`npm run lint` fails on `innerHTML` and similar); a strict CSP (`script-src 'self'`, no inline scripts) is served via `_headers`; API responses are `application/json` with `nosniff` and `default-src 'none'`. Formatting (HTML) is never rendered: it is only handed to the browser's clipboard API, which sanitizes it, exactly as when copying from any web page. Images are accepted only as PNG or JPEG whose signature bytes match (never SVG) and served with `nosniff` and a sandboxing CSP | `lint:html`, `clipboard.test.ts`, browser QA |
| 15 | A malicious pairing tricks a user | See [Pairing](#pairing-risks) | `pairing.test.ts` |

## Passwords

- **Algorithm**: PBKDF2-HMAC-SHA256 through the Workers Web Crypto API, 100,000 iterations, 16-byte random salt,
  256-bit output. Stored as `pbkdf2_sha256$<iterations>$<salt>$<hash>`. Passwords are NFKC-normalised first.
- **Why not Argon2id, scrypt or bcrypt?** Workers has no native implementation. WASM builds need tens of
  milliseconds of CPU and 19+ MiB per hash at OWASP parameters, beyond the Free plan's 10 ms CPU budget per request.
- **Why 100,000 iterations when OWASP recommends 600,000?** Cloudflare's production runtime has rejected higher
  counts ("Pbkdf2 failed: iteration counts above 100000 are not supported"). The open-source `workerd` used for local
  development and tests delegates this limit to the host and does not enforce it, so it cannot be checked locally;
  verify on a deployment before raising the count. One hash costs about 7 ms of CPU (600,000 would cost about 44 ms,
  well beyond the Free plan's 10 ms budget). To compensate, passwords must be
  12 to 256 characters (no composition rules; paste and password managers work). NIST SP 800-63B-4 recommends
  at least 15 characters for single-factor passwords; consider a passphrase.
- **Migration**: because the parameters are stored with each hash, changing the iteration count or algorithm in
  `worker/src/security.ts` makes the next successful login re-hash with the new parameters. Old hashes keep working.
- Failed logins return the same `invalid_credentials` error whether or not the account exists, and unknown
  usernames are checked against a dummy hash so timing does not reveal them either.
- Registration necessarily reveals whether a username is taken (`409 username_unavailable`). It is rate-limited
  to 5 accounts per hour per IP. Keep registration closed or invite-only if that matters to you.

## Sessions

- 256-bit random token in the cookie; only its SHA-256 is stored. Lifetime: 30 days, absolute.
- A new session is created on every login; sessions are never reused across authentication.
- Logout and "Sign out" on other sessions delete the server-side row.
- Changing the password deletes **all** of the user's sessions and issues a fresh one to the current browser.
  Paired devices are not affected; revoke them separately if a device may be compromised.
- Deleting an account (password required) deletes the user and, by cascade, all sessions, devices, pairing
  requests, invites and clipboard entries.
- The cookie is never readable by JavaScript, and no token is stored in `localStorage` or put in a URL.

## Pairing risks

The flow is described in [architecture.md](architecture.md#pairing). It resists guessing and replay, and a code
alone grants nothing. The remaining risks need a deceived user:

- **Shoulder-surfed or guessed code.** Someone who claims your code before your Mac does appears as the pending
  device. The approval screen shows the device name, macOS version, app version, IP address, country and time,
  with a warning to approve only a Mac you just entered the code on. Your own Mac's claim then fails with "code
  already used", which is a signal to deny. Even if you approve the wrong device, it can only **add** entries to
  your history: device tokens cannot read it. Revoke it from Devices.
- **Being tricked into pairing your Mac with someone else's server or account.** Your clipboard would then go to
  them. The Mac app shows the server address and the account it paired with, and requires an explicit consent
  step that names the destination before any upload. A changed server address resets that consent.

## Rate limiting: what it does and does not guarantee

Counters live in D1 (`rate_limits`), one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` per check. The
increment and the check cannot race, and because D1 has a single primary, limits are global rather than per
data centre.

- Fixed windows allow up to 2× the limit across a window boundary.
- IP-based limits can be spread across many addresses (IPv6 is grouped by /64). Per-account login limits cap
  guessing against one account regardless of IP, but someone can use them to block a user's logins for up to
  10 minutes.
- Each limited request costs one D1 write. Counters older than a day are deleted by the 15-minute cleanup job.
- This protects the service from brute force and casual abuse, not from a determined distributed attack. Put
  Cloudflare's WAF rate-limiting rules in front for that.

## Data at rest, and who can read it

- Clipboard text, its formatting (HTML) and images, usernames, password hashes, session and device token hashes, device names, pairing metadata
  (including the claiming IP for at most 10 minutes) and rate-limit counters are stored in D1.
- **Clipboard content is plaintext.** The operator, anyone with access to the Cloudflare account or an API token
  with D1 permissions, and Cloudflare itself can read it. Clipstead does not provide end-to-end encryption.
- **Retention**: by default each entry is hidden 6 hours after it was copied and deleted within the following 15
  minutes. Users can choose 1 hour to 1 year, or forever.
- Deleted rows are gone from the live database immediately, but D1 Time Travel keeps point-in-time history for
  7 days (Free) or 30 days (Paid), and any exports you made keep what they contain.
- Nothing is sent to the project author or any third party. There are no analytics.

### Toward end-to-end encryption (not implemented)

Entries are opaque text to the server except for `content_hash` (used for deduplication) and search. A future
design could encrypt on the device with a key the server never sees, at the cost of server-side search and
deduplication. The API and schema are versioned to allow that change.

## The macOS app

- The device token is stored in the login Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synced
  to iCloud). Settings are in `UserDefaults` and contain nothing secret.
- Clipboard content is held only in memory, in a bounded queue of 20 items; nothing copied is written to disk. Items
  pending when the app quits are lost.
- Formatting is read only after the privacy checks pass: the app's own HTML, or RTF converted to HTML. Images are read
  the same way, re-encoded smaller if they exceed the size limit, and accompanied by a small JPEG thumbnail. Files
  copied in Finder are skipped entirely.
- Content is skipped before it is read if the pasteboard carries an `org.nspasteboard.ConcealedType`,
  `TransientType` or `AutoGeneratedType` marker (used by 1Password, KeePassXC and others), or if the frontmost
  app is excluded (common password managers by default).
- **Limitation:** exclusions rely on which app is frontmost when the change is noticed. An app that writes to the
  clipboard in the background, or a switch of apps within the polling interval, defeats them. Clipstead cannot
  recognise secrets that are not marked.
- Nothing is uploaded until the Mac is paired, the user has consented to the named server, and sync is on. Content
  already on the clipboard when sync starts is never uploaded. Pausing clears the queue and cancels the request in
  flight.
- Locally built apps are ad-hoc signed. macOS may ask for Keychain access again after you rebuild the app, because
  the signature changed; choose "Always Allow". Notarised releases are not provided yet.

## Not provided

- Multi-factor authentication or passkeys.
- End-to-end encryption.
- Checking passwords against breach lists.
- An admin UI to disable users (use `UPDATE users SET status = 'disabled' …`, see [self-hosting.md](self-hosting.md)).
