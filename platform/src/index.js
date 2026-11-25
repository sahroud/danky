import { importX509, jwtVerify } from "jose";
import { loadEffectiveRuntimePolicy } from "./runtime-policy.js";
import { signCoordinatorAssertion } from "./operation-coordinator-do.js";

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
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
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
    "SELECT ai.principal_id, am.account_id FROM account_identities ai JOIN account_memberships am ON am.principal_id = ai.principal_id AND am.status = 'active' JOIN accounts a ON a.id = am.account_id AND a.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? ORDER BY am.created_at"
  ).bind(identity.subject).all();

  if (existing.results?.length) {
    const accounts = existing.results.map(row => row.account_id);
    return { principalId: existing.results[0].principal_id, accountId: accounts.length === 1 ? accounts[0] : null, accountIds: accounts };
  }

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
    "SELECT ai.principal_id, am.account_id FROM account_identities ai JOIN account_memberships am ON am.principal_id = ai.principal_id AND am.status = 'active' JOIN accounts a ON a.id = am.account_id AND a.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? ORDER BY am.created_at"
  ).bind(identity.subject).all();

  if (!resolved.results?.length) throw Object.assign(new Error("account_provisioning_failed"), { status: 503 });
  const accountIds = resolved.results.map(row => row.account_id);
  return { principalId: resolved.results[0].principal_id, accountId: accountIds.length === 1 ? accountIds[0] : null, accountIds };
}

async function authenticate(request, env) {
  const token = bearerToken(request);
  const identity = await verifyFirebaseIdToken(token, env);
  const central = await resolveCentralIdentity(env, identity);
  return json({
    authenticated: true,
    principal_id: central.principalId,
    account_id: central.accountId,
    account_ids: central.accountIds || (central.accountId ? [central.accountId] : []),
    account_selection_required: Boolean(central.accountIds?.length > 1),
    sign_in_provider: identity.provider,
    api_version: API_VERSION
  });
}

