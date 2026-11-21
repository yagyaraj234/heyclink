import Constants from "expo-constants";
import { Platform } from "react-native";
import type { User } from "@react-native-firebase/auth";

export const authEnabled = Platform.OS !== "web" && Constants.expoConfig?.extra?.householdAuth === true;
const inviteOrigin: unknown = Constants.expoConfig?.extra?.inviteOrigin;

export function inviteCode(value: string) {
  let code = value;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.origin !== inviteOrigin || url.pathname !== "/invite") return;
      code = url.hash.slice(1);
    } catch { return; }
  }
  code = code.trim().replace(/[ -]/g, "").toUpperCase();
  return /^[A-HJ-NP-Z2-9]{12}$/.test(code) ? code : undefined;
}

export const firebase = () => import("@react-native-firebase/auth");

export async function signInWithGoogle(user?: User) {
  const [{ GoogleOneTapSignIn, isSuccessResponse }, auth] = await Promise.all([
    import("react-native-nitro-google-signin"), firebase(),
  ]);
  GoogleOneTapSignIn.configure({ webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "autoDetect" });
  await GoogleOneTapSignIn.checkPlayServices();
  const result = await GoogleOneTapSignIn.presentExplicitSignIn();
  if (!isSuccessResponse(result)) return;
  if (!result.data.idToken) throw new Error("Google sign-in did not return a credential.");
  const credential = auth.GoogleAuthProvider.credential(result.data.idToken);
  return user ? auth.linkWithCredential(user, credential) : auth.signInWithCredential(auth.getAuth(), credential);
}

export async function requestPhoneCode(phone: string, user?: User, resend = false) {
  const auth = await firebase();
  const client = auth.getAuth();
  if (!user) {
    const confirmation = await auth.signInWithPhoneNumber(client, phone);
    return (code: string) => confirmation.confirm(code);
  }
  const confirmation = await auth.verifyPhoneNumber(client, phone, resend);
  if (!confirmation.verificationId) throw new Error("Could not verify this phone number.");
  const confirm = async (code: string) => {
    const result = await auth.linkWithCredential(user, auth.PhoneAuthProvider.credential(confirmation.verificationId, code));
    await auth.getIdToken(result.user, true);
    return result;
  };
  if (confirmation.code) {
    await confirm(confirmation.code);
    return;
  }
  return confirm;
}

export function authError(error: unknown) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  switch (code) {
    case "auth/credential-already-in-use":
    case "auth/account-exists-with-different-credential": return "That sign-in method already belongs to an account. Use the original sign-in method for this account.";
    case "auth/invalid-verification-code": return "That SMS code is incorrect.";
    case "auth/session-expired": return "The SMS code expired. Request another.";
    case "auth/too-many-requests":
    case "auth/quota-exceeded": return "SMS is temporarily unavailable. Try again later.";
    case "auth/network-request-failed": return "Check your connection and try again.";
  }
  return "Could not complete sign-in. Try again.";
}
