# Self-hosting Clipstead

Clipstead runs entirely in **your** Cloudflare account: one Worker (the API and the web app) and one D1
database. Nothing depends on the project author's servers, and no custom domain is required.

## What you need

- A Cloudflare account. The Free plan works; see [limits and costs](#limits-and-costs).
- Node.js 22 or newer, and git.
- To build the Mac app: macOS 14 (Sonoma) or later with Xcode 16 or later.

## Deploy

```sh
git clone https://github.com/t0uh33d/clipstead.git
cd clipstead/worker
npm ci
npx wrangler login
```

**1. Create the database.** Add `--jurisdiction eu` to keep data in the EU.

```sh
npx wrangler d1 create clipstead
```

Copy the printed `database_id` into the `d1_databases` entry in `worker/wrangler.jsonc` (Wrangler may offer to do
this for you):

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "clipstead", "database_id": "<your id>", "migrations_dir": "migrations" }
]
```

**2. Create the tables.**

```sh
npx wrangler d1 migrations apply clipstead --remote
```

**3. Set the one-time setup token.** It protects the first-run page, so nobody else can create the first account.

```sh
openssl rand -base64 32                 # copy the output
npx wrangler secret put SETUP_TOKEN     # paste it when prompted
```

**4. Deploy.**

```sh
npx wrangler deploy
```

Wrangler builds the web app and prints your address, e.g. `https://clipstead.<your-subdomain>.workers.dev`. On
your first deploy it may ask you to choose a `workers.dev` subdomain.

**5. Create the administrator.** Open the address, enter the setup token, choose a username and a password of at
least 12 characters, and pick the registration policy. Setup works exactly once. Afterwards the token is useless,
and you may delete it with `npx wrangler secret delete SETUP_TOKEN`.

## Install the Mac app

```sh
cd apps/macos
./scripts/build-app.sh          # creates build/Clipstead.app (universal, ad-hoc signed)
cp -R build/Clipstead.app /Applications/
open /Applications/Clipstead.app
```

The app lives in the menu bar. Open **Settings…**, enter your server address and click **Save**. In the web app,
go to **Devices → Add a Mac**, type the code it shows into the app, then check the device details in the browser
and click **Approve**. Finally turn on **Sync clipboard to this server** and confirm.

Because the app is built locally and ad-hoc signed, macOS may ask for Keychain access again after you rebuild it.
Choose **Always Allow**. To sign with your own Developer ID, set `SIGN_IDENTITY` when running the build script.

## Users and registration

The policy is stored in the database and changed only in the web app (**Settings → Instance**). Deploys and
migrations never reset it.

| Mode | Who can create an account |
| --- | --- |
| `closed` (default) | Nobody. Best for a personal instance. |
| `invite_only` | People with a single-use invite code (valid 7 days) that an administrator creates in Settings. |
| `open` | Anyone who can reach your address. Only use this if you accept strangers storing data on your account. |

Administrators manage registration and invites only. They cannot see other users' clipboards, devices or sessions
in the app. They can, of course, read the database, as can anyone with access to the Cloudflare account.

Disabling or promoting users has no UI yet. Use SQL:

```sh
npx wrangler d1 execute clipstead --remote --command "UPDATE users SET status = 'disabled' WHERE username = 'mallory'"
npx wrangler d1 execute clipstead --remote --command "UPDATE users SET is_admin = 1 WHERE username = 'alice'"
```

Disabled users can no longer sign in, and their sessions and devices stop working immediately.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Per-user storage quota | `vars.STORAGE_QUOTA_MB` in `wrangler.jsonc` | 100 |
| Cleanup schedule | `triggers.crons` in `wrangler.jsonc` | every 15 minutes |
| History retention | each user, in the web app's Settings | 6 hours |
| Setup token | `npx wrangler secret put SETUP_TOKEN` | none |

Workers Logs (`observability`) is off. If you turn it on, request URLs, which include search terms, are logged.

### Custom domain (optional)

In the Cloudflare dashboard, open the Worker, go to **Settings → Domains & Routes** and add a custom domain on a zone
you own. Enable **Always Use HTTPS** for that zone. Then use the new address in the Mac app (this requires pairing
again; revoke the old device in the web app).

## What is stored, where, and who can read it

| Data | Where |
| --- | --- |
| Clipboard text (**plaintext**), its size and SHA-256 | D1 |
| Usernames, PBKDF2 password hashes, settings | D1 |
| SHA-256 hashes of session cookies and device tokens; device names, platforms, last-seen times | D1 |
| Pairing requests (including the claiming IP), for at most 10 minutes | D1 |
| Rate-limit counters (hashed keys), for at most a day | D1 |
| Each Mac's device token | That Mac's login Keychain |
| The setup token | Cloudflare secret |

