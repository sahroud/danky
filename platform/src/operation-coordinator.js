/**
 * Deterministic operation-lease state transitions.
 * Storage/serialization is supplied by the Durable Object wrapper; this module
 * never trusts limits from a client and performs no I/O.
 */
export function emptyCoordinatorState() {
  return { leases: {}, queue: {}, nextSequence: 1 };
}

function purge(state, now) {
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.expiresAt <= now || lease.revoked) delete state.leases[id];
  }
  for (const [id, entry] of Object.entries(state.queue)) {
    if (entry.expiresAt <= now) delete state.queue[id];
  }
}

function validatePolicy(input) {
  const { cap, leaseSeconds, maxLifetimeSeconds, queueLimit = 0, maxWaitSeconds = 0 } = input;
  return Number.isSafeInteger(cap) && cap >= 1 &&
    Number.isSafeInteger(leaseSeconds) && leaseSeconds >= 1 &&
    Number.isSafeInteger(maxLifetimeSeconds) && maxLifetimeSeconds >= leaseSeconds &&
    Number.isSafeInteger(queueLimit) && queueLimit >= 0 &&
    Number.isSafeInteger(maxWaitSeconds) && maxWaitSeconds >= 0;
}

function scopedRequestKey(accountId, productKey, requestId) {
  return JSON.stringify([accountId, productKey, requestId]);
}

function leaseIdInUse(state, leaseId) {
  return Boolean(state.leases[leaseId]) ||
    Object.values(state.queue).some((entry) => entry.leaseId === leaseId);
}

function promote(state, now, cap, leaseSeconds, maxLifetimeSeconds) {
  while (Object.keys(state.leases).length < cap) {
    const next = Object.entries(state.queue)
      .sort((a, b) => a[1].sequence - b[1].sequence)[0];
    if (!next) break;
    const [requestKey, entry] = next;
    delete state.queue[requestKey];
    if (entry.expiresAt <= now || entry.maxExpiresAt <= now) continue;
    state.leases[entry.leaseId] = {
      leaseId: entry.leaseId, requestId: entry.requestId, requestKey,
      accountId: entry.accountId, productKey: entry.productKey,
      createdAt: now, expiresAt: Math.min(now + leaseSeconds, entry.maxExpiresAt),
      maxExpiresAt: entry.maxExpiresAt
    };
  }
}

export function acquire(state, input) {
  const { now, accountId, productKey, requestId, leaseId,
    cap, leaseSeconds, maxLifetimeSeconds, queueLimit = 0, maxWaitSeconds = 0 } = input;
  if (!Number.isSafeInteger(now) || typeof accountId !== "string" || !accountId ||
      typeof productKey !== "string" || !productKey ||
      typeof requestId !== "string" || !requestId ||
      typeof leaseId !== "string" || !leaseId || !validatePolicy(input)) {
    return { status: "denied", reason: "invalid_request_or_policy" };
  }
  purge(state, now);
  // Always honor an older FIFO waiter before admitting a new request after expiry.
  promote(state, now, cap, leaseSeconds, maxLifetimeSeconds);
  const requestKey = scopedRequestKey(accountId, productKey, requestId);
  const existing = Object.values(state.leases).find(x => x.requestKey === requestKey);
  if (existing) return { status: "granted", lease: { ...existing }, idempotent: true };
  const queued = state.queue[requestKey];
  if (queued) return { status: "queued", position: queuePosition(state, requestKey) };
  if (leaseIdInUse(state, leaseId)) return { status: "denied", reason: "lease_id_conflict" };
  if (Object.keys(state.leases).length < cap) {
    const lease = {
      leaseId, requestId, requestKey, accountId, productKey, createdAt: now,
      expiresAt: now + leaseSeconds, maxExpiresAt: now + maxLifetimeSeconds
    };
    state.leases[leaseId] = lease;
    return { status: "granted", lease: { ...lease }, idempotent: false };
  }
  if (Object.keys(state.queue).length >= queueLimit || maxWaitSeconds <= 0) {
    return { status: "denied", reason: "capacity_full" };
  }
  state.queue[requestKey] = {
    requestId, requestKey, leaseId, accountId, productKey, sequence: state.nextSequence++,
    expiresAt: now + maxWaitSeconds, maxExpiresAt: now + maxLifetimeSeconds
  };
  return { status: "queued", position: queuePosition(state, requestKey) };
}

