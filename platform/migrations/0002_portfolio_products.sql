-- SAHROUD CENTRAL migration 0002: complete the current SAHROUD product catalog.
-- Keep migration 0001 immutable; these inserts are safe to apply once through Wrangler.

INSERT OR IGNORE INTO products
  (product_key, display_name, category, lifecycle_status, created_at, updated_at)
VALUES
  ('gps', 'SAHROUD GPS', 'surveying', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rtk', 'SAHROUD RTK', 'surveying', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('earth', 'SAHROUD EARTH', 'surveying', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('topography', 'SAHROUD TOPOGRAPHY', 'surveying', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rakat', 'SAHROUD RAKAT', 'utility', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('counter', 'SAHROUD COUNTER', 'analytics', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('windows-doctor', 'SAHROUD WINDOWS DOCTOR', 'desktop-utility', 'development', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
