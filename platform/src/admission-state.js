// Pure admission state transitions. A Durable Object wrapper must serialize calls and persist this state.
export function createAdmissionState() {
  return { leases: {}, requests: {}, queue: [], nextSequence: 1, revokedAccounts: {} };
}

export function sweepExpired(state, now) {
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.expiresAt <= now || lease.maxExpiresAt <= now) delete state.leases[id];
  }
  state.queue = state.queue.filter((item) => item.expiresAt > now);
  return state;
}

export function acquire(state, input, now) {
  sweepExpired(state, now);
  const { leaseId, requestKey, accountId, productKey, limit, leaseSeconds, maxLifetimeSeconds } = input;
  if (!leaseId || !requestKey || !accountId || !productKey) return { ok: false, code: "INVALID_REQUEST" };
  if (![limit, leaseSeconds, maxLifetimeSeconds].every(Number.isSafeInteger) || limit < 1 || leaseSeconds < 1 || maxLifetimeSeconds < leaseSeconds) {
    return { ok: false, code: "INVALID_POLICY" };
  }
  const priorId = state.requests[requestKey];
  if (priorId && state.leases[priorId]) return { ok: true, lease: state.leases[priorId], idempotent: true };
  if (state.revokedAccounts[accountId + ":" + productKey]) return { ok: false, code: "REVOKED" };
  const active = Object.values(state.leases).filter((lease) => lease.accountId === accountId && lease.productKey === productKey);
  if (active.length >= limit) return { ok: false, code: "CAPACITY" };
  const lease = { leaseId, requestKey, accountId, productKey, createdAt: now, expiresAt: now + leaseSeconds * 1000, maxExpiresAt: now + maxLifetimeSeconds * 1000 };
  state.leases[leaseId] = lease;
  state.requests[requestKey] = leaseId;
  return { ok: true, lease, idempotent: false };
}

export function renew(state, leaseId, leaseSeconds, now) {
  sweepExpired(state, now);
  const lease = state.leases[leaseId];
  if (!lease) return { ok: false, code: "LEASE_NOT_FOUND" };
  if (state.revokedAccounts[lease.accountId + ":" + lease.productKey]) return { ok: false, code: "REVOKED" };
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) return { ok: false, code: "INVALID_POLICY" };
  lease.expiresAt = Math.min(now + leaseSeconds * 1000, lease.maxExpiresAt);
  if (lease.expiresAt <= now) return { ok: false, code: "MAX_LIFETIME" };
  return { ok: true, lease };
}

export function release(state, leaseId, now) {
  sweepExpired(state, now);
  const existed = Boolean(state.leases[leaseId]);
  delete state.leases[leaseId];
  return { ok: true, released: existed };
}

export function revokeAccountProduct(state, accountId, productKey, now) {
  sweepExpired(state, now);
  state.revokedAccounts[accountId + ":" + productKey] = now;
  let revoked = 0;
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.accountId === accountId && lease.productKey === productKey) {
      delete state.leases[id];
      revoked++;
    }
  }
  return { ok: true, revoked };
}
