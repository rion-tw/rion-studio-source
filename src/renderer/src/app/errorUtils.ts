import { localizeErrorMessage, type Language, type Translator } from "../i18n";

export function toMessage(error: unknown, language: Language, t: Translator): string {
  if (error instanceof Error) {
    return localizeErrorMessage(error.message, language);
  }

  if (isErrorLike(error)) {
    const proxyErrorKey = browserProxyErrorKey(error.code);
    if (proxyErrorKey) return t(proxyErrorKey);
    return localizeErrorMessage(error.message, language);
  }

  if (typeof error === "string") {
    return localizeErrorMessage(error, language);
  }

  return t("error.unexpected");
}

export function isPersistentRuntimeError(error: unknown): boolean {
  if (typeof error === "string") {
    return isSurfaceReleaseMessage(error);
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const payload = error as { code?: unknown; message?: unknown };
  return (
    payload.code === "SYSTEM_SURFACE_RELEASE_UNVERIFIED" ||
    (typeof payload.message === "string" && isSurfaceReleaseMessage(payload.message))
  );
}

function isSurfaceReleaseMessage(message: string): boolean {
  return (
    (message.startsWith("Rion Studio could not verify that ") ||
      message.startsWith("Rion Studio still cannot verify that ")) &&
    message.includes("native game page")
  );
}

function browserProxyErrorKey(code: unknown) {
  const keys = {
    BROWSER_PROXY_INVALID_CONFIGURATION: "error.browserProxyInvalidConfiguration",
    BROWSER_PROXY_UNAVAILABLE: "error.browserProxyUnavailable",
    BROWSER_PROXY_APPLY_FAILED: "error.browserProxyApplyFailed",
    BROWSER_PROXY_RESTART_REQUIRED: "error.browserProxyRestartRequired"
  } as const;
  return typeof code === "string" ? keys[code as keyof typeof keys] : undefined;
}

function isErrorLike(error: unknown): error is { code?: unknown; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}
