import { browser } from "@wdio/globals";
import type {} from "@wdio/tauri-service";
import type { RionStudioApi } from "../../../src/shared/api";

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
  | { action: "close" | "minimize" }
  | {
      action: "moveResize";
      height: number;
      scaleFactor?: number;
      width: number;
      x: number;
      y: number;
    }
  | { action: "setPresentation"; presentation: "fullscreen" | "maximized" | "normal" };

interface RendererCallResult {
  error?: string;
  ok: boolean;
  value?: unknown;
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
  afterSequence: number;
  kind?: string;
  minimumGeneration?: number;
  minimumRevision?: number;
  presentation?: "fullscreen" | "maximized" | "normal";
  timeoutMs?: number;
  windowId?: string;
}): Promise<DesktopE2eEvent> {
  const request = { timeoutMs: 30_000, ...input };
  const result = await browser.tauri.execute(
    ({ core }, token, waitRequest) => core.invoke("desktop_e2e_wait_event", {
      request: waitRequest,
      token
    }),
    sessionToken(),
    request
  );
  return result as unknown as DesktopE2eEvent;
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

export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the desktop E2E harness`);
  return value;
}
