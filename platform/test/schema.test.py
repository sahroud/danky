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
    "checkout_orders",
    "payment_attempts",
    "payment_webhook_events",
    "product_runtime_policies",
    "account_product_policy_overrides",
    "account_product_devices",
    "account_product_sessions",
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

# Checkout is idempotent per account, and attempts/events retain provider references.
connection.execute(
    "INSERT INTO checkout_orders "
    "(id, account_id, product_key, plan_code, order_type, status, amount, currency, idempotency_key, created_at, updated_at) "
    "VALUES ('o1', 'a1', 'steel', 'free', 'subscription_purchase', 'pending_payment', 120000, 'IRR', 'checkout-1', 'now', 'now')"
)
connection.execute(
    "INSERT INTO payment_attempts "
    "(id, order_id, provider, status, amount, currency, provider_payment_ref, initiated_at, created_at, updated_at) "
    "VALUES ('pa1', 'o1', 'provider-test', 'created', 120000, 'IRR', 'pay-ref-1', 'now', 'now', 'now')"
)
connection.execute(
    "INSERT INTO payment_webhook_events "
    "(id, provider, provider_event_id, event_type, payload_sha256, received_at) "
    "VALUES ('wh1', 'provider-test', 'event-1', 'payment.succeeded', 'sha256-test', 'now')"
)
try:
    connection.execute(
        "INSERT INTO checkout_orders "
        "(id, account_id, product_key, plan_code, order_type, amount, currency, idempotency_key, created_at, updated_at) "
        "VALUES ('o2', 'a1', 'steel', 'free', 'subscription_purchase', 120000, 'IRR', 'checkout-1', 'now', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate account checkout idempotency key was accepted")
try:
    connection.execute(
        "INSERT INTO payment_webhook_events "
        "(id, provider, provider_event_id, event_type, payload_sha256, received_at) "
        "VALUES ('wh2', 'provider-test', 'event-1', 'payment.succeeded', 'sha256-test', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate provider webhook event was accepted")

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


# Product runtime admission policies are configurable metadata, separate from sessions.
connection.execute(
    "INSERT INTO product_runtime_policies "
    "(product_key, max_devices_per_account, max_sessions_per_account, "
    "session_lease_seconds, max_concurrent_operations, max_queued_operations, "
    "queue_wait_seconds, operation_lease_seconds, max_operation_lifetime_seconds, updated_at) "
    "VALUES ('steel', 3, 2, 300, 8, 20, 60, 300, 3600, 'now')"
)
connection.execute(
    "INSERT INTO account_product_policy_overrides "
    "(account_id, product_key, max_devices_per_account, max_sessions_per_account, "
    "max_concurrent_operations, max_queued_operations, operation_lease_seconds, "
    "max_operation_lifetime_seconds, updated_at) "
    "VALUES ('a1', 'steel', 2, NULL, 4, NULL, 120, 1800, 'now')"
)
policy = connection.execute(
    "SELECT max_devices_per_account, max_sessions_per_account, "
    "max_concurrent_operations, max_queued_operations "
    "FROM product_runtime_policies WHERE product_key='steel'"
).fetchone()
assert policy == (3, 2, 8, 20), f"Unexpected product runtime policy: {policy}"
override = connection.execute(
    "SELECT max_devices_per_account, max_sessions_per_account, "
    "max_concurrent_operations, max_queued_operations "
    "FROM account_product_policy_overrides WHERE account_id='a1' AND product_key='steel'"
).fetchone()
assert override == (2, None, 4, None), f"NULL override values must inherit product defaults: {override}"
lease_override = connection.execute(
    "SELECT operation_lease_seconds, max_operation_lifetime_seconds "
    "FROM account_product_policy_overrides WHERE account_id='a1' AND product_key='steel'"
).fetchone()
assert lease_override == (120, 1800), f"Unexpected operation lease override: {lease_override}"
product_lease = connection.execute(
    "SELECT operation_lease_seconds, max_operation_lifetime_seconds "
    "FROM product_runtime_policies WHERE product_key='steel'"
).fetchone()
assert product_lease == (300, 3600), f"Unexpected operation lease defaults: {product_lease}"
try:
    connection.execute(
        "INSERT INTO product_runtime_policies "
        "(product_key, max_devices_per_account, session_lease_seconds, updated_at) "
        "VALUES ('utm', 0, 10, 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Invalid device limit or lease duration was accepted")

# Product device identities and session leases are isolated by account and product.
connection.execute(
    "INSERT INTO account_product_devices "
    "(account_id, product_key, device_id, device_label, platform, status, "
    "first_seen_at, last_seen_at, created_at, updated_at) "
    "VALUES ('a1', 'steel', 'device-install-001', 'Android phone', 'android', "
    "'active', 'now', 'now', 'now', 'now')"
)
connection.execute(
    "INSERT INTO account_product_sessions "
    "(session_id, account_id, product_key, principal_id, device_id, token_hash, "
    "status, issued_at, expires_at, last_seen_at, created_at, updated_at) "
    "VALUES ('sess-1', 'a1', 'steel', 'p1', 'device-install-001', "
    "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', "
    "'active', 'now', 'later', 'now', 'now', 'now')"
)
try:
    connection.execute(
        "INSERT INTO account_product_sessions "
        "(session_id, account_id, product_key, principal_id, device_id, token_hash, "
        "status, issued_at, expires_at, last_seen_at, created_at, updated_at) "
        "VALUES ('sess-2', 'a1', 'steel', 'p1', 'device-install-001', "
        "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', "
        "'active', 'now', 'later', 'now', 'now', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate session token hash was accepted")

try:
    connection.execute(
        "INSERT INTO account_product_sessions "
        "(session_id, account_id, product_key, principal_id, device_id, token_hash, "
        "status, issued_at, expires_at, last_seen_at, created_at, updated_at) "
        "VALUES ('sess-3', 'a1', 'steel', 'p1', 'unknown-device', "
        "'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', "
        "'active', 'now', 'later', 'now', 'now', 'now')"
    )
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Session without a registered account/product device was accepted")

stored_session = connection.execute(
    "SELECT account_id, product_key, device_id, status FROM account_product_sessions "
    "WHERE session_id='sess-1'"
).fetchone()
assert stored_session == ('a1', 'steel', 'device-install-001', 'active'), (
    f"Unexpected product session scope: {stored_session}"
)

print("SAHROUD Central schema tests passed")


# Exercise the exact conditional UPSERT against SQLite with independent connections.
# SQLite serializes writers; deterministic sequential attempts validate the SQL cap here.
# The Cloudflare D1 test separately covers concurrent consume requests.
from tempfile import TemporaryDirectory

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

with TemporaryDirectory() as temp_dir:
    db_path = Path(temp_dir) / "central-usage.sqlite"
    # Finish the in-memory schema/data transaction before SQLite backup.
    # An uncommitted source transaction can leave backup waiting indefinitely.
    connection.commit()
    with sqlite3.connect(db_path) as seed:
        connection.backup(seed)

    outcomes = []
    for _ in range(40):
        with sqlite3.connect(db_path, timeout=10) as db:
            db.execute("PRAGMA busy_timeout = 10000")
            outcomes.append(db.execute(
                usage_upsert,
                ("a1", "steel", "dxf-export", "2026-11-24T00:00:00Z",
                 "2026-11-24T00:00:00Z", 5, 5, 5, 5),
            ).fetchone())

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

print("SAHROUD Central SQLite usage limit test passed")
