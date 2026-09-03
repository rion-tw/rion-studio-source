import { $, browser } from "@wdio/globals";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe
} from "./electron-driver";

const executeFile = promisify(execFile);
const SHELL_ERROR_JOURNAL_KEY = "__rionStudioNativeTabsShellErrors";

type ElectronWindowTracker = {
  electron?: { windowHandle?: string };
};

function trackWindow(handle: string): void {
  const electron = (browser as unknown as ElectronWindowTracker).electron;
  if (electron) electron.windowHandle = handle;
}

async function switchTrackedWindow(handle: string): Promise<void> {
  await browser.switchToWindow(handle);
  trackWindow(handle);
}

/** Installs a read-only shell-error journal before visible native tab actions. */
export async function installRuntimeTabShellErrorJournal(): Promise<void> {
  await browser.execute((key) => {
    const page = window as unknown as Record<string, unknown>;
    if (page[key]) return;
    const errors: unknown[] = [];
    const unsubscribe = window.rionStudio.onShellError((error) => errors.push(error));
    page[key] = { errors, unsubscribe };
  }, SHELL_ERROR_JOURNAL_KEY);
}

/** Reads shell errors without replacing the visible user action under test. */
export async function runtimeTabShellErrors(): Promise<readonly unknown[]> {
  return browser.execute((key) => {
    const page = window as unknown as Record<string, unknown>;
    const journal = page[key] as { errors?: unknown[] } | undefined;
    return journal?.errors ?? [];
  }, SHELL_ERROR_JOURNAL_KEY);
}

async function windowsRuntimeHostHandle(
  mainWindowHandle: string,
  tabId?: string
): Promise<string> {
  let target: string | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        const current = new URL(await browser.execute(() => window.location.href));
        if (current.protocol === "file:" && current.pathname.endsWith(
          "/runtime-windows-host.html"
        )) {
          if (tabId && !await $(`[data-tab-id='${tabId}']`).isExisting()) {
            continue;
          }
          target = handle;
          return true;
        }
      } catch {
        // A retired WebContents target is ignored until WebDriver publishes
        // the current bundled runtime-host document.
      }
    }
    await switchTrackedWindow(mainWindowHandle);
    return false;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The visible Windows runtime-host tab row was not attached"
  });
  if (!target) throw new Error("The visible Windows runtime-host tab row is unavailable");
  return target;
}

async function withWindowsRuntimeHost<Value>(
  mainWindowHandle: string,
  tabId: string | undefined,
  action: () => Promise<Value>
): Promise<Value> {
  const target = await windowsRuntimeHostHandle(mainWindowHandle, tabId);
  await switchTrackedWindow(target);
  try {
    return await action();
  } finally {
    await switchTrackedWindow(mainWindowHandle);
  }
}

async function runAppKitAction(script: string, ...arguments_: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The retained AppKit tab row is macOS-only");
  }
  await executeFile("/usr/bin/osascript", ["-e", script, "--", ...arguments_], {
    encoding: "utf8",
    timeout: 10_000
  });
}

async function readAppKitAction(
  script: string,
  ...arguments_: string[]
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The retained AppKit window is macOS-only");
  }
  const result = await executeFile("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    ...arguments_
  ], { encoding: "utf8", timeout: 10_000 });
  return result.stdout.trim();
}

async function clickMacosScreenPoint(x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("The exact AppKit click point is invalid");
  }
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState) else {
  fatalError("system pointer source unavailable")
}
let point = CGPoint(x: ${x}, y: ${y})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(50_000)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
  mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
  mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
}

