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
    "access-control-allow-headers": "Content-Type, Authorization, X-Sahroud-Account-Id",
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
      firebase_uid: identity.subject,
      status: row.principal_status,
      account_id: row.account_id,
      account_name: row.account_name,
      account_role: row.account_role,
      sign_in_provider: identity.provider
    },
    api_version: API_VERSION
  });
}


function isCentralAdmin(identity, env) {
  return String(env?.CENTRAL_ADMIN_UIDS || "").split(",").map(v => v.trim()).filter(Boolean).includes(identity.subject);
}

async function requireCentralAccount(env, identity, requestedAccountId = null) {
  if (!env?.CORE_DB) throw Object.assign(new Error("core_database_not_configured"), { status: 503 });
  const rows = await env.CORE_DB.prepare(
    "SELECT p.id AS principal_id, p.status AS principal_status, a.id AS account_id, a.status AS account_status FROM account_identities ai JOIN principals p ON p.id=ai.principal_id JOIN account_memberships am ON am.principal_id=p.id AND am.status='active' JOIN accounts a ON a.id=am.account_id AND a.status='active' WHERE ai.provider='firebase' AND ai.provider_subject=? AND p.status='active' ORDER BY am.created_at"
  ).bind(identity.subject).all();
  const active = rows.results || [];
  if (requestedAccountId) {
    const selected = active.find(row => row.account_id === requestedAccountId);
    if (!selected) throw Object.assign(new Error("account_membership_required"), { status: 403 });
    return selected;
  }
  if (active.length === 0) throw Object.assign(new Error("active_central_account_required"), { status: 403 });
  if (active.length > 1) throw Object.assign(new Error("account_selection_required"), { status: 409 });
  return active[0];
}

async function adminFeatureList(request, env, productKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  if (!env?.CORE_DB) return json({ error: "core_database_not_configured" }, 503);
  const product = await env.CORE_DB.prepare("SELECT product_key, display_name FROM products WHERE product_key=? AND lifecycle_status<>'retired'").bind(productKey).first();
  if (!product) return json({ error: "product_not_found" }, 404);
  const result = await env.CORE_DB.prepare(
    "SELECT feature_key, display_name, description, is_enabled, access_mode, price_amount, currency, trial_days, usage_limit, updated_at FROM product_features WHERE product_key=? ORDER BY display_name"
  ).bind(productKey).all();
  return json({
    product: { id: product.product_key, name: product.display_name },
    features: (result.results || []).map(row => ({
      key: row.feature_key, name: row.display_name, description: row.description,
      enabled: row.is_enabled === 1, access_mode: row.access_mode,
      price_amount: row.price_amount, currency: row.currency,
      trial_days: row.trial_days, usage_limit: row.usage_limit, updated_at: row.updated_at
    })),
    api_version: API_VERSION
  });
}

async function adminUpsertFeature(request, env, productKey, featureKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  if (!env?.CORE_DB) return json({ error: "core_database_not_configured" }, 503);
  if (!/^[a-z0-9-]{2,64}$/.test(productKey) || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(featureKey)) return json({ error: "invalid_product_or_feature_key" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const name = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 1000) : "";
  const mode = body?.access_mode;
  const enabled = body?.is_enabled;
  const price = body?.price_amount ?? null;
  const currency = typeof body?.currency === "string" ? body.currency.trim().toUpperCase() : "IRR";
  const trialDays = body?.trial_days ?? 0;
  const usageLimit = body?.usage_limit ?? null;
  if (!name || name.length > 120 || !["free", "paid", "disabled"].includes(mode) ||
      typeof enabled !== "boolean" || (price !== null && (!Number.isSafeInteger(price) || price < 0)) ||
      !/^[A-Z]{3,8}$/.test(currency) || !Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365 ||
      (usageLimit !== null && (!Number.isSafeInteger(usageLimit) || usageLimit < 0))) return json({ error: "invalid_feature_settings" }, 400);
  if (mode === "free" && price !== null) return json({ error: "free_feature_cannot_have_price" }, 400);
  const product = await env.CORE_DB.prepare("SELECT product_key FROM products WHERE product_key=?").bind(productKey).first();
  if (!product) return json({ error: "product_not_found" }, 404);
  const now = new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      "INSERT INTO product_features (product_key,feature_key,display_name,description,is_enabled,access_mode,price_amount,currency,trial_days,usage_limit,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_key,feature_key) DO UPDATE SET display_name=excluded.display_name,description=excluded.description,is_enabled=excluded.is_enabled,access_mode=excluded.access_mode,price_amount=excluded.price_amount,currency=excluded.currency,trial_days=excluded.trial_days,usage_limit=excluded.usage_limit,updated_at=excluded.updated_at,updated_by=excluded.updated_by"
    ).bind(productKey, featureKey, name, description, enabled ? 1 : 0, mode, price, currency, trialDays, usageLimit, now, now, identity.subject),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,NULL,?,'feature_settings_changed','product_feature',?,'success',?,?)"
    ).bind(crypto.randomUUID(), productKey, featureKey, now, JSON.stringify({ access_mode: mode, is_enabled: enabled, actor_uid: identity.subject }))
  ]);
  return json({ saved: true, product_key: productKey, feature_key: featureKey, enabled, access_mode: mode, api_version: API_VERSION });
}

