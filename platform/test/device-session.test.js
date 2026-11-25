import test from "node:test";
import assert from "node:assert/strict";
import { loadEffectiveDeviceSessionPolicy, handleDeviceSession } from "../src/device-session.js";

function policyDb(product, override = null) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("FROM product_runtime_policies")) return product;
          if (sql.includes("FROM account_product_policy_overrides")) return override;
          return null;
        }
      };
    }
  };
}

test("device/session policy uses the tighter account caps", async () => {
  const policy = await loadEffectiveDeviceSessionPolicy(
    policyDb(
      { max_devices_per_account: 5, max_sessions_per_account: 4, session_lease_seconds: 600 },
      { max_devices_per_account: 3, max_sessions_per_account: 2 }
    ),
    "account-a",
    "steel"
  );
  assert.deepEqual(policy, {
    maxDevicesPerAccount: 3,
    maxSessionsPerAccount: 2,
    sessionLeaseSeconds: 600
  });
});

test("device/session policy fails closed when either cap is unconfigured", async () => {
  await assert.rejects(
    loadEffectiveDeviceSessionPolicy(
      policyDb({ max_devices_per_account: null, max_sessions_per_account: 2, session_lease_seconds: 300 }),
      "account-a",
      "steel"
    ),
    error => error.message === "device_session_policy_not_configured"
  );
});

test("device and session ceilings remain independent", async () => {
  const policy = await loadEffectiveDeviceSessionPolicy(
    policyDb({ max_devices_per_account: 2, max_sessions_per_account: 5, session_lease_seconds: 300 }),
    "account-a",
    "steel"
  );
  assert.equal(policy.maxDevicesPerAccount, 2);
  assert.equal(policy.maxSessionsPerAccount, 5);
});

test("session close works with header token and does not depend on runtime caps", async () => {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) { queries.push({ sql, args }); return this; },
        async all() {
          if (sql.includes("FROM account_identities")) {
            return { results: [{ principal_id: "principal-a", account_id: "account-a" }] };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM products")) return { product_key: "steel" };
          if (sql.startsWith("UPDATE account_product_sessions")) return { session_id: "session-a" };
          return null;
        }
      };
    }
  };
  const token = "a".repeat(64);
  const request = new Request("https://central.test/v1/sessions/steel/close", {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "X-Sahroud-Session-Token": token
    }
  });
  const response = await handleDeviceSession(
    request,
    { CORE_DB: db },
    { subject: "firebase-user" },
    "steel",
    "sessions",
    "close"
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).closed, true);
  assert.equal(queries.some(item => item.sql.includes("product_runtime_policies")), false);
  assert.match(queries.find(item => item.sql.startsWith("UPDATE account_product_sessions")).sql, /token_hash=\?/);
  assert.notEqual(queries.find(item => item.sql.startsWith("UPDATE account_product_sessions")).args[4], token);
});
