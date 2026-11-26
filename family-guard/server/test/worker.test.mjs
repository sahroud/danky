import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const digest = async value => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
};

class FakeD1 {
  constructor() {
    this.families = new Map();
    this.members = new Map();
    this.invites = new Map();
    this.parentInvites = new Map();
    this.devices = new Map();
    this.locations = [];
  }
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM family_members m JOIN families f")) {
          const member = [...db.members.values()].find(x => x.token_hash === args[0] && x.status === "active");
          if (!member) return null;
          const family = db.families.get(member.family_id);
          return { member_id: member.id, id: member.family_id, role: member.role,
            subscription_status: member.subscription_status, subscription_expires_at: member.subscription_expires_at,
            parent_label: family?.parent_label };
        }
        if (sql.includes("FROM family_members") && sql.includes("role = 'second_parent'")) {
          const row = [...db.members.values()].find(x => x.family_id === args[0] && x.role === "second_parent" && x.status === "active");
          return row ? { id: row.id } : null;
        }
        if (sql.includes("FROM invites WHERE code_hash")) return db.invites.get(args[0]) || null;
        if (sql.includes("FROM parent_invites WHERE code_hash")) return db.parentInvites.get(args[0]) || null;
        if (sql.includes("FROM devices WHERE device_token_hash")) {
          const row = [...db.devices.values()].find(x => x.device_token_hash === args[0]);
          return row ? { id: row.id, family_id: row.family_id, label: row.label, sharing_enabled: row.sharing_enabled } : null;
        }
        if (sql.includes("FROM devices WHERE id = ? AND family_id = ?")) {
          const row = db.devices.get(args[0]);
          return row?.family_id === args[1] ? { id: row.id, label: row.label } : null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM family_members WHERE role = 'owner'")) {
          return { results: [...db.members.values()].filter(x => x.role === "owner" && x.status === "active").slice(0, 2).map(x => ({ member_id: x.id, family_id: x.family_id })) };
        }
        if (sql.includes("FROM devices d WHERE d.family_id")) {
          const rows = [...db.devices.values()].filter(x => x.family_id === args[0]).map(device => {
            const latest = db.locations.filter(x => x.device_id === device.id)
              .sort((a,b) => b.recorded_at.localeCompare(a.recorded_at))[0];
            return { id: device.id, label: device.label, sharing_enabled: device.sharing_enabled,
              consented_at: device.consented_at, last_seen_at: device.last_seen_at,
              latitude: latest?.latitude ?? null, longitude: latest?.longitude ?? null,
              accuracy_m: latest?.accuracy_m ?? null, location_recorded_at: latest?.recorded_at ?? null,
              location_received_at: latest?.received_at ?? null };
          });
          return { results: rows };
        }
        if (sql.includes("FROM locations WHERE device_id")) {
          const rows = db.locations.filter(x => x.device_id === args[0])
            .sort((a,b) => b.recorded_at.localeCompare(a.recorded_at)).slice(0, args[1]);
          return { results: rows.map(({latitude,longitude,accuracy_m,recorded_at,received_at}) =>
            ({latitude,longitude,accuracy_m,recorded_at,received_at})) };
        }
        return { results: [] };
      },
      async run() {
        if (sql.includes("INSERT INTO families")) {
          const [id,parent_label,parent_token_hash,created_at] = args;
          db.families.set(id,{id,parent_label,parent_token_hash,created_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO family_members")) {
          const [id,family_id,label,token_hash,created_at] = args;
          const isSecondParent = sql.includes("'second_parent'");
          db.members.set(id,{id,family_id,role:isSecondParent?"second_parent":"owner",label,token_hash,
            status:"active",subscription_status:isSecondParent?"inactive":"included",created_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO invites")) {
          const [code_hash,family_id,expires_at,created_at] = args;
          db.invites.set(code_hash,{code_hash,family_id,expires_at,used_at:null,created_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE invites SET used_at") || sql.includes("UPDATE parent_invites SET used_at")) {
          const store = sql.includes("parent_invites") ? db.parentInvites : db.invites;
          const [used_at,code_hash,now] = args;
          const invite = store.get(code_hash);
          if (invite && !invite.used_at && invite.expires_at > now) {
            invite.used_at = used_at;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("INSERT INTO parent_invites")) {
          const [code_hash,family_id,expires_at,created_at] = args;
          db.parentInvites.set(code_hash,{code_hash,family_id,expires_at,used_at:null,created_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO devices")) {
          const [id,family_id,label,device_token_hash,consented_at,sharing_enabled,created_at] = args;
          db.devices.set(id,{id,family_id,label,device_token_hash,consented_at,sharing_enabled,last_seen_at:null,created_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO locations")) {
          const [device_id,latitude,longitude,accuracy_m,recorded_at,received_at] = args;
          db.locations.push({device_id,latitude,longitude,accuracy_m,recorded_at,received_at});
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE family_members SET token_hash")) {
          const [token_hash,id] = args; const member = db.members.get(id);
          if (member && member.role === "owner" && member.status === "active") { member.token_hash = token_hash; return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE families SET parent_token_hash")) {
          const [parent_token_hash,id] = args; const family = db.families.get(id);
          if (family) { family.parent_token_hash = parent_token_hash; return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE devices SET last_seen_at")) {
          const [last_seen_at,id] = args;
          const device = db.devices.get(id);
          if (device) device.last_seen_at = last_seen_at;
          return { meta: { changes: device ? 1 : 0 } };
        }
        if (sql.includes("UPDATE devices SET sharing_enabled = 0")) {
          const [id,family_id] = args;
          const device = db.devices.get(id);
          if (device && (family_id === undefined || device.family_id === family_id)) {
            device.sharing_enabled = 0;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      }
    };
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const request = (path, { method = "GET", body, token, origin, recoveryKey } = {}) =>
  new Request("https://family.test" + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(origin ? { origin } : {}),
      ...(recoveryKey ? { "x-parent-recovery-key": recoveryKey } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

test("family owner can invite, pair with consent, receive location, inspect history and revoke", async () => {
  const DB = new FakeD1();
  const env = { DB, ALLOWED_ORIGIN: "https://parent.example" };
  const createdResponse = await handle(request("/v1/families", {
    method:"POST", body:{parent_label:"Parent"}
  }), env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(DB.members.size, 1);
  assert.notEqual([...DB.members.values()][0].token_hash, created.parent_token);
  assert.equal([...DB.members.values()][0].token_hash, await digest(created.parent_token));

  const inviteResponse = await handle(request("/v1/invites", {
    method:"POST", body:{}, token:created.parent_token
  }), env);
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  assert.equal(invite.invite_code.length, 16);

  const noConsent = await handle(request("/v1/devices/pair", {
    method:"POST", body:{invite_code:invite.invite_code,device_label:"Ali phone",consent:false}
  }), env);
  assert.equal(noConsent.status, 400);
  assert.equal([...DB.invites.values()][0].used_at, null);

  const pairedResponse = await handle(request("/v1/devices/pair", {
    method:"POST", body:{invite_code:invite.invite_code,device_label:"Ali phone",consent:true}
  }), env);
  assert.equal(pairedResponse.status, 201);
  const paired = await pairedResponse.json();
  const device = DB.devices.get(paired.device_id);
  assert.equal(device.device_token_hash, await digest(paired.device_token));
  assert.notEqual(device.device_token_hash, paired.device_token);

  const duplicatePair = await handle(request("/v1/devices/pair", {
    method:"POST", body:{invite_code:invite.invite_code,device_label:"Other",consent:true}
  }), env);
  assert.equal(duplicatePair.status, 400);

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const locationResponse = await handle(request("/v1/location", {
    method:"POST", token:paired.device_token,
    body:{latitude:35.5,longitude:54.2,accuracy_m:8,recorded_at:future}
  }), env);
  assert.equal(locationResponse.status, 200);
  const location = await locationResponse.json();
  assert.ok(Date.parse(location.recorded_at) <= Date.now() + 5 * 60 * 1000);

  const invalidLocation = await handle(request("/v1/location", {
    method:"POST", token:paired.device_token,
    body:{latitude:null,longitude:54.2}
  }), env);
  assert.equal(invalidLocation.status, 400);

  const listResponse = await handle(request("/v1/family/devices", {
    token:created.parent_token, origin:"https://parent.example"
  }), env);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("access-control-allow-origin"), "https://parent.example");
  const listed = await listResponse.json();
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].latitude, 35.5);

  const historyResponse = await handle(request("/v1/family/devices/"+paired.device_id+"/locations?limit=10", {
    token:created.parent_token
  }), env);
  assert.equal(historyResponse.status, 200);
  assert.equal((await historyResponse.json()).locations.length, 1);

  const revokeResponse = await handle(request("/v1/family/devices/"+paired.device_id+"/revoke", {
    method:"POST", body:{}, token:created.parent_token
  }), env);
  assert.equal(revokeResponse.status, 200);
  const blockedUpload = await handle(request("/v1/location", {
    method:"POST", token:paired.device_token,
    body:{latitude:35.6,longitude:54.3}
  }), env);
  assert.equal(blockedUpload.status, 403);
});

test("location endpoint rejects unauthenticated uploads", async () => {
  const DB = new FakeD1();
  const env = { DB };
  const unauthorized = await handle(request("/v1/location", {
    method:"POST", body:{latitude:35,longitude:54}
  }), env);
  assert.equal(unauthorized.status, 401);
});

test("second parent requires consent and a separate active subscription", async () => {
  const DB = new FakeD1();
  const env = { DB };
  const created = await (await handle(request("/v1/families", {
    method:"POST", body:{parent_label:"Owner"}
  }), env)).json();

  const inviteResponse = await handle(request("/v1/parents/invite", {
    method:"POST", body:{}, token:created.parent_token
  }), env);
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  assert.equal(invite.invite_code.length, 16);

  const denied = await handle(request("/v1/parents/accept", {
    method:"POST", body:{parent_label:"Second",invite_code:invite.invite_code,consent:false}
  }), env);
  assert.equal(denied.status, 400);

  const accepted = await handle(request("/v1/parents/accept", {
    method:"POST", body:{parent_label:"Second",invite_code:invite.invite_code,consent:true}
  }), env);
  assert.equal(accepted.status, 201);
  const second = await accepted.json();
  assert.equal(second.subscription_status, "inactive");

  const blocked = await handle(request("/v1/family/devices", { token:second.parent_token }), env);
  assert.equal(blocked.status, 402);

  const cannotInvite = await handle(request("/v1/invites", {
    method:"POST", body:{}, token:second.parent_token
  }), env);
  assert.equal(cannotInvite.status, 403);
});

test("family data requires a valid parent token", async () => {
  const response = await handle(request("/v1/family/devices"), { DB:new FakeD1() });
  assert.equal(response.status, 401);
});


test("device owner can stop sharing and subsequent location uploads are rejected", async () => {
  const DB = new FakeD1();
  const env = { DB };
  const created = await (await handle(request("/v1/families", {
    method:"POST", body:{parent_label:"Parent"}
  }), env)).json();
  const invite = await (await handle(request("/v1/invites", {
    method:"POST", body:{}, token:created.parent_token
  }), env)).json();
  const paired = await (await handle(request("/v1/devices/pair", {
    method:"POST", body:{invite_code:invite.invite_code,device_label:"Member phone",consent:true}
  }), env)).json();

  const stopped = await handle(request("/v1/devices/sharing/stop", {
    method:"POST", body:{}, token:paired.device_token
  }), env);
  assert.equal(stopped.status, 200);
  assert.equal(DB.devices.get(paired.device_id).sharing_enabled, 0);

  const upload = await handle(request("/v1/location", {
    method:"POST", token:paired.device_token,
    body:{latitude:35.5,longitude:54.2,accuracy_m:8}
  }), env);
  assert.equal(upload.status, 403);
  assert.equal(DB.locations.length, 0);
});

test("owner recovery rotates only the single active owner key and preserves paired devices", async () => {
  const DB = new FakeD1();
  const env = { DB, PARENT_RECOVERY_KEY: "a".repeat(48) };
  const created = await (await handle(request("/v1/families", {
    method:"POST", body:{parent_label:"Owner"}
  }), env)).json();
  const invite = await (await handle(request("/v1/invites", {
    method:"POST", body:{}, token:created.parent_token
  }), env)).json();
  const paired = await (await handle(request("/v1/devices/pair", {
    method:"POST", body:{invite_code:invite.invite_code,device_label:"Ali phone",consent:true}
  }), env)).json();

  const denied = await handle(request("/v1/owner/recover", {
    method:"POST", recoveryKey:"wrong-key"
  }), env);
  assert.equal(denied.status, 401);

  const rotatedResponse = await handle(request("/v1/owner/recover", {
    method:"POST", recoveryKey:"a".repeat(48)
  }), env);
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.ok(rotated.parent_token);
  assert.notEqual(rotated.parent_token, created.parent_token);

  const oldKey = await handle(request("/v1/family/devices", { token:created.parent_token }), env);
  assert.equal(oldKey.status, 401);
  const newKey = await handle(request("/v1/family/devices", { token:rotated.parent_token }), env);
  assert.equal(newKey.status, 200);
  assert.equal((await newKey.json()).devices.length, 1);
  assert.ok(DB.devices.has(paired.device_id));
  assert.equal(DB.devices.get(paired.device_id).sharing_enabled, 1);
});

test("owner recovery refuses to run unless exactly one active owner exists", async () => {
  const DB = new FakeD1();
  const env = { DB, PARENT_RECOVERY_KEY: "b".repeat(48) };
  const response = await handle(request("/v1/owner/recover", {
    method:"POST", recoveryKey:"b".repeat(48)
  }), env);
  assert.equal(response.status, 409);
});
