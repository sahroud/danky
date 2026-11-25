-- SAHROUD CENTRAL migration 0008: registered product devices and session leases.
-- Metadata only; no remote migration is authorized by this change.
-- Device IDs identify app installations, not guaranteed physical hardware identities.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_product_devices (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL REFERENCES products(product_key) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 8 AND 128),
  device_label TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'windows', 'macos', 'linux', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, product_key, device_id)
);

CREATE INDEX IF NOT EXISTS idx_product_devices_active
  ON account_product_devices(account_id, product_key, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS account_product_sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id, product_key, device_id)
    REFERENCES account_product_devices(account_id, product_key, device_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, principal_id)
    REFERENCES account_memberships(account_id, principal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_sessions_active
  ON account_product_sessions(account_id, product_key, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_product_sessions_device
  ON account_product_sessions(account_id, product_key, device_id, status);
