import test from "node:test";
import assert from "node:assert/strict";
import worker, { API_VERSION } from "../src/index.js";

const request = (path, options = {}) =>
  new Request("https://central.example" + path, options);

function mockDatabase(products = []) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          if (sql.includes("SELECT 1 AS ok")) return { ok: 1 };
          if (sql.includes("FROM products")) {
            return products.find(row => row.product_key === values[0]) || null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM products")) return { results: products };
          return { results: [] };
        }
      };
    }
  };
}

const productRows = [
  { product_key: "family-guard", display_name: "SAHROUD FAMILY GUARD", category: "safety", lifecycle_status: "development" },
  { product_key: "steel", display_name: "SAHROUD STEEL", category: "engineering", lifecycle_status: "development" }
];

test("health reports a healthy core database", async () => {
  const response = await worker.fetch(request("/health"), { CORE_DB: mockDatabase() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.dependencies.core_db, "ok");
  assert.equal(body.version, API_VERSION);
});

test("health clearly reports a missing database binding", async () => {
  const response = await worker.fetch(request("/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.dependencies.core_db, "not_configured");
});

test("version endpoint does not require database access", async () => {
  const response = await worker.fetch(request("/v1/version"), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).api_version, API_VERSION);
});

test("catalog reads the central product registry from D1", async () => {
  const response = await worker.fetch(request("/v1/catalog/products"), {
    CORE_DB: mockDatabase(productRows)
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.equal(body.products[0].id, "family-guard");
  assert.equal(body.products[1].id, "steel");
  assert.equal(body.products[0].category, "safety");
});

test("catalog refuses to pretend it is live when D1 is not configured", async () => {
  const response = await worker.fetch(request("/v1/catalog/products"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "core_database_not_configured");
});

test("product detail returns a registered product only", async () => {
  const response = await worker.fetch(request("/v1/catalog/products/steel"), {
    CORE_DB: mockDatabase(productRows)
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product.id, "steel");
});

test("invalid product keys are rejected", async () => {
  const response = await worker.fetch(request("/v1/catalog/products/Bad%20Key"), {
    CORE_DB: mockDatabase(productRows)
  });
  assert.equal(response.status, 400);
});

test("unknown products return 404", async () => {
  const response = await worker.fetch(request("/v1/catalog/products/unknown"), {
    CORE_DB: mockDatabase(productRows)
  });
  assert.equal(response.status, 404);
});

test("unknown routes return 404", async () => {
  const response = await worker.fetch(request("/unknown"), {});
  assert.equal(response.status, 404);
});

test("write methods are disabled until authentication and authorization are designed", async () => {
  const response = await worker.fetch(request("/v1/catalog/products", { method: "POST" }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, OPTIONS");
});

test("unlisted browser origins are rejected", async () => {
  const response = await worker.fetch(request("/health", {
    headers: { Origin: "https://untrusted.example" }
  }), {
    CORE_DB: mockDatabase(),
    CORS_ALLOWED_ORIGINS: "https://app.sahroud.example"
  });
  assert.equal(response.status, 403);
});

test("listed browser origins receive exact CORS permission", async () => {
  const response = await worker.fetch(request("/health", {
    headers: { Origin: "https://app.sahroud.example" }
  }), {
    CORE_DB: mockDatabase(),
    CORS_ALLOWED_ORIGINS: "https://app.sahroud.example"
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.sahroud.example");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("CORS preflight accepts only an explicitly allowed origin", async () => {
  const response = await worker.fetch(request("/v1/catalog/products", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.sahroud.example",
      "Access-Control-Request-Method": "GET"
    }
  }), {
    CORS_ALLOWED_ORIGINS: "https://app.sahroud.example"
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.sahroud.example");
});

test("native requests without an Origin header remain supported", async () => {
  const response = await worker.fetch(request("/v1/version"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("auth session is disabled until Firebase project is configured", async () => {
  const response = await worker.fetch(request("/v1/auth/session", { method: "POST" }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "auth_not_configured");
});

test("auth session requires a bearer identity token", async () => {
  const response = await worker.fetch(request("/v1/auth/session", { method: "POST" }), {
    FIREBASE_PROJECT_ID: "sahroud-central-test"
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "authentication_required");
});

test("current user endpoint requires a bearer identity token", async () => {
  const response = await worker.fetch(request("/v1/me"), {
    FIREBASE_PROJECT_ID: "sahroud-central-test",
    CORE_DB: mockDatabase()
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "authentication_required");
});

test("CORS advertises POST for Firebase authentication", async () => {
  const response = await worker.fetch(request("/v1/auth/session", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.sahroud.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization"
    }
  }), { CORS_ALLOWED_ORIGINS: "https://app.sahroud.example" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, PATCH, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type, Authorization, X-Sahroud-Account-Id");
});
