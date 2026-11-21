const API_VERSION = "0.1.0";

const PRODUCTS = Object.freeze([
  { id: "family-guard", name: "SAHROUD FAMILY GUARD", category: "safety", status: "development" },
  { id: "steel", name: "SAHROUD STEEL", category: "engineering", status: "development" },
  { id: "metreh", name: "SAHROUD METREH", category: "construction", status: "development" },
  { id: "utm", name: "SAHROUD UTM", category: "surveying", status: "development" },
  { id: "tasbih", name: "SAHROUD TASBIH", category: "utility", status: "development" },
  { id: "games", name: "SAHROUD GAMES", category: "games", status: "development" }
]);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
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

async function handle(request, env = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const hasOrigin = Boolean(origin);
  const originAllowed = !hasOrigin || allowed.includes(origin);

  if (!originAllowed) {
    return json({ error: "origin_not_allowed" }, 403);
  }

  if (request.method === "OPTIONS") {
    if (!origin || !allowed.includes(origin)) {
      return json({ error: "cors_origin_not_allowed" }, 403);
    }
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  let response;
  if (request.method !== "GET") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
  } else if (url.pathname === "/health") {
    response = json({ service: "SAHROUD CENTRAL API", status: "ok", version: API_VERSION });
  } else if (url.pathname === "/v1/version") {
    response = json({ api_version: API_VERSION, service: "sahroud-central-api" });
  } else if (url.pathname === "/v1/catalog/products") {
    response = json({ products: PRODUCTS, count: PRODUCTS.length });
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

export { handle, PRODUCTS, API_VERSION };
