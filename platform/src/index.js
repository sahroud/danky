const API_VERSION = "0.2.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...headers
    }
  });

function allowedOrigins(env) {
  return String(env?.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "600",
    "vary": "Origin"
  };
}

function withHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function databaseHealth(env) {
  if (!env?.CORE_DB) return "not_configured";
  try {
    const result = await env.CORE_DB.prepare("SELECT 1 AS ok").first();
    return result?.ok === 1 ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function listProducts(env) {
  if (!env?.CORE_DB) {
    return json({ error: "core_database_not_configured" }, 503);
  }

  try {
    const result = await env.CORE_DB.prepare(
      "SELECT product_key, display_name, category, lifecycle_status FROM products WHERE lifecycle_status <> 'retired' ORDER BY display_name"
    ).all();

    const products = (result?.results || []).map(row => ({
      id: row.product_key,
      name: row.display_name,
      category: row.category,
      status: row.lifecycle_status
    }));

    return json({ products, count: products.length, api_version: API_VERSION });
  } catch {
    return json({ error: "catalog_unavailable" }, 503);
  }
}

async function getProduct(env, productKey) {
  if (!/^[a-z0-9-]{2,64}$/.test(productKey)) {
    return json({ error: "invalid_product_key" }, 400);
  }
  if (!env?.CORE_DB) {
    return json({ error: "core_database_not_configured" }, 503);
  }

  try {
    const row = await env.CORE_DB.prepare(
      "SELECT product_key, display_name, category, lifecycle_status FROM products WHERE product_key = ? AND lifecycle_status <> 'retired'"
    ).bind(productKey).first();

    if (!row) return json({ error: "product_not_found" }, 404);
    return json({
      product: {
        id: row.product_key,
        name: row.display_name,
        category: row.category,
        status: row.lifecycle_status
      },
      api_version: API_VERSION
    });
  } catch {
    return json({ error: "catalog_unavailable" }, 503);
  }
}

async function handle(request, env = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const origins = allowedOrigins(env);

  if (origin && !origins.includes(origin)) {
    return json({ error: "origin_not_allowed" }, 403, { vary: "Origin" });
  }

  if (request.method === "OPTIONS") {
    if (!origin) return json({ error: "cors_origin_required" }, 400);
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env)
    });
  }

  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
  }

  let response;
  if (url.pathname === "/health") {
    const coreDb = await databaseHealth(env);
    response = json({
      service: "SAHROUD CENTRAL API",
      status: coreDb === "ok" ? "ok" : "degraded",
      version: API_VERSION,
      dependencies: { core_db: coreDb }
    });
  } else if (url.pathname === "/v1/version") {
    response = json({
      api_version: API_VERSION,
      service: "sahroud-central-api"
    });
  } else if (url.pathname === "/v1/catalog/products") {
    response = await listProducts(env);
  } else if (url.pathname.startsWith("/v1/catalog/products/")) {
    const productKey = url.pathname.slice("/v1/catalog/products/".length);
    response = await getProduct(env, productKey);
  } else {
    response = json({ error: "not_found" }, 404);
  }

  return withHeaders(response, corsHeaders(request, env));
}

export default {
  fetch(request, env) {
    return handle(request, env).catch(() =>
      json({ error: "internal_server_error" }, 500)
    );
  }
};

export { handle, API_VERSION, databaseHealth };
