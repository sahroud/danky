-- SAHROUD CENTRAL migration 0004: account-level feature usage counters.
-- Counts are lifetime totals per account/product/feature; changing access source
-- does not reset usage. Operational product data remains outside the central DB.

CREATE TABLE IF NOT EXISTS feature_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, product_key, feature_key),
  FOREIGN KEY (product_key, feature_key)
    REFERENCES product_features(product_key, feature_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feature_usage_account_product
  ON feature_usage(account_id, product_key);