async function clickMacosAppKitTab(tabName: string): Promise<void> {
  const processId = String((await electronDesktopE2eProbe()).processId);
  const rawPoint = await readAppKitAction(`
on run argv
  set targetName to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set targetTab to missing value
    set targetWindow to missing value
    set targetCount to 0
    set observedTabs to ""
    repeat with appWindow in windows of targetProcess
      set allElements to entire contents of appWindow
      repeat with candidate in allElements
        try
          if role of candidate is "AXRadioButton" then
            set observedTabs to observedTabs & " [name=" & (name of candidate as text) & "; description=" & (description of candidate as text) & "]"
            if description of candidate is targetName then
              set targetTab to candidate
              set targetWindow to appWindow
              set targetCount to targetCount + 1
            end if
          end if
        end try
      end repeat
    end repeat
    if targetCount is not 1 then error "exact AppKit tab unavailable; observed" & observedTabs
    if targetWindow is missing value then error "exact AppKit tab has no AXWindow owner"
    set targetPosition to position of targetTab
    set targetSize to size of targetTab
    set clickX to ((item 1 of targetPosition) + ((item 1 of targetSize) / 2)) as integer
    set clickY to ((item 2 of targetPosition) + ((item 2 of targetSize) / 2)) as integer
    set targetIdentifier to value of attribute "AXIdentifier" of targetWindow
    if targetIdentifier is missing value or targetIdentifier is "" then ¬
      error "exact AppKit tab window has no stable identifier"
    set frontmost of targetProcess to true
    perform action "AXRaise" of targetWindow
    return (clickX as text) & "," & (clickY as text) & "," & targetIdentifier
  end tell
end run`, tabName, processId);
  const fields = rawPoint.split(",");
  const point = fields.slice(0, 2).map(Number);
  const windowIdentifier = fields[2];
  if (fields.length !== 3 || point.some((value) => !Number.isFinite(value)) ||
      !windowIdentifier) {
    throw new Error(`The exact AppKit tab click point is invalid (${rawPoint})`);
  }
  await clickMacosScreenPoint(point[0]!, point[1]!);
  await readAppKitAction(`
on run argv
  set targetIdentifier to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    set targetWindow to missing value
    set targetCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is targetIdentifier then
          set targetWindow to appWindow
          set targetCount to targetCount + 1
        end if
      end try
    end repeat
    if targetCount is not 1 then error "exact clicked AppKit tab window unavailable"
    set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
    if focusedWindow is missing value then error "exact AppKit tab click has no focused window"
    set focusedIdentifier to value of attribute "AXIdentifier" of focusedWindow
    if focusedIdentifier is not targetIdentifier then ¬
      error "exact AppKit tab click did not focus its owner"
    return "focused"
  end tell
end run`, windowIdentifier, processId);
}

export interface VisibleMacosRuntimeTabCloseEvidence {
  readonly tabId: string;
  readonly windowId: string;
  readonly x: number;
  readonly y: number;
}

