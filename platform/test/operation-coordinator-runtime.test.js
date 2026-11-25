import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { signCoordinatorAssertion } from "../src/operation-coordinator-do.js";

const secret = "local-test-secret-not-for-production-000000000000";
const base = { accountId: "runtime-test-account", productKey: "steel", cap: 2, accountCap: 2,
  leaseSeconds: 60, maxLifetimeSeconds: 180, queueLimit: 10, accountQueueLimit: 10, maxWaitSeconds: 90 };
const stub = label => env.OPERATION_COORDINATOR.get(
  env.OPERATION_COORDINATOR.idFromName("runtime-" + label + "-" + crypto.randomUUID())
);
async function token(action, binding = {}, policy = {}) {
  const expiresAt = policy.expiresAt ?? (Math.floor(Date.now() / 1000) + 60);
  const limits = { ...base, ...policy };
  delete limits.expiresAt;
  return signCoordinatorAssertion({ ...limits, ...binding, action, expiresAt }, secret);
}
async function call(object, action, assertion, input = {}) {
  return object.fetch("https://coordinator.internal/" + action, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, assertion, input }) });
}
describe("Durable Object coordinator in Cloudflare runtime", () => {
  beforeAll(() => expect(env.OPERATION_COORDINATOR).toBeDefined());

  it("serializes concurrent admissions and ignores client policy and identity", async () => {
    const object = stub("capacity");
    const responses = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const requestId = "req-" + i, leaseId = "lease-" + i;
      return call(object, "acquire", await token("acquire", { requestId, leaseId }), {
        accountId: "forged", productKey: "forged", cap: 999, requestId: "forged", leaseId: "forged"
      });
    }));
    const results = await Promise.all(responses.map(r => r.json()));
    expect(results.filter(x => x.status === "granted")).toHaveLength(2);
    expect(results.filter(x => x.status === "queued")).toHaveLength(10);
  });

  it("enforces per-account caps without wasting product-wide capacity", async () => {
    const object = stub("account-cap");
    const policy = { cap: 2, accountCap: 1, queueLimit: 4, accountQueueLimit: 1 };
    const first = await token("acquire", { accountId: "account-a", requestId: "a1", leaseId: "la1" }, policy);
    const second = await token("acquire", { accountId: "account-a", requestId: "a2", leaseId: "la2" }, policy);
    const other = await token("acquire", { accountId: "account-b", requestId: "b1", leaseId: "lb1" }, policy);
    expect((await (await call(object, "acquire", first)).json()).status).toBe("granted");
    expect((await (await call(object, "acquire", second)).json()).status).toBe("queued");
    const third = await token("acquire", { accountId: "account-a", requestId: "a3", leaseId: "la3" }, policy);
    expect((await (await call(object, "acquire", third)).json()).reason).toBe("capacity_full");
    expect((await (await call(object, "acquire", other)).json()).status).toBe("granted");
    const releaseOther = await token("release", { accountId: "account-b", leaseId: "lb1" }, { ...policy, accountCap: 5 });
    expect((await (await call(object, "release", releaseOther)).json()).existed).toBe(true);
    const retry = await token("acquire", { accountId: "account-a", requestId: "a2", leaseId: "la2" }, policy);
    expect((await (await call(object, "acquire", retry)).json()).status).toBe("queued");
    const releaseOwner = await token("release", { accountId: "account-a", leaseId: "la1" }, policy);
    expect((await (await call(object, "release", releaseOwner)).json()).existed).toBe(true);
    expect((await (await call(object, "acquire", retry)).json()).status).toBe("granted");
  });

  it("uses each queued account's lease duration when promoting FIFO work", async () => {
    const object = stub("queued-lease-duration");
    const holder = await token("acquire", { accountId: "account-holder", requestId: "h1", leaseId: "lh1" },
      { cap: 1, accountCap: 1, leaseSeconds: 60, maxLifetimeSeconds: 240 });
    const waiting = await token("acquire", { accountId: "account-waiter", requestId: "w1", leaseId: "lw1" },
      { cap: 1, accountCap: 1, leaseSeconds: 90, maxLifetimeSeconds: 300 });
    expect((await (await call(object, "acquire", holder)).json()).status).toBe("granted");
    expect((await (await call(object, "acquire", waiting)).json()).status).toBe("queued");
    const releaseHolder = await token("release", { accountId: "account-holder", leaseId: "lh1" },
      { cap: 1, accountCap: 1, leaseSeconds: 60, maxLifetimeSeconds: 240 });
    expect((await (await call(object, "release", releaseHolder)).json()).existed).toBe(true);
    const promoted = await (await call(object, "acquire", waiting)).json();
    expect(promoted.status).toBe("granted");
    expect(promoted.lease.expiresAt - promoted.lease.createdAt).toBe(90);
  });

  it("persists state and scopes heartbeat/release to the signed account", async () => {
    const id = env.OPERATION_COORDINATOR.idFromName("runtime-persist-" + crypto.randomUUID());
    const first = env.OPERATION_COORDINATOR.get(id);
    const acquireToken = await token("acquire", { requestId: "r1", leaseId: "l1" });
    expect((await (await call(first, "acquire", acquireToken)).json()).status).toBe("granted");
    const second = env.OPERATION_COORDINATOR.get(id);
    const heartbeatToken = await token("heartbeat", { leaseId: "l1" });
    expect((await (await call(second, "heartbeat", heartbeatToken)).json()).status).toBe("renewed");
    const foreign = await token("release", { leaseId: "l1" }, { accountId: "other-account" });
    expect(await (await call(second, "release", foreign)).json()).toMatchObject({ status: "released", existed: false });
    const release = await token("release", { leaseId: "l1" });
    expect(await (await call(second, "release", release)).json()).toMatchObject({ status: "released", existed: true });
  });

  it("rejects absent, tampered, expired and action-mismatched assertions", async () => {
    const object = stub("assertions");
    const binding = { requestId: "r", leaseId: "l" };
    const good = await token("acquire", binding);
    const [payload, signature] = good.split(".");
    const bad = payload + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect((await call(object, "acquire", "")).status).toBe(401);
    expect((await call(object, "acquire", bad)).status).toBe(401);
    const expired = await token("acquire", binding, { expiresAt: 1 });
    expect((await call(object, "acquire", expired)).status).toBe(401);
    const wrongAction = await token("heartbeat", { leaseId: "l" });
    expect((await call(object, "acquire", wrongAction)).status).toBe(401);
  });

  it("promotes queued requests in FIFO order after release", async () => {
    const object = stub("fifo"), policy = { cap: 1, queueLimit: 2 };
    const a = await token("acquire", { requestId: "a", leaseId: "la" }, policy);
    const b = await token("acquire", { requestId: "b", leaseId: "lb" }, policy);
    const c = await token("acquire", { requestId: "c", leaseId: "lc" }, policy);
    expect((await (await call(object, "acquire", a)).json()).status).toBe("granted");
    expect((await (await call(object, "acquire", b)).json()).status).toBe("queued");
    expect((await (await call(object, "acquire", c)).json()).status).toBe("queued");
    const release = await token("release", { leaseId: "la" }, policy);
    expect((await (await call(object, "release", release)).json()).existed).toBe(true);
    const retry = await token("acquire", { requestId: "b", leaseId: "lb" }, policy);
    const promoted = await (await call(object, "acquire", retry)).json();
    expect(promoted.status).toBe("granted");
    expect(promoted.lease.leaseId).toBe("lb");
  });
  it("expires leases and promotes the FIFO queue from a scheduled alarm", async () => {
    const object = stub("alarm-cleanup");
    const policy = { cap: 1, queueLimit: 2, accountQueueLimit: 2, leaseSeconds: 60, maxLifetimeSeconds: 180 };
    const first = await token("acquire", { requestId: "alarm-a", leaseId: "alarm-la" }, policy);
    const waiting = await token("acquire", { requestId: "alarm-b", leaseId: "alarm-lb" }, policy);
    expect((await (await call(object, "acquire", first)).json()).status).toBe("granted");
    expect((await (await call(object, "acquire", waiting)).json()).status).toBe("queued");

    await runInDurableObject(object, async (_instance, state) => {
      const stored = await state.storage.get("coordinator-state");
      stored.leases["alarm-la"].expiresAt = Math.floor(Date.now() / 1000) - 1;
      await state.storage.put("coordinator-state", stored);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(object)).toBe(true);
    const promoted = await (await call(object, "acquire", waiting)).json();
    expect(promoted).toMatchObject({ status: "granted", lease: { leaseId: "alarm-lb" }, idempotent: true });

    const nextAlarm = await runInDurableObject(object, (_instance, state) => state.storage.getAlarm());
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm).toBeGreaterThan(Date.now());
  });

});