async function currentUser(request, env) {
  const token = bearerToken(request);
  const identity = await verifyFirebaseIdToken(token, env);
  if (!env?.CORE_DB) return json({ error: "core_database_not_configured" }, 503);

  const result = await env.CORE_DB.prepare(
    "SELECT p.id AS principal_id, p.status AS principal_status, a.id AS account_id, a.display_name AS account_name, am.role AS account_role FROM account_identities ai JOIN principals p ON p.id = ai.principal_id JOIN account_memberships am ON am.principal_id = p.id AND am.status = 'active' JOIN accounts a ON a.id = am.account_id AND a.status = 'active' WHERE ai.provider = 'firebase' AND ai.provider_subject = ? AND p.status = 'active' ORDER BY am.created_at"
  ).bind(identity.subject).all();

  const accounts = (result.results || []).map(row => ({
    account_id: row.account_id,
    account_name: row.account_name,
    account_role: row.account_role
  }));
  if (!accounts.length) return json({ error: "central_identity_not_found" }, 404);
  const principalId = result.results[0].principal_id;
  const principalStatus = result.results[0].principal_status;
  const singleAccount = accounts.length === 1 ? accounts[0] : null;
  return json({
    user: {
      principal_id: principalId,
      firebase_uid: identity.subject,
      status: principalStatus,
      account_id: singleAccount?.account_id ?? null,
      account_name: singleAccount?.account_name ?? null,
      account_role: singleAccount?.account_role ?? null,
      accounts,
      account_selection_required: accounts.length > 1,
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


async function adminRuntimePolicy(request, env, productKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  if (!/^[a-z0-9-]{2,64}$/.test(productKey)) return json({ error: "invalid_product_key" }, 400);
  const product = await env.CORE_DB.prepare("SELECT product_key,display_name FROM products WHERE product_key=? AND lifecycle_status<>'retired'").bind(productKey).first();
  if (!product) return json({ error: "product_not_found" }, 404);
  if (request.method === "GET") {
    const policy = await env.CORE_DB.prepare("SELECT max_devices_per_account,max_sessions_per_account,session_lease_seconds,max_concurrent_operations,max_queued_operations,queue_wait_seconds,updated_at,updated_by FROM product_runtime_policies WHERE product_key=?").bind(productKey).first();
    return json({ product, policy: policy || { max_devices_per_account:null,max_sessions_per_account:null,session_lease_seconds:300,max_concurrent_operations:null,max_queued_operations:0,queue_wait_seconds:0,updated_at:null,updated_by:null } });
  }
  let body; try { body = await request.json(); } catch { return json({ error:"invalid_json" },400); }
  const pos = v => v === null ? null : Number.isSafeInteger(v) && v >= 1 && v <= 100000 ? v : undefined;
  const devices=pos(body?.max_devices_per_account), sessions=pos(body?.max_sessions_per_account), operations=pos(body?.max_concurrent_operations);
  const lease=body?.session_lease_seconds, queue=body?.max_queued_operations, wait=body?.queue_wait_seconds;
  if (devices===undefined || sessions===undefined || operations===undefined || !Number.isInteger(lease) || lease<30 || lease>86400 || !Number.isSafeInteger(queue) || queue<0 || queue>100000 || !Number.isInteger(wait) || wait<0 || wait>86400 || (sessions!==null && devices!==null && sessions>devices)) return json({error:"invalid_runtime_policy"},400);
  const now=new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT INTO product_runtime_policies (product_key,max_devices_per_account,max_sessions_per_account,session_lease_seconds,max_concurrent_operations,max_queued_operations,queue_wait_seconds,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(product_key) DO UPDATE SET max_devices_per_account=excluded.max_devices_per_account,max_sessions_per_account=excluded.max_sessions_per_account,session_lease_seconds=excluded.session_lease_seconds,max_concurrent_operations=excluded.max_concurrent_operations,max_queued_operations=excluded.max_queued_operations,queue_wait_seconds=excluded.queue_wait_seconds,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(productKey,devices,sessions,lease,operations,queue,wait,now,identity.subject),
    env.CORE_DB.prepare("INSERT INTO audit_events (id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,'runtime_policy_updated','product_runtime_policy',?,'success',?,?)").bind(crypto.randomUUID(),productKey,productKey,now,JSON.stringify({max_devices_per_account:devices,max_sessions_per_account:sessions,session_lease_seconds:lease,max_concurrent_operations:operations,max_queued_operations:queue,queue_wait_seconds:wait,actor_uid:identity.subject}))
  ]);
  return json({saved:true,product_key:productKey,policy:{max_devices_per_account:devices,max_sessions_per_account:sessions,session_lease_seconds:lease,max_concurrent_operations:operations,max_queued_operations:queue,queue_wait_seconds:wait,updated_at:now}});
}

async function adminAccountRuntimePolicy(request, env, accountId, productKey) {
  const identity=await verifyFirebaseIdToken(bearerToken(request),env);
  if(!isCentralAdmin(identity,env)) return json({error:"central_admin_required"},403);
  if(!/^[a-z0-9-]{2,64}$/.test(productKey)||!accountId||accountId.length>128) return json({error:"invalid_account_or_product"},400);
  const account=await env.CORE_DB.prepare("SELECT id FROM accounts WHERE id=?").bind(accountId).first();
  const product=await env.CORE_DB.prepare("SELECT product_key FROM products WHERE product_key=? AND lifecycle_status<>'retired'").bind(productKey).first();
  if(!account) return json({error:"account_not_found"},404);
  if(!product) return json({error:"product_not_found"},404);
  if(request.method==="GET"){
    const override=await env.CORE_DB.prepare("SELECT max_devices_per_account,max_sessions_per_account,max_concurrent_operations,max_queued_operations,updated_at,updated_by FROM account_product_policy_overrides WHERE account_id=? AND product_key=?").bind(accountId,productKey).first();
    return json({account_id:accountId,product_key:productKey,override:override||null});
  }
  let body;try{body=await request.json();}catch{return json({error:"invalid_json"},400);}
  const pos=v=>v===null?null:Number.isSafeInteger(v)&&v>=1&&v<=100000?v:undefined;
  const qv=v=>v===null?null:Number.isSafeInteger(v)&&v>=0&&v<=100000?v:undefined;
  const devices=pos(body?.max_devices_per_account),sessions=pos(body?.max_sessions_per_account),operations=pos(body?.max_concurrent_operations),queue=qv(body?.max_queued_operations);
  if(devices===undefined||sessions===undefined||operations===undefined||queue===undefined||(sessions!==null&&devices!==null&&sessions>devices))return json({error:"invalid_runtime_policy_override"},400);
  const now=new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT INTO account_product_policy_overrides (account_id,product_key,max_devices_per_account,max_sessions_per_account,max_concurrent_operations,max_queued_operations,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,product_key) DO UPDATE SET max_devices_per_account=excluded.max_devices_per_account,max_sessions_per_account=excluded.max_sessions_per_account,max_concurrent_operations=excluded.max_concurrent_operations,max_queued_operations=excluded.max_queued_operations,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(accountId,productKey,devices,sessions,operations,queue,now,identity.subject),
    env.CORE_DB.prepare("INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,?,'runtime_policy_override_updated','account_product_policy_override',?,'success',?,?)").bind(crypto.randomUUID(),accountId,productKey,accountId+":"+productKey,now,JSON.stringify({max_devices_per_account:devices,max_sessions_per_account:sessions,max_concurrent_operations:operations,max_queued_operations:queue,actor_uid:identity.subject}))
  ]);
  return json({saved:true,account_id:accountId,product_key:productKey,override:{max_devices_per_account:devices,max_sessions_per_account:sessions,max_concurrent_operations:operations,max_queued_operations:queue,updated_at:now}});
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


function validIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 40) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

async function adminAccountList(request, env) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length > 120) return json({ error: "invalid_search_query" }, 400);
  const pattern = "%" + query + "%";
  const result = await env.CORE_DB.prepare(
    "SELECT id,display_name,account_type,status FROM accounts WHERE status='active' AND (?='' OR id LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT 50"
  ).bind(query, pattern, pattern).all();
  return json({ accounts: result.results || [] });
}

