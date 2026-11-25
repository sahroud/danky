import test from "node:test";
import assert from "node:assert/strict";
import { OperationCoordinatorDO, signCoordinatorAssertion } from "../src/operation-coordinator-do.js";

const secret = "test-only-secret-with-at-least-32-characters";
const policy = {
  accountId: "account-1", productKey: "steel", cap: 1,
  leaseSeconds: 30, maxLifetimeSeconds: 90, queueLimit: 2,
  maxWaitSeconds: 60, expiresAt: Math.floor(Date.now() / 1000) + 120
};

function storageHarness() {
  const data = new Map();
  let chain = Promise.resolve();
  return {
    data,
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

async function call(object, assertion, action, input = {}) {
  return object.fetch(new Request("https://internal.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion, action, input })
  }));
}

test("DO rejects requests without a configured assertion secret", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, {});
  const response = await call(object, "bad", "acquire", { requestId: "r1", leaseId: "l1" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "coordinator_not_configured");
});

test("DO verifies signed scope and ignores client-supplied limits and identity", async () => {
  const storage = storageHarness();
  const object = new OperationCoordinatorDO({ storage }, { OPERATION_ASSERTION_SECRET: secret });
  const assertion = await signCoordinatorAssertion(policy, secret);
  const response = await call(object, assertion, "acquire", {
    accountId: "attacker-account", productKey: "wrong-product",
    cap: 999, leaseSeconds: 999, requestId: "r1", leaseId: "l1"
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "granted");
  assert.equal(result.lease.accountId, "account-1");
  assert.equal(result.lease.productKey, "steel");
  assert.equal(result.lease.expiresAt - result.lease.createdAt, 30);
});

test("DO rejects tampered and expired assertions", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, { OPERATION_ASSERTION_SECRET: secret });
  const signed = await signCoordinatorAssertion(policy, secret);
  const [payload, signature] = signed.split(".");
  const tampered = payload.slice(0, -1) + (payload.endsWith("a") ? "b" : "a") + "." + signature;
  assert.equal((await call(object, tampered, "acquire", { requestId: "r", leaseId: "l" })).status, 401);
  const expired = await signCoordinatorAssertion({ ...policy, expiresAt: 1 }, secret);
  assert.equal((await call(object, expired, "acquire", { requestId: "r", leaseId: "l" })).status, 401);
});

test("DO serializes concurrent acquisitions and enforces the cap", async () => {
  const object = new OperationCoordinatorDO({ storage: storageHarness() }, { OPERATION_ASSERTION_SECRET: secret });
  const assertion = await signCoordinatorAssertion(policy, secret);
  const responses = await Promise.all([
    call(object, assertion, "acquire", { requestId: "r1", leaseId: "l1" }),
    call(object, assertion, "acquire", { requestId: "r2", leaseId: "l2" })
  ]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.filter(result => result.status === "granted").length, 1);
  assert.equal(results.filter(result => result.status === "queued").length, 1);
});

test("DO persists leases across instances and supports heartbeat and release", async () => {
  const storage = storageHarness();
  const env = { OPERATION_ASSERTION_SECRET: secret };
  const first = new OperationCoordinatorDO({ storage }, env);
  const assertion = await signCoordinatorAssertion(policy, secret);
  assert.equal((await (await call(first, assertion, "acquire", { requestId: "r1", leaseId: "l1" })).json()).status, "granted");
  const restarted = new OperationCoordinatorDO({ storage }, env);
  assert.equal((await (await call(restarted, assertion, "heartbeat", { leaseId: "l1" })).json()).status, "renewed");
  assert.equal((await (await call(restarted, assertion, "release", { leaseId: "l1" })).json()).status, "released");
});