/** Reads exact AppKit close geometry without submitting the user action. */
export async function readVisibleMacosRuntimeTabCloseEvidence(input: Readonly<{
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<VisibleMacosRuntimeTabCloseEvidence> {
  const [toolbar, runtimeInspection] = await Promise.all([
    electronDesktopE2eFullscreenToolbarRuntime(input.windowId),
    electronDesktopE2eGameWindowRuntime(input.windowId)
  ]);
  const runtime = runtimeInspection.currentRuntime;
  const anchor = toolbar.native.appKit?.tabAnchors?.[input.tabId];
  if (!runtime || runtime.hostKind !== "appkit-chromium" ||
      runtime.windowId !== input.windowId ||
      !runtime.nativeTabIds.includes(input.tabId) ||
      toolbar.hostKind !== "appkit" || !toolbar.tabIds.includes(input.tabId) ||
      !anchor) {
    throw new Error(`The exact AppKit tab ${input.tabName} has no native close geometry`);
  }
  const bounds = runtime.nativeDisplay.bounds;
  return Object.freeze({
    tabId: input.tabId,
    windowId: input.windowId,
    // The native anchor is the tab's right-centre point. AppKit lays the
    // 20 pt close slot 8 pt inside that edge, so its visible centre is 18 pt left.
    x: bounds.x + anchor.x - 18,
    y: bounds.y + anchor.y
  });
}

async function closeMacosAppKitTab(
  mainWindowHandle: string,
  windowId: string,
  tabId: string,
  tabName: string,
  exactProcessId?: number,
  preloadedEvidence?: VisibleMacosRuntimeTabCloseEvidence,
  deferRendererVerification = false
): Promise<void> {
  if (exactProcessId !== undefined &&
      (!Number.isSafeInteger(exactProcessId) || exactProcessId < 1)) {
    throw new Error("The exact AppKit tab close requires one valid process ID");
  }
  const processId = String(
    exactProcessId ?? (await electronDesktopE2eProbe()).processId
  );
  const evidence = preloadedEvidence ??
    await readVisibleMacosRuntimeTabCloseEvidence({ tabId, tabName, windowId });
  if (evidence.tabId !== tabId || evidence.windowId !== windowId ||
      !Number.isFinite(evidence.x) || !Number.isFinite(evidence.y)) {
    throw new Error("The preloaded AppKit tab close evidence changed identity");
  }
  if (deferRendererVerification && preloadedEvidence === undefined) {
    throw new Error("A deferred AppKit close requires preloaded native evidence");
  }
  const expectedWindowIdentifier =
    `com.rionstudio.runtime.appkit-window.v1:${windowId}`;
  await readAppKitAction(`
on run argv
  set expectedWindowIdentifier to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set targetWindow to missing value
    set targetCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is expectedWindowIdentifier then
          set targetWindow to appWindow
          set targetCount to targetCount + 1
        end if
      end try
    end repeat
    if targetCount is not 1 then error "exact AppKit close window unavailable"
    set frontmost of targetProcess to true
    perform action "AXRaise" of targetWindow
    return "raised"
  end tell
end run`, expectedWindowIdentifier, processId);
  await clickMacosScreenPoint(evidence.x, evidence.y);
  if (deferRendererVerification) return;
  await switchTrackedWindow(mainWindowHandle);
  await browser.waitUntil(async () => {
    const observed = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime;
    return !observed || !observed.nativeTabIds.includes(tabId);
  }, {
    interval: 100,
    timeout: 10_000,
    timeoutMsg: `The visible AppKit close control did not close ${tabName} (${tabId})`
  });
}

async function closeMacosAppKitWindow(tabName?: string): Promise<void> {
  const processId = String((await electronDesktopE2eProbe()).processId);
  await runAppKitAction(`
on run argv
  set targetName to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set targetWindow to missing value
    set targetCount to 0
    repeat with appWindow in windows of targetProcess
      set hasRuntimeTab to false
      set hasTargetTab to false
      set allElements to entire contents of appWindow
      repeat with candidate in allElements
        try
          if role of candidate is "AXRadioButton" then
            set hasRuntimeTab to true
            if targetName is not "" and description of candidate is targetName then
              set hasTargetTab to true
            end if
          end if
        end try
      end repeat
      if hasRuntimeTab and (targetName is "" or hasTargetTab) then
        set targetWindow to appWindow
        set targetCount to targetCount + 1
      end if
    end repeat
    if targetCount is not 1 then error "exact AppKit runtime window unavailable"
    tell targetWindow
      set closeButtons to buttons whose subrole is "AXCloseButton"
      if (count of closeButtons) is not 1 then error "AppKit close control unavailable"
      perform action "AXPress" of item 1 of closeButtons
    end tell
  end tell
end run`, tabName ?? "", processId);
}

/** Activates one exact visible native tab without debug/runtime action APIs. */
export async function clickVisibleRuntimeTab(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId: string;
  tabName: string;
}>): Promise<void> {
  if (input.platform === "macos") {
    await clickMacosAppKitTab(input.tabName);
    return;
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const activate = await $(
      `[data-runtime-tab-activate][data-tab-id='${input.tabId}']`
    );
    await activate.waitForClickable({ timeout: 10_000 });
    await activate.click();
  });
}

/** Closes one exact tab through its retained AppKit or bundled Windows chrome. */
export async function closeVisibleRuntimeTab(input: Readonly<{
  deferMacosRendererVerification?: boolean;
  mainWindowHandle: string;
  macosCloseEvidence?: VisibleMacosRuntimeTabCloseEvidence;
  platform: "macos" | "windows";
  processId?: number;
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<void> {
  if (input.platform === "macos") {
    await closeMacosAppKitTab(
      input.mainWindowHandle,
      input.windowId,
      input.tabId,
      input.tabName,
      input.processId,
      input.macosCloseEvidence,
      input.deferMacosRendererVerification
    );
    return;
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const close = await $(`[data-runtime-tab-close][data-tab-id='${input.tabId}']`);
    await close.waitForClickable({ timeout: 10_000 });
    await close.click();
  });
}

// Windows Chromium tab-gesture helpers. These submit only real pointer/menu
// actions to the bundled host; callers use the observation bridge separately.
export async function dragVisibleWindowsRuntimeTab(input: Readonly<{
  beforeTabId?: string;
  mainWindowHandle: string;
  tabId: string;
}>): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The bundled Windows tab drag is Windows-only");
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const source = await $(
      `[data-runtime-tab-activate][data-tab-id='${input.tabId}']`
    );
    await source.waitForClickable({ timeout: 10_000 });
    const target = input.beforeTabId === undefined
      ? await $("[data-runtime-tabs]")
      : await $(
          `[data-runtime-tab-activate][data-tab-id='${input.beforeTabId}']`
        );
    await target.waitForDisplayed({ timeout: 10_000 });
    const targetSize = await target.getSize();
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: source, x: 0, y: 0 })
      .down("left")
      .move({
        duration: 500,
        origin: target,
        x: input.beforeTabId === undefined
          ? Math.max(1, Math.floor(targetSize.width / 2) - 8)
          : -Math.max(8, Math.floor(targetSize.width / 4)),
        y: 0
      })
      .up("left")
      .perform();
  });
}