async function adminAccountGrants(request, env, accountId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  const account = await env.CORE_DB.prepare("SELECT id,display_name FROM accounts WHERE id=?").bind(accountId).first();
  if (!account) return json({ error: "account_not_found" }, 404);
  const result = await env.CORE_DB.prepare(
    "SELECT g.id,g.product_key,g.feature_key,f.display_name AS feature_name,g.status,g.source_type,g.starts_at,g.ends_at,g.usage_limit,g.created_at,g.updated_at FROM account_feature_grants g JOIN product_features f ON f.product_key=g.product_key AND f.feature_key=g.feature_key WHERE g.account_id=? ORDER BY g.created_at DESC LIMIT 200"
  ).bind(accountId).all();
  return json({ account, grants: result.results || [] });
}

async function adminCreateGrant(request, env, accountId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const productKey = typeof body?.product_key === "string" ? body.product_key : "";
  const featureKey = typeof body?.feature_key === "string" ? body.feature_key : "";
  const sourceType = body?.source_type || "manual";
  const startsAt = validIsoDate(body?.starts_at);
  const endsAt = validIsoDate(body?.ends_at);
  const usageLimit = body?.usage_limit ?? null;
  if (!/^[a-z0-9-]{2,64}$/.test(productKey) || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(featureKey) ||
      !["manual","promotion","trial","purchase","subscription"].includes(sourceType) ||
      startsAt === undefined || endsAt === undefined ||
      (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) ||
      (usageLimit !== null && (!Number.isSafeInteger(usageLimit) || usageLimit < 0))) {
    return json({ error: "invalid_grant_settings" }, 400);
  }
  const account = await env.CORE_DB.prepare("SELECT id FROM accounts WHERE id=? AND status='active'").bind(accountId).first();
  if (!account) return json({ error: "active_account_not_found" }, 404);
  const feature = await env.CORE_DB.prepare("SELECT access_mode,is_enabled FROM product_features WHERE product_key=? AND feature_key=?").bind(productKey, featureKey).first();
  if (!feature) return json({ error: "feature_not_found" }, 404);
  if (!feature.is_enabled || feature.access_mode === "disabled") return json({ error: "feature_disabled" }, 409);
  const now = new Date().toISOString();
  const grantId = crypto.randomUUID();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      "INSERT INTO account_feature_grants (id,account_id,product_key,feature_key,status,source_type,starts_at,ends_at,usage_limit,created_at,updated_at,updated_by) VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?)"
    ).bind(grantId, accountId, productKey, featureKey, sourceType, startsAt, endsAt, usageLimit, now, now, identity.subject),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,?,'feature_grant_created','account_feature_grant',?,'success',?,?)"
    ).bind(crypto.randomUUID(), accountId, productKey, grantId, now, JSON.stringify({ feature_key: featureKey, source_type: sourceType, starts_at: startsAt, ends_at: endsAt, usage_limit: usageLimit, actor_uid: identity.subject }))
  ]);
  return json({ created: true, grant_id: grantId, account_id: accountId, product_key: productKey, feature_key: featureKey, starts_at: startsAt, ends_at: endsAt, status: "active" }, 201);
}

