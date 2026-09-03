import type { CoreErrorPayload } from "../../shared/generated";

const DEFAULT_ERROR_CODE = "ELECTRON_BRIDGE_FAILED";
const DEFAULT_ERROR_MESSAGE = "Rion Studio could not complete the desktop request.";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class RionBridgeError extends Error {
  readonly code: string;

  constructor(payload: CoreErrorPayload) {
    super(payload.message);
    this.name = "RionBridgeError";
    this.code = payload.code;
  }
}

export function normalizeRionBridgeError(
  error: unknown,
  fallbackCode = DEFAULT_ERROR_CODE
): CoreErrorPayload {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = nonEmptyString(record.code) ?? fallbackCode;
    const message = nonEmptyString(record.message);
    if (message) return { code, message };
  }

  const message = error instanceof Error
    ? nonEmptyString(error.message)
    : nonEmptyString(error);
  return {
    code: fallbackCode,
    message: message ?? DEFAULT_ERROR_MESSAGE
  };
}

export function bridgeErrorFromPayload(payload: CoreErrorPayload): RionBridgeError {
  return new RionBridgeError(normalizeRionBridgeError(payload));
}
