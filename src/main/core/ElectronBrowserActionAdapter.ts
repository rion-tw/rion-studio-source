import type {
  BrowserAction,
  CoreJsonValue
} from "../../shared/generated";
import type { MacroClickAnchor, MacroKeyModifier } from "../../shared/types";
import type { MacroKeyInput } from "../../shared/macroKeys";
import type { AutomationTargetPort } from "../browser/ports/AutomationTargetPort";
import type { BrowserCoreEffectAction } from "./ElectronEffectExecutor";

export interface ElectronBrowserActionAdapterOptions {
  executeCookies?: (roleId: string, operation: string, payload: unknown) => Promise<unknown>;
  executeDebugger?: (
    roleId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  executeSession?: (roleId: string, operation: string, payload: unknown) => Promise<unknown>;
  getTarget: (roleId: string) => AutomationTargetPort | undefined;
  now?: () => number;
  recordMacroScheduleToDispatchLatency?: (durationMs: number) => void;
}

export class ElectronBrowserActionAdapter {
  private readonly now: () => number;

  constructor(private readonly options: ElectronBrowserActionAdapterOptions) {
    this.now = options.now ?? Date.now;
  }

  async shutdown(): Promise<void> {
    // The adapter owns no queue or runtime state.
  }

  async executeEffect(action: BrowserCoreEffectAction): Promise<CoreJsonValue | undefined> {
    const request = action.request;
    if (request.origin === "macro") {
      this.options.recordMacroScheduleToDispatchLatency?.(
        Math.max(0, this.now() - request.scheduledAtMs)
      );
    }
    if (!request.requestId || !request.roleId) {
      throw actionError("BROWSER_ACTION_INVALID", "Browser action is invalid.");
    }
    if (this.now() > request.deadlineMs) {
      throw actionError("BROWSER_ACTION_DEADLINE", "Browser action deadline expired.");
    }
    const target = this.options.getTarget(request.roleId);
    if (!target) {
      throw actionError(
        "BROWSER_TARGET_UNAVAILABLE",
        "The browser role is not running."
      );
    }
    return await this.executeAction(request.roleId, target, request.action) as
      CoreJsonValue | undefined;
  }

  private async executeAction(
    roleId: string,
    target: AutomationTargetPort,
    action: BrowserAction
  ): Promise<unknown> {
    switch (action.type) {
      case "focus":
        await target.ensureInputFocus();
        return undefined;
      case "key": {
        const input: MacroKeyInput = {
          code: action.code ?? action.key,
          modifiers: action.modifiers.filter(isMacroKeyModifier)
        };
        if (action.phase === "hold") {
          await target.holdKey(input, action.ownerId);
          return undefined;
        }
        if (action.phase === "release") {
          await target.releaseKey(input, action.ownerId);
          return undefined;
        }
        if (action.phase === "tap") {
          await target.dispatchKey(input);
          return undefined;
        }
        throw actionError("BROWSER_KEY_PHASE_INVALID", "Browser key action phase is invalid.");
      }
      case "click": {
        if (target.dispatchClickAnchored) {
          await target.dispatchClickAnchored(
            isMacroClickAnchor(action.anchor) ? action.anchor : undefined,
            action.unit === "px" ? "px" : "percent",
            action.x,
            action.y
          );
          return undefined;
        }
        if (action.unit === "px") {
          if (!target.dispatchClickPixels) {
            throw actionError("BROWSER_CLICK_UNSUPPORTED", "Pixel click is not supported.");
          }
          await target.dispatchClickPixels(action.x, action.y);
          return undefined;
        }
        await target.dispatchClick(action.x, action.y);
        return undefined;
      }
      case "evaluate":
        return target.evaluate(action.source);
      case "cookies":
        if (!this.options.executeCookies) {
          throw actionError("BROWSER_COOKIES_UNAVAILABLE", "Cookie operation is unavailable.");
        }
        return this.options.executeCookies(roleId, action.operation, parsePayload(action.payloadJson));
      case "session":
        if (!this.options.executeSession) {
          throw actionError("BROWSER_SESSION_UNAVAILABLE", "Session operation is unavailable.");
        }
        return this.options.executeSession(roleId, action.operation, parsePayload(action.payloadJson));
      case "debugger":
        if (!this.options.executeDebugger) {
          throw actionError("BROWSER_DEBUGGER_UNAVAILABLE", "Debugger operation is unavailable.");
        }
        return this.options.executeDebugger(
          roleId,
          action.method,
          asRecord(parsePayload(action.paramsJson))
        );
    }
  }
}

function actionError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw actionError("BROWSER_ACTION_PAYLOAD_INVALID", "Browser action payload is invalid.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw actionError("BROWSER_ACTION_PAYLOAD_INVALID", "Debugger parameters are invalid.");
  }
  return value as Record<string, unknown>;
}

function isMacroKeyModifier(value: string): value is MacroKeyModifier {
  return ["primary", "ctrl", "alt", "shift", "meta"].includes(value);
}

function isMacroClickAnchor(value: string | null): value is MacroClickAnchor {
  return value !== null && [
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right"
  ].includes(value);
}
