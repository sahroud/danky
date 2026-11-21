import test from "node:test";
import assert from "node:assert/strict";
import worker, { API_VERSION, PRODUCTS } from "../src/index.js";

const request = (path, options = {}) =>
  new Request(`https://central.example${path}`, options);

test("health endpoint reports service status", async () => {
  const response = await worker.fetch(request("/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.version, API_VERSION);
});

test("version endpoint is available", async () => {
  const response = await worker.fetch(request("/v1/version"), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).api_version, API_VERSION);
});

test("catalog lists known SAHROUD products without secrets", async () => {
  const response = await worker.fetch(request("/v1/catalog/products"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, PRODUCTS.length);
  assert.ok(body.products.some(product => product.id === "family-guard"));
  assert.ok(body.products.some(product => product.id === "steel"));
  assert.ok(body.products.every(product => product.status === "development"));
});

test("unknown routes return 404", async () => {
  const response = await worker.fetch(request("/unknown"), {});
  assert.equal(response.status, 404);
});

test("non-GET methods are rejected", async () => {
  const response = await worker.fetch(request("/health", { method: "POST" }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, OPTIONS");
});

test("unlisted browser origins are rejected", async () => {
  const response = await worker.fetch(request("/health", {
    headers: { Origin: "https://untrusted.example" }
  }), { CORS_ALLOWED_ORIGINS: "https://app.sahroud.example" });
  assert.equal(response.status, 403);
});

test("listed browser origins receive exact CORS permission", async () => {
  const response = await worker.fetch(request("/health", {
    headers: { Origin: "https://app.sahroud.example" }
  }), { CORS_ALLOWED_ORIGINS: "https://app.sahroud.example" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.sahroud.example");
});
