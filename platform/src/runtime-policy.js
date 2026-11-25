const positiveOrNull = value =>
  value === null || value === undefined
    ? null
    : Number.isSafeInteger(value) && value >= 1
      ? value
      : undefined;

const nonNegativeOrNull = value =>
  value === null || value === undefined
    ? null
    : Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;

function effectiveCeiling(productValue, accountValue) {
  const product = positiveOrNull(productValue);
  const account = positiveOrNull(accountValue);
  if (product === undefined || account === undefined) {
    throw new TypeError("invalid_runtime_policy_value");
  }
  if (product === null) return account;
  if (account === null) return product;
  return Math.min(product, account);
}

function effectiveQueueLimit(productValue, accountValue) {
  const product = nonNegativeOrNull(productValue);
  const account = nonNegativeOrNull(accountValue);
  if (product === undefined || account === undefined) {
    throw new TypeError("invalid_runtime_policy_value");
  }
  if (product === null) return account ?? 0;
  if (account === null) return product;
  return Math.min(product, account);
}

/**
 * Account overrides may tighten product policy but can never raise its ceilings.
 * A null product operation cap means the product has not enabled admission control;
 * callers must fail closed rather than inventing an unlimited or arbitrary cap.
 */
export function resolveEffectiveRuntimePolicy(productPolicy, accountOverride = null) {
  if (!productPolicy) throw new TypeError("product_runtime_policy_required");
  const maxConcurrentOperations = effectiveCeiling(
    productPolicy.max_concurrent_operations,
    accountOverride?.max_concurrent_operations
  );
  if (maxConcurrentOperations === null) {
    throw Object.assign(new Error("runtime_policy_not_configured"), { code: "runtime_policy_not_configured" });
  }

  const maxDevices = effectiveCeiling(
    productPolicy.max_devices_per_account,
    accountOverride?.max_devices_per_account
  );
  const maxSessions = effectiveCeiling(
    productPolicy.max_sessions_per_account,
    accountOverride?.max_sessions_per_account
  );
  if (maxDevices !== null && maxSessions !== null && maxSessions > maxDevices) {
    throw new TypeError("invalid_effective_session_policy");
  }

  const leaseSeconds = productPolicy.session_lease_seconds;
  const maxLifetimeSeconds = productPolicy.max_operation_lifetime_seconds;
  const queueLimit = effectiveQueueLimit(
    productPolicy.max_queued_operations,
    accountOverride?.max_queued_operations
  );
  const maxWaitSeconds = productPolicy.queue_wait_seconds;

  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 ||
      !Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < leaseSeconds ||
      !Number.isSafeInteger(maxWaitSeconds) || maxWaitSeconds < 0) {
    throw new TypeError("invalid_product_runtime_policy");
  }

  return Object.freeze({
    maxDevicesPerAccount: maxDevices,
    maxSessionsPerAccount: maxSessions,
    maxConcurrentOperations: maxConcurrentOperations,
    maxQueuedOperations: queueLimit,
    sessionLeaseSeconds: leaseSeconds,
    maxOperationLifetimeSeconds: maxLifetimeSeconds,
    queueWaitSeconds: maxWaitSeconds
  });
}

/** Loads only server-owned policy rows; never accepts policy values from request bodies. */
export async function loadEffectiveRuntimePolicy(db, accountId, productKey) {
  if (!db || typeof accountId !== "string" || !accountId ||
      typeof productKey !== "string" || !/^[a-z0-9-]{2,64}$/.test(productKey)) {
    throw new TypeError("invalid_runtime_policy_scope");
  }
  const productPolicy = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account,operation_lease_seconds AS session_lease_seconds,max_concurrent_operations,max_queued_operations,queue_wait_seconds,max_operation_lifetime_seconds FROM product_runtime_policies WHERE product_key=?"
  ).bind(productKey).first();
  if (!productPolicy) {
    throw Object.assign(new Error("runtime_policy_not_configured"), { code: "runtime_policy_not_configured" });
  }
  const accountOverride = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account,max_concurrent_operations,max_queued_operations FROM account_product_policy_overrides WHERE account_id=? AND product_key=?"
  ).bind(accountId, productKey).first();
  return resolveEffectiveRuntimePolicy(productPolicy, accountOverride);
}
