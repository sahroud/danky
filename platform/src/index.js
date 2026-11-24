import { importX509, jwtVerify } from "jose";

const API_VERSION = "0.3.0";
const FIREBASE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const ALLOWED_FIREBASE_PROVIDERS = new Set(["google.com", "phone"]);
let firebaseCertCache = { keys: null, expiresAt: 0 };

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match || match[1].length > 8192) return null;
  return match[1];
}

async function firebaseCertificates() {
  if (firebaseCertCache.keys && firebaseCertCache.expiresAt > Date.now()) {
    return firebaseCertCache.keys;
  }

  const response = await fetch(FIREBASE_CERTS_URL, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!response.ok) throw new Error("firebase_certificates_unavailable");

  const keys = await response.json();
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("firebase_certificates_invalid");
  }

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(/max-age=(\d+)/i.exec(cacheControl)?.[1] || 300);
  firebaseCertCache = {
    keys,
    expiresAt: Date.now() + Math.max(60, Math.min(maxAge, 3600)) * 1000
  };
  return keys;
}

async function verifyFirebaseIdToken(token, env) {
  const projectId = String(env?.FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) throw Object.assign(new Error("auth_not_configured"), { status: 503 });
  if (!token) throw Object.assign(new Error("authentication_required"), { status: 401 });

  let protectedHeader;
  try {
    const firstPart = token.split(".")[0];
    protectedHeader = JSON.parse(atob(firstPart.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw Object.assign(new Error("invalid_identity_token"), { status: 401 });
  }
  if (protectedHeader?.alg !== "RS256" || typeof protectedHeader.kid !== "string") {
    throw Object.assign(new Error("invalid_identity_token"), { status: 401 });
  }

  let certs;
  try {
    certs = await firebaseCertificates();
  } catch {
    throw Object.assign(new Error("identity_provider_unavailable"), { status: 503 });
  }
  const certificate = certs[protectedHeader.kid];
  if (typeof certificate !== "string") {
    firebaseCertCache.expiresAt = 0;
    throw Object.assign(new Error("identity_key_not_found"), { status: 401 });
  }

  let payload;
  try {
    const publicKey = await importX509(certificate, "RS256");
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      clockTolerance: 5
    });
    payload = verified.payload;
  } catch {
    throw Object.assign(new Error("invalid_identity_token"), { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 128 ||
    typeof payload.iat !== "number" ||
    payload.iat > now + 60 ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > now + 60 ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    throw Object.assign(new Error("invalid_identity_claims"), { status: 401 });
  }

  const signInProvider = payload.firebase?.sign_in_provider;
  if (!ALLOWED_FIREBASE_PROVIDERS.has(signInProvider)) {
    throw Object.assign(new Error("sign_in_provider_not_allowed"), { status: 403 });
  }
  if (signInProvider === "google.com" && payload.email_verified !== true) {
    throw Object.assign(new Error("verified_google_email_required"), { status: 403 });
  }
  if (signInProvider === "phone" && (
    typeof payload.phone_number !== "string" ||
    !/^\+[1-9]\d{7,14}$/.test(payload.phone_number)
  )) {
    throw Object.assign(new Error("verified_phone_number_required"), { status: 403 });
  }

  return {
    subject: payload.sub,
    provider: signInProvider,
    emailVerified: payload.email_verified === true
  };
}

async function resolveCentralIdentity(env, identity) {
  if (!env?.CORE_DB) throw Object.assign(new Error("core_database_not_configured"), { status: 503 });

  const existing = await env.CORE_DB.prepare(
    "SELECT ai.principal_id, am.account_id FROM account_identities ai JOIN account_memberships am ON am.principal_id = ai.principal_id AND am.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? ORDER BY am.created_at LIMIT 1"
  ).bind(identity.subject).first();

  if (existing) return { principalId: existing.principal_id, accountId: existing.account_id };

  const principalId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      "INSERT OR IGNORE INTO principals (id, status, created_at, updated_at) SELECT ?, 'active', ?, ? WHERE NOT EXISTS (SELECT 1 FROM account_identities WHERE provider = 'firebase' AND provider_subject = ?)"
    ).bind(principalId, now, now, identity.subject),
    env.CORE_DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, account_type, display_name, status, created_at, updated_at) SELECT ?, 'personal', 'SAHROUD User', 'active', ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)"
    ).bind(accountId, now, now, principalId),
    env.CORE_DB.prepare(
      "INSERT OR IGNORE INTO account_memberships (account_id, principal_id, role, status, created_at, updated_at) SELECT ?, ?, 'owner', 'active', ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)"
    ).bind(accountId, principalId, now, now, principalId),
    env.CORE_DB.prepare(
      "INSERT OR IGNORE INTO account_identities (id, principal_id, provider, provider_subject, verified_at, created_at) SELECT ?, ?, 'firebase', ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)"
    ).bind(identityId, principalId, identity.subject, now, now, principalId)
  ]);

  const resolved = await env.CORE_DB.prepare(
    "SELECT ai.principal_id, am.account_id FROM account_identities ai JOIN account_memberships am ON am.principal_id = ai.principal_id AND am.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? ORDER BY am.created_at LIMIT 1"
  ).bind(identity.subject).first();

  if (!resolved) throw Object.assign(new Error("account_provisioning_failed"), { status: 503 });
  return { principalId: resolved.principal_id, accountId: resolved.account_id };
}

