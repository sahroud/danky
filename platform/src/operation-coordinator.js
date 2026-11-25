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

function promote(state, now, cap, leaseSeconds, maxLifetimeSeconds) {
  while (Object.keys(state.leases).length < cap) {
    const next = Object.entries(state.queue)
      .sort((a, b) => a[1].sequence - b[1].sequence)[0];
    if (!next) break;
    const [requestId, entry] = next;
    delete state.queue[requestId];
    if (entry.expiresAt <= now) continue;
    const leaseId = entry.leaseId;
    state.leases[leaseId] = {
      leaseId, requestId, accountId: entry.accountId, productKey: entry.productKey,
      createdAt: now, expiresAt: Math.min(now + leaseSeconds, entry.maxExpiresAt),
      maxExpiresAt: entry.maxExpiresAt
    };
  }
}

export function acquire(state, input) {
  const { now, accountId, productKey, requestId, leaseId, cap, leaseSeconds,
    maxLifetimeSeconds, queueLimit = 0, maxWaitSeconds = 0 } = input;
  purge(state, now);
  const existing = Object.values(state.leases).find(x => x.requestId === requestId);
  if (existing) return { status: "granted", lease: { ...existing }, idempotent: true };
  const queued = state.queue[requestId];
  if (queued) return { status: "queued", position: queuePosition(state, requestId) };
  if (Object.keys(state.leases).length < cap) {
    const lease = {
      leaseId, requestId, accountId, productKey, createdAt: now,
      expiresAt: now + leaseSeconds, maxExpiresAt: now + maxLifetimeSeconds
    };
    state.leases[leaseId] = lease;
    return { status: "granted", lease: { ...lease }, idempotent: false };
  }
  if (Object.keys(state.queue).length >= queueLimit || maxWaitSeconds <= 0) {
    return { status: "denied", reason: "capacity_full" };
  }
  state.queue[requestId] = {
    requestId, leaseId, accountId, productKey, sequence: state.nextSequence++,
    expiresAt: now + maxWaitSeconds, maxExpiresAt: now + maxLifetimeSeconds
  };
  return { status: "queued", position: queuePosition(state, requestId) };
}

function queuePosition(state, requestId) {
  return Object.entries(state.queue)
    .sort((a, b) => a[1].sequence - b[1].sequence)
    .findIndex(([id]) => id === requestId) + 1;
}

export function heartbeat(state, input) {
  const { now, leaseId, leaseSeconds, maxLifetimeSeconds } = input;
  purge(state, now);
  const lease = state.leases[leaseId];
  if (!lease) return { status: "not_found" };
  lease.expiresAt = Math.min(now + leaseSeconds, lease.createdAt + maxLifetimeSeconds, lease.maxExpiresAt);
  return { status: "renewed", lease: { ...lease } };
}

export function release(state, input) {
  const { now, leaseId, cap, leaseSeconds, maxLifetimeSeconds } = input;
  purge(state, now);
  const existed = Boolean(state.leases[leaseId]);
  delete state.leases[leaseId];
  promote(state, now, cap, leaseSeconds, maxLifetimeSeconds);
  return { status: "released", existed };
}

export function revoke(state, input) {
  const { now, accountId, productKey, leaseId, cap, leaseSeconds, maxLifetimeSeconds } = input;
  purge(state, now);
  let revoked = 0;
  for (const [id, lease] of Object.entries(state.leases)) {
    if ((leaseId && id === leaseId) ||
      (accountId && lease.accountId === accountId && (!productKey || lease.productKey === productKey))) {
      delete state.leases[id];
      revoked++;
    }
  }
  promote(state, now, cap, leaseSeconds, maxLifetimeSeconds);
  return { status: "revoked", count: revoked };
}

export function expireAndPromote(state, input) {
  purge(state, input.now);
  promote(state, input.now, input.cap, input.leaseSeconds, input.maxLifetimeSeconds);
  return { active: Object.keys(state.leases).length, queued: Object.keys(state.queue).length };
}
