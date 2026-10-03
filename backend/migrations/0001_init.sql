CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_before INTEGER
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  dns_record_id TEXT NOT NULL,
  port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  UNIQUE (user_id, name)
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE refresh_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_kind TEXT NOT NULL CHECK (client_kind IN ('app', 'cli', 'web')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

-- OAuth round-trip state (not in spec table list; needed for CSRF protection)
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  client_kind TEXT NOT NULL,       -- app | web | link
  pkce_challenge TEXT,
  extra TEXT,                      -- user_code for link flow
  expires_at INTEGER NOT NULL
);
