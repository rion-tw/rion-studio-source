export const EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL = "browser:embedded-runtime-diagnostics";

export const EMBEDDED_RUNTIME_LIFECYCLE_EVENTS = [
  "install",
  "focus",
  "blur",
  "pageshow",
  "pagehide",
  "visibilitychange",
  "freeze",
  "resume"
] as const;

export type EmbeddedRuntimeLifecycleEvent =
  (typeof EMBEDDED_RUNTIME_LIFECYCLE_EVENTS)[number];

export type EmbeddedRuntimeDiagnosticPayload =
  | {
      type: "heartbeat";
      sequence: number;
      monotonicMs: number;
      hasFocus: boolean;
      hidden: boolean;
      visibilityState: DocumentVisibilityState;
      wasDiscarded: boolean;
    }
  | {
      type: "lifecycle";
      event: EmbeddedRuntimeLifecycleEvent;
      sequence: number;
      monotonicMs: number;
      hasFocus: boolean;
      hidden: boolean;
      visibilityState: DocumentVisibilityState;
      wasDiscarded: boolean;
      webglRenderer?: string;
      webglVendor?: string;
    }
  | {
      type: "webgl";
      event: "context_lost" | "context_restored";
      sequence: number;
      monotonicMs: number;
      hasFocus: boolean;
      hidden: boolean;
      visibilityState: DocumentVisibilityState;
      wasDiscarded: boolean;
    };

const VISIBILITY_STATES = new Set<DocumentVisibilityState>(["hidden", "visible"]);
const LIFECYCLE_EVENTS = new Set<string>(EMBEDDED_RUNTIME_LIFECYCLE_EVENTS);
const MAX_GRAPHICS_VALUE_LENGTH = 512;
const BASE_KEYS = new Set([
  "type",
  "sequence",
  "monotonicMs",
  "hasFocus",
  "hidden",
  "visibilityState",
  "wasDiscarded"
]);

export function isEmbeddedRuntimeDiagnosticPayload(
  value: unknown
): value is EmbeddedRuntimeDiagnosticPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 0 ||
    typeof payload.monotonicMs !== "number" ||
    !Number.isFinite(payload.monotonicMs) ||
    payload.monotonicMs < 0 ||
    typeof payload.hasFocus !== "boolean" ||
    typeof payload.hidden !== "boolean" ||
    typeof payload.visibilityState !== "string" ||
    !VISIBILITY_STATES.has(payload.visibilityState as DocumentVisibilityState) ||
    typeof payload.wasDiscarded !== "boolean"
  ) {
    return false;
  }

  if (payload.type === "heartbeat") {
    return keys.every((key) => BASE_KEYS.has(key));
  }
  if (payload.type === "webgl") {
    return keys.every((key) => BASE_KEYS.has(key) || key === "event") &&
      (payload.event === "context_lost" || payload.event === "context_restored");
  }
  if (payload.type !== "lifecycle" || typeof payload.event !== "string") {
    return false;
  }
  if (!LIFECYCLE_EVENTS.has(payload.event)) {
    return false;
  }
  if (!keys.every((key) =>
    BASE_KEYS.has(key) || key === "event" || key === "webglRenderer" || key === "webglVendor"
  )) {
    return false;
  }

  return [payload.webglRenderer, payload.webglVendor].every(
    (item) => item === undefined ||
      (typeof item === "string" && item.length <= MAX_GRAPHICS_VALUE_LENGTH)
  );
}