**Users are isolated** by the API: every request is tied to one account and every query is limited to it (details in
[security.md](security.md)). **Plaintext clipboard data can be read** by you as the operator, by anyone with access to
your Cloudflare account or an API token with D1 access, and by Cloudflare. Tell your users.

## Revoking devices

In the web app, open **Devices** and click **Revoke**. The device's next request is refused, and the Mac app stops
syncing, deletes its credential and asks to be paired again. A Mac can also unpair itself from **Settings → Account →
Unpair This Mac**.

## Backups, export and restore

```sh
# Full SQL export (schema and data). Contains everyone's clipboard text: store it securely.
npx wrangler d1 export clipstead --remote --output=clipstead-backup.sql

# Point-in-time restore (Time Travel: last 7 days on Free, 30 days on Paid). Replaces current data.
npx wrangler d1 time-travel restore clipstead --timestamp=2026-10-01T12:00:00Z
```

To restore an export into a fresh database: create it, put its ID in `wrangler.jsonc`, then
`npx wrangler d1 execute <new-db> --remote --file=clipstead-backup.sql` (skip the `migrations apply` step, because the
export includes the schema and migration history), and deploy.

## Deleting data

- A user can delete single entries, clear their history, shorten retention, or delete their account (Settings).
  Rows are removed from the live database at once.
- Deleted data can remain in D1 Time Travel for up to 7 or 30 days, and in any exports you made. Clipstead cannot
  erase those.

## Upgrading

```sh
git pull
cd worker && npm ci
npx wrangler d1 migrations apply clipstead --remote   # if there are new migrations
npx wrangler deploy
```

Migrations are applied before the deploy and are written to keep the previous version working. Take an export first
if you want a fallback. Rebuild and reinstall the Mac app when its code changes.

## Limits and costs

Prices and limits change. Check Cloudflare's current [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1](https://developers.cloudflare.com/d1/platform/pricing/) pages. At the time of writing, the **Free** plan includes:

- 100,000 Worker requests per day and 10 ms of CPU per request. Signing in, registering and changing a password each
  hash a password (about 7 ms of CPU); everything else is far cheaper. Cloudflare tolerates occasional overruns, but
  if many sign-ins fail with error 1102, consider the Workers Paid plan.
- D1: 5 million rows read and 100,000 rows written per day, **500 MB per database**. Each upload costs a few writes;
  each page of history reads at most one row per entry. A personal instance stays well inside these limits.
- With the default 100 MB per-user quota, a Free-plan database has room for about five users who fill their quota.
  Lower `STORAGE_QUOTA_MB` or use Workers Paid (10 GB per database) for more.

Clipstead never promises unlimited free hosting. If you exceed Free limits, requests fail until the daily reset.

## If Cloudflare or your deployment is unavailable

The web app and uploads stop working. The Mac app keeps the last few copies in memory, retries for up to an hour, then
drops them. Nothing is lost from the database. If your Cloudflare account is closed, the data goes with it, so keep
exports if the history matters to you. Clipstead has no central service to fall back on, and needs none.

## Teardown

```sh
npx wrangler d1 export clipstead --remote --output=final-export.sql   # optional
npx wrangler delete            # removes the Worker and its secrets
npx wrangler d1 delete clipstead
```

On each Mac: **Settings → Diagnostics → Reset Clipstead…**, then delete the app.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup says the token is not configured | Run `npx wrangler secret put SETUP_TOKEN` with at least 32 characters. |
| `500` errors right after the first deploy | Apply migrations: `npx wrangler d1 migrations apply clipstead --remote`. |
| `Couldn't find a D1 DB with the name or binding` | Check `database_id` in `wrangler.jsonc` matches `npx wrangler d1 list`. |
| Error 1102 on sign-in | The Free plan's CPU limit; see [limits](#limits-and-costs). |
| "Too many requests" | Rate limits; wait for the window (at most an hour). |
| Mac app: "Use https://" | The app accepts plain HTTP only for `localhost`. |
| Mac app: "Access revoked. Pair this Mac again" | The device was revoked or the account disabled. Pair again. |
| Mac app keeps asking for Keychain access | Expected once after each rebuild of an ad-hoc signed app; choose **Always Allow**. |
| Copies from an app are not synced | Check Settings → Privacy (excluded apps, size limit). Password managers mark copies as confidential, and Clipstead skips them on purpose. |