function queuePosition(state, requestKey) {
  return Object.entries(state.queue)
    .sort((a, b) => a[1].sequence - b[1].sequence)
    .findIndex(([key]) => key === requestKey) + 1;
}

export function heartbeat(state, input) {
  const { now, leaseId, leaseSeconds, maxLifetimeSeconds } = input;
  if (!Number.isSafeInteger(now) || typeof leaseId !== "string" || !leaseId ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 ||
      !Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1) {
    return { status: "invalid_request" };
  }
  purge(state, now);
  const lease = state.leases[leaseId];
  if (!lease || lease.accountId !== input.accountId || lease.productKey !== input.productKey) return { status: "not_found" };
  lease.expiresAt = Math.min(now + leaseSeconds, lease.createdAt + maxLifetimeSeconds, lease.maxExpiresAt);
  return lease.expiresAt <= now
    ? { status: "max_lifetime" }
    : { status: "renewed", lease: { ...lease } };
}

export function release(state, input) {
  const { now, leaseId, cap, leaseSeconds, maxLifetimeSeconds } = input;
  if (!Number.isSafeInteger(now) || typeof leaseId !== "string" || !leaseId ||
      !validatePolicy({ ...input, queueLimit: 0, maxWaitSeconds: 0 })) {
    return { status: "invalid_request" };
  }
  purge(state, now);
  const lease = state.leases[leaseId];
  const existed = Boolean(lease && lease.accountId === input.accountId && lease.productKey === input.productKey);
  if (existed) delete state.leases[leaseId];
  promote(state, now, cap, leaseSeconds, maxLifetimeSeconds);
  return { status: "released", existed };
}

export function revoke(state, input) {
  const { now, accountId, productKey, leaseId, cap, leaseSeconds, maxLifetimeSeconds } = input;
  if (!Number.isSafeInteger(now) || !validatePolicy({ ...input, queueLimit: 0, maxWaitSeconds: 0 }) ||
      (!leaseId && !accountId) ||
      (accountId !== undefined && (typeof accountId !== "string" || !accountId)) ||
      (productKey !== undefined && (typeof productKey !== "string" || !productKey))) {
    return { status: "invalid_request", count: 0, queuedCancelled: 0 };
  }
  purge(state, now);
  let revoked = 0;
  for (const [id, lease] of Object.entries(state.leases)) {
    if ((leaseId && id === leaseId) ||
      (accountId && lease.accountId === accountId && (!productKey || lease.productKey === productKey))) {
      delete state.leases[id];
      revoked++;
    }
  }
  let queuedCancelled = 0;
  if (accountId) {
    for (const [key, entry] of Object.entries(state.queue)) {
      if (entry.accountId === accountId && (!productKey || entry.productKey === productKey)) {
        delete state.queue[key];
        queuedCancelled++;
      }
    }
  }
  promote(state, now, cap, leaseSeconds, maxLifetimeSeconds);
  return { status: "revoked", count: revoked, queuedCancelled };
}

export function expireAndPromote(state, input) {
  if (!Number.isSafeInteger(input.now) ||
      !validatePolicy({ ...input, queueLimit: 0, maxWaitSeconds: 0 })) {
    return { active: Object.keys(state.leases).length, queued: Object.keys(state.queue).length, error: "invalid_policy" };
  }
  purge(state, input.now);
  promote(state, input.now, input.cap, input.leaseSeconds, input.maxLifetimeSeconds);
  return { active: Object.keys(state.leases).length, queued: Object.keys(state.queue).length };
}
