import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Each test file gets its own isolated storage; bring its database up to the current schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
