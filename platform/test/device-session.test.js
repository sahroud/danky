import test from "node:test";
import assert from "node:assert/strict";
import { loadEffectiveDeviceSessionPolicy, handleDeviceSession, handleAdminDeviceSessions } from "../src/device-session.js";

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


test("central admin can list sessions without exposing token hashes", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("FROM accounts")) return { id: "account-a" };
          if (sql.includes("FROM products")) return { product_key: "steel" };
          return null;
        },
        async all() {
          if (sql.includes("FROM account_product_devices")) return { results: [{ device_id: "install-0001", status: "active" }] };
          if (sql.includes("FROM account_product_sessions")) return { results: [{ session_id: "session-a", status: "active" }] };
          return { results: [] };
        },
        async run() { return { success: true }; }
      };
    }
  };
  const response = await handleAdminDeviceSessions(
    new Request("https://central.test/v1/admin/accounts/account-a/products/steel/sessions"),
    { CORE_DB: db, CENTRAL_ADMIN_UIDS: "admin-uid" },
    { subject: "admin-uid" },
    "account-a", "steel", "sessions", "list"
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessions[0].session_id, "session-a");
  assert.equal(JSON.stringify(body).includes("token_hash"), false);
  assert.equal(sqls.some(sql => sql.includes("SET status='expired'")), true);
});

test("central admin revocation is account and product scoped", async () => {
  let updateArgs;
  const db = {
    prepare(sql) {
      return {
        bind(...args) { updateArgs = args; return this; },
        async first() {
          if (sql.includes("FROM accounts")) return { id: "account-a" };
          if (sql.includes("FROM products")) return { product_key: "steel" };
          if (sql.startsWith("UPDATE account_product_sessions")) return { session_id: "session-a" };
          return null;
        }
      };
    }
  };
  const response = await handleAdminDeviceSessions(
    new Request("https://central.test", { method: "POST" }),
    { CORE_DB: db, CENTRAL_ADMIN_UIDS: "admin-uid" },
    { subject: "admin-uid" },
    "account-a", "steel", "sessions", "revoke", "session-a"
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, true);
  assert.equal(updateArgs[2], "account-a");
  assert.equal(updateArgs[3], "steel");
  assert.equal(updateArgs[4], "session-a");
});

test("non-admin cannot use central session management", async () => {
  const response = await handleAdminDeviceSessions(
    new Request("https://central.test"),
    { CENTRAL_ADMIN_UIDS: "admin-uid" },
    { subject: "ordinary-user" },
    "account-a", "steel", "sessions", "list"
  );
  assert.equal(response.status, 403);
});
