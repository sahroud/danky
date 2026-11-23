import test from "node:test";
import assert from "node:assert/strict";
import {
  SahroudCentralClient,
  SahroudCentralError,
  createSahroudCentralClient
} from "../client/sahroud-central.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("client requires an absolute HTTPS API URL", () => {
  assert.throws(() => new SahroudCentralClient({ apiBase: "" }), /apiBase_required/);
  assert.throws(() => new SahroudCentralClient({ apiBase: "/api" }), /absolute_url/);
  assert.throws(() => new SahroudCentralClient({ apiBase: "http://api.example.com" }), /https/);
  assert.throws(() => new SahroudCentralClient({ apiBase: "https://user:pass@example.com" }), /credentials/);
  assert.throws(() => new SahroudCentralClient({ apiBase: "https://example.com?token=x" }), /credentials/);
});

test("client permits HTTP only for local development", () => {
  const client = new SahroudCentralClient({
    apiBase: "http://localhost:8787/"
  });
  assert.equal(client.apiBase, "http://localhost:8787");
});

test("health uses a no-store anonymous GET request", async () => {
  let observed;
  const client = createSahroudCentralClient({
    apiBase: "https://central.example/",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({ status: "ok" });
    }
  });

  const result = await client.health();
  assert.equal(result.status, "ok");
  assert.equal(observed.url, "https://central.example/health");
  assert.equal(observed.options.method, "GET");
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.credentials, "omit");
  assert.equal(observed.options.headers.Accept, "application/json");
  assert.equal("authorization" in observed.options.headers, false);
});

test("version and product catalog use versioned read-only endpoints", async () => {
  const urls = [];
  const client = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async url => {
      urls.push(url);
      return jsonResponse({ api_version: "0.2.0", products: [] });
    }
  });

  await client.version();
  await client.products();
  assert.deepEqual(urls, [
    "https://central.example/v1/version",
    "https://central.example/v1/catalog/products"
  ]);
});

test("product detail accepts only a stable safe product key", async () => {
  let requestedUrl = "";
  const client = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async url => {
      requestedUrl = url;
      return jsonResponse({ product: { id: "family-guard" } });
    }
  });

  const result = await client.product("family-guard");
  assert.equal(result.product.id, "family-guard");
  assert.equal(requestedUrl, "https://central.example/v1/catalog/products/family-guard");
  await assert.rejects(
    async () => client.product("../other"),
    /invalid_product_key/
  );
});

test("HTTP errors expose only the API error code and status", async () => {
  const client = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async () => jsonResponse({ error: "not_found", internal: "do not expose" }, 404)
  });

  await assert.rejects(client.products(), error => {
    assert.ok(error instanceof SahroudCentralError);
    assert.equal(error.code, "not_found");
    assert.equal(error.status, 404);
    assert.equal(error.message, "not_found");
    assert.equal(error.message.includes("do not expose"), false);
    return true;
  });
});

test("invalid JSON and network failures are normalized", async () => {
  const badJsonClient = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async () => new Response("not-json", { status: 200 })
  });
  await assert.rejects(badJsonClient.health(), error =>
    error instanceof SahroudCentralError && error.code === "invalid_json_response"
  );

  const offlineClient = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async () => { throw new Error("private network detail"); }
  });
  await assert.rejects(offlineClient.health(), error =>
    error instanceof SahroudCentralError &&
    error.code === "network_error" &&
    !error.message.includes("private network detail")
  );
});

test("client sends Firebase ID token only in Authorization header", async () => {
  let observed;
  const client = new SahroudCentralClient({
    apiBase: "https://central.example",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({ authenticated: true, principal_id: "p1" });
    }
  });
  const result = await client.authenticate("header.payload.signature");
  assert.equal(result.authenticated, true);
  assert.equal(observed.url, "https://central.example/v1/auth/session");
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.headers.Authorization, "Bearer header.payload.signature");
  assert.equal(observed.options.credentials, "omit");
  assert.equal(observed.options.cache, "no-store");
  assert.equal("body" in observed.options, false);
});

test("client rejects empty identity tokens before network access", async () => {
  const client = new SahroudCentralClient({ apiBase: "https://central.example" });
  assert.throws(() => client.authenticate(""), /identity_token_required/);
});
