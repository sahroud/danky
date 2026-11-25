import test from "node:test";
import assert from "node:assert/strict";
import { handle, resolveCentralIdentity, resolveFeatureAccess, incrementFeatureUsage } from "../src/index.js";

const request = (path, options = {}) =>
  new Request(`https://central.test${path}`, options);

test("health reports a configured central database", async () => {
  const env = {
    CORE_DB: {
      prepare(sql) {
        assert.match(sql, /SELECT 1 AS ok/);
        return { first: async () => ({ ok: 1 }) };
      }
    }
  };
  const response = await handle(request("/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.dependencies.core_db, "ok");
});

test("version endpoint is available without database access", async () => {
  const response = await handle(request("/v1/version"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "sahroud-central-api");
  assert.equal(body.api_version, "0.3.0");
});

test("catalog reports missing central database instead of pretending success", async () => {
  const response = await handle(request("/v1/catalog/products"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "core_database_not_configured");
});

test("allowed browser origin receives CORS headers", async () => {
  const response = await handle(request("/v1/version", {
    headers: { Origin: "https://sahroud.github.io" }
  }), { CORS_ALLOWED_ORIGINS: "https://sahroud.github.io" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://sahroud.github.io");
});

test("disallowed browser origin is rejected", async () => {
  const response = await handle(request("/v1/version", {
    headers: { Origin: "https://example.invalid" }
  }), { CORS_ALLOWED_ORIGINS: "https://sahroud.github.io" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_not_allowed");
});

test("CORS preflight advertises account selection header", async () => {
  const response = await handle(request("/v1/access/steel/dxf-export", {
    method: "OPTIONS",
    headers: { Origin: "https://sahroud.github.io" }
  }), { CORS_ALLOWED_ORIGINS: "https://sahroud.github.io" });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /X-Sahroud-Account-Id/i);
});


test("identity resolution does not choose an arbitrary account when multiple memberships exist", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM account_identities/);
      assert.match(sql, /JOIN accounts a ON a.id = am.account_id AND a.status = 'active'/);
      return {
        bind(subject) {
          assert.equal(subject, "firebase-user-1");
          return this;
        },
        async all() {
          return { results: [
            { principal_id: "principal-1", account_id: "account-a" },
            { principal_id: "principal-1", account_id: "account-b" }
          ] };
        }
      };
    }
  };
  const identity = await resolveCentralIdentity({ CORE_DB: db }, { subject: "firebase-user-1" });
  assert.equal(identity.principalId, "principal-1");
  assert.equal(identity.accountId, null);
  assert.deepEqual(identity.accountIds, ["account-a", "account-b"]);
});

test("identity resolution keeps the single-account compatibility field", async () => {
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async all() {
          return { results: [{ principal_id: "principal-1", account_id: "account-a" }] };
        }
      };
    }
  };
  const identity = await resolveCentralIdentity({ CORE_DB: db }, { subject: "firebase-user-1" });
  assert.equal(identity.accountId, "account-a");
  assert.deepEqual(identity.accountIds, ["account-a"]);
});


function entitlementDatabase({ feature = { is_enabled: 1, access_mode: "free", usage_limit: null, lifecycle_status: "active" }, grant = null, subscription = null, usedCount = 0, accounts = [{ principal_id: "principal-1", principal_status: "active", account_id: "account-a", account_status: "active" }] } = {}) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() {
          if (sql.includes("FROM account_identities")) return { results: accounts };
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM product_features")) return feature;
          if (sql.includes("FROM account_feature_grants")) return grant;
          if (sql.includes("FROM subscriptions")) return subscription;
          if (sql.includes("FROM feature_usage")) return usedCount ? { used_count: usedCount } : null;
          return null;
        }
      };
    }
  };
}

const entitlementRequest = (accountId = null) => new Request("https://central.test/v1/access/steel/dxf-export", {
  headers: accountId ? { "X-Sahroud-Account-Id": accountId } : {}
});
const testIdentity = { subject: "firebase-user-1" };