async function resolveFeatureAccess(request, env, identity, productKey, featureKey) {
  const account = await requireCentralAccount(env, identity, request.headers.get('X-Sahroud-Account-Id'));
  if (!/^[a-z0-9-]{2,64}$/.test(productKey) || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(featureKey)) return { response: json({ error: "invalid_product_or_feature_key" }, 400) };
  const feature = await env.CORE_DB.prepare("SELECT f.is_enabled,f.access_mode,f.usage_limit,p.lifecycle_status FROM product_features f JOIN products p ON p.product_key=f.product_key WHERE f.product_key=? AND f.feature_key=?").bind(productKey, featureKey).first();
  if (!feature) return { response: json({ allowed: false, reason: "feature_not_registered" }, 404) };
  if (feature.lifecycle_status === "retired" || feature.is_enabled !== 1 || feature.access_mode === "disabled") return { response: json({ allowed: false, reason: "feature_disabled" }, 403) };

  let source = "free", sourceId = "free", limit = feature.usage_limit;
  if (feature.access_mode === "paid") {
    const now = new Date().toISOString();
    const grant = await env.CORE_DB.prepare("SELECT id,usage_limit FROM account_feature_grants WHERE account_id=? AND product_key=? AND feature_key=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) ORDER BY created_at DESC LIMIT 1").bind(account.account_id, productKey, featureKey, now, now).first();
    if (grant) {
      source = "grant"; sourceId = grant.id;
      if (grant.usage_limit !== null && grant.usage_limit !== undefined) limit = grant.usage_limit;
    } else {
      const subscription = await env.CORE_DB.prepare("SELECT s.id FROM subscriptions s JOIN plans p ON p.product_key=s.product_key AND p.plan_code=s.plan_code JOIN plan_features pf ON pf.product_key=s.product_key AND pf.plan_code=s.plan_code WHERE s.account_id=? AND s.product_key=? AND pf.feature_key=? AND s.status='active' AND p.is_active=1 AND (s.starts_at IS NULL OR s.starts_at<=?) AND (s.ends_at IS NULL OR s.ends_at>?) ORDER BY s.created_at DESC LIMIT 1").bind(account.account_id, productKey, featureKey, now, now).first();
      if (!subscription) return { response: json({ allowed: false, reason: "purchase_or_subscription_required", product_key: productKey, feature_key: featureKey }, 403) };
      source = "subscription"; sourceId = subscription.id;
    }
  }
  const usage = await env.CORE_DB.prepare("SELECT used_count FROM feature_usage WHERE account_id=? AND product_key=? AND feature_key=?").bind(account.account_id, productKey, featureKey).first();
  const usedCount = usage?.used_count || 0;
  if (limit !== null && limit !== undefined && usedCount >= limit) return { response: json({ allowed: false, reason: "usage_limit_reached", used_count: usedCount, usage_limit: limit }, 403) };
  return { account, source, sourceId, limit, usedCount };
}

async function checkFeatureAccess(request, env, productKey, featureKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  const access = await resolveFeatureAccess(request, env, identity, productKey, featureKey);
  if (access.response) return access.response;
  return json({ allowed: true, reason: access.source === "free" ? "free_feature" : access.source === "grant" ? "active_feature_grant" : "active_plan_subscription", product_key: productKey, feature_key: featureKey, access_source: access.source, usage_limit: access.limit, used_count: access.usedCount, remaining_uses: access.limit == null ? null : Math.max(0, access.limit - access.usedCount) });
}

async function consumeFeatureUsage(request, env, productKey, featureKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  const access = await resolveFeatureAccess(request, env, identity, productKey, featureKey);
  if (access.response) return access.response;
  const now = new Date().toISOString();
  const result = await env.CORE_DB.prepare("INSERT INTO feature_usage (account_id,product_key,feature_key,used_count,created_at,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT(account_id,product_key,feature_key) DO UPDATE SET used_count=feature_usage.used_count+1,updated_at=excluded.updated_at WHERE (? IS NULL OR feature_usage.used_count < ?)").bind(access.account.account_id, productKey, featureKey, now, now, access.limit ?? null, access.limit ?? null).run();
  if (result?.meta?.changes !== 1) {
    const current = await env.CORE_DB.prepare("SELECT used_count FROM feature_usage WHERE account_id=? AND product_key=? AND feature_key=?").bind(access.account.account_id, productKey, featureKey).first();
    return json({ allowed: false, reason: "usage_limit_reached", used_count: current?.used_count || 0, usage_limit: access.limit }, 403);
  }
  const current = await env.CORE_DB.prepare("SELECT used_count FROM feature_usage WHERE account_id=? AND product_key=? AND feature_key=?").bind(access.account.account_id, productKey, featureKey).first();
  const usedCount = current?.used_count || access.usedCount + 1;
  return json({ allowed: true, consumed: true, product_key: productKey, feature_key: featureKey, access_source: access.source, used_count: usedCount, usage_limit: access.limit, remaining_uses: access.limit == null ? null : Math.max(0, access.limit - usedCount) });
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
  } else if (request.method === "GET" && /^\/v1\/admin\/products\/[a-z0-9-]+\/features$/.test(url.pathname)) {
    response = await adminFeatureList(request, env, url.pathname.split("/")[4]);
  } else if (request.method === "POST" && /^\/v1\/admin\/products\/[a-z0-9-]+\/features\/[a-z0-9][a-z0-9._-]{1,80}$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await adminUpsertFeature(request, env, parts[4], parts[6]);
  } else if (request.method === "GET" && /^\/v1\/access\/[a-z0-9-]+\/[a-z0-9][a-z0-9._-]{1,80}$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await checkFeatureAccess(request, env, parts[3], parts[4]);
  } else if (request.method === "POST" && /^\/v1\/access\/[a-z0-9-]+\/[a-z0-9][a-z0-9._-]{1,80}\/consume$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await consumeFeatureUsage(request, env, parts[3], parts[4]);
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
