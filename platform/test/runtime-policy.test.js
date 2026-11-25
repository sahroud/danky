import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveRuntimePolicy } from "../src/runtime-policy.js";

const product = {
  max_devices_per_account: 5,
  max_sessions_per_account: 3,
  session_lease_seconds: 300,
  max_concurrent_operations: 10,
  max_queued_operations: 20,
  queue_wait_seconds: 120,
  max_operation_lifetime_seconds: 3600
};

test("account overrides can tighten but never raise product ceilings", () => {
  const policy = resolveEffectiveRuntimePolicy(product, {
    max_devices_per_account: 2,
    max_sessions_per_account: 1,
    max_concurrent_operations: 50,
    max_queued_operations: 50
  });
  assert.equal(policy.maxDevicesPerAccount, 2);
  assert.equal(policy.maxSessionsPerAccount, 1);
  assert.equal(policy.maxConcurrentOperations, 10);
  assert.equal(policy.maxQueuedOperations, 20);
});

test("null account overrides inherit product ceilings", () => {
  const policy = resolveEffectiveRuntimePolicy(product, {
    max_devices_per_account: null,
    max_sessions_per_account: null,
    max_concurrent_operations: null,
    max_queued_operations: null
  });
  assert.equal(policy.maxDevicesPerAccount, 5);
  assert.equal(policy.maxSessionsPerAccount, 3);
  assert.equal(policy.maxConcurrentOperations, 10);
  assert.equal(policy.maxQueuedOperations, 20);
});

test("null product queue limit defaults to zero queued work", () => {
  const policy = resolveEffectiveRuntimePolicy({ ...product, max_queued_operations: null }, null);
  assert.equal(policy.maxQueuedOperations, 0);
});

test("missing product operation cap fails closed", () => {
  assert.throws(
    () => resolveEffectiveRuntimePolicy({ ...product, max_concurrent_operations: null }),
    error => error.code === "runtime_policy_not_configured"
  );
});

test("invalid or internally inconsistent effective policies are rejected", () => {
  assert.throws(
    () => resolveEffectiveRuntimePolicy(product, { max_devices_per_account: 2, max_sessions_per_account: 4 }),
    /invalid_effective_session_policy/
  );
  assert.throws(
    () => resolveEffectiveRuntimePolicy({ ...product, session_lease_seconds: 10 }),
    /invalid_product_runtime_policy/
  );
});
