import test from "node:test";
import assert from "node:assert/strict";
import { handle, resolveCentralIdentity } from "../src/index.js";

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