async function adminUpdateGrant(request, env, grantId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const allowedStatuses = ["active", "suspended", "revoked", "expired"];
  const status = body?.status;
  const hasEnd = body && Object.hasOwn(body, "ends_at");
  const endsAt = hasEnd ? validIsoDate(body.ends_at) : null;
  const hasLimit = body && Object.hasOwn(body, "usage_limit");
  const usageLimit = hasLimit ? body.usage_limit : undefined;
  if ((status !== undefined && !allowedStatuses.includes(status)) ||
      (hasEnd && endsAt === undefined) ||
      (hasLimit && usageLimit !== null && (!Number.isSafeInteger(usageLimit) || usageLimit < 0)) ||
      (status === undefined && !hasEnd && !hasLimit)) return json({ error: "invalid_grant_update" }, 400);
  const current = await env.CORE_DB.prepare("SELECT id,account_id,product_key,feature_key,starts_at,ends_at,status FROM account_feature_grants WHERE id=?").bind(grantId).first();
  if (!current) return json({ error: "grant_not_found" }, 404);
  const nextEnd = hasEnd ? endsAt : current.ends_at;
  if (nextEnd && current.starts_at && Date.parse(nextEnd) <= Date.parse(current.starts_at)) return json({ error: "end_must_follow_start" }, 400);
  const nextStatus = status || current.status;
  const now = new Date().toISOString();
  let updateSql = "UPDATE account_feature_grants SET status=?,updated_at=?,updated_by=? WHERE id=?";
  let bindings = [nextStatus, now, identity.subject, grantId];
  if (hasEnd && hasLimit) {
    updateSql = "UPDATE account_feature_grants SET status=?,ends_at=?,usage_limit=?,updated_at=?,updated_by=? WHERE id=?";
    bindings = [nextStatus, nextEnd, usageLimit, now, identity.subject, grantId];
  } else if (hasEnd) {
    updateSql = "UPDATE account_feature_grants SET status=?,ends_at=?,updated_at=?,updated_by=? WHERE id=?";
    bindings = [nextStatus, nextEnd, now, identity.subject, grantId];
  } else if (hasLimit) {
    updateSql = "UPDATE account_feature_grants SET status=?,usage_limit=?,updated_at=?,updated_by=? WHERE id=?";
    bindings = [nextStatus, usageLimit, now, identity.subject, grantId];
  }
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(updateSql).bind(...bindings),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,?,'feature_grant_updated','account_feature_grant',?,'success',?,?)"
    ).bind(crypto.randomUUID(), current.account_id, current.product_key, grantId, now, JSON.stringify({ status: nextStatus, ends_at: hasEnd ? nextEnd : current.ends_at, usage_limit: hasLimit ? usageLimit : "unchanged", actor_uid: identity.subject }))
  ]);
  return json({ updated: true, grant_id: grantId, status: nextStatus, ends_at: nextEnd });
}


async function adminProductPlans(request, env, productKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  const result = await env.CORE_DB.prepare(
    "SELECT p.plan_code,p.display_name,p.limits_json,p.is_active,(SELECT COUNT(*) FROM plan_features pf WHERE pf.product_key=p.product_key AND pf.plan_code=p.plan_code) AS feature_count FROM plans p WHERE p.product_key=? ORDER BY p.display_name"
  ).bind(productKey).all();
  return json({ product_key: productKey, plans: result.results || [] });
}


