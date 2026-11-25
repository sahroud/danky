-- SAHROUD CENTRAL migration 0007: bounded operation permit leases.
-- Metadata only; the coordinator remains disabled until its DO implementation
-- and local concurrency tests are complete. No remote migration is authorized.

PRAGMA foreign_keys = ON;

ALTER TABLE product_runtime_policies
  ADD COLUMN operation_lease_seconds INTEGER NOT NULL DEFAULT 300
  CHECK (operation_lease_seconds BETWEEN 30 AND 86400);

ALTER TABLE product_runtime_policies
  ADD COLUMN max_operation_lifetime_seconds INTEGER NOT NULL DEFAULT 3600
  CHECK (max_operation_lifetime_seconds BETWEEN 30 AND 604800);

ALTER TABLE account_product_policy_overrides
  ADD COLUMN operation_lease_seconds INTEGER
  CHECK (operation_lease_seconds IS NULL OR operation_lease_seconds BETWEEN 30 AND 86400);

ALTER TABLE account_product_policy_overrides
  ADD COLUMN max_operation_lifetime_seconds INTEGER
  CHECK (max_operation_lifetime_seconds IS NULL OR max_operation_lifetime_seconds BETWEEN 30 AND 604800);
