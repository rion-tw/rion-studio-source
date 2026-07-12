import { localizeErrorMessage, type Language, type Translator } from "../i18n";

export function toMessage(error: unknown, language: Language, t: Translator): string {
  if (error instanceof Error) {
    return localizeErrorMessage(error.message, language);
  }

  if (isErrorLike(error)) {
    return localizeErrorMessage(error.message, language);
  }

  if (typeof error === "string") {
    return localizeErrorMessage(error, language);
  }

  return t("error.unexpected");
}

function isErrorLike(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}
