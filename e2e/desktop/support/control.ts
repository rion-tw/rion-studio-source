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
    selectedTabId?: string | null;
    surfaceTabIds: string[];
    tabs: Array<{
      activationPhase: "activating" | "attaching" | "degraded" | "dormant" | "failed" | "loading" | "ready" | null;
      audioMuted: boolean;
      hidden: boolean;
      launchPhase: "attaching" | "degraded" | "essentialReady" | "navigating" | "optionalHydrating" | "ready" | null;
      sourceId: string;
      tabId: string;
      tabType: string;
      title: string;
      workspaceSlots: Array<{
        browserZoomPercent?: number;
        id: string;
        rect: Required<WindowBounds>;
        roleId?: string;
        web?: { name: string; startUrl: string };
      }>;
    }>;
    targetDisplay?: { id: number };
    windowGeneration: number;
    windowRevision: number;
  };
  native: {
    appKitTitlebar?: {
      rootMinX: number;
      rootWidth: number;
      tabMaxX: number;
      tabMaxY: number;
      tabMinX: number;
      tabMinY: number;
      titleHidden: boolean;
      trafficLightsMaxX: number;
      windowNameMaxX: number;
    };
    clientBounds: WindowBounds;
    displayId?: number;
    dividerSurfaces?: Array<{
      axis: "horizontal" | "vertical";
      bounds: WindowBounds;
      dividerIndex: number;
      webviewLabel: string;
    }>;
    dpi?: number;
    focused?: boolean;
    fullscreenToolbar?: {
      accessoryOnScreen: boolean;
      accessoryVisibleHeight: number;
      alwaysShowInFullScreen: boolean;
      fullscreen: boolean;
      fullscreenHostReady: boolean;
      presentationAutoHideToolbar: boolean;
      revealLocked: boolean;
      tabStripOnScreen: boolean;
      toolbarPinned: boolean;
      visibleTrafficLightCount: number;
    };
    handle: string;
    normalOuterBounds?: WindowBounds;
    outerBounds: WindowBounds;
    presentation: "fullscreen" | "maximized" | "minimized" | "normal";
    popupWindows?: Array<{
      label: string;
      native: {
        clientBounds: WindowBounds;
        outerBounds: WindowBounds;
        presentation: "fullscreen" | "maximized" | "minimized" | "normal";
        title: string;
      };
      roleId: string;
    }>;
    roleSurfaces?: Array<{
      controllerBounds: WindowBounds;
      controllerVisible: boolean;
      documentViewport?: {
        height: number;
        resizeEventCount: number;
        width: number;
      };
      hostBounds: WindowBounds;
      parentWindowMatchesHost: boolean;
      roleId: string;
      webviewLabel?: string;
    }>;
    roleWebviews?: Array<{
      roleId: string;
      url?: string;
      webviewLabel: string;
    }>;
    workspaceWebChromeSurfaces?: Array<{
      bounds: WindowBounds;
      fullscreen: boolean;
      roleId: string;
      visible: boolean;
      webviewLabel: string;
    }>;
    scaleFactor: number;
    tabStatusPresentation?: "failed" | "hidden" | "loading";
    tabStripBounds?: WindowBounds;
    tabStripHostBounds?: WindowBounds;
    title: string;
    workArea: WindowBounds;
  };
  observationSequence: number;
  pid: number;
  roleSurfaceGenerations: Record<string, number>;
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
      action:
        | "activateFullscreenSpace"
        | "clickVisibleClose"
        | "clickVisibleFullscreen"
        | "clickVisibleFullscreenToolbarMenu"
        | "clickVisibleMinimize"
        | "close"
        | "focus"
        | "minimize"
        | "permitCloseConfirmation";
    }
  | { action: "dragVisibleChrome"; deltaX: number; deltaY: number }
  | { action: "movePointerToRoleContent" }
  | { action: "movePointerToFullscreenToolbar" }
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
  | {
      action: "dragTab";
      beforeTabId: string;
      tabId: string;
      targetWindowGeneration: number;
      targetWindowId: string;
      topologyRevision: number;
      windowGeneration: number;
    }
  | {
      action: "dragDivider";
      deltaRatio: number;
      dividerIndex: number;
      tabId: string;
      topologyRevision: number;
      windowGeneration: number;
    }
  | { action: "focusRole"; roleId: string; tabId: string; windowGeneration: number }
  | { action: "clickRoleContent"; roleId: string; tabId: string; windowGeneration: number }
  | { action: "pressRoleSlot"; roleId: string; tabId: string; windowGeneration: number }
  | {
      action: "openTabMenu";
      tabId: string;
      topologyRevision: number;
      windowGeneration: number;
    }
  | {
      action: "selectTabMenuItem";
      menuAction: "hide" | "move" | "moveToNewWindow";
      tabId: string;
      targetWindowGeneration?: number;
      targetWindowId?: string;
      topologyRevision: number;
      windowGeneration: number;
    };

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

