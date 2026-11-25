-- SAHROUD CENTRAL migration 0006: configurable runtime admission policies.
-- Policy metadata only. Runtime session leases and operation permits must be
-- enforced by a per-product Durable Object (or equivalent serialized coordinator),
-- not by a racy D1 COUNT-then-INSERT sequence.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_runtime_policies (
  product_key TEXT PRIMARY KEY REFERENCES products(product_key) ON DELETE CASCADE,
  max_devices_per_account INTEGER,
  max_sessions_per_account INTEGER,
  session_lease_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (session_lease_seconds BETWEEN 30 AND 86400),
  max_concurrent_operations INTEGER,
  max_queued_operations INTEGER NOT NULL DEFAULT 0
    CHECK (max_queued_operations >= 0),
  queue_wait_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (queue_wait_seconds BETWEEN 0 AND 86400),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (max_devices_per_account IS NULL OR max_devices_per_account >= 1),
  CHECK (max_sessions_per_account IS NULL OR max_sessions_per_account >= 1),
  CHECK (max_concurrent_operations IS NULL OR max_concurrent_operations >= 1)
);

-- Account/product overrides take precedence over product defaults.
-- NULL means inherit the product policy; it does not mean unlimited.
CREATE TABLE IF NOT EXISTS account_product_policy_overrides (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL REFERENCES products(product_key) ON DELETE CASCADE,
  max_devices_per_account INTEGER,
  max_sessions_per_account INTEGER,
  max_concurrent_operations INTEGER,
  max_queued_operations INTEGER,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (account_id, product_key),
  CHECK (max_devices_per_account IS NULL OR max_devices_per_account >= 1),
  CHECK (max_sessions_per_account IS NULL OR max_sessions_per_account >= 1),
  CHECK (max_concurrent_operations IS NULL OR max_concurrent_operations >= 1),
  CHECK (max_queued_operations IS NULL OR max_queued_operations >= 0)
);

CREATE INDEX IF NOT EXISTS idx_runtime_policy_overrides_product
  ON account_product_policy_overrides(product_key, account_id);
