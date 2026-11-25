import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { handleDeviceSession } from "../src/device-session.js";

const identity = { subject: "firebase-device-session-test" };
const accountId = "device-session-account";
const productKey = "steel";
const request = (path, body, headers = {}) => new Request("https://central.test" + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const call = (req, resource, action) => handleDeviceSession(req, { CORE_DB: env.CORE_DB }, identity, productKey, resource, action);
const deviceId = i => "install-" + String(i).padStart(4, "0");
describe("D1 device and session lifecycle concurrency", () => {
  beforeAll(async () => {
    const statements = [
      "DROP TABLE IF EXISTS account_product_sessions",
      "DROP TABLE IF EXISTS account_product_devices",
      "DROP TABLE IF EXISTS account_product_policy_overrides",
      "DROP TABLE IF EXISTS product_runtime_policies",
      "DROP TABLE IF EXISTS account_identities",
      "DROP TABLE IF EXISTS account_memberships",
      "DROP TABLE IF EXISTS principals",
      "DROP TABLE IF EXISTS accounts",
      "DROP TABLE IF EXISTS products",
      "CREATE TABLE products (product_key TEXT PRIMARY KEY, lifecycle_status TEXT NOT NULL)",
      "CREATE TABLE accounts (id TEXT PRIMARY KEY, status TEXT NOT NULL)",
      "CREATE TABLE principals (id TEXT PRIMARY KEY, status TEXT NOT NULL)",
      "CREATE TABLE account_memberships (account_id TEXT NOT NULL, principal_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_id, principal_id))",
      "CREATE TABLE account_identities (provider TEXT NOT NULL, provider_subject TEXT NOT NULL, principal_id TEXT NOT NULL)",
      "CREATE TABLE product_runtime_policies (product_key TEXT PRIMARY KEY, max_devices_per_account INTEGER, max_sessions_per_account INTEGER, session_lease_seconds INTEGER)",
      "CREATE TABLE account_product_policy_overrides (account_id TEXT NOT NULL, product_key TEXT NOT NULL, max_devices_per_account INTEGER, max_sessions_per_account INTEGER, PRIMARY KEY(account_id, product_key))",
      "CREATE TABLE account_product_devices (account_id TEXT NOT NULL, product_key TEXT NOT NULL, device_id TEXT NOT NULL, device_label TEXT, platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id, product_key, device_id))",
      "CREATE TABLE account_product_sessions (session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, product_key TEXT NOT NULL, principal_id TEXT NOT NULL, device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active', issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "INSERT INTO products VALUES ('steel', 'development')",
      "INSERT INTO accounts VALUES ('device-session-account', 'active')",
      "INSERT INTO principals VALUES ('device-session-principal', 'active')",
      "INSERT INTO account_memberships VALUES ('device-session-account', 'device-session-principal', 'active', '2026-11-25T00:00:00.000Z')",
      "INSERT INTO account_identities VALUES ('firebase', 'firebase-device-session-test', 'device-session-principal')",
      "INSERT INTO product_runtime_policies VALUES ('steel', 2, 3, 300)"
    ];
    for (const sql of statements) await env.CORE_DB.prepare(sql).run();
  });

  afterAll(async () => {
    for (const table of [
      "account_product_sessions", "account_product_devices", "account_product_policy_overrides",
      "product_runtime_policies", "account_identities", "account_memberships", "principals",
      "accounts", "products"
    ]) await env.CORE_DB.prepare("DROP TABLE IF EXISTS " + table).run();
  });

  it("never exceeds the device cap under concurrent registration and remains idempotent at cap", async () => {
    const results = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const response = await call(request("/v1/devices/steel/register", {
        device_id: deviceId(i), platform: "android"
      }), "devices", "register");
      return { status: response.status, body: await response.json() };
    }));
    expect(results.filter(x => x.status === 200)).toHaveLength(2);
    expect(results.filter(x => x.status === 409)).toHaveLength(22);
    const count = await env.CORE_DB.prepare(
      "SELECT COUNT(*) AS n FROM account_product_devices WHERE account_id=? AND product_key=? AND status='active'"
    ).bind(accountId, productKey).first();
    expect(count.n).toBe(2);

    const existingId = results.find(x => x.status === 200).body.device_id;
    const repeat = await call(request("/v1/devices/steel/register", {
      device_id: existingId, platform: "android", device_label: "Updated"
    }), "devices", "register");
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).registered).toBe(true);
  });

  it("never exceeds the session cap under concurrent opens and stores only token hashes", async () => {
    // Raise device cap for this independent session-cap test and register five installations.
    await env.CORE_DB.prepare("UPDATE product_runtime_policies SET max_devices_per_account=10 WHERE product_key='steel'").run();
    for (let i = 0; i < 5; i++) {
      const response = await call(request("/v1/devices/steel/register", {
        device_id: deviceId(100 + i), platform: "android"
      }), "devices", "register");
      expect(response.status).toBe(200);
    }
    const results = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const response = await call(request("/v1/sessions/steel/open", {
        device_id: deviceId(100 + (i % 5))
      }), "sessions", "open");
      return { status: response.status, body: await response.json() };
    }));
    const accepted = results.filter(x => x.status === 200);
    expect(accepted).toHaveLength(3);
    expect(results.filter(x => x.status === 409)).toHaveLength(21);
    const rows = await env.CORE_DB.prepare(
      "SELECT token_hash,status FROM account_product_sessions WHERE account_id=? AND product_key=?"
    ).bind(accountId, productKey).all();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.every(row => /^[a-f0-9]{64}$/.test(row.token_hash))).toBe(true);
    for (const item of accepted) {
      expect(item.body.session_token).toMatch(/^[a-f0-9]{64}$/);
      expect(rows.results.some(row => row.token_hash === item.body.session_token)).toBe(false);
    }
  });

  it("device revocation invalidates all sessions belonging to that installation", async () => {
    const active = await env.CORE_DB.prepare(
      "SELECT session_id,device_id FROM account_product_sessions WHERE account_id=? AND product_key=? AND status='active' LIMIT 1"
    ).bind(accountId, productKey).first();
    expect(active).toBeTruthy();
    const response = await call(request("/v1/devices/steel/revoke", { device_id: active.device_id }), "devices", "revoke");
    expect(response.status).toBe(200);
    const device = await env.CORE_DB.prepare(
      "SELECT status FROM account_product_devices WHERE account_id=? AND product_key=? AND device_id=?"
    ).bind(accountId, productKey, active.device_id).first();
    const session = await env.CORE_DB.prepare(
      "SELECT status FROM account_product_sessions WHERE session_id=?"
    ).bind(active.session_id).first();
    expect(device.status).toBe("revoked");
    expect(session.status).toBe("revoked");
  });
});
