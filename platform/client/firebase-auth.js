/**
 * Firebase Authentication adapter for SAHROUD Central.
 *
 * Firebase SDK functions are injected by the consuming app so this module
 * does not bundle a second Firebase app or persist central API tokens.
 */
export function createSahroudFirebaseAuth({
  auth,
  GoogleAuthProvider,
  signInWithPopup,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  linkWithPopup,
  linkWithPhoneNumber,
  centralClient
} = {}) {
  if (!auth || !centralClient || typeof centralClient.authenticate !== "function") {
    throw new TypeError("firebase_auth_and_central_client_required");
  }
  if (
    typeof GoogleAuthProvider !== "function" ||
    typeof signInWithPopup !== "function" ||
    typeof RecaptchaVerifier !== "function" ||
    typeof signInWithPhoneNumber !== "function" ||
    typeof linkWithPopup !== "function" ||
    typeof linkWithPhoneNumber !== "function"
  ) {
    throw new TypeError("firebase_auth_sdk_functions_required");
  }

  let recaptchaVerifier = null;
  let pendingPhoneConfirmation = null;

  async function finishSignIn(user) {
    if (!user || typeof user.getIdToken !== "function") {
      throw new TypeError("firebase_user_required");
    }
    const idToken = await user.getIdToken();
    return centralClient.authenticate(idToken);
  }

  return {
    async signInWithGoogle() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters?.({ prompt: "select_account" });
      const result = await signInWithPopup(auth, provider);
      return finishSignIn(result.user);
    },

    async linkGoogleToCurrentUser() {
      if (!auth.currentUser) throw new Error("sign_in_required_before_linking");
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters?.({ prompt: "select_account" });
      const result = await linkWithPopup(auth.currentUser, provider);
      return finishSignIn(result.user);
    },

    async sendPhoneCode(phoneNumber, containerId = "sahroud-recaptcha") {
      if (typeof phoneNumber !== "string" || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        throw new TypeError("phone_number_must_be_e164");
      }
      if (recaptchaVerifier) {
        await recaptchaVerifier.clear();
        recaptchaVerifier = null;
      }
      recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
      pendingPhoneConfirmation = await signInWithPhoneNumber(
        auth,
        phoneNumber,
        recaptchaVerifier
      );
      return { sms_sent: true };
    },

    async sendPhoneCodeToLinkCurrentUser(phoneNumber, containerId = "sahroud-recaptcha") {
      if (!auth.currentUser) throw new Error("sign_in_required_before_linking");
      if (typeof phoneNumber !== "string" || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        throw new TypeError("phone_number_must_be_e164");
      }
      if (recaptchaVerifier) {
        await recaptchaVerifier.clear();
        recaptchaVerifier = null;
      }
      recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
      pendingPhoneConfirmation = await linkWithPhoneNumber(
        auth.currentUser,
        phoneNumber,
        recaptchaVerifier
      );
      return { sms_sent: true };
    },

    async verifyPhoneCode(code) {
      if (!pendingPhoneConfirmation) throw new Error("phone_verification_not_started");
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        throw new TypeError("verification_code_must_be_six_digits");
      }
      const result = await pendingPhoneConfirmation.confirm(code);
      pendingPhoneConfirmation = null;
      if (recaptchaVerifier) {
        await recaptchaVerifier.clear();
        recaptchaVerifier = null;
      }
      return finishSignIn(result.user);
    },

    async signOut() {
      pendingPhoneConfirmation = null;
      if (recaptchaVerifier) {
        await recaptchaVerifier.clear();
        recaptchaVerifier = null;
      }
      if (typeof auth.signOut === "function") await auth.signOut();
    }
  };
}
