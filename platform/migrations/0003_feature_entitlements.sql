-- SAHROUD CENTRAL migration 0003: feature-level access control.
-- This is control-plane metadata only. Product operational data stays isolated.

PRAGMA foreign_keys = ON;

-- Every independently controllable capability is registered here.
-- access_mode:
--   free     = available to every active account when enabled
--   paid     = requires a matching active account_feature_grants row
--   disabled = blocked for everyone, including paid users
CREATE TABLE IF NOT EXISTS product_features (
  product_key TEXT NOT NULL REFERENCES products(product_key) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  access_mode TEXT NOT NULL DEFAULT 'paid'
    CHECK (access_mode IN ('free', 'paid', 'disabled')),
  price_amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'IRR',
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  usage_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (product_key, feature_key),
  CHECK (price_amount IS NULL OR price_amount >= 0),
  CHECK (usage_limit IS NULL OR usage_limit >= 0),
  CHECK (access_mode <> 'free' OR price_amount IS NULL)
);

-- Explicit grants are used for paid purchases, promotional access and admin-issued access.
CREATE TABLE IF NOT EXISTS account_feature_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('purchase', 'subscription', 'promotion', 'manual', 'trial')),
  source_ref TEXT,
  starts_at TEXT,
  ends_at TEXT,
  usage_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (product_key, feature_key)
    REFERENCES product_features(product_key, feature_key) ON DELETE CASCADE,
  CHECK (usage_limit IS NULL OR usage_limit >= 0)
);

-- A plan may include any subset of a product's paid features.
CREATE TABLE IF NOT EXISTS plan_features (
  product_key TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_key, plan_code, feature_key),
  FOREIGN KEY (product_key, plan_code)
    REFERENCES plans(product_key, plan_code) ON DELETE CASCADE,
  FOREIGN KEY (product_key, feature_key)
    REFERENCES product_features(product_key, feature_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_features_status
  ON product_features(product_key, is_enabled, access_mode);
CREATE INDEX IF NOT EXISTS idx_feature_grants_account_product
  ON account_feature_grants(account_id, product_key, status);
CREATE INDEX IF NOT EXISTS idx_feature_grants_expiry
  ON account_feature_grants(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_plan_features_plan
  ON plan_features(product_key, plan_code);