test("free enabled feature is available to a single active account", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), { CORE_DB: entitlementDatabase() }, testIdentity, "steel", "dxf-export");
  assert.equal(access.source, "free");
  assert.equal(access.account.account_id, "account-a");
  assert.equal(access.usedCount, 0);
});

test("disabled feature is denied even if its access mode is free", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), {
    CORE_DB: entitlementDatabase({ feature: { is_enabled: 0, access_mode: "free", usage_limit: null, lifecycle_status: "active" } })
  }, testIdentity, "steel", "dxf-export");
  assert.equal(access.response.status, 403);
  assert.equal((await access.response.json()).reason, "feature_disabled");
});

test("paid feature without a grant or subscription is denied", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), {
    CORE_DB: entitlementDatabase({ feature: { is_enabled: 1, access_mode: "paid", usage_limit: null, lifecycle_status: "active" } })
  }, testIdentity, "steel", "dxf-export");
  assert.equal(access.response.status, 403);
  assert.equal((await access.response.json()).reason, "purchase_or_subscription_required");
});

test("paid feature accepts an active feature grant and its usage limit", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), {
    CORE_DB: entitlementDatabase({
      feature: { is_enabled: 1, access_mode: "paid", usage_limit: 20, lifecycle_status: "active" },
      grant: { id: "grant-1", usage_limit: 3 },
      usedCount: 1
    })
  }, testIdentity, "steel", "dxf-export");
  assert.equal(access.source, "grant");
  assert.equal(access.limit, 3);
  assert.equal(access.usedCount, 1);
});

test("paid feature accepts an active plan subscription", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), {
    CORE_DB: entitlementDatabase({
      feature: { is_enabled: 1, access_mode: "paid", usage_limit: null, lifecycle_status: "active" },
      subscription: { id: "subscription-1" }
    })
  }, testIdentity, "steel", "dxf-export");
  assert.equal(access.source, "subscription");
  assert.equal(access.sourceId, "subscription-1");
});

test("usage limit blocks access when lifetime usage is exhausted", async () => {
  const access = await resolveFeatureAccess(entitlementRequest(), {
    CORE_DB: entitlementDatabase({
      feature: { is_enabled: 1, access_mode: "free", usage_limit: 2, lifecycle_status: "active" },
      usedCount: 2
    })
  }, testIdentity, "steel", "dxf-export");
  assert.equal(access.response.status, 403);
  assert.equal((await access.response.json()).reason, "usage_limit_reached");
});

test("multiple active accounts require an explicit account selection", async () => {
  await assert.rejects(
    resolveFeatureAccess(entitlementRequest(), {
      CORE_DB: entitlementDatabase({
        accounts: [
          { principal_id: "principal-1", principal_status: "active", account_id: "account-a", account_status: "active" },
          { principal_id: "principal-1", principal_status: "active", account_id: "account-b", account_status: "active" }
        ]
      })
    }, testIdentity, "steel", "dxf-export"),
    error => error.message === "account_selection_required" && error.status === 409
  );
});

test("selected account must belong to the authenticated identity", async () => {
  await assert.rejects(
    resolveFeatureAccess(entitlementRequest("account-other"), {
      CORE_DB: entitlementDatabase()
    }, testIdentity, "steel", "dxf-export"),
    error => error.message === "account_membership_required" && error.status === 403
  );
});


test("usage counter rejects a zero limit before inserting the first use", async () => {
  let insertSql = "";
  let insertBindings = [];
  const db = {
    prepare(sql) {
      if (sql.startsWith("INSERT INTO feature_usage")) {
        insertSql = sql;
        return {
          bind(...args) { insertBindings = args; return { first: async () => null }; },
          async first() { return null; }
        };
      }
      return {
        bind() { return this; },
        async first() { return null; }
      };
    }
  };
  const result = await incrementFeatureUsage(
    { CORE_DB: db },
    { account: { account_id: "account-a" }, limit: 0, usedCount: 0 },
    "steel",
    "dxf-export",
    "2026-11-24T00:00:00.000Z"
  );
  assert.equal(result.consumed, false);
  assert.equal(result.usedCount, 0);
  assert.match(insertSql, /INSERT INTO feature_usage .* SELECT /);
  assert.match(insertSql, /WHERE \(\? IS NULL OR \? > 0\)/);
  assert.match(insertSql, /feature_usage\.used_count < \?/);
  assert.equal(insertBindings[5], 0);
  assert.equal(insertBindings[7], 0);
});