async function adminUpsertPlan(request, env, productKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const planCode = typeof body?.plan_code === "string" ? body.plan_code.trim() : "";
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const featureKeys = body?.feature_keys;
  const isActive = body?.is_active === false ? 0 : 1;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(planCode) ||
      !displayName || displayName.length > 120 ||
      !Array.isArray(featureKeys) || featureKeys.length < 1 || featureKeys.length > 100 ||
      featureKeys.some(key => typeof key !== "string" || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(key)) ||
      new Set(featureKeys).size !== featureKeys.length) {
    return json({ error: "invalid_plan_settings" }, 400);
  }
  const product = await env.CORE_DB.prepare("SELECT product_key,lifecycle_status FROM products WHERE product_key=?").bind(productKey).first();
  if (!product || product.lifecycle_status === "retired") return json({ error: "active_product_not_found" }, 404);
  const placeholders = featureKeys.map(() => "?").join(",");
  const features = await env.CORE_DB.prepare(
    "SELECT feature_key FROM product_features WHERE product_key=? AND is_enabled=1 AND access_mode='paid' AND feature_key IN (" + placeholders + ")"
  ).bind(productKey, ...featureKeys).all();
  const validKeys = new Set((features.results || []).map(row => row.feature_key));
  if (validKeys.size !== featureKeys.length) return json({ error: "plan_contains_unknown_or_unavailable_features" }, 400);
  const now = new Date().toISOString();
  const statements = [
    env.CORE_DB.prepare(
      "INSERT INTO plans (product_key,plan_code,display_name,limits_json,is_active,created_at,updated_at) VALUES (?,?,?,'{}',?,?,?) ON CONFLICT(product_key,plan_code) DO UPDATE SET display_name=excluded.display_name,is_active=excluded.is_active,updated_at=excluded.updated_at"
    ).bind(productKey, planCode, displayName, isActive, now, now),
    env.CORE_DB.prepare("DELETE FROM plan_features WHERE product_key=? AND plan_code=?").bind(productKey, planCode),
    ...featureKeys.map(key => env.CORE_DB.prepare(
      "INSERT INTO plan_features (product_key,plan_code,feature_key,created_at) VALUES (?,?,?,?)"
    ).bind(productKey, planCode, key, now)),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,'plan_upserted','plan',?,'success',?,?)"
    ).bind(crypto.randomUUID(), productKey, planCode, now, JSON.stringify({ display_name: displayName, is_active: !!isActive, feature_keys: featureKeys, actor_uid: identity.subject }))
  ];
  await env.CORE_DB.batch(statements);
  return json({ saved: true, product_key: productKey, plan_code: planCode, display_name: displayName, is_active: !!isActive, feature_keys: featureKeys });
}


async function adminUpdatePlan(request, env, productKey, planCode) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  if (!/^[a-z0-9-]{2,64}$/.test(productKey) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(planCode)) return json({ error: "invalid_product_or_plan_key" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (typeof body?.is_active !== "boolean") return json({ error: "invalid_plan_status" }, 400);
  const current = await env.CORE_DB.prepare("SELECT plan_code FROM plans WHERE product_key=? AND plan_code=?").bind(productKey, planCode).first();
  if (!current) return json({ error: "plan_not_found" }, 404);
  const now = new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("UPDATE plans SET is_active=?,updated_at=? WHERE product_key=? AND plan_code=?").bind(body.is_active ? 1 : 0, now, productKey, planCode),
    env.CORE_DB.prepare("INSERT INTO audit_events (id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,'plan_status_updated','plan',?,'success',?,?)").bind(crypto.randomUUID(), productKey, planCode, now, JSON.stringify({ is_active: body.is_active, actor_uid: identity.subject }))
  ]);
  return json({ updated: true, product_key: productKey, plan_code: planCode, is_active: body.is_active });
}

async function adminAccountSubscriptions(request, env, accountId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  const account = await env.CORE_DB.prepare("SELECT id,display_name FROM accounts WHERE id=?").bind(accountId).first();
  if (!account) return json({ error: "account_not_found" }, 404);
  const result = await env.CORE_DB.prepare(
    "SELECT s.id,s.product_key,s.plan_code,p.display_name AS plan_name,s.status,s.starts_at,s.ends_at,s.billing_provider,s.created_at,s.updated_at FROM subscriptions s JOIN plans p ON p.product_key=s.product_key AND p.plan_code=s.plan_code WHERE s.account_id=? ORDER BY s.created_at DESC LIMIT 200"
  ).bind(accountId).all();
  return json({ account, subscriptions: result.results || [] });
}

