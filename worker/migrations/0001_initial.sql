-- Clipstead schema. All timestamps are Unix epoch milliseconds.
-- Every account-owned table carries user_id with ON DELETE CASCADE, so deleting a user removes all of their data.

-- Single-row instance configuration. Created once by this migration; never reset by deploys.
CREATE TABLE instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_mode TEXT NOT NULL DEFAULT 'closed'
    CHECK (registration_mode IN ('closed', 'invite_only', 'open')),
  setup_completed_at INTEGER
);
INSERT INTO instance (id) VALUES (1);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Entries are deleted this many hours after they are copied; NULL keeps them forever.
  retention_hours INTEGER DEFAULT 6 CHECK (retention_hours IS NULL OR retention_hours BETWEEN 1 AND 87600),
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Browser sessions. Only a SHA-256 hash of the cookie value is stored; revocation deletes the row.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions (user_id);

-- Paired devices. Revocation clears token_hash, so a revoked token can never match again.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  CHECK ((token_hash IS NULL) = (revoked_at IS NOT NULL))
);
CREATE INDEX devices_user_id ON devices (user_id);

-- Browser-initiated pairing: waiting -> claimed (by a device) -> approved (in the browser) -> completed.
CREATE TABLE pairing_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT UNIQUE,
  device_name TEXT,
  platform TEXT,
  app_version TEXT,
  claim_ip TEXT,
  claim_country TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  approved_at INTEGER,
  completed_at INTEGER,
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL
);
CREATE INDEX pairing_challenges_user_id ON pairing_challenges (user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE clipboard_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'text/plain'),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX clipboard_entries_user_created ON clipboard_entries (user_id, created_at DESC, id DESC);
CREATE INDEX clipboard_entries_user_hash ON clipboard_entries (user_id, content_hash);

-- Keep users.storage_bytes exact for quota checks, whatever deletes the rows (API, retention, cascade).
CREATE TRIGGER clipboard_entries_storage_insert AFTER INSERT ON clipboard_entries BEGIN
  UPDATE users SET storage_bytes = storage_bytes + NEW.size_bytes WHERE id = NEW.user_id;
END;
CREATE TRIGGER clipboard_entries_storage_delete AFTER DELETE ON clipboard_entries BEGIN
  UPDATE users SET storage_bytes = storage_bytes - OLD.size_bytes WHERE id = OLD.user_id;
END;

-- Fixed-window rate-limit counters, keyed by a SHA-256 of "<action>:<subject>".
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;
