from pathlib import Path
import sqlite3

migration_dir = Path(__file__).resolve().parents[1] / "migrations"
connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")

migration_files = sorted(migration_dir.glob("[0-9][0-9][0-9][0-9]_*.sql"))
assert len(migration_files) >= 2, "Expected versioned core and portfolio migrations"
for migration in migration_files:
    connection.executescript(migration.read_text(encoding="utf-8"))

tables = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
}
required = {
    "principals",
    "accounts",
    "account_identities",
    "account_memberships",
    "products",
    "plans",
    "subscriptions",
    "entitlements",
    "license_keys",
    "audit_events",
    "product_features",
    "account_feature_grants",
    "plan_features",
    "feature_usage",
}
assert required.issubset(tables), f"Missing tables: {required - tables}"

expected_products = {
    "family-guard",
    "steel",
    "metreh",
    "utm",
    "tasbih",
    "games",
    "gps",
    "rtk",
    "earth",
    "topography",
    "rakat",
    "counter",
    "windows-doctor",
}
products = connection.execute(
    "SELECT product_key, lifecycle_status FROM products ORDER BY product_key"
).fetchall()
actual_product_keys = {key for key, _ in products}
assert actual_product_keys == expected_products, (
    f"Product catalog mismatch. Missing: {expected_products - actual_product_keys}; "
    f"unexpected: {actual_product_keys - expected_products}"
)
assert len(products) == 13, f"Expected 13 registered products, got {len(products)}"
assert all(status == "development" for _, status in products)

# One principal can belong to more than one personal/organization account.
connection.execute(
    "INSERT INTO principals (id, created_at, updated_at) VALUES ('p1', 'now', 'now')"
)
connection.execute(
    "INSERT INTO accounts (id, account_type, display_name, created_at, updated_at) "
    "VALUES ('a1', 'personal', 'Personal', 'now', 'now'), "
    "('a2', 'organization', 'Organization', 'now', 'now')"
)
connection.execute(
    "INSERT INTO account_memberships "
    "(account_id, principal_id, role, status, created_at, updated_at) "
    "VALUES ('a1', 'p1', 'owner', 'active', 'now', 'now'), "
    "('a2', 'p1', 'member', 'active', 'now', 'now')"
)
membership_count = connection.execute(
    "SELECT COUNT(*) FROM account_memberships WHERE principal_id = 'p1'"
).fetchone()[0]
assert membership_count == 2, "A user must be able to belong to multiple accounts"

# Identity ownership is unique across the central identity namespace.
connection.execute(
    "INSERT INTO account_identities "
    "(id, principal_id, provider, provider_subject, created_at) "
    "VALUES ('i1', 'p1', 'google', 'subject-1', 'now')"
)
try:
    connection.execute(
        "INSERT INTO account_identities "
        "(id, principal_id, provider, provider_subject, created_at) "
        "VALUES ('i2', 'p1', 'google', 'subject-1', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate external identity was accepted")

# Product plans and subscriptions must reference an existing product/plan pair.
connection.execute(
    "INSERT INTO plans "
    "(product_key, plan_code, display_name, created_at, updated_at) "
    "VALUES ('steel', 'free', 'Free', 'now', 'now')"
)
connection.execute(
    "INSERT INTO subscriptions "
    "(id, account_id, product_key, plan_code, status, created_at, updated_at) "
    "VALUES ('s1', 'a1', 'steel', 'free', 'active', 'now', 'now')"
)

# License secrets are represented by a unique hash, not the plaintext key.
connection.execute(
    "INSERT INTO license_keys "
    "(id, account_id, product_key, public_prefix, key_hash, created_at) "
    "VALUES ('l1', 'a1', 'steel', 'SAHROUD-ST', 'hash-1', 'now')"
)
try:
    connection.execute(
        "INSERT INTO license_keys "
        "(id, account_id, product_key, public_prefix, key_hash, created_at) "
        "VALUES ('l2', 'a2', 'steel', 'SAHROUD-ST', 'hash-1', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate license hash was accepted")


