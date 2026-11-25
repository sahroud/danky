import test from "node:test";
import assert from "node:assert/strict";
import { OperationCoordinatorDO, signCoordinatorAssertion } from "../src/operation-coordinator-do.js";

const secret = "test-only-secret-with-at-least-32-characters";
const policy = {
  accountId: "account-1", productKey: "steel", cap: 1, accountCap: 1,
  leaseSeconds: 30, maxLifetimeSeconds: 90, queueLimit: 2,
  maxWaitSeconds: 60, expiresAt: Math.floor(Date.now() / 1000) + 120
};
function storageHarness() {
  const data = new Map();
  let chain = Promise.resolve();
  let alarmAt = null;
  return {
    data,
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async setAlarm(timestamp) { alarmAt = timestamp; },
    async getAlarm() { return alarmAt; },
    async deleteAlarm() { alarmAt = null; },
    async transaction(callback) {
      const run = chain.then(async () => callback({
        get: async key => data.get(key),
        put: async (key, value) => data.set(key, structuredClone(value))
      }));
      chain = run.catch(() => {});
      return run;
    }
  };
}
async function assertion(action, binding = {}) {
  return signCoordinatorAssertion({ ...policy, ...binding, action }, secret);
}
async function call(object, signed, action, input = {}) {
  return object.fetch(new Request("https://internal.invalid/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion: signed, action, input })
  }));
}

test("DO rejects requests without a configured assertion secret", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, {});
  const response = await call(object, "bad", "acquire", { requestId: "r1", leaseId: "l1" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "coordinator_not_configured");
});
test("DO verifies signed scope and ignores client-supplied limits and identity", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, { OPERATION_ASSERTION_SECRET: secret });
  const response = await call(object, await assertion("acquire", { requestId: "r1", leaseId: "l1" }), "acquire", {
    accountId: "attacker-account", productKey: "wrong-product", cap: 999,
    leaseSeconds: 999, requestId: "attacker-request", leaseId: "attacker-lease"
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.status, "granted");
  assert.equal(result.lease.accountId, "account-1");
  assert.equal(result.lease.productKey, "steel");
  assert.equal(result.lease.expiresAt - result.lease.createdAt, 30);
});
test("DO rejects tampered, expired, and action-mismatched assertions", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, { OPERATION_ASSERTION_SECRET: secret });
  const signed = await assertion("acquire", { requestId: "r", leaseId: "l" });
  const [payload, signature] = signed.split(".");
  const tampered = payload.slice(0, -1) + (payload.endsWith("a") ? "b" : "a") + "." + signature;
  assert.equal((await call(object, tampered, "acquire", { requestId: "r", leaseId: "l" })).status, 401);
  const expired = await signCoordinatorAssertion({ ...policy, action: "acquire", requestId: "r", leaseId: "l", expiresAt: 1 }, secret);
  assert.equal((await call(object, expired, "acquire", { requestId: "r", leaseId: "l" })).status, 401);
  assert.equal((await call(object, signed, "release", { leaseId: "l" })).status, 401);
});
test("DO serializes concurrent acquisitions and enforces the cap", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, { OPERATION_ASSERTION_SECRET: secret });
  const [a1, a2] = await Promise.all([assertion("acquire", { requestId: "r1", leaseId: "l1" }), assertion("acquire", { requestId: "r2", leaseId: "l2" })]);
  const responses = await Promise.all([
    call(object, a1, "acquire", { requestId: "r1", leaseId: "l1" }),
    call(object, a2, "acquire", { requestId: "r2", leaseId: "l2" })
  ]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.filter(result => result.status === "granted").length, 1);
  assert.equal(results.filter(result => result.status === "queued").length, 1);
});

test("DO rejects unbound operations and prevents cross-account lease mutation", async () => {
  const storage = storageHarness();
  const env = { OPERATION_ASSERTION_SECRET: secret };
  const owner = new OperationCoordinatorDO({ storage }, env);
  const other = new OperationCoordinatorDO({ storage }, env);
  const missingBinding = await signCoordinatorAssertion({ ...policy, action: "acquire" }, secret);
  assert.equal((await call(owner, missingBinding, "acquire", { requestId: "r1", leaseId: "l1" })).status, 401);

  const acquired = await call(owner, await assertion("acquire", { requestId: "r1", leaseId: "l1" }), "acquire", {});
  assert.equal((await acquired.json()).status, "granted");

  const foreignScope = { ...policy, accountId: "account-2" };
  const heartbeatToken = await signCoordinatorAssertion({ ...foreignScope, action: "heartbeat", leaseId: "l1" }, secret);
  const releaseToken = await signCoordinatorAssertion({ ...foreignScope, action: "release", leaseId: "l1" }, secret);
  assert.equal((await (await call(other, heartbeatToken, "heartbeat", { leaseId: "l1" })).json()).status, "not_found");
  assert.deepEqual(await (await call(other, releaseToken, "release", { leaseId: "l1" })).json(), { status: "released", existed: false });

  const revokeToken = await signCoordinatorAssertion({ ...foreignScope, action: "revoke" }, secret);
  const foreignRevoke = await call(other, revokeToken, "revoke", { leaseId: "l1" });
  assert.deepEqual(await foreignRevoke.json(), { status: "revoked", count: 0, queuedCancelled: 0 });

  const ownerHeartbeat = await call(owner, await assertion("heartbeat", { leaseId: "l1" }), "heartbeat", { leaseId: "l1" });
  assert.equal((await ownerHeartbeat.json()).status, "renewed");
});

test("DO persists leases across instances and supports heartbeat and release", async () => {
  const storage = storageHarness();
  const env = { OPERATION_ASSERTION_SECRET: secret };
  const first = new OperationCoordinatorDO({ storage }, env);
  assert.equal((await (await call(first, await assertion("acquire", { requestId: "r1", leaseId: "l1" }), "acquire", { requestId: "r1", leaseId: "l1" })).json()).status, "granted");
  const restarted = new OperationCoordinatorDO({ storage }, env);
  assert.equal((await (await call(restarted, await assertion("heartbeat", { leaseId: "l1" }), "heartbeat", { leaseId: "l1" })).json()).status, "renewed");
  assert.equal((await (await call(restarted, await assertion("release", { leaseId: "l1" }), "release", { leaseId: "l1" })).json()).status, "released");
});
