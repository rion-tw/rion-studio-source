import { browser } from "@wdio/globals";
import type {} from "@wdio/tauri-service";
import type { RionStudioApi } from "../../../src/shared/api";
import type { MacroInputDiagnosticsRecord } from "../../../src/shared/generated";
import {
  detachTerminatedWebDriverSession,
  type WebDriverGlobalRegistry
} from "./session";

export interface DesktopE2eEvent {
  details: unknown;
  generation?: number;
  kind: string;
  revision?: number;
  sequence: number;
  timestamp: string;
  windowId?: string;
}

export interface DesktopE2eProbe {
  latestSequence: number;
  pid: number;
  sessionId: string;
  transcriptPath: string;
  userDataDir: string;
}

export interface DesktopE2eWindowSnapshot {
  kernel?: {
    persistedName?: string;
    placement?: WindowPlacement;
    revision: number;
    selectedTabId?: string;
    surfaceTabIds: string[];
    tabs: Array<{
      audioMuted: boolean;
      hidden: boolean;
      launchPhase: "attaching" | "degraded" | "essentialReady" | "navigating" | "optionalHydrating" | "ready" | null;
      sourceId: string;
      tabId: string;
      tabType: string;
      title: string;
    }>;
    targetDisplay?: { id: number };
    windowGeneration: number;
    windowRevision: number;
  };
  native: {
    clientBounds: WindowBounds;
    displayId?: number;
    dpi?: number;
    handle: string;
    normalOuterBounds?: WindowBounds;
    outerBounds: WindowBounds;
    presentation: "fullscreen" | "maximized" | "minimized" | "normal";
    scaleFactor: number;
    tabStripBounds?: WindowBounds;
    tabStripHostBounds?: WindowBounds;
    title: string;
    workArea: WindowBounds;
  };
  observationSequence: number;
  pid: number;
  target: {
    bounds: WindowBounds;
    persistedName?: string;
    presentation: "fullscreen" | "maximized" | "normal";
  };
  windowGeneration: number;
  windowId: string;
}

export interface WindowBounds {
  height: number;
  width: number;
  x?: number;
  y?: number;
}

interface WindowPlacement {
  normalBounds: Required<WindowBounds>;
  presentation: "fullscreen" | "maximized" | "normal";
  savedWorkArea: Required<WindowBounds>;
}

export type WindowControlRequest =
  | {
      action: "clickVisibleClose" | "close" | "minimize" | "permitCloseConfirmation";
    }
  | { action: "dragVisibleChrome"; deltaX: number; deltaY: number }
  | {
      action: "moveResize";
      height: number;
      scaleFactor?: number;
      width: number;
      x: number;
      y: number;
    }
  | { action: "setPresentation"; presentation: "fullscreen" | "maximized" | "normal" };

export type RuntimeUiActionRequest =
  | { action: "activateTab"; tabId: string; windowGeneration: number }
  | { action: "closeTab"; tabId: string; windowGeneration: number }
  | { action: "focusRole"; roleId: string; tabId: string; windowGeneration: number }
  | { action: "pressRoleSlot"; roleId: string; tabId: string; windowGeneration: number };

interface RendererCallResult {
  error?: string;
  ok: boolean;
  value?: unknown;
}

interface DesktopE2eTauriCore {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
}

function sessionToken(): string {
  const token = process.env.RION_STUDIO_E2E_SESSION_TOKEN;
  if (!token) throw new Error("RION_STUDIO_E2E_SESSION_TOKEN is unavailable");
  return token;
}

