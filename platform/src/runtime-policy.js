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

function effectiveDuration(productValue, accountValue, minimum, maximum, code) {
  const product = productValue;
  const account = accountValue ?? null;
  if (!Number.isSafeInteger(product) || product < minimum || product > maximum ||
      (account !== null && (!Number.isSafeInteger(account) || account < minimum || account > maximum))) {
    throw new TypeError(code);
  }
  return account === null ? product : Math.min(product, account);
}

/**
 * Account overrides may tighten but never raise product policy.
 * Product and account operation caps remain separate for global vs per-account enforcement.
 */
export function resolveEffectiveRuntimePolicy(productPolicy, accountOverride = null) {
  if (!productPolicy) throw new TypeError("product_runtime_policy_required");

  const productConcurrentCap = positiveOrNull(productPolicy.max_concurrent_operations);
  if (productConcurrentCap === null) {
    throw Object.assign(new Error("runtime_policy_not_configured"), { code: "runtime_policy_not_configured" });
  }
  if (productConcurrentCap === undefined) throw new TypeError("invalid_product_runtime_policy");

  const accountConcurrentCap = effectiveCeiling(
    productConcurrentCap,
    accountOverride?.max_concurrent_operations
  );
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

  const sessionLeaseSeconds = effectiveDuration(
    productPolicy.session_lease_seconds, null, 30, 86400, "invalid_product_session_lease"
  );
  const operationLeaseSeconds = effectiveDuration(
    productPolicy.operation_lease_seconds,
    accountOverride?.operation_lease_seconds,
    30, 86400, "invalid_product_operation_lease"
  );
  const maxOperationLifetimeSeconds = effectiveDuration(
    productPolicy.max_operation_lifetime_seconds,
    accountOverride?.max_operation_lifetime_seconds,
    operationLeaseSeconds, 604800, "invalid_product_operation_lifetime"
  );
  const productQueueLimit = nonNegativeOrNull(productPolicy.max_queued_operations);
  const configuredAccountQueueLimit = nonNegativeOrNull(accountOverride?.max_queued_operations);
  if (productQueueLimit === undefined || configuredAccountQueueLimit === undefined) {
    throw new TypeError("invalid_runtime_policy_value");
  }
  const accountQueueLimit = productQueueLimit === null
    ? 0
    : configuredAccountQueueLimit === null
      ? productQueueLimit
      : Math.min(productQueueLimit, configuredAccountQueueLimit);
  const queueWaitSeconds = productPolicy.queue_wait_seconds;
  if (!Number.isSafeInteger(queueWaitSeconds) || queueWaitSeconds < 0 || queueWaitSeconds > 86400) {
    throw new TypeError("invalid_product_queue_wait");
  }

  return Object.freeze({
    maxDevicesPerAccount: maxDevices,
    maxSessionsPerAccount: maxSessions,
    productConcurrentCap,
    accountConcurrentCap,
    productQueueLimit: productQueueLimit ?? 0,
    accountQueueLimit,
    sessionLeaseSeconds,
    operationLeaseSeconds,
    maxOperationLifetimeSeconds,
    queueWaitSeconds
  });
}

/** Loads only server-owned policy rows; never accepts policy values from request bodies. */
export async function loadEffectiveRuntimePolicy(db, accountId, productKey) {
  if (!db || typeof accountId !== "string" || !accountId ||
      typeof productKey !== "string" || !/^[a-z0-9-]{2,64}$/.test(productKey)) {
    throw new TypeError("invalid_runtime_policy_scope");
  }
  const productPolicy = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account,session_lease_seconds,max_concurrent_operations,max_queued_operations,queue_wait_seconds,operation_lease_seconds,max_operation_lifetime_seconds FROM product_runtime_policies WHERE product_key=?"
  ).bind(productKey).first();
  if (!productPolicy) {
    throw Object.assign(new Error("runtime_policy_not_configured"), { code: "runtime_policy_not_configured" });
  }
  const accountOverride = await db.prepare(
    "SELECT max_devices_per_account,max_sessions_per_account,max_concurrent_operations,max_queued_operations,operation_lease_seconds,max_operation_lifetime_seconds FROM account_product_policy_overrides WHERE account_id=? AND product_key=?"
  ).bind(accountId, productKey).first();
  return resolveEffectiveRuntimePolicy(productPolicy, accountOverride);
}
