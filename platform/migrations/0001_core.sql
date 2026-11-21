PRAGMA foreign_keys = ON;

-- Central identity and licensing only. Product-specific/private data stays in each product's own database.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('personal', 'organization')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS products (
  product_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'development'
    CHECK (lifecycle_status IN ('development', 'beta', 'active', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  product_key TEXT NOT NULL REFERENCES products(product_key),
  plan_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_key, plan_code)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_key TEXT NOT NULL REFERENCES products(product_key),
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired')),
  starts_at TEXT,
  ends_at TEXT,
  billing_provider TEXT,
  provider_subscription_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_key, plan_code) REFERENCES plans(product_key, plan_code)
);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_key TEXT NOT NULL REFERENCES products(product_key),
  entitlement_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  starts_at TEXT,
  ends_at TEXT,
  source_subscription_id TEXT REFERENCES subscriptions(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_key TEXT NOT NULL REFERENCES products(product_key),
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_validated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  product_key TEXT REFERENCES products(product_key),
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_account_identities_account
  ON account_identities(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_product
  ON subscriptions(account_id, product_key, status);
CREATE INDEX IF NOT EXISTS idx_entitlements_account_product
  ON entitlements(account_id, product_key, status);
CREATE INDEX IF NOT EXISTS idx_license_keys_account_product
  ON license_keys(account_id, product_key, status);
CREATE INDEX IF NOT EXISTS idx_audit_events_account_time
  ON audit_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_product_time
  ON audit_events(product_key, created_at DESC);

INSERT OR IGNORE INTO products (product_key, display_name, lifecycle_status, created_at, updated_at)
VALUES
  ('family-guard', 'SAHROUD FAMILY GUARD', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('steel', 'SAHROUD STEEL', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metreh', 'SAHROUD METREH', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('utm', 'SAHROUD UTM', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('tasbih', 'SAHROUD TASBIH', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('games', 'SAHROUD GAMES', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
