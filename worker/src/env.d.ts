// Bindings and vars from wrangler.jsonc, plus secrets set with `wrangler secret put`.
// Runtime types come from `npm run types` (wrangler types --include-env=false).
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
  interface Env {
    DB: D1Database;
    /** One-time secret required to create the first administrator. At least 32 characters. */
    SETUP_TOKEN?: string;
    /** Per-user clipboard storage quota in MiB. */
    STORAGE_QUOTA_MB?: string;
  }
}
interface Env extends Cloudflare.Env {}