async function adminCreateSubscription(request, env, accountId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const productKey = typeof body?.product_key === "string" ? body.product_key : "";
  const planCode = typeof body?.plan_code === "string" ? body.plan_code : "";
  const startsAt = validIsoDate(body?.starts_at);
  const endsAt = validIsoDate(body?.ends_at);
  if (!/^[a-z0-9-]{2,64}$/.test(productKey) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(planCode) ||
      startsAt === undefined || endsAt === undefined ||
      (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))) {
    return json({ error: "invalid_subscription_settings" }, 400);
  }
  const account = await env.CORE_DB.prepare("SELECT id FROM accounts WHERE id=? AND status='active'").bind(accountId).first();
  if (!account) return json({ error: "active_account_not_found" }, 404);
  const plan = await env.CORE_DB.prepare(
    "SELECT p.plan_code,p.display_name,pr.lifecycle_status FROM plans p JOIN products pr ON pr.product_key=p.product_key WHERE p.product_key=? AND p.plan_code=? AND p.is_active=1"
  ).bind(productKey, planCode).first();
  if (!plan || plan.lifecycle_status === "retired") return json({ error: "active_plan_not_found" }, 404);
  const now = new Date().toISOString();
  const subscriptionId = crypto.randomUUID();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      "INSERT INTO subscriptions (id,account_id,product_key,plan_code,status,starts_at,ends_at,billing_provider,provider_subscription_ref,created_at,updated_at) VALUES (?,?,?,?, 'active', ?,?,NULL,NULL,?,?)"
    ).bind(subscriptionId, accountId, productKey, planCode, startsAt, endsAt, now, now),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,?,'subscription_created','subscription',?,'success',?,?)"
    ).bind(crypto.randomUUID(), accountId, productKey, subscriptionId, now, JSON.stringify({ plan_code: planCode, starts_at: startsAt, ends_at: endsAt, actor_uid: identity.subject, source: "admin_manual" }))
  ]);
  return json({ created: true, subscription_id: subscriptionId, account_id: accountId, product_key: productKey, plan_code: planCode, status: "active", starts_at: startsAt, ends_at: endsAt }, 201);
}

async function adminUpdateSubscription(request, env, subscriptionId) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (!isCentralAdmin(identity, env)) return json({ error: "central_admin_required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const statuses = ["pending", "active", "past_due", "cancelled", "expired"];
  const status = body?.status;
  const hasEnd = body && Object.hasOwn(body, "ends_at");
  const endsAt = hasEnd ? validIsoDate(body.ends_at) : null;
  if ((status !== undefined && !statuses.includes(status)) || (hasEnd && endsAt === undefined) ||
      (status === undefined && !hasEnd)) return json({ error: "invalid_subscription_update" }, 400);
  const current = await env.CORE_DB.prepare("SELECT id,account_id,product_key,starts_at,ends_at,status FROM subscriptions WHERE id=?").bind(subscriptionId).first();
  if (!current) return json({ error: "subscription_not_found" }, 404);
  const nextEnd = hasEnd ? endsAt : current.ends_at;
  if (nextEnd && current.starts_at && Date.parse(nextEnd) <= Date.parse(current.starts_at)) return json({ error: "end_must_follow_start" }, 400);
  const nextStatus = status || current.status;
  const now = new Date().toISOString();
  const sql = hasEnd
    ? "UPDATE subscriptions SET status=?,ends_at=?,updated_at=? WHERE id=?"
    : "UPDATE subscriptions SET status=?,updated_at=? WHERE id=?";
  const bindings = hasEnd ? [nextStatus, nextEnd, now, subscriptionId] : [nextStatus, now, subscriptionId];
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(sql).bind(...bindings),
    env.CORE_DB.prepare(
      "INSERT INTO audit_events (id,account_id,product_key,event_type,target_type,target_id,outcome,created_at,metadata_json) VALUES (?,?,?,'subscription_updated','subscription',?,'success',?,?)"
    ).bind(crypto.randomUUID(), current.account_id, current.product_key, subscriptionId, now, JSON.stringify({ status: nextStatus, ends_at: nextEnd, actor_uid: identity.subject }))
  ]);
  return json({ updated: true, subscription_id: subscriptionId, status: nextStatus, ends_at: nextEnd });
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