export async function rendererCall<K extends keyof RionStudioApi>(
  method: K,
  ...args: Parameters<RionStudioApi[K]>
): Promise<Awaited<ReturnType<RionStudioApi[K]>>> {
  const result = await browser.executeAsync(
    (
      methodName: string,
      methodArgs: unknown[],
      done: (result: RendererCallResult) => void
    ) => {
      type AsyncMethod = (...values: unknown[]) => Promise<unknown>;
      const api = window.rionStudio as unknown as Record<string, AsyncMethod>;
      const callable = api[methodName];
      if (!callable) {
        done({ error: `Unknown renderer bridge method: ${methodName}`, ok: false });
        return;
      }
      void callable(...methodArgs).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    String(method),
    args
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? `Renderer bridge method ${String(method)} failed`);
  return result.value as Awaited<ReturnType<RionStudioApi[K]>>;
}

export async function probe(): Promise<DesktopE2eProbe> {
  const result = await browser.tauri.execute(
    ({ core }, token) => core.invoke("desktop_e2e_probe", { token }),
    sessionToken()
  );
  return result as unknown as DesktopE2eProbe;
}

export async function waitEvent(input: {
  activeTabId?: string;
  afterSequence: number;
  kind?: string;
  minimumGeneration?: number;
  minimumRevision?: number;
  presentation?: "fullscreen" | "maximized" | "normal";
  timeoutMs?: number;
  windowId?: string;
}): Promise<DesktopE2eEvent> {
  const request = { timeoutMs: 30_000, ...input };
  const result = await browser.executeAsync(
    (
      token: string,
      waitRequest: typeof request,
      done: (result: RendererCallResult) => void
    ) => {
      const core = (window as typeof window & {
        __wdio_original_core__?: DesktopE2eTauriCore;
      }).__wdio_original_core__;
      if (!core?.invoke) {
        done({ error: "Desktop E2E Tauri invoke bridge is unavailable", ok: false });
        return;
      }
      void core.invoke("desktop_e2e_wait_event", {
        request: waitRequest,
        token
      }).then(
        (value: unknown) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    sessionToken(),
    request
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? "Desktop E2E event wait failed");
  return result.value as DesktopE2eEvent;
}

export async function windowSnapshot(windowId: string): Promise<DesktopE2eWindowSnapshot> {
  const result = await browser.tauri.execute(
    ({ core }, token, id) => core.invoke("desktop_e2e_window_snapshot", {
      token,
      windowId: id
    }),
    sessionToken(),
    windowId
  );
  return result as unknown as DesktopE2eWindowSnapshot;
}

export async function injectDuplicateRoleCookieCheckpoint(
  roleId: string
): Promise<{ duplicateCount: number; roleId: string; totalCookieCount: number }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id) => core.invoke(
      "desktop_e2e_inject_duplicate_role_cookie_checkpoint",
      { roleId: id, token }
    ),
    sessionToken(),
    roleId
  );
  return result as unknown as {
    duplicateCount: number;
    roleId: string;
    totalCookieCount: number;
  };
}

export async function controlWindow(
  windowId: string,
  request: WindowControlRequest
): Promise<DesktopE2eWindowSnapshot | { submitted: true }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id, controlRequest) => core.invoke("desktop_e2e_control_window", {
      request: controlRequest,
      token,
      windowId: id
    }),
    sessionToken(),
    windowId,
    request
  );
  return result as unknown as DesktopE2eWindowSnapshot | { submitted: true };
}

export async function submitWindowControl(
  snapshot: DesktopE2eWindowSnapshot,
  request: WindowControlRequest
): Promise<DesktopE2eEvent> {
  const cursor = (await probe()).latestSequence;
  await controlWindow(snapshot.windowId, request);
  return waitEvent({
    afterSequence: cursor,
    kind: "native-control-submitted",
    minimumGeneration: snapshot.windowGeneration,
    windowId: snapshot.windowId
  });
}

export async function closeWindowAndWait(
  snapshot: DesktopE2eWindowSnapshot
): Promise<DesktopE2eEvent> {
  const cursor = (await probe()).latestSequence;
  await controlWindow(snapshot.windowId, { action: "close" });
  return waitEvent({
    afterSequence: cursor,
    kind: "window-destroyed",
    minimumGeneration: snapshot.windowGeneration,
    timeoutMs: 45_000,
    windowId: snapshot.windowId
  });
}

export async function runtimeUiAction(
  windowId: string,
  request: RuntimeUiActionRequest
): Promise<{ action: string; submitted: true; windowGeneration: number; windowId: string }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id, actionRequest) => core.invoke("desktop_e2e_runtime_ui_action", {
      request: actionRequest,
      token,
      windowId: id
    }),
    sessionToken(),
    windowId,
    request
  );
  return result as unknown as {
    action: string;
    submitted: true;
    windowGeneration: number;
    windowId: string;
  };
}

export async function inputDiagnostics(): Promise<MacroInputDiagnosticsRecord> {
  const result = await browser.tauri.execute(
    ({ core }, token) => core.invoke("desktop_e2e_input_diagnostics", { token }),
    sessionToken()
  );
  return result as unknown as MacroInputDiagnosticsRecord;
}

export async function shutdown(confirm = false): Promise<void> {
  await browser.tauri.execute(
    ({ core }, token, shouldConfirm) => core.invoke("desktop_e2e_shutdown", {
      confirm: shouldConfirm,
      token
    }),
    sessionToken(),
    confirm
  );
}

export function detachTerminatedApplicationSession(): void {
  // WebdriverIO stores the real browser object behind the @wdio/globals proxy.
  const registry = globalThis._wdioGlobals as WebDriverGlobalRegistry | undefined;
  if (!registry) throw new Error("WDIO global registry is unavailable");
  detachTerminatedWebDriverSession(registry);
}

export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the desktop E2E harness`);
  return value;
}
