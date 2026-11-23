import test from "node:test";
import assert from "node:assert/strict";
import { createSahroudFirebaseAuth } from "../client/firebase-auth.js";

function setup() {
  const calls = [];
  const user = { async getIdToken() { return "firebase.id.token"; } };
  const auth = { currentUser: user, async signOut() { calls.push("signOut"); } };
  class GoogleAuthProvider {
    setCustomParameters(value) { calls.push(["googleParams", value]); }
  }
  class RecaptchaVerifier {
    constructor(_auth, container, options) { calls.push(["recaptcha", container, options]); }
    async clear() { calls.push("recaptchaClear"); }
  }
  const centralClient = {
    async authenticate(token) {
      calls.push(["centralAuthenticate", token]);
      return { authenticated: true, principal_id: "principal-1" };
    }
  };
  const adapter = createSahroudFirebaseAuth({
    auth,
    GoogleAuthProvider,
    RecaptchaVerifier,
    centralClient,
    async signInWithPopup(_auth, _provider) { return { user }; },
    async signInWithPhoneNumber(_auth, phone, _verifier) {
      calls.push(["sendSms", phone]);
      return { async confirm(code) { calls.push(["confirm", code]); return { user }; } };
    },
    async linkWithPopup(_user, _provider) { return { user }; },
    async linkWithPhoneNumber(_user, phone, _verifier) {
      calls.push(["linkSms", phone]);
      return { async confirm(code) { calls.push(["linkConfirm", code]); return { user }; } };
    }
  });
  return { adapter, calls, auth };
}

test("Google sign-in exchanges the Firebase ID token with Central", async () => {
  const { adapter, calls } = setup();
  const result = await adapter.signInWithGoogle();
  assert.equal(result.principal_id, "principal-1");
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "centralAuthenticate" && call[1] === "firebase.id.token"));
});

test("phone sign-in validates E.164 and confirms the SMS code", async () => {
  const { adapter, calls } = setup();
  await assert.rejects(adapter.sendPhoneCode("09120000000"), /phone_number_must_be_e164/);
  const sent = await adapter.sendPhoneCode("+989120000000");
  assert.equal(sent.sms_sent, true);
  const result = await adapter.verifyPhoneCode("123456");
  assert.equal(result.authenticated, true);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "confirm" && call[1] === "123456"));
});

test("Google and phone credentials can be linked to one Firebase user", async () => {
  const { adapter, calls } = setup();
  await adapter.linkGoogleToCurrentUser();
  await adapter.sendPhoneCodeToLinkCurrentUser("+989120000000");
  const result = await adapter.verifyPhoneCode("654321");
  assert.equal(result.principal_id, "principal-1");
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "linkSms"));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "linkConfirm" && call[1] === "654321"));
});

test("phone verification requires a six digit code and a pending challenge", async () => {
  const { adapter } = setup();
  await assert.rejects(adapter.verifyPhoneCode("123"), /phone_verification_not_started/);
  await adapter.sendPhoneCode("+989120000000");
  await assert.rejects(adapter.verifyPhoneCode("12ab56"), /verification_code_must_be_six_digits/);
});
