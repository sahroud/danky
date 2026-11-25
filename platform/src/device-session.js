const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const validProduct = value => typeof value === "string" && /^[a-z0-9-]{2,64}$/.test(value);
const validDeviceId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
const nowIso = () => new Date().toISOString();

async function accountFor(request, env, identity) {
  const rows = await env.CORE_DB.prepare(
    "SELECT p.id AS principal_id, a.id AS account_id FROM account_identities ai JOIN principals p ON p.id=ai.principal_id AND p.status='active' JOIN account_memberships am ON am.principal_id=p.id AND am.status='active' JOIN accounts a ON a.id=am.account_id AND a.status='active' WHERE ai.provider='firebase' AND ai.provider_subject=? ORDER BY am.created_at"
  ).bind(identity.subject).all();
  const active = rows.results || [];
  const requested = request.headers.get("X-Sahroud-Account-Id");
  if (requested) {
    const row = active.find(item => item.account_id === requested);
    if (!row) throw Object.assign(new Error("account_membership_required"), { status: 403 });
    return row;
  }
  if (!active.length) throw Object.assign(new Error("active_central_account_required"), { status: 403 });
  if (active.length > 1) throw Object.assign(new Error("account_selection_required"), { status: 409 });
  return active[0];
}

export async function loadEffectiveDeviceSessionPolicy(db, accountId, productKey) {
  const product = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account,session_lease_seconds FROM product_runtime_policies WHERE product_key=?"
  ).bind(productKey).first();
  if (!product) throw Object.assign(new Error("device_session_policy_not_configured"), { status: 503 });
  const override = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account FROM account_product_policy_overrides WHERE account_id=? AND product_key=?"
  ).bind(accountId, productKey).first();
  const cap = (base, tighter) => {
    const a = base == null ? null : Number(base);
    const b = tighter == null ? null : Number(tighter);
    if ((a !== null && (!Number.isSafeInteger(a) || a < 1)) ||
        (b !== null && (!Number.isSafeInteger(b) || b < 1))) throw new TypeError("invalid_device_session_policy");
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
  };
  const maxDevicesPerAccount = cap(product.max_devices_per_account, override?.max_devices_per_account);
  const maxSessionsPerAccount = cap(product.max_sessions_per_account, override?.max_sessions_per_account);
  const sessionLeaseSeconds = Number(product.session_lease_seconds);
  if (maxDevicesPerAccount === null || maxSessionsPerAccount === null ||
      !Number.isSafeInteger(sessionLeaseSeconds) || sessionLeaseSeconds < 30 || sessionLeaseSeconds > 86400) {
    throw Object.assign(new Error("device_session_policy_not_configured"), { status: 503 });
  }
  return { maxDevicesPerAccount, maxSessionsPerAccount, sessionLeaseSeconds };
}

