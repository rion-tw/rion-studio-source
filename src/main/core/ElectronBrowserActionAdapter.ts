import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  CoreEvent
} from "../../shared/generated";
import type { MacroClickAnchor, MacroKeyModifier } from "../../shared/types";
import type { MacroKeyInput } from "../../shared/macroKeys";
import type { BrowserAutomationTarget } from "../browser/ElectronAutomationTarget";
import type { AppCoreClient } from "./nativeCore";

export interface ElectronBrowserActionAdapterOptions {
  executeCookies?: (roleId: string, operation: string, payload: unknown) => Promise<unknown>;
  executeDebugger?: (
    roleId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  executeSession?: (roleId: string, operation: string, payload: unknown) => Promise<unknown>;
  getTarget: (roleId: string) => BrowserAutomationTarget | undefined;
  now?: () => number;
  recordMacroScheduleToDispatchLatency?: (durationMs: number) => void;
}

export class ElectronBrowserActionAdapter {
  private accepting = true;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: AppCoreClient,
    private readonly options: ElectronBrowserActionAdapterOptions
  ) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = core.subscribe((events) => this.handleEvents(events));
  }

  async shutdown(): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    this.unsubscribe();
  }

  private handleEvents(events: CoreEvent[]): void {
    for (const event of events) {
      if (event.type !== "browserActions") continue;
      if (!this.accepting) {
        void this.core.dispatchBrowserResults(event.actions.map((action) =>
          createFailure(action.requestId, "CORE_SHUTTING_DOWN", "Browser action adapter is shutting down.")
        ));
        continue;
      }
      void this.handleActionBatch(event.actions);
    }
  }

  private async handleActionBatch(actions: BrowserActionRequest[]): Promise<void> {
    try {
      const external = await this.core.dispatchExternalBrowserActions(actions);
      const embedded = await this.executeEmbeddedBatch(external.unhandled);
      await this.core.dispatchBrowserResults([...external.results, ...embedded]);
    } catch (error) {
      process.stderr.write(`Rion Studio browser action result dispatch failed: ${String(error)}\n`);
    }
  }

  private async executeEmbeddedBatch(
    actions: BrowserActionRequest[]
  ): Promise<BrowserActionResult[]> {
    const groups = new Map<string, Array<{ index: number; request: BrowserActionRequest }>>();
    actions.forEach((request, index) => {
      groups.set(request.roleId, [
        ...(groups.get(request.roleId) ?? []),
        { index, request }
      ]);
    });
    const results = new Array<BrowserActionResult>(actions.length);
    await Promise.all([...groups.values()].map(async (group) => {
      for (const { index, request } of group) {
        results[index] = await this.execute(request);
      }
    }));
    return results;
  }

  private async execute(request: BrowserActionRequest): Promise<BrowserActionResult> {
    if (request.origin === "macro") {
      this.options.recordMacroScheduleToDispatchLatency?.(
        Math.max(0, this.now() - request.scheduledAtMs)
      );
    }
    try {
      if (!request.requestId || !request.roleId) {
        return createFailure(request.requestId, "BROWSER_ACTION_INVALID", "Browser action is invalid.");
      }
      if (this.now() > request.deadlineMs) {
        return createFailure(request.requestId, "BROWSER_ACTION_DEADLINE", "Browser action deadline expired.");
      }
      const target = this.options.getTarget(request.roleId);
      if (!target) {
        return createFailure(
          request.requestId,
          "BROWSER_TARGET_UNAVAILABLE",
          "The browser role is not running."
        );
      }
      const value = await this.executeAction(request.roleId, target, request.action);
      return {
        requestId: request.requestId,
        ok: true,
        valueJson: value === undefined ? null : JSON.stringify(value),
        errorCode: null,
        errorMessage: null
      };
    } catch (error) {
      const normalized = normalizeActionError(error);
      return createFailure(request.requestId, normalized.code, normalized.message);
    }
  }

  private async executeAction(
    roleId: string,
    target: BrowserAutomationTarget,
    action: BrowserAction
  ): Promise<unknown> {
    switch (action.type) {
      case "focus":
        await target.focus();
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

function createFailure(requestId: string, errorCode: string, errorMessage: string): BrowserActionResult {
  return {
    requestId,
    ok: false,
    valueJson: null,
    errorCode,
    errorMessage
  };
}

function actionError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizeActionError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : "BROWSER_ACTION_FAILED",
      message: error.message || "Browser action failed."
    };
  }
  return { code: "BROWSER_ACTION_FAILED", message: String(error) };
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