export async function injectPageFinishFailure(
  roleId: string
): Promise<{ generation: number; inputEpoch: number; roleId: string; status: "injected" }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id) => core.invoke(
      "desktop_e2e_inject_page_finish_failure",
      { roleId: id, token }
    ),
    sessionToken(),
    roleId
  );
  return result as unknown as {
    generation: number;
    inputEpoch: number;
    roleId: string;
    status: "injected";
  };
}

export async function applicationLifecycleSignal(
  suspended: boolean
): Promise<{ status: "submitted"; suspended: boolean }> {
  const result = await browser.tauri.execute(
    ({ core }, token, shouldSuspend) => core.invoke(
      "desktop_e2e_application_lifecycle_signal",
      { suspended: shouldSuspend, token }
    ),
    sessionToken(),
    suspended
  );
  return result as unknown as { status: "submitted"; suspended: boolean };
}

export async function armAutomationReadinessFailure(
  roleId: string,
  causeCode:
    | "SYSTEM_AUTOMATION_SURFACE_WAKE_FAILED"
    | "SYSTEM_AUTOMATION_SURFACE_WAKE_INDETERMINATE"
): Promise<{ armed: true; causeCode: string; roleId: string }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id, code) => core.invoke(
      "desktop_e2e_arm_automation_readiness_failure",
      { causeCode: code, roleId: id, token }
    ),
    sessionToken(),
    roleId,
    causeCode
  );
  return result as unknown as { armed: true; causeCode: string; roleId: string };
}