export async function selectVisibleWindowsRuntimeTabMenuAction(input: Readonly<{
  action: "hide" | "move" | "moveToNewWindow" | "reload";
  mainWindowHandle: string;
  tabId: string;
  targetWindowId?: string;
}>): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The bundled Windows tab menu is Windows-only");
  }
  if ((input.action === "move") !== (input.targetWindowId !== undefined)) {
    throw new Error("A Windows move action requires one exact target window");
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const source = await $(
      `[data-runtime-tab-activate][data-tab-id='${input.tabId}']`
    );
    await source.waitForClickable({ timeout: 10_000 });
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: source, x: 0, y: 0 })
      .down("right")
      .up("right")
      .perform();
    const action = input.action === "hide"
      ? "hideTab"
      : input.action === "move"
        ? "moveTab"
        : input.action === "reload" ? "reloadTab" : "moveTabToNewWindow";
    const target = input.targetWindowId === undefined
      ? await $(`[data-runtime-tab-menu-action='${action}']`)
      : await $(
          `[data-runtime-tab-menu-action='${action}']` +
          `[data-target-window-id='${input.targetWindowId}']`
        );
    await target.waitForClickable({ timeout: 10_000 });
    await target.click();
  });
}

export interface VisibleWindowsRuntimeHostLayout {
  readonly contentBounds: Readonly<{
    height: number;
    width: number;
    x: number;
    y: number;
  }>;
  readonly projectionRevision: number;
  readonly resizeEventCount: number;
  readonly topologyRevision: number;
  readonly viewport: Readonly<{ height: number; width: number }>;
  readonly visibleTabIds: readonly string[];
  readonly windowGeneration: number;
  readonly windowId: string;
}

/** Reads the exact visible host viewport/projection without mutating runtime state. */
export async function readVisibleWindowsRuntimeHostLayout(input: Readonly<{
  mainWindowHandle: string;
  tabId: string;
}>): Promise<VisibleWindowsRuntimeHostLayout> {
  if (process.platform !== "win32") {
    throw new Error("The bundled Windows host layout is Windows-only");
  }
  return withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, () =>
    browser.execute(() => {
      const root = document.documentElement.dataset;
      const number = (value: string | undefined, name: string): number => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) {
          throw new Error(`Windows runtime ${name} is unavailable`);
        }
        return parsed;
      };
      if (!root.runtimeWindowId) {
        throw new Error("Windows runtime window identity is unavailable");
      }
      return {
        contentBounds: {
          height: number(root.runtimeContentHeight, "content height"),
          width: number(root.runtimeContentWidth, "content width"),
          x: number(root.runtimeContentX, "content x"),
          y: number(root.runtimeContentY, "content y")
        },
        projectionRevision: number(
          root.runtimeProjectionRevision,
          "projection revision"
        ),
        resizeEventCount: number(root.runtimeResizeEventCount, "resize event count"),
        topologyRevision: number(root.runtimeTopologyRevision, "topology revision"),
        viewport: { height: window.innerHeight, width: window.innerWidth },
        visibleTabIds: [...document.querySelectorAll<HTMLElement>(
          ".runtime-tab[data-tab-id]"
        )].map((element) => element.dataset.tabId!),
        windowGeneration: number(root.runtimeWindowGeneration, "window generation"),
        windowId: root.runtimeWindowId
      };
    })
  );
}

/** Closes the live native Game Window, leaving its saved topology dormant. */
export async function closeVisibleRuntimeWindow(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId?: string;
  tabName?: string;
}>): Promise<void> {
  if (input.platform === "macos") {
    await closeMacosAppKitWindow(input.tabName);
    return;
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const close = await $("button[data-window-command='closeWindow']");
    await close.waitForClickable({ timeout: 10_000 });
    await close.click();
  });
}