async function incrementFeatureUsage(env, access, productKey, featureKey, now = new Date().toISOString()) {
  // A single conditional UPSERT enforces finite limits under concurrent requests.
  // RETURNING reports the count produced by this exact statement, avoiding a racy follow-up read.
  const row = await env.CORE_DB.prepare(
    "INSERT INTO feature_usage (account_id,product_key,feature_key,used_count,created_at,updated_at) SELECT ?,?,?,1,?,? WHERE (? IS NULL OR ? > 0) ON CONFLICT(account_id,product_key,feature_key) DO UPDATE SET used_count=feature_usage.used_count+1,updated_at=excluded.updated_at WHERE (? IS NULL OR feature_usage.used_count < ?) RETURNING used_count"
  ).bind(access.account.account_id, productKey, featureKey, now, now, access.limit ?? null, access.limit ?? null, access.limit ?? null, access.limit ?? null).first();
  if (!row) return { consumed: false, usedCount: access.usedCount || 0 };
  return { consumed: true, usedCount: row.used_count };
}
async function consumeFeatureUsage(request, env, productKey, featureKey) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  const access = await resolveFeatureAccess(request, env, identity, productKey, featureKey);
  if (access.response) return access.response;
  const usage = await incrementFeatureUsage(env, access, productKey, featureKey);
  if (!usage.consumed) {
    return json({ allowed: false, reason: "usage_limit_reached", used_count: usage.usedCount, usage_limit: access.limit }, 403);
  }
  return json({ allowed: true, consumed: true, product_key: productKey, feature_key: featureKey, access_source: access.source, used_count: usage.usedCount, usage_limit: access.limit, remaining_uses: access.limit == null ? null : Math.max(0, access.limit - usage.usedCount) });
}

/**
 * Acquires or manages a product-wide operation permit.
 * The Durable Object id is product-scoped so its cap is shared across accounts.
 * Identity, account membership, entitlements and all limits are resolved server-side.
 */