async function authenticate(request, env) {
  const token = bearerToken(request);
  const identity = await verifyFirebaseIdToken(token, env);
  const central = await resolveCentralIdentity(env, identity);
  return json({
    authenticated: true,
    principal_id: central.principalId,
    account_id: central.accountId,
    sign_in_provider: identity.provider,
    api_version: API_VERSION
  });
}

async function currentUser(request, env) {
  const token = bearerToken(request);
  const identity = await verifyFirebaseIdToken(token, env);
  if (!env?.CORE_DB) return json({ error: "core_database_not_configured" }, 503);

  const row = await env.CORE_DB.prepare(
    "SELECT p.id AS principal_id, p.status AS principal_status, a.id AS account_id, a.display_name AS account_name, am.role AS account_role FROM account_identities ai JOIN principals p ON p.id = ai.principal_id JOIN account_memberships am ON am.principal_id = p.id AND am.status = 'active' JOIN accounts a ON a.id = am.account_id AND a.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? AND p.status = 'active' ORDER BY am.created_at LIMIT 1"
  ).bind(identity.subject).first();

  if (!row) return json({ error: "central_identity_not_found" }, 404);
  return json({
    user: {
      principal_id: row.principal_id,
      status: row.principal_status,
      account_id: row.account_id,
      account_name: row.account_name,
      account_role: row.account_role,
      sign_in_provider: identity.provider
    },
    api_version: API_VERSION
  });
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

  let response;
  if (request.method === "GET" && url.pathname === "/health") {
    const coreDb = await databaseHealth(env);
    response = json({
      service: "SAHROUD CENTRAL API",
      status: coreDb === "ok" ? "ok" : "degraded",
      version: API_VERSION,
      dependencies: { core_db: coreDb }
    });
  } else if (request.method === "GET" && url.pathname === "/v1/version") {
    response = json({ api_version: API_VERSION, service: "sahroud-central-api" });
  } else if (request.method === "GET" && url.pathname === "/v1/catalog/products") {
    response = await listProducts(env);
  } else if (request.method === "GET" && url.pathname.startsWith("/v1/catalog/products/")) {
    const productKey = url.pathname.slice("/v1/catalog/products/".length);
    response = await getProduct(env, productKey);
  } else if (request.method === "POST" && url.pathname === "/v1/auth/session") {
    response = await authenticate(request, env);
  } else if (request.method === "GET" && url.pathname === "/v1/me") {
    response = await currentUser(request, env);
  } else if (url.pathname === "/v1/auth/session") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  } else if (url.pathname === "/v1/me") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
  } else if (request.method !== "GET") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
  } else {
    response = json({ error: "not_found" }, 404);
  }

  return withHeaders(response, corsHeaders(request, env));
}

export default {
  fetch(request, env) {
    return handle(request, env).catch(error => {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = status < 500 && typeof error?.message === "string"
        ? error.message
        : status === 503 && error?.message === "auth_not_configured"
          ? "auth_not_configured"
          : "internal_server_error";
      return json({ error: code }, status);
    });
  }
};

export { handle, API_VERSION, databaseHealth, verifyFirebaseIdToken, resolveCentralIdentity };