test("usage counter uses a conditional atomic increment for finite limits", async () => {
  let insertSql = "";
  const db = {
    prepare(sql) {
      if (sql.startsWith("INSERT INTO feature_usage")) {
        insertSql = sql;
        return {
          bind() { return { first: async () => ({ used_count: 1 }) }; },
          async first() { return { used_count: 1 }; }
        };
      }
      return {
        bind() { return this; },
        async first() { return { used_count: 1 }; }
      };
    }
  };
  const result = await incrementFeatureUsage(
    { CORE_DB: db },
    { account: { account_id: "account-a" }, limit: 1, usedCount: 0 },
    "steel",
    "dxf-export",
    "2026-11-24T00:00:00.000Z"
  );
  assert.equal(result.consumed, true);
  assert.equal(result.usedCount, 1);
  assert.match(insertSql, /ON CONFLICT\(account_id,product_key,feature_key\) DO UPDATE/);
  assert.match(insertSql, /WHERE \(\? IS NULL OR feature_usage\.used_count < \?\)/);
});


function expiryDatabase({ feature = { is_enabled: 1, access_mode: "paid", usage_limit: null, lifecycle_status: "active" } } = {}) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind(...args) { queries.push({ sql, args }); return this; },
        async all() {
          if (sql.includes("FROM account_identities")) return { results: [{ principal_id: "principal-1", principal_status: "active", account_id: "account-a", account_status: "active" }] };
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM product_features")) return feature;
          if (sql.includes("FROM account_feature_grants")) return null;
          if (sql.includes("FROM subscriptions")) return null;
          if (sql.includes("FROM feature_usage")) return null;
          return null;
        }
      };
    }
  };
}

test("grant lookup enforces start and end timestamps using the same current instant", async () => {
  const db = expiryDatabase();
  const access = await resolveFeatureAccess(entitlementRequest(), { CORE_DB: db }, testIdentity, "steel", "dxf-export");
  assert.equal(access.response.status, 403);
  const grantQuery = db.queries.find(q => q.sql.includes("FROM account_feature_grants"));
  assert.match(grantQuery.sql, /starts_at IS NULL OR starts_at<=\?/);
  assert.match(grantQuery.sql, /ends_at IS NULL OR ends_at>\?/);
  assert.equal(grantQuery.args[3], grantQuery.args[4]);
  assert.match(db.queries.find(q => q.sql.includes("FROM subscriptions")).sql, /starts_at IS NULL OR s.starts_at<=\?/);
});

test("subscription lookup enforces start, end, and active plan status", async () => {
  const db = expiryDatabase();
  await resolveFeatureAccess(entitlementRequest(), { CORE_DB: db }, testIdentity, "steel", "dxf-export");
  const sub = db.queries.find(q => q.sql.includes("FROM subscriptions"));
  assert.match(sub.sql, /s.status='active'/);
  assert.match(sub.sql, /p.is_active=1/);
  assert.match(sub.sql, /s.starts_at IS NULL OR s.starts_at<=\?/);
  assert.match(sub.sql, /s.ends_at IS NULL OR s.ends_at>\?/);
  assert.equal(sub.args[3], sub.args[4]);
});

test("grant lookup ignores grants whose status is not active", async () => {
  const db = expiryDatabase();
  await resolveFeatureAccess(entitlementRequest(), { CORE_DB: db }, testIdentity, "steel", "dxf-export");
  const grant = db.queries.find(q => q.sql.includes("FROM account_feature_grants"));
  assert.match(grant.sql, /status='active'/);
});