async function coordinateOperation(request, env, productKey, featureKey, action) {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  let account;
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request_body" }, 400);
  }

  if (action === "release") {
    // Release is allowed for an authenticated account member even if its subscription
    // has since expired; otherwise a client could not voluntarily free its own permit.
    account = await requireCentralAccount(env, identity, request.headers.get("X-Sahroud-Account-Id"));
  } else {
    const access = await resolveFeatureAccess(request, env, identity, productKey, featureKey);
    if (access.response) return access.response;
    account = access.account;
  }

  if (!env?.OPERATION_COORDINATOR ||
      typeof env.OPERATION_COORDINATOR.idFromName !== "function" ||
      typeof env.OPERATION_COORDINATOR.get !== "function") {
    return json({ error: "operation_coordinator_not_configured" }, 503);
  }
  const secret = env.OPERATION_ASSERTION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    return json({ error: "operation_assertion_secret_not_configured" }, 503);
  }

  let requestId;
  let leaseId;
  if (action === "acquire") {
    requestId = body.request_id;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
      return json({ error: "valid_request_id_required" }, 400);
    }
    leaseId = crypto.randomUUID();
  } else {
    leaseId = body.lease_id;
    if (typeof leaseId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(leaseId)) {
      return json({ error: "valid_lease_id_required" }, 400);
    }
  }

  let policy;
  try {
    policy = await loadEffectiveRuntimePolicy(env.CORE_DB, account.account_id, productKey);
  } catch (error) {
    if (error?.code === "runtime_policy_not_configured") {
      return json({ error: "runtime_policy_not_configured" }, 503);
    }
    return json({ error: "runtime_policy_invalid" }, 503);
  }

  const assertion = {
    action,
    accountId: account.account_id,
    productKey,
    cap: policy.productConcurrentCap,
    accountCap: policy.accountConcurrentCap,
    leaseSeconds: policy.operationLeaseSeconds,
    maxLifetimeSeconds: policy.maxOperationLifetimeSeconds,
    queueLimit: policy.productQueueLimit,
    accountQueueLimit: policy.accountQueueLimit,
    maxWaitSeconds: policy.queueWaitSeconds,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    ...(action === "acquire" ? { requestId, leaseId } : { leaseId })
  };
  let signed;
  try { signed = await signCoordinatorAssertion(assertion, secret); }
  catch { return json({ error: "operation_assertion_signing_failed" }, 503); }

  try {
    // One coordinator per product enforces the global cap across all accounts.
    const id = env.OPERATION_COORDINATOR.idFromName(productKey);
    const stub = env.OPERATION_COORDINATOR.get(id);
    const response = await stub.fetch("https://coordinator.internal/operation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, assertion: signed, input: {} })
    });
    const result = await response.json();
    if (!response.ok) return json({ error: result?.error || "operation_coordinator_failed" }, response.status);
    const status = action === "acquire" && result?.status === "denied" ? 409
      : action === "heartbeat" && result?.status === "not_found" ? 404
        : 200;
    return json({
      ...result,
      product_key: productKey,
      feature_key: featureKey,
      ...(action === "acquire" ? { request_id: requestId } : {})
    }, status);
  } catch {
    return json({ error: "operation_coordinator_unavailable" }, 503);
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
  } else if ((request.method === "GET" || request.method === "PUT") && /^\/v1\/admin\/products\/[a-z0-9-]+\/runtime-policy$/.test(url.pathname)) {
    response = await adminRuntimePolicy(request, env, url.pathname.split("/")[4]);
  } else if ((request.method === "GET" || request.method === "PUT") && /^\/v1\/admin\/accounts\/[^/]+\/products\/[a-z0-9-]+\/runtime-policy$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await adminAccountRuntimePolicy(request, env, decodeURIComponent(parts[4]), parts[6]);
  } else if (request.method === "POST" && /^\/v1\/admin\/products\/[a-z0-9-]+\/plans$/.test(url.pathname)) {
    response = await adminUpsertPlan(request, env, url.pathname.split("/")[4]);
  } else if (request.method === "GET" && /^\/v1\/admin\/products\/[a-z0-9-]+\/plans$/.test(url.pathname)) {
    response = await adminProductPlans(request, env, url.pathname.split("/")[4]);
  } else if (request.method === "GET" && /^\/v1\/admin\/accounts\/[^/]+\/subscriptions$/.test(url.pathname)) {
    response = await adminAccountSubscriptions(request, env, decodeURIComponent(url.pathname.split("/")[4]));
  } else if (request.method === "POST" && /^\/v1\/admin\/accounts\/[^/]+\/subscriptions$/.test(url.pathname)) {
    response = await adminCreateSubscription(request, env, decodeURIComponent(url.pathname.split("/")[4]));
  } else if (request.method === "PATCH" && /^\/v1\/admin\/subscriptions\/[^/]+$/.test(url.pathname)) {
    response = await adminUpdateSubscription(request, env, decodeURIComponent(url.pathname.split("/")[4]));
  } else if (request.method === "PATCH" && /^\/v1\/admin\/products\/[a-z0-9-]+\/plans\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await adminUpdatePlan(request, env, parts[4], decodeURIComponent(parts[6]));
  } else if (request.method === "GET" && url.pathname === "/v1/admin/accounts") {
    response = await adminAccountList(request, env);
  } else if (request.method === "GET" && /^\/v1\/admin\/accounts\/[^/]+\/grants$/.test(url.pathname)) {
    response = await adminAccountGrants(request, env, decodeURIComponent(url.pathname.split("/")[4]));
  } else if (request.method === "POST" && /^\/v1\/admin\/accounts\/[^/]+\/grants$/.test(url.pathname)) {
    response = await adminCreateGrant(request, env, decodeURIComponent(url.pathname.split("/")[4]));
  } else if (request.method === "PATCH" && /^\/v1\/admin\/grants\/[^/]+$/.test(url.pathname)) {
    response = await adminUpdateGrant(request, env, decodeURIComponent(url.pathname.split("/")[4]));
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
  } else if (request.method === "POST" && /^\/v1\/operations\/[a-z0-9-]+\/[a-z0-9][a-z0-9._-]{1,80}\/(acquire|heartbeat|release)$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    response = await coordinateOperation(request, env, parts[3], parts[4], parts[5]);
  } else if (request.method === "GET" && url.pathname === "/v1/me") {
    response = await currentUser(request, env);
  } else if (url.pathname === "/v1/auth/session") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  } else if (url.pathname === "/v1/me") {
    response = json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, PATCH, OPTIONS" });
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

export { handle, API_VERSION, databaseHealth, verifyFirebaseIdToken, resolveCentralIdentity, resolveFeatureAccess, incrementFeatureUsage };
export { OperationCoordinatorDO } from "./operation-coordinator-do.js";