/** Reads the visible native phase adornment without mutating runtime state. */
export async function visibleRuntimeTabPhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<"degraded" | "failed" | "loading" | "ready"> {
  if (input.platform === "macos") {
    const inspection = await electronDesktopE2eGameWindowRuntime(input.windowId);
    const runtime = inspection.currentRuntime;
    if (!runtime?.appKitIdentity ||
        runtime.appKitIdentity.logicalWindowId !== input.windowId ||
        runtime.nativeTabIds.length === 0 ||
        !runtime.nativeTabIds.includes(input.tabId) ||
        runtime.appKitStatusPresentation === null) {
      throw new Error(
        `AppKit window ${input.windowId} has no exact visible status presentation`
      );
    }
    return runtime.appKitStatusPresentation;
  }
  let phase: string | null = null;
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const item = await $(`.runtime-tab[data-tab-id='${input.tabId}']`);
    await item.waitForDisplayed({ timeout: 10_000 });
    phase = await item.getAttribute("data-phase");
  });
  if (phase === "degraded" || phase === "failed" || phase === "ready") return phase;
  if (phase === "activating" || phase === "attaching" || phase === "loading") {
    return "loading";
  }
  throw new Error(`Windows native tab ${input.tabId} reported invalid phase ${phase}`);
}

/** Presses a real retained-AppKit or bundled-Windows window control. */
export async function clickVisibleRuntimeWindowControl(input: Readonly<{
  command: "maximize" | "minimize";
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId?: string;
}>): Promise<void> {
  if (input.platform === "windows") {
    await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
      const command = input.command === "maximize"
        ? "toggleMaximizeWindow"
        : "minimizeWindow";
      const control = await $(`button[data-window-command='${command}']`);
      await control.waitForClickable({ timeout: 10_000 });
      await control.click();
    });
    return;
  }
  const processId = String((await electronDesktopE2eProbe()).processId);
  if (input.command === "minimize") {
    await runAppKitAction(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    repeat with appWindow in windows of targetProcess
      if (count of (entire contents of appWindow whose role is "AXRadioButton")) > 0 then
        set buttonsFound to buttons of appWindow whose subrole is "AXMinimizeButton"
        if (count of buttonsFound) is not 1 then error "AppKit minimize control unavailable"
        perform action "AXPress" of item 1 of buttonsFound
        return
      end if
    end repeat
    error "exact AppKit runtime window unavailable"
  end tell
end run`, processId);
    return;
  }
  await runAppKitAction(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    set frontmost of targetProcess to true
    tell menu bar 1 of targetProcess
      click menu bar item "Window"
      click menu item "Zoom" of menu 1 of menu bar item "Window"
    end tell
  end tell
end run`, processId);
}

/** Reads the OS-native minimized state after the visible minimize action. */
export async function runtimeWindowIsMinimized(
  platform: "macos" | "windows"
): Promise<boolean> {
  const processId = String((await electronDesktopE2eProbe()).processId);
  if (platform === "macos") {
    return (await readAppKitAction(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    repeat with appWindow in windows of targetProcess
      if (count of (entire contents of appWindow whose role is "AXRadioButton")) > 0 then
        return (value of attribute "AXMinimized" of appWindow) as text
      end if
    end repeat
    error "exact AppKit runtime window unavailable"
  end tell
end run`, processId)) === "true";
  }
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionWindowReadback {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
}
'@
$targetPid = [uint32]$args[0]
$matches = New-Object System.Collections.Generic.List[System.IntPtr]
[RionWindowReadback]::EnumWindows({ param($hwnd, $value) $pid = 0; [RionWindowReadback]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null; if ($pid -eq $targetPid -and [RionWindowReadback]::IsIconic($hwnd)) { $matches.Add($hwnd) }; return $true }, [IntPtr]::Zero) | Out-Null
if ($matches.Count -ne 1) { throw "exact minimized runtime window unavailable" }
Write-Output "true"
`;
  const result = await executeFile("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
    processId
  ], { encoding: "utf8", timeout: 10_000 });
  return result.stdout.trim() === "true";
}

/** Drags the visible native titlebar; Windows uses its local no-content drag region. */
export async function dragVisibleRuntimeWindow(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId?: string;
}>): Promise<void> {
  if (input.platform === "windows") {
    await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
      const dragRegion = await $(".runtime-drag-region");
      await browser.action("pointer", { parameters: { pointerType: "mouse" } })
        .move({ origin: dragRegion, x: 120, y: 18 })
        .down("left")
        .move({ x: 64, y: 38, duration: 500 })
        .up("left")
        .perform();
    });
    return;
  }
  const processId = String((await electronDesktopE2eProbe()).processId);
  const geometry = await readAppKitAction(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    repeat with appWindow in windows of targetProcess
      if (count of (entire contents of appWindow whose role is "AXRadioButton")) > 0 then
        set p to position of appWindow
        set s to size of appWindow
        return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text)
      end if
    end repeat
  end tell