test("subscription lookup requires a matching plan feature mapping", async () => {
  const db = expiryDatabase();
  await resolveFeatureAccess(entitlementRequest(), { CORE_DB: db }, testIdentity, "steel", "dxf-export");
  const sub = db.queries.find(q => q.sql.includes("FROM subscriptions"));
  assert.match(sub.sql, /JOIN plan_features pf/);
  assert.match(sub.sql, /pf.feature_key=\?/);
});


test("concurrent consume attempts never exceed a finite usage limit (atomic D1 mock)", async () => {
  let usedCount = 0;
  const limit = 5;
  const db = {
    prepare(sql) {
      assert.match(sql, /ON CONFLICT/);
      assert.match(sql, /RETURNING used_count/);
      return {
        bind(...args) {
          return {
            async first() {
              // Model the atomic conditional UPSERT as one indivisible operation.
              if (args[5] !== null && args[5] <= 0) return null;
              if (args[7] !== null && usedCount >= args[7]) return null;
              usedCount += 1;
              return { used_count: usedCount };
            }
          };
        }
      };
    }
  };
  const access = { account: { account_id: "account-a" }, limit, usedCount: 0 };
  const attempts = await Promise.all(Array.from({ length: 40 }, () =>
    incrementFeatureUsage({ CORE_DB: db }, access, "steel", "dxf-export", "2026-11-24T00:00:00.000Z")
  ));
  assert.equal(attempts.filter(x => x.consumed).length, limit);
  assert.equal(attempts.filter(x => !x.consumed).length, 40 - limit);
  assert.equal(usedCount, limit);
  assert.deepEqual(attempts.filter(x => x.consumed).map(x => x.usedCount).sort((a,b) => a-b), [1,2,3,4,5]);
});


test("admin account and grant management routes require Firebase authentication", async () => {
  const cases = [
    ["/v1/admin/accounts", "GET"],
    ["/v1/admin/accounts/account-a/grants", "GET"],
    ["/v1/admin/accounts/account-a/grants", "POST"],
    ["/v1/admin/products/steel/plans", "GET"],
    ["/v1/admin/products/steel/plans/pro", "PATCH"],
    ["/v1/admin/accounts/account-a/subscriptions", "GET"],
    ["/v1/admin/accounts/account-a/subscriptions", "POST"],
    ["/v1/admin/subscriptions/sub-1", "PATCH"],
    ["/v1/admin/grants/grant-1", "PATCH"]
  ];
  for (const [path, method] of cases) {
    await assert.rejects(
      handle(request(path, { method }), { FIREBASE_PROJECT_ID: "sahroud-central-test" }),
      /authentication_required/,
      path + " " + method
    );
  }
});

test("CORS preflight advertises PATCH for grant administration", async () => {
  const response = await handle(request("/v1/admin/grants/grant-1", {
    method: "OPTIONS",
    headers: { Origin: "https://sahroud.github.io" }
  }), { CORS_ALLOWED_ORIGINS: "https://sahroud.github.io" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, PATCH, OPTIONS");
});


test("admin plan creation route requires Firebase authentication", async () => {
  await assert.rejects(
    handle(request("/v1/admin/products/steel/plans", { method: "POST", body: JSON.stringify({ plan_code: "pro", display_name: "Pro", feature_keys: ["dxf-export"] }) }), { FIREBASE_PROJECT_ID: "sahroud-central-test" }),
    /authentication_required/
  );
});

test("runtime policy admin endpoints require Firebase authentication", async () => {
  const env = { CORE_DB: {} };
  const product = await handle(request("/v1/admin/products/steel/runtime-policy"), env);
  assert.equal(product.status, 401);
  assert.equal((await product.json()).error, "authentication_required");

  const account = await handle(request("/v1/admin/accounts/account-1/products/steel/runtime-policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      max_devices_per_account: 2,
      max_sessions_per_account: 2,
      max_concurrent_operations: 4,
      max_queued_operations: 10
    })
  }), env);
  assert.equal(account.status, 401);
  assert.equal((await account.json()).error, "authentication_required");
});