export async function suspendAutomationSurface(
  roleId: string
): Promise<{ roleId: string; status: "suspended" }> {
  const result = await browser.tauri.execute(
    ({ core }, token, id) => core.invoke(
      "desktop_e2e_suspend_automation_surface",
      { roleId: id, token }
    ),
    sessionToken(),
    roleId
  );
  return result as unknown as { roleId: string; status: "suspended" };
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

export async function runtimeUiActionAndWaitEvent(
  windowId: string,
  request: RuntimeUiActionRequest,
  wait: {
    afterSequence: number;
    kind: string;
    timeoutMs?: number;
  }
): Promise<DesktopE2eEvent> {
  const waitRequest = { timeoutMs: 30_000, ...wait };
  const result = await browser.executeAsync(
    (
      token: string,
      id: string,
      actionRequest: RuntimeUiActionRequest,
      eventRequest: typeof waitRequest,
      done: (result: RendererCallResult) => void
    ) => {
      const core = (window as typeof window & {
        __wdio_original_core__?: DesktopE2eTauriCore;
      }).__wdio_original_core__;
      if (!core?.invoke) {
        done({ error: "Desktop E2E Tauri invoke bridge is unavailable", ok: false });
        return;
      }
      void core.invoke("desktop_e2e_runtime_ui_action", {
        request: actionRequest,
        token,
        windowId: id
      }).then(() => core.invoke("desktop_e2e_wait_event", {
        request: eventRequest,
        token
      })).then(
        (value: unknown) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    sessionToken(),
    windowId,
    request,
    waitRequest
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? "Desktop E2E UI action event wait failed");
  return result.value as DesktopE2eEvent;
}

export async function inputDiagnostics(): Promise<MacroInputDiagnosticsRecord> {
  const result = await browser.tauri.execute(
    ({ core }, token) => core.invoke("desktop_e2e_input_diagnostics", { token }),
    sessionToken()
  );
  return result as unknown as MacroInputDiagnosticsRecord;
}

export async function keyboardInput(
  code: string,
  phase: "keyDown" | "keyUp",
  focus = true
): Promise<{ code: string; phase: string; sequence: number; status: "submitted" }> {
  const result = await browser.tauri.execute(
    ({ core }, token, inputCode, inputPhase, shouldFocus) => core.invoke("desktop_e2e_keyboard_input", {
      request: { code: inputCode, focus: shouldFocus, phase: inputPhase },
      token
    }),
    sessionToken(),
    code,
    phase,
    focus
  );
  return result as unknown as {
    code: string;
    phase: string;
    sequence: number;
    status: "submitted";
  };
}

export async function keyboardInputSequence(
  requests: Array<{ code: string; phase: "keyDown" | "keyUp" }>
): Promise<Array<{ code: string; phase: string; sequence: number; status: "submitted" }>> {
  if (requests.length === 0) throw new Error("Desktop E2E keyboard input sequence is empty");
  const result = await browser.executeAsync(
    (
      token: string,
      inputRequests: Array<{ code: string; phase: "keyDown" | "keyUp" }>,
      done: (result: RendererCallResult) => void
    ) => {
      const core = (window as typeof window & {
        __wdio_original_core__?: DesktopE2eTauriCore;
      }).__wdio_original_core__;
      if (!core?.invoke) {
        done({ error: "Desktop E2E Tauri invoke bridge is unavailable", ok: false });
        return;
      }
      void (async () => {
        const receipts: unknown[] = [];
        let focusNextKeyDown = true;
        for (const request of inputRequests) {
          const focus = focusNextKeyDown && request.phase === "keyDown";
          receipts.push(await core.invoke("desktop_e2e_keyboard_input", {
            request: { ...request, focus },
            token
          }));
          if (focus) focusNextKeyDown = false;
        }
        return receipts;
      })().then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    sessionToken(),
    requests
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? "Desktop E2E keyboard input sequence failed");
  return result.value as Array<{
    code: string;
    phase: string;
    sequence: number;
    status: "submitted";
  }>;
}

export async function keyboardInputSession(
  steps: Array<
    | { code: string; phase: "keyDown" | "keyUp"; type: "input" }
    | {
        afterSequence: number;
        details: Record<string, boolean | number | string>;
        kind: string;
        timeoutMs?: number;
        type: "waitEvent";
      }
  >
): Promise<{
  events: DesktopE2eEvent[];
  receipts: Array<{ code: string; phase: string; sequence: number; status: "submitted" }>;
}> {
  if (steps.length === 0) throw new Error("Desktop E2E keyboard input session is empty");
  const result = await browser.executeAsync(
    (
      token: string,
      sessionSteps: typeof steps,
      done: (result: RendererCallResult) => void
    ) => {
      const core = (window as typeof window & {
        __wdio_original_core__?: DesktopE2eTauriCore;
      }).__wdio_original_core__;
      if (!core?.invoke) {
        done({ error: "Desktop E2E Tauri invoke bridge is unavailable", ok: false });
        return;
      }
      void (async () => {
        const events: DesktopE2eEvent[] = [];
        const receipts: unknown[] = [];
        let focusNextKeyDown = true;
        for (const step of sessionSteps) {
          if (step.type === "input") {
            const focus = focusNextKeyDown && step.phase === "keyDown";
            receipts.push(await core.invoke("desktop_e2e_keyboard_input", {
              request: { code: step.code, focus, phase: step.phase },
              token
            }));
            if (focus) focusNextKeyDown = false;
            continue;
          }
          let cursor = step.afterSequence;
          for (;;) {
            const event = await core.invoke("desktop_e2e_wait_event", {
              request: {
                afterSequence: cursor,
                kind: step.kind,
                timeoutMs: step.timeoutMs ?? 30_000
              },
              token
            }) as DesktopE2eEvent;
            cursor = event.sequence;
            const details = event.details as Record<string, unknown> | null;
            if (details && Object.entries(step.details).every(
              ([key, value]) => details[key] === value
            )) {
              events.push(event);
              break;
            }
          }
        }
        return { events, receipts };
      })().then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    sessionToken(),
    steps
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? "Desktop E2E keyboard input session failed");
  return result.value as {
    events: DesktopE2eEvent[];
    receipts: Array<{ code: string; phase: string; sequence: number; status: "submitted" }>;
  };
}

export async function focusMainApplicationWindow(): Promise<void> {
  const cursor = (await probe()).latestSequence;
  const result = await browser.tauri.execute(
    ({ core }, token) => core.invoke("desktop_e2e_control_window", {
      request: { action: "focus" },
      token,
      windowId: "main"
    }),
    sessionToken()
  );
  const submission = result as unknown as { submitted?: boolean };
  if (submission.submitted !== true) {
    throw new Error("Desktop E2E main-window focus was not submitted.");
  }
  const terminal = await waitEvent({
    afterSequence: cursor,
    kind: "main-window-focus-terminal",
    windowId: "main"
  });
  const receipt = terminal.details as { stage?: string; status?: string };
  if (receipt.status !== "applied") {
    throw new Error(
      `Desktop E2E main-window focus ended as ${receipt.status ?? "unknown"}`
      + ` at ${receipt.stage ?? "unknown"}.`
    );
  }
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
