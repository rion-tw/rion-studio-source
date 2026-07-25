import type {
  CoreCommand,
  CoreEffectRequest,
  CoreEffectResult,
  CoreEvent,
  SystemWebViewRuntimeRegistrationRecord
} from "./generated";

export const RUNTIME_HELPER_PROTOCOL_VERSION = 1;
export const RUNTIME_HELPER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

interface RuntimeHelperEnvelope {
  protocol: typeof RUNTIME_HELPER_PROTOCOL_VERSION;
  token: string;
}

export type RuntimeHelperHostMessage = RuntimeHelperEnvelope & (
  | { type: "coreEvents"; events: CoreEvent[] }
  | { type: "coreInvokeResult"; requestId: string; ok: true; value: unknown }
  | {
      type: "coreInvokeResult";
      requestId: string;
      ok: false;
      error: { code: string; message: string };
    }
  | { type: "effect"; effect: CoreEffectRequest }
  | { type: "shutdown" }
);

export type RuntimeHelperChildMessage = RuntimeHelperEnvelope & (
  | {
      type: "ready";
      registration: SystemWebViewRuntimeRegistrationRecord;
      helperVersion: string;
      versions: {
        chromium: string;
        electron: string;
        node: string;
      };
    }
  | { type: "coreInvoke"; requestId: string; command: CoreCommand }
  | { type: "effectResult"; result: CoreEffectResult }
  | {
      type: "shellEvent";
      event: "macroPageRequest" | "runtimeState" | "workspaceLaunchRequest";
      payload: unknown;
    }
  | {
      type: "log";
      level: "error" | "warn";
      message: string;
    }
);
