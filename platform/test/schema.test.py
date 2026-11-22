from pathlib import Path
import sqlite3

migration = Path(__file__).resolve().parents[1] / "migrations" / "0001_core.sql"
connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
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
}
assert required.issubset(tables), f"Missing tables: {required - tables}"

products = connection.execute(
    "SELECT product_key, lifecycle_status FROM products ORDER BY product_key"
).fetchall()
assert len(products) == 6, f"Expected 6 seeded products, got {len(products)}"
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

print("SAHROUD Central schema tests passed")
