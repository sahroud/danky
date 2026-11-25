import test from "node:test";
import assert from "node:assert/strict";
import { createAdmissionState, acquire, renew, release, revokeAccountProduct, sweepExpired } from "../src/admission-state.js";

const policy = { accountId: "acct", productKey: "steel", limit: 1, leaseSeconds: 60, maxLifetimeSeconds: 120 };

test("acquire enforces cap and returns existing lease for idempotent retry", () => {
  const state = createAdmissionState();
  const first = acquire(state, { ...policy, leaseId: "lease-a", requestKey: "req-a" }, 1000);
  assert.equal(first.ok, true);
  const retry = acquire(state, { ...policy, leaseId: "lease-b", requestKey: "req-a" }, 1001);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.lease.leaseId, "lease-a");
  assert.equal(acquire(state, { ...policy, leaseId: "lease-b", requestKey: "req-b" }, 1002).code, "CAPACITY");
});

test("expiry frees capacity; renew is bounded by max lifetime", () => {
  const state = createAdmissionState();
  acquire(state, { ...policy, leaseId: "lease-a", requestKey: "req-a" }, 1000);
  assert.equal(renew(state, "lease-a", 60, 60000).ok, true);
  assert.equal(renew(state, "lease-a", 60, 121000).code, "LEASE_NOT_FOUND");
  sweepExpired(state, 121000);
  assert.equal(acquire(state, { ...policy, leaseId: "lease-b", requestKey: "req-b" }, 121000).ok, true);
});

test("release is idempotent and revocation clears active leases", () => {
  const state = createAdmissionState();
  acquire(state, { ...policy, leaseId: "lease-a", requestKey: "req-a" }, 1000);
  assert.deepEqual(release(state, "lease-a", 1001), { ok: true, released: true });
  assert.deepEqual(release(state, "lease-a", 1002), { ok: true, released: false });
  acquire(state, { ...policy, leaseId: "lease-b", requestKey: "req-b" }, 1003);
  assert.equal(revokeAccountProduct(state, "acct", "steel", 1004).revoked, 1);
  assert.equal(acquire(state, { ...policy, leaseId: "lease-c", requestKey: "req-c" }, 1005).code, "REVOKED");
});
