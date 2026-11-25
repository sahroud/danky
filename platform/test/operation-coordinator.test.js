import test from "node:test";
import assert from "node:assert/strict";
import { emptyCoordinatorState, acquire, heartbeat, release, revoke, expireAndPromote } from "../src/operation-coordinator.js";

const policy = { cap: 1, leaseSeconds: 30, maxLifetimeSeconds: 90, queueLimit: 2, maxWaitSeconds: 20 };
const request = (requestId, accountId = "acct-a", now = 100) => ({
  ...policy, now, accountId, productKey: "steel", requestId, leaseId: "lease-" + requestId
});

test("acquire enforces capacity and returns an idempotent lease for repeated request IDs", () => {
  const state = emptyCoordinatorState();
  const first = acquire(state, request("one"));
  assert.equal(first.status, "granted");
  assert.equal(acquire(state, request("one")).idempotent, true);
  assert.equal(acquire(state, request("two")).status, "queued");
  assert.equal(Object.keys(state.leases).length, 1);
});

test("queue is bounded and promotes FIFO after release", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("one"));
  assert.equal(acquire(state, request("two")).position, 1);
  assert.equal(acquire(state, request("three")).position, 2);
  assert.equal(acquire(state, request("four")).reason, "capacity_full");
  release(state, { ...policy, now: 105, leaseId: "lease-one" });
  assert.equal(state.leases["lease-two"].requestId, "two");
  assert.equal(Object.keys(state.queue).length, 1);
});

test("heartbeat cannot extend beyond the lease's maximum lifetime", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("one"));
  const result = heartbeat(state, { ...policy, now: 120, leaseId: "lease-one" });
  assert.equal(result.status, "renewed");
  assert.equal(result.lease.expiresAt, 150);
  const second = heartbeat(state, { ...policy, now: 145, leaseId: "lease-one" });
  assert.equal(second.lease.expiresAt, 175);
  const bounded = heartbeat(state, { ...policy, now: 170, leaseId: "lease-one" });
  assert.equal(bounded.status, "renewed");
  assert.equal(bounded.lease.expiresAt, 190);
});

test("expired leases are removed and queued requests can be promoted", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("one"));
  acquire(state, request("two"));
  const result = expireAndPromote(state, { ...policy, now: 131 });
  assert.equal(result.active, 1);
  assert.equal(state.leases["lease-two"].requestId, "two");
});

test("release is idempotent and revoke can target an account/product scope", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("one"));
  assert.equal(release(state, { ...policy, now: 101, leaseId: "lease-one" }).existed, true);
  assert.equal(release(state, { ...policy, now: 102, leaseId: "lease-one" }).existed, false);
  acquire(state, request("two"));
  assert.equal(revoke(state, { ...policy, now: 103, accountId: "acct-a", productKey: "steel" }).count, 1);
});
