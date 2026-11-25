-- SAHROUD CENTRAL migration 0005: provider-neutral commerce foundation.
-- This schema is metadata only. Payment secrets and provider credentials belong in Worker secrets.
-- No remote migration is performed by this change.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS checkout_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  product_key TEXT NOT NULL REFERENCES products(product_key) ON DELETE RESTRICT,
  plan_code TEXT,
  order_type TEXT NOT NULL
    CHECK (order_type IN ('feature_purchase', 'subscription_purchase', 'subscription_renewal')),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('draft', 'pending_payment', 'paid', 'failed', 'cancelled', 'refunded', 'expired')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8),
  idempotency_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT,
  provider_order_ref TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (product_key, plan_code)
    REFERENCES plans(product_key, plan_code)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES checkout_orders(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'redirected', 'authorized', 'captured', 'failed', 'cancelled', 'refunded')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8),
  provider_payment_ref TEXT,
  checkout_url TEXT,
  failure_code TEXT,
  initiated_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  failure_reason TEXT,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_orders_account_status
  ON checkout_orders(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_orders_provider_ref
  ON checkout_orders(provider, provider_order_ref);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order
  ON payment_attempts(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_provider_ref
  ON payment_attempts(provider, provider_payment_ref);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_processing
  ON payment_webhook_events(processing_status, received_at);
