import {
  emptyCoordinatorState, acquire, heartbeat, release, revoke, expireAndPromote
} from "./operation-coordinator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACTIONS = new Set(["acquire", "heartbeat", "release", "revoke", "sweep"]);

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_assertion");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function hmacKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("assertion_secret_not_configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signCoordinatorAssertion(payload, secret) {
  const key = await hmacKey(secret);
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return encoded + "." + base64UrlEncode(new Uint8Array(signature));
}
async function verifyAssertion(token, secret, now, action) {
  if (typeof token !== "string" || token.length > 4096) throw new Error("invalid_assertion");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("invalid_assertion");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(parts[1]), encoder.encode(parts[0]));
  if (!valid) throw new Error("invalid_assertion_signature");
  let payload;
  try { payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0]))); }
  catch { throw new Error("invalid_assertion_payload"); }
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 128;
  const operationBindingValid =
    (action === "acquire" && validId(payload?.requestId) && validId(payload?.leaseId)) ||
    ((action === "heartbeat" || action === "release") && validId(payload?.leaseId)) ||
    (action === "revoke" && validId(payload?.accountId) && validId(payload?.productKey)) ||
    (action === "sweep" && validId(payload?.accountId) && validId(payload?.productKey));
  if (!payload || payload.action !== action || !ACTIONS.has(action) || !operationBindingValid ||
      typeof payload.accountId !== "string" || !payload.accountId ||
      typeof payload.productKey !== "string" || !/^[a-z0-9-]{2,64}$/.test(payload.productKey) ||
      !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now ||
      !Number.isSafeInteger(payload.cap) || payload.cap < 1 ||
      !Number.isSafeInteger(payload.accountCap) || payload.accountCap < 1 ||
      !Number.isSafeInteger(payload.leaseSeconds) || payload.leaseSeconds < 1 ||
      !Number.isSafeInteger(payload.maxLifetimeSeconds) || payload.maxLifetimeSeconds < payload.leaseSeconds ||
      !Number.isSafeInteger(payload.queueLimit) || payload.queueLimit < 0 ||
      !Number.isSafeInteger(payload.maxWaitSeconds) || payload.maxWaitSeconds < 0) {
    throw new Error("invalid_assertion_scope_or_policy");
  }
  return payload;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

/** Internal-only Durable Object. No public route or namespace binding is enabled yet. */
export class OperationCoordinatorDO {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async refreshAlarm() {
    const state = await this.ctx.storage.get("coordinator-state") || emptyCoordinatorState();
    const deadlines = [
      ...Object.values(state.leases).map(lease => lease.expiresAt),
      ...Object.values(state.queue).flatMap(entry => [entry.expiresAt, entry.maxExpiresAt])
    ].filter(Number.isSafeInteger);
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextAlarm = Math.max(Date.now() + 1, Math.min(...deadlines) * 1000);
    const currentAlarm = await this.ctx.storage.getAlarm();
    // Keeping an earlier alarm is safe: it will re-check state and schedule the next deadline.
    if (currentAlarm === null || nextAlarm < currentAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async alarm() {
    const policy = await this.ctx.storage.get("coordinator-policy");
    if (!policy) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get("coordinator-state") || emptyCoordinatorState();
      expireAndPromote(state, { ...policy, now });
      await transaction.put("coordinator-state", state);
    });
    await this.refreshAlarm();
  }

  async fetch(request) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }
    const action = body?.action;
    if (typeof this.env?.OPERATION_ASSERTION_SECRET !== "string" || this.env.OPERATION_ASSERTION_SECRET.length < 32) {
      return json({ error: "coordinator_not_configured" }, 503);
    }
    const now = Math.floor(Date.now() / 1000);
    let assertion;
    try { assertion = await verifyAssertion(body?.assertion, this.env?.OPERATION_ASSERTION_SECRET, now, action); }
    catch (error) {
      const code = error?.message === "assertion_secret_not_configured" ? "coordinator_not_configured" : "invalid_internal_assertion";
      return json({ error: code }, code === "coordinator_not_configured" ? 503 : 401);
    }
    const requestInput = body?.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
    const input = {
      ...requestInput, now,
      accountId: assertion.accountId, productKey: assertion.productKey,
      cap: assertion.cap, accountCap: assertion.accountCap, leaseSeconds: assertion.leaseSeconds,
      maxLifetimeSeconds: assertion.maxLifetimeSeconds,
      queueLimit: assertion.queueLimit, maxWaitSeconds: assertion.maxWaitSeconds,
      ...(action === "acquire" ? { requestId: assertion.requestId, leaseId: assertion.leaseId } : {}),
      ...((action === "heartbeat" || action === "release") ? { leaseId: assertion.leaseId } : {}),
      ...(action === "revoke" ? { leaseId: undefined } : {})
    };
    try {
      const result = await this.ctx.storage.transaction(async transaction => {
        const state = await transaction.get("coordinator-state") || emptyCoordinatorState();
        let outcome;
        if (action === "acquire") outcome = acquire(state, input);
        else if (action === "heartbeat") outcome = heartbeat(state, input);
        else if (action === "release") outcome = release(state, input);
        else if (action === "revoke") outcome = revoke(state, input);
        else outcome = expireAndPromote(state, input);
        await transaction.put("coordinator-state", state);
        await transaction.put("coordinator-policy", {
          cap: assertion.cap,
          accountCap: assertion.accountCap,
          leaseSeconds: assertion.leaseSeconds,
          maxLifetimeSeconds: assertion.maxLifetimeSeconds
        });
        return outcome;
      });
      await this.refreshAlarm();
      return json(result);
    } catch {
      return json({ error: "coordinator_storage_unavailable" }, 503);
    }
  }
}
