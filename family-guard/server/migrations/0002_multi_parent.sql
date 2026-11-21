-- SAHROUD FAMILY GUARD migration 0002: independent parent accounts.
-- Run once on the existing D1 database before deploying the updated Worker.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS family_members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'second_parent')),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  subscription_status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (subscription_status IN ('included', 'inactive', 'active', 'expired', 'cancelled')),
  subscription_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_owner_per_family
  ON family_members(family_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_family_members_family
  ON family_members(family_id, role, status);

-- Preserve every existing parent's access by migrating the current token as the owner.
INSERT OR IGNORE INTO family_members
  (id, family_id, role, label, token_hash, status, subscription_status, created_at)
SELECT lower(hex(randomblob(16))), id, 'owner', parent_label,
       parent_token_hash, 'active', 'included', created_at
FROM families;

CREATE TABLE IF NOT EXISTS parent_invites (
  code_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parent_invites_family_expiry
  ON parent_invites(family_id, expires_at);