async function tokenHash(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

/**
 * Device IDs identify app installations, not guaranteed physical hardware.
 * The caller must authenticate Firebase before calling this lifecycle handler.
 */
export async function handleDeviceSession(request, env, identity, productKey, resource, action) {
  if (!validProduct(productKey)) return json({ error: "invalid_product_key" }, 400);
  if (!env?.CORE_DB) return json({ error: "core_database_not_configured" }, 503);
  const product = await env.CORE_DB.prepare(
    "SELECT product_key FROM products WHERE product_key=? AND lifecycle_status<>'retired'"
  ).bind(productKey).first();
  if (!product) return json({ error: "product_not_found" }, 404);

  const account = await accountFor(request, env, identity);
  const now = nowIso();
  const parsedBody = request.method === "GET" ? {} : await readBody(request);
  const body = parsedBody || ((resource === "sessions" && (action === "heartbeat" || action === "close") &&
    request.headers.get("X-Sahroud-Session-Token")) ? {} : null);
  if (!body) return json({ error: "invalid_json_or_body" }, 400);

  let policy = null;
  if ((resource === "devices" && action === "register") ||
      (resource === "sessions" && (action === "open" || action === "heartbeat"))) {
    try { policy = await loadEffectiveDeviceSessionPolicy(env.CORE_DB, account.account_id, productKey); }
    catch (error) {
      return json({ error: error?.message === "device_session_policy_not_configured" ? error.message : "device_session_policy_invalid" }, 503);
    }
  }

  if (resource === "devices" && action === "register") {
    const deviceId = body.device_id;
    if (!validDeviceId(deviceId)) return json({ error: "valid_device_id_required" }, 400);
    const label = typeof body.device_label === "string" ? body.device_label.trim().slice(0, 80) : null;
    const platform = typeof body.platform === "string" ? body.platform.trim().slice(0, 40) : null;
    const result = await env.CORE_DB.prepare(
      "INSERT INTO account_product_devices (account_id,product_key,device_id,device_label,platform,status,first_seen_at,last_seen_at,created_at,updated_at) SELECT ?,?,?,?,?, 'active',?,?,?,? WHERE (SELECT COUNT(*) FROM account_product_devices WHERE account_id=? AND product_key=? AND status='active') < ? OR EXISTS (SELECT 1 FROM account_product_devices WHERE account_id=? AND product_key=? AND device_id=? AND status='active') ON CONFLICT(account_id,product_key,device_id) DO UPDATE SET device_label=excluded.device_label,platform=excluded.platform,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at,status='active' WHERE account_product_devices.status='active' OR (SELECT COUNT(*) FROM account_product_devices WHERE account_id=? AND product_key=? AND status='active') < ? RETURNING device_id"
    ).bind(account.account_id, productKey, deviceId, label, platform, now, now, now, now,
      account.account_id, productKey, policy.maxDevicesPerAccount,
      account.account_id, productKey, deviceId,
      account.account_id, productKey, policy.maxDevicesPerAccount).first();
    if (!result) return json({ registered: false, reason: "device_limit_reached", max_devices: policy.maxDevicesPerAccount }, 409);
    return json({ registered: true, device_id: result.device_id, max_devices: policy.maxDevicesPerAccount });
  }

  if (resource === "devices" && action === "list") {
    const rows = await env.CORE_DB.prepare(
      "SELECT device_id,device_label,platform,status,first_seen_at,last_seen_at,revoked_at FROM account_product_devices WHERE account_id=? AND product_key=? ORDER BY last_seen_at DESC"
    ).bind(account.account_id, productKey).all();
    return json({ devices: rows.results || [], max_devices: policy.maxDevicesPerAccount });
  }

  if (resource === "devices" && action === "revoke") {
    if (!validDeviceId(body.device_id)) return json({ error: "valid_device_id_required" }, 400);
    await env.CORE_DB.batch([
      env.CORE_DB.prepare("UPDATE account_product_devices SET status='revoked',revoked_at=?,updated_at=? WHERE account_id=? AND product_key=? AND device_id=? AND status='active'").bind(now, now, account.account_id, productKey, body.device_id),
      env.CORE_DB.prepare("UPDATE account_product_sessions SET status='revoked',revoked_at=?,updated_at=? WHERE account_id=? AND product_key=? AND device_id=? AND status='active'").bind(now, now, account.account_id, productKey, body.device_id)
    ]);
    return json({ revoked: true, device_id: body.device_id });
  }

  if (resource === "sessions" && action === "open") {
    if (!validDeviceId(body.device_id)) return json({ error: "valid_device_id_required" }, 400);
    const sessionId = crypto.randomUUID();
    const rawTokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const rawToken = [...rawTokenBytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hash = await tokenHash(rawToken);
    const expiresAt = new Date(Date.now() + policy.sessionLeaseSeconds * 1000).toISOString();
    const inserted = await env.CORE_DB.prepare(
      "INSERT INTO account_product_sessions (session_id,account_id,product_key,principal_id,device_id,token_hash,status,issued_at,expires_at,last_seen_at,created_at,updated_at) SELECT ?,?,?,?,?,?,'active',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_product_devices d WHERE d.account_id=? AND d.product_key=? AND d.device_id=? AND d.status='active') AND (SELECT COUNT(*) FROM account_product_sessions s WHERE s.account_id=? AND s.product_key=? AND s.status='active' AND s.expires_at>?) < ? AND EXISTS (SELECT 1 FROM account_memberships am WHERE am.account_id=? AND am.principal_id=? AND am.status='active') RETURNING session_id"
    ).bind(sessionId, account.account_id, productKey, account.principal_id, body.device_id, hash,
      now, expiresAt, now, now, now,
      account.account_id, productKey, body.device_id,
      account.account_id, productKey, now, policy.maxSessionsPerAccount,
      account.account_id, account.principal_id).first();
    if (!inserted) {
      const device = await env.CORE_DB.prepare("SELECT status FROM account_product_devices WHERE account_id=? AND product_key=? AND device_id=?").bind(account.account_id, productKey, body.device_id).first();
      if (!device || device.status !== "active") return json({ error: "active_device_required" }, 403);
      return json({ opened: false, reason: "session_limit_reached", max_sessions: policy.maxSessionsPerAccount }, 409);
    }
    return json({ opened: true, session_id: sessionId, session_token: rawToken, expires_at: expiresAt, lease_seconds: policy.sessionLeaseSeconds });
  }

  if (resource === "sessions" && (action === "heartbeat" || action === "close")) {
    const rawToken = request.headers.get("X-Sahroud-Session-Token") || body.session_token;
    if (typeof rawToken !== "string" || !/^[a-f0-9]{64}$/.test(rawToken)) return json({ error: "valid_session_token_required" }, 400);
    const hash = await tokenHash(rawToken);
    if (action === "heartbeat") {
      const expiresAt = new Date(Date.now() + policy.sessionLeaseSeconds * 1000).toISOString();
      const updated = await env.CORE_DB.prepare(
        "UPDATE account_product_sessions SET expires_at=?,last_seen_at=?,updated_at=? WHERE account_id=? AND product_key=? AND token_hash=? AND status='active' AND expires_at>? AND EXISTS (SELECT 1 FROM account_product_devices d WHERE d.account_id=account_product_sessions.account_id AND d.product_key=account_product_sessions.product_key AND d.device_id=account_product_sessions.device_id AND d.status='active') RETURNING session_id,expires_at"
      ).bind(expiresAt, now, now, account.account_id, productKey, hash, now).first();
      if (!updated) return json({ heartbeat: false, reason: "session_not_active" }, 404);
      return json({ heartbeat: true, session_id: updated.session_id, expires_at: updated.expires_at, lease_seconds: policy.sessionLeaseSeconds });
    }
    const closed = await env.CORE_DB.prepare(
      "UPDATE account_product_sessions SET status='revoked',revoked_at=?,updated_at=? WHERE account_id=? AND product_key=? AND token_hash=? AND status='active' RETURNING session_id"
    ).bind(now, now, account.account_id, productKey, hash).first();
    return json({ closed: Boolean(closed), session_id: closed?.session_id || null });
  }

  return json({ error: "not_found" }, 404);
}
