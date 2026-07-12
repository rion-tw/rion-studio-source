import type { AuthState } from "../../shared/types";
import type { LoginStorageReadiness } from "./loginEvidence";
import { containsLoginPromptText, isKnownLoginUrl } from "./loginDetection";

export const NO_PERSISTED_LOGIN_SESSION_MESSAGE = "Login is still required. No persisted login session was found.";

export interface AuthSessionCheckResult {
  authState: Exclude<AuthState, "unknown">;
  message?: string;
  finalUrl?: string;
}

export function classifyAuthSession(
  finalUrl: string,
  bodyText: string,
  evidence: LoginStorageReadiness = {
    ready: false,
    reason: "no_persisted_login_evidence"
  }
): AuthSessionCheckResult {
  const normalizedUrl = finalUrl.toLowerCase();
  const normalizedText = bodyText.toLowerCase();

  if (
    normalizedUrl.includes("support.google.com/accounts/answer/7675428") ||
    normalizedText.includes("this browser or app may not be secure") ||
    normalizedText.includes("couldn") && normalizedText.includes("sign you in")
  ) {
    return {
      authState: "auth_failed",
      finalUrl,
      message: "Google rejected this browser during session check."
    };
  }

  if (isKnownLoginUrl(normalizedUrl) || containsLoginPromptText(normalizedText)) {
    return {
      authState: "login_required",
      finalUrl,
      message: "Login is still required."
    };
  }

  if (evidence.ready) {
    return {
      authState: "authenticated",
      finalUrl
    };
  }

  return {
    authState: "login_required",
    finalUrl,
    message: NO_PERSISTED_LOGIN_SESSION_MESSAGE
  };
}