end run`, processId);
  const [x, y, width] = geometry.split(",").map(Number);
  const swift = `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: ${x! + width! / 2}, y: ${y! + 16})
let end = CGPoint(x: start.x + 64, y: start.y + 38)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", swift], {
    encoding: "utf8",
    timeout: 30_000
  });
}

/** Resizes one exact Windows runtime host through its real OS resize border. */
export async function resizeVisibleWindowsRuntimeWindow(input: Readonly<{
  deltaHeight: number;
  deltaWidth: number;
  mainWindowHandle: string;
  tabId: string;
}>): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The exact Windows runtime resize is Windows-only");
  }
  if (!Number.isSafeInteger(input.deltaWidth) || !Number.isSafeInteger(input.deltaHeight) ||
      Math.abs(input.deltaWidth) > 400 || Math.abs(input.deltaHeight) > 400) {
    throw new Error("The exact Windows runtime resize delta is invalid");
  }
  await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const rect = await browser.getWindowRect();
    const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionExactVisibleResize {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$right = [int]$args[0]
$bottom = [int]$args[1]
$deltaWidth = [int]$args[2]
$deltaHeight = [int]$args[3]
[RionExactVisibleResize]::SetCursorPos($right - 2, $bottom - 2) | Out-Null
[RionExactVisibleResize]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[RionExactVisibleResize]::SetCursorPos($right + $deltaWidth, $bottom + $deltaHeight) | Out-Null
[RionExactVisibleResize]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
[RionExactVisibleResize]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;
    await executeFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      String(rect.x + rect.width),
      String(rect.y + rect.height),
      String(input.deltaWidth),
      String(input.deltaHeight)
    ], { encoding: "utf8", timeout: 10_000 });
  });
}

/** Resizes the visible native window by dragging its OS-native lower-right edge. */
export async function resizeVisibleRuntimeWindow(
  platform: "macos" | "windows"
): Promise<void> {
  const processId = String((await electronDesktopE2eProbe()).processId);
  if (platform === "windows") {
    const script = String.raw`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RionVisibleResize {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr value);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$targetPid = [uint32]$args[0]
$matches = New-Object System.Collections.Generic.List[System.IntPtr]
[RionVisibleResize]::EnumWindows({ param($hwnd, $value) $pid = 0; [RionVisibleResize]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null; $title = New-Object System.Text.StringBuilder 256; [RionVisibleResize]::GetWindowText($hwnd, $title, 256) | Out-Null; if ($pid -eq $targetPid -and $title.ToString() -eq "Rion Studio Game Window") { $matches.Add($hwnd) }; return $true }, [IntPtr]::Zero) | Out-Null
if ($matches.Count -ne 1) { throw "exact visible runtime window unavailable" }
$rect = New-Object RionVisibleResize+RECT
[RionVisibleResize]::GetWindowRect($matches[0], [ref]$rect) | Out-Null
[RionVisibleResize]::SetCursorPos($rect.Right - 2, $rect.Bottom - 2) | Out-Null
[RionVisibleResize]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[RionVisibleResize]::SetCursorPos($rect.Right + 72, $rect.Bottom + 48) | Out-Null
[RionVisibleResize]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
[RionVisibleResize]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;
    await executeFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script, processId
    ], { encoding: "utf8", timeout: 10_000 });
    return;
  }
  const geometry = await readAppKitAction(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to item 1 of (application processes whose unix id is targetPid)
    repeat with appWindow in windows of targetProcess
      set hasRuntimeTab to false
      repeat with candidate in entire contents of appWindow
        try
          if role of candidate is "AXRadioButton" then set hasRuntimeTab to true
        end try
      end repeat
      if hasRuntimeTab then
        set p to position of appWindow
        set s to size of appWindow
        return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
      end if
    end repeat
    error "exact AppKit runtime window unavailable"
  end tell
end run`, processId);
  const [x, y, width, height] = geometry.split(",").map(Number);
  const swift = `
import CoreGraphics
let source = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: ${x! + width! - 2}, y: ${y! + height! - 2})
let end = CGPoint(x: start.x + 72, y: start.y + 48)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", swift], {
    encoding: "utf8",
    timeout: 30_000
  });
}
