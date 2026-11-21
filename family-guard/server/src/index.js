const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const randomToken = (bytes = 32) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
};
const hash = async value => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
};
const body = async request => {
  try { return await request.json(); } catch { return null; }
};
const bearer = request => {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
};

async function parentAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const member = await env.DB.prepare(
    `SELECT m.id AS member_id, m.family_id AS id, m.role, m.subscription_status,
      m.subscription_expires_at, f.parent_label
     FROM family_members m JOIN families f ON f.id = m.family_id
     WHERE m.token_hash = ? AND m.status = 'active'`
  ).bind(await hash(token)).first();
  return member || null;
}

const ownerOnly = family => family?.role === "owner";
const paidParentActive = family => family?.role === "owner" ||
  (family?.role === "second_parent" &&
   family.subscription_status === "active" &&
   (!family.subscription_expires_at || family.subscription_expires_at > now()));

async function deviceAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT id, family_id, label, sharing_enabled FROM devices WHERE device_token_hash = ?"
  ).bind(await hash(token)).first();
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  let response;
  if (url.pathname === "/health" && request.method === "GET") {
    response = json({ service: "SAHROUD FAMILY GUARD API", status: "ok" });
  } else if (url.pathname === "/v1/families" && request.method === "POST") {
    const input = await body(request);
    const label = String(input?.parent_label || "").trim().slice(0, 80);
    if (!label) response = json({ error: "parent_label_required" }, 400);
    else {
      const familyId = id();
      const parentToken = randomToken();
      const tokenHash = await hash(parentToken);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO families (id, parent_label, parent_token_hash, created_at) VALUES (?, ?, ?, ?)"
        ).bind(familyId, label, tokenHash, now()),
        env.DB.prepare(
          "INSERT INTO family_members (id, family_id, role, label, token_hash, status, subscription_status, created_at) VALUES (?, ?, 'owner', ?, ?, 'active', 'included', ?)"
        ).bind(id(), familyId, label, tokenHash, now())
      ]);
      response = json({
        family_id: familyId,
        parent_token: parentToken,
        message: "این کلید فقط یک بار نمایش داده می‌شود؛ آن را محرمانه نگه دارید."
      }, 201);
    }
  } else if (url.pathname === "/v1/parents/invite" && request.method === "POST") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else if (!ownerOnly(family)) response = json({ error: "owner_required" }, 403);
    else {
      const code = randomToken(4).toUpperCase();
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO parent_invites (code_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      ).bind(await hash(code), family.id, expires, now()).run();
      response = json({
        invite_code: code, expires_at: expires, role: "second_parent",
        subscription_required: true, single_use: true
      }, 201);
    }
  } else if (url.pathname === "/v1/parents/accept" && request.method === "POST") {
    const input = await body(request);
    const code = String(input?.invite_code || "").trim().toUpperCase();
    const label = String(input?.parent_label || "").trim().slice(0, 80);
    if (!code || !label || input?.consent !== true) {
      response = json({ error: "invite_label_and_explicit_consent_required" }, 400);
    } else {
      const codeHash = await hash(code);
      const invite = await env.DB.prepare(
        "SELECT code_hash, family_id, expires_at, used_at FROM parent_invites WHERE code_hash = ?"
      ).bind(codeHash).first();
      if (!invite || invite.used_at || invite.expires_at <= now()) {
        response = json({ error: "invite_invalid_expired_or_used" }, 400);
      } else {
        const parentToken = randomToken();
        const timestamp = now();
        const used = await env.DB.prepare(
          "UPDATE parent_invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?"
        ).bind(timestamp, codeHash, timestamp).run();
        if (!used.meta?.changes) response = json({ error: "invite_already_used" }, 409);
        else {
          await env.DB.prepare(
            "INSERT INTO family_members (id, family_id, role, label, token_hash, status, subscription_status, created_at) VALUES (?, ?, 'second_parent', ?, ?, 'active', 'inactive', ?)"
          ).bind(id(), invite.family_id, label, await hash(parentToken), timestamp).run();
          response = json({
            parent_token: parentToken, role: "second_parent",
            subscription_status: "inactive",
            message: "حساب والد دوم ایجاد شد؛ برای مشاهده موقعیت‌ها اشتراک مستقل والد دوم باید فعال شود."
          }, 201);
        }
      }
    }
  } else if (url.pathname === "/v1/family/subscription" && request.method === "GET") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else response = json({
      role: family.role,
      subscription_status: family.subscription_status,
      subscription_expires_at: family.subscription_expires_at || null,
      second_parent_subscription: "separate_paid_subscription"
    });
  } else if (url.pathname === "/v1/invites" && request.method === "POST") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else if (!ownerOnly(family)) response = json({ error: "owner_required" }, 403);
    else if (!paidParentActive(family)) response = json({ error: "subscription_inactive", subscription_required: true }, 402);
    else {
      const code = randomToken(4).toUpperCase();
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO invites (code_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      ).bind(await hash(code), family.id, expires, now()).run();
      response = json({ invite_code: code, expires_at: expires, single_use: true }, 201);
    }
  } else if (url.pathname === "/v1/devices/pair" && request.method === "POST") {
    const input = await body(request);
    const code = String(input?.invite_code || "").trim().toUpperCase();
    const label = String(input?.device_label || "").trim().slice(0, 80);
    if (!code || !label || input?.consent !== true) {
      response = json({ error: "valid_invite_device_label_and_explicit_consent_required" }, 400);
    } else {
      const inviteHash = await hash(code);
      const invite = await env.DB.prepare(
        "SELECT code_hash, family_id, expires_at, used_at FROM invites WHERE code_hash = ?"
      ).bind(inviteHash).first();
      if (!invite || invite.used_at || invite.expires_at <= now()) {
        response = json({ error: "invite_invalid_expired_or_used" }, 400);
      } else {
        const deviceId = id();
        const deviceToken = randomToken();
        const timestamp = now();
        const used = await env.DB.prepare(
          "UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?"
        ).bind(timestamp, inviteHash, timestamp).run();
        if (!used.meta?.changes) response = json({ error: "invite_already_used" }, 409);
        else {
          await env.DB.prepare(
            "INSERT INTO devices (id, family_id, label, device_token_hash, consented_at, sharing_enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
          ).bind(deviceId, invite.family_id, label, await hash(deviceToken), timestamp, timestamp).run();
          response = json({
            device_id: deviceId,
            device_token: deviceToken,
            sharing_enabled: true,
            consented_at: timestamp,
            notice: "اشتراک‌گذاری مکان فعال است و هر زمان از داخل برنامه قابل توقف است."
          }, 201);
        }
      }
    }
  } else if (url.pathname === "/v1/location" && request.method === "POST") {
    const device = await deviceAuth(request, env);
    const input = await body(request);
    const lat = Number(input?.latitude);
    const lon = Number(input?.longitude);
    const accuracy = input?.accuracy_m == null ? null : Number(input.accuracy_m);
    if (!device) response = json({ error: "unauthorized" }, 401);
    else if (!device.sharing_enabled) response = json({ error: "sharing_disabled" }, 403);
    else if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
             !Number.isFinite(lon) || lon < -180 || lon > 180 ||
             (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))) {
      response = json({ error: "invalid_coordinates_or_accuracy" }, 400);
    } else {
      const recordedAt = input?.recorded_at && !Number.isNaN(Date.parse(input.recorded_at))
        ? new Date(input.recorded_at).toISOString() : now();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO locations (device_id, latitude, longitude, accuracy_m, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(device.id, lat, lon, accuracy, recordedAt, now()),
        env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now(), device.id)
      ]);
      response = json({ accepted: true, recorded_at: recordedAt });
    }
  } else if (url.pathname === "/v1/family/devices" && request.method === "GET") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else if (!paidParentActive(family)) response = json({ error: "subscription_inactive", subscription_required: true }, 402);
    else {
      const result = await env.DB.prepare(
        `SELECT d.id, d.label, d.sharing_enabled, d.consented_at, d.last_seen_at,
          (SELECT l.latitude FROM locations l WHERE l.device_id = d.id ORDER BY l.recorded_at DESC LIMIT 1) AS latitude,
          (SELECT l.longitude FROM locations l WHERE l.device_id = d.id ORDER BY l.recorded_at DESC LIMIT 1) AS longitude,
          (SELECT l.accuracy_m FROM locations l WHERE l.device_id = d.id ORDER BY l.recorded_at DESC LIMIT 1) AS accuracy_m,
          (SELECT l.recorded_at FROM locations l WHERE l.device_id = d.id ORDER BY l.recorded_at DESC LIMIT 1) AS location_recorded_at,
          (SELECT l.received_at FROM locations l WHERE l.device_id = d.id ORDER BY l.recorded_at DESC LIMIT 1) AS location_received_at
         FROM devices d WHERE d.family_id = ? ORDER BY d.created_at`
      ).bind(family.id).all();
      response = json({ family: { id: family.id, parent_label: family.parent_label }, devices: result.results || [] });
    }
  } else if (url.pathname.startsWith("/v1/family/devices/") && url.pathname.endsWith("/locations") && request.method === "GET") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else if (!paidParentActive(family)) response = json({ error: "subscription_inactive", subscription_required: true }, 402);
    else {
      const deviceId = url.pathname.split("/")[4];
      const device = await env.DB.prepare(
        "SELECT id, label FROM devices WHERE id = ? AND family_id = ?"
      ).bind(deviceId, family.id).first();
      if (!device) response = json({ error: "device_not_found" }, 404);
      else {
        const requested = Number(url.searchParams.get("limit") || 100);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
        const rows = await env.DB.prepare(
          "SELECT latitude, longitude, accuracy_m, recorded_at, received_at FROM locations WHERE device_id = ? ORDER BY recorded_at DESC LIMIT ?"
        ).bind(deviceId, limit).all();
        response = json({ device, locations: rows.results || [] });
      }
    }
  } else if (url.pathname === "/v1/devices/sharing/stop" && request.method === "POST") {
    const device = await deviceAuth(request, env);
    if (!device) response = json({ error: "unauthorized" }, 401);
    else {
      await env.DB.prepare("UPDATE devices SET sharing_enabled = 0 WHERE id = ?").bind(device.id).run();
      response = json({ sharing_enabled: false, stopped_at: now() });
    }
  } else if (url.pathname.startsWith("/v1/family/devices/") && url.pathname.endsWith("/revoke") && request.method === "POST") {
    const family = await parentAuth(request, env);
    if (!family) response = json({ error: "unauthorized" }, 401);
    else if (!ownerOnly(family)) response = json({ error: "owner_required" }, 403);
    else {
      const deviceId = url.pathname.split("/")[4];
      const result = await env.DB.prepare(
        "UPDATE devices SET sharing_enabled = 0 WHERE id = ? AND family_id = ?"
      ).bind(deviceId, family.id).run();
      response = result.meta?.changes
        ? json({ sharing_enabled: false, revoked: true })
        : json({ error: "device_not_found" }, 404);
    }
  } else {
    response = json({ error: "not_found" }, 404);
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGIN || "";
  const headers = { "vary": "Origin" };
  if (origin && allowed && origin === allowed) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-allow-headers"] = "Content-Type, Authorization";
  }
  return headers;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      return json({ error: "internal_error" }, 500);
    }
  }
};
