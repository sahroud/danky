PRAGMA foreign_keys = ON;

-- SAHROUD CENTRAL stores shared identity, product catalog and licensing metadata only.
-- Product operational data must remain in each product's isolated database.

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL
    CHECK (account_type IN ('personal', 'organization')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One person can use multiple identity providers and belong to multiple accounts.
CREATE TABLE IF NOT EXISTS account_identities (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS account_memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invited', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, principal_id)
);

CREATE TABLE IF NOT EXISTS products (
  product_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
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
  product_key TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired')),
  starts_at TEXT,
  ends_at TEXT,
  billing_provider TEXT,
  provider_subscription_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_key, plan_code)
    REFERENCES plans(product_key, plan_code)
);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_key TEXT NOT NULL REFERENCES products(product_key),
  entitlement_code TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  starts_at TEXT,
  ends_at TEXT,
  source_subscription_id TEXT REFERENCES subscriptions(id),
  created_at TEXT NOT NULL
);

-- Store only a one-way hash of the full license secret. The visible prefix is not secret.
CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_key TEXT NOT NULL REFERENCES products(product_key),
  public_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  not_before TEXT,
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

CREATE INDEX IF NOT EXISTS idx_account_identities_principal
  ON account_identities(principal_id);
CREATE INDEX IF NOT EXISTS idx_memberships_principal_status
  ON account_memberships(principal_id, status);
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

INSERT OR IGNORE INTO products
  (product_key, display_name, category, lifecycle_status, created_at, updated_at)
VALUES
  ('family-guard', 'SAHROUD FAMILY GUARD', 'safety', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('steel', 'SAHROUD STEEL', 'engineering', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metreh', 'SAHROUD METREH', 'construction', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('utm', 'SAHROUD UTM', 'surveying', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('tasbih', 'SAHROUD TASBIH', 'utility', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('games', 'SAHROUD GAMES', 'games', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
