import { localizeErrorMessage, type Language, type Translator } from "../i18n";

export function toMessage(error: unknown, language: Language, t: Translator): string {
  if (isErrorLike(error)) {
    const errorKey = localizedErrorKey(error.code);
    if (errorKey) return t(errorKey);
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

function localizedErrorKey(code: unknown) {
  const keys = {
    GAME_WINDOW_NAME_DUPLICATE: "error.gameWindowNameDuplicate",
    GAME_WINDOW_NAME_REQUIRED: "error.gameWindowNameRequired",
    GAME_WINDOW_NAME_TOO_LONG: "error.gameWindowNameTooLong",
    MACRO_ROLE_STOPPING: "error.macroRoleStopping",
    MACRO_ROLE_INPUT_FENCED: "error.macroRoleInputFenced",
    MACRO_ROLE_INPUT_RECOVERING: "error.macroRoleInputRecovering",
    MACRO_ROLE_INPUT_RESTART_REQUIRED: "error.macroRoleInputRestartRequired",
    SYSTEM_TRUSTED_INPUT_RECOVERING: "error.trustedInputRecovering",
    WORKSPACE_CONTENT_REQUIRED: "error.workspaceEmpty"
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
