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
  acquire(state, { ...request("two"), maxWaitSeconds: 60 });
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

test("idempotency keys are scoped to account and product", () => {
  const state = emptyCoordinatorState();
  const first = acquire(state, { ...request("same"), cap: 2 });
  const second = acquire(state, { ...request("same", "acct-b"), cap: 2, leaseId: "lease-acct-b" });
  assert.equal(first.status, "granted");
  assert.equal(second.status, "granted");
  assert.notEqual(first.lease.requestKey, second.lease.requestKey);
});

test("lease IDs cannot overwrite an existing active or queued lease", () => {
  const state = emptyCoordinatorState();
  assert.equal(acquire(state, request("one")).status, "granted");
  const collision = acquire(state, { ...request("two"), leaseId: "lease-one" });
  assert.deepEqual(collision, { status: "denied", reason: "lease_id_conflict" });
});

test("invalid policy and malformed requests fail closed", () => {
  const state = emptyCoordinatorState();
  assert.equal(acquire(state, { ...request("bad"), cap: 0 }).reason, "invalid_request_or_policy");
  assert.equal(acquire(state, { ...request("bad2"), maxLifetimeSeconds: 1 }).reason, "invalid_request_or_policy");
  assert.equal(acquire(state, { ...request("bad3"), accountId: "" }).reason, "invalid_request_or_policy");
});

test("new requests cannot jump ahead of an older waiter after lease expiry", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("first"));
  acquire(state, { ...request("waiter"), maxWaitSeconds: 60 });
  const newcomer = acquire(state, request("newcomer", "acct-b", 131));
  assert.equal(state.leases["lease-waiter"].requestId, "waiter");
  assert.equal(newcomer.status, "queued");
});

test("account/product revocation also cancels queued requests in that scope", () => {
  const state = emptyCoordinatorState();
  acquire(state, request("active"));
  acquire(state, request("waiting"));
  const result = revoke(state, { ...policy, now: 101, accountId: "acct-a", productKey: "steel" });
  assert.equal(result.count, 1);
  assert.equal(result.queuedCancelled, 1);
  assert.equal(Object.keys(state.leases).length, 0);
  assert.equal(Object.keys(state.queue).length, 0);
});