# Feature-level plan mapping and lifetime usage counters must be enforceable.
connection.execute(
    "INSERT INTO product_features "
    "(product_key, feature_key, display_name, access_mode, created_at, updated_at) "
    "VALUES ('steel', 'dxf-export', 'DXF export', 'paid', 'now', 'now')"
)
connection.execute(
    "INSERT INTO plan_features (product_key, plan_code, feature_key, created_at) "
    "VALUES ('steel', 'free', 'dxf-export', 'now')"
)
connection.execute(
    "INSERT INTO feature_usage "
    "(account_id, product_key, feature_key, used_count, created_at, updated_at) "
    "VALUES ('a1', 'steel', 'dxf-export', 2, 'now', 'now')"
)
usage_count = connection.execute(
    "SELECT used_count FROM feature_usage "
    "WHERE account_id='a1' AND product_key='steel' AND feature_key='dxf-export'"
).fetchone()[0]
assert usage_count == 2, "Feature usage counter must persist account-level totals"

mapped_features = connection.execute(
    "SELECT COUNT(*) FROM plan_features pf "
    "JOIN subscriptions s ON s.product_key=pf.product_key AND s.plan_code=pf.plan_code "
    "WHERE s.account_id='a1' AND s.status='active' AND pf.feature_key='dxf-export'"
).fetchone()[0]
assert mapped_features == 1, "Active product plans must map to included features"

print("SAHROUD Central schema tests passed")


# Exercise the exact conditional UPSERT against SQLite using independent connections.
# This is a database-engine concurrency test, not a Cloudflare D1 runtime test.
from concurrent.futures import ThreadPoolExecutor
import tempfile

usage_upsert = """
INSERT INTO feature_usage
  (account_id, product_key, feature_key, used_count, created_at, updated_at)
SELECT ?, ?, ?, 1, ?, ?
WHERE (? IS NULL OR ? > 0)
ON CONFLICT(account_id, product_key, feature_key)
DO UPDATE SET
  used_count = feature_usage.used_count + 1,
  updated_at = excluded.updated_at
WHERE (? IS NULL OR feature_usage.used_count < ?)
RETURNING used_count
"""

with tempfile.TemporaryDirectory() as temp_dir:
    db_path = Path(temp_dir) / "central-concurrency.sqlite"
    with sqlite3.connect(db_path) as seed:
        connection.backup(seed)

    def attempt_consume(_):
        with sqlite3.connect(db_path, timeout=15, isolation_level=None) as db:
            db.execute("PRAGMA busy_timeout = 15000")
            return db.execute(
                usage_upsert,
                ("a1", "steel", "dxf-export", "2026-11-24T00:00:00Z",
                 "2026-11-24T00:00:00Z", 5, 5, 5, 5),
            ).fetchone()

    with ThreadPoolExecutor(max_workers=40) as pool:
        outcomes = list(pool.map(attempt_consume, range(40)))

    accepted = [row[0] for row in outcomes if row is not None]
    rejected = sum(row is None for row in outcomes)
    with sqlite3.connect(db_path) as verify:
        final_count = verify.execute(
            "SELECT used_count FROM feature_usage "
            "WHERE account_id='a1' AND product_key='steel' AND feature_key='dxf-export'"
        ).fetchone()[0]

    assert len(accepted) == 3, (
        f"Expected exactly 3 accepted requests from initial count 2 to limit 5; got {len(accepted)}"
    )
    assert rejected == 37, f"Expected 37 rejected requests, got {rejected}"
    assert final_count == 5, f"Usage counter exceeded or missed limit: {final_count}"
    assert sorted(accepted) == [3, 4, 5], f"Unexpected returned counts: {accepted}"

print("SAHROUD Central SQLite concurrent usage test passed")
