import { $, browser, expect } from "@wdio/globals";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  GameWindow,
  LaunchWorkspace,
  Macro,
  Role
} from "../../../src/shared/types";
import {
  electronDesktopE2eFocusMainWindow,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRolePlaceholderRuntime,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { fixtureCursor, fixtureRequest, waitFixtureEvent } from "../support/fixture";
import { clickVisibleRuntimeTab } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForMacroProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

export type ChromiumMacroPlatform = "macos" | "windows";

const executeFile = promisify(execFile);

export interface ChromiumMacroScenarioContext {
  readonly mainWindowHandle: string;
  readonly platform: ChromiumMacroPlatform;
}

export interface ChromiumRoleTab {
  readonly role: Role;
  readonly tabId: string;
  readonly windowId: string;
}

type DiagnosticResult = Readonly<
  { status: "fulfilled"; value: unknown } |
  { reason: string; status: "rejected" }
>;

function diagnosticResult(result: PromiseSettledResult<unknown>): DiagnosticResult {
  return result.status === "fulfilled"
    ? Object.freeze({ status: "fulfilled", value: result.value })
    : Object.freeze({
        reason: result.reason instanceof Error
          ? `${result.reason.name}: ${result.reason.message}`
          : String(result.reason),
        status: "rejected"
      });
}

async function chromiumRoleLaunchDiagnostic(
  roleId: string,
  windowId: string,
  projectionOutcome: string
): Promise<Readonly<Record<string, unknown>>> {
  const [embeddedRuntime, gameWindowRuntime, placeholderRuntime, roleSessionRuntime] =
    await Promise.allSettled([
      rendererCall("getEmbeddedRuntimeState"),
      electronDesktopE2eGameWindowRuntime(windowId),
      electronDesktopE2eRolePlaceholderRuntime(roleId),
      electronDesktopE2eRoleSessionRuntime(roleId)
    ]);
  return Object.freeze({
    embeddedRuntime: diagnosticResult(embeddedRuntime),
    gameWindowRuntime: diagnosticResult(gameWindowRuntime),
    placeholderRuntime: diagnosticResult(placeholderRuntime),
    projectionOutcome,
    roleSessionRuntime: diagnosticResult(roleSessionRuntime)
  });
}

export function requiredMacroEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium Macro cutover`);
  return value;
}

export function chromiumMacroPlatform(): ChromiumMacroPlatform {
  const target = requiredMacroEnvironment("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "macos";
  if (target === "chromium-v23-windows") return "windows";
  throw new Error(`Unsupported Chromium Macro runtime target ${target}`);
}

export function macroFixtureUrl(fixtureId: string, query = ""): string {
  const url = new URL(
    `/role/${fixtureId}`,
    requiredMacroEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  );
  if (query) url.search = query;
  return url.href;
}

export async function bootstrapChromiumMacroCutover(): Promise<
  ChromiumMacroScenarioContext
> {
  const probe = await electronDesktopE2eProbe();
  const platform = chromiumMacroPlatform();
  expect(probe.platform).toBe(platform);
  expect(probe.runtimeTarget).toBe(
    requiredMacroEnvironment("RION_STUDIO_E2E_RUNTIME_TARGET")
  );
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  await fixtureRequest("/api/reset", {});
  return {
    mainWindowHandle: await browser.getWindowHandle(),
    platform
  };
}

export async function openChromiumSection(
  label: string,
  route: string
): Promise<void> {
  await electronDesktopE2eFocusMainWindow();
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
  await waitForRoute(route);
}

async function pressVisibleControl(
  selector: string,
  expectedLabel?: string,
  interaction: "accessibility" | "physical" = "accessibility",
  expectedAccessibilityRole?: "AXButton" | "AXMenuItem"
): Promise<void> {
  const control = await $(selector);
  await control.waitForClickable({ timeout: 10_000 });
  if (chromiumMacroPlatform() !== "macos") {
    await control.click();
    return;
  }
  const accessibleLabel = [
    expectedLabel,
    await control.getAttribute("aria-label"),
    await control.getComputedLabel(),
    await control.getText()
  ].find((candidate) => candidate?.trim())?.trim();
  if (!accessibleLabel) {
    throw new Error("The visible Chromium Macro control has no accessible label");
  }
  await electronDesktopE2eFocusMainWindow();
  const focused = await browser.execute((target) => {
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }, control);
  if (!focused) {
    throw new Error("The visible Chromium Macro control rejected exact focus");
  }
  const probe = await electronDesktopE2eProbe();
  await executeFile("/usr/bin/osascript", [
    "-e",
    `on run argv
  set targetPid to (item 1 of argv) as integer
  set appKitWindowPrefix to "com.rionstudio.runtime.appkit-window.v1:"
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set launcherWindow to missing value
    set launcherWindowCount to 0
    repeat with appWindow in windows of targetProcess
      set appWindowIdentifier to ""
      try
        set appWindowIdentifier to value of attribute "AXIdentifier" of appWindow as text
      end try
      if appWindowIdentifier does not start with appKitWindowPrefix then
        if value of attribute "AXRole" of appWindow is "AXWindow" then
          set launcherWindow to appWindow
          set launcherWindowCount to launcherWindowCount + 1
        end if
      end if
    end repeat
    if launcherWindowCount is not 1 then error "exact Rion launcher AXWindow unavailable"
    perform action "AXRaise" of launcherWindow
  end tell
end run`,
    "--",
    String(probe.processId)
  ], { encoding: "utf8", timeout: 10_000 });
  const script = `
import ApplicationServices
import AppKit
let targetPid = pid_t(${probe.processId})
let expectedLabel = ${JSON.stringify(accessibleLabel)}
let useAccessibilityAction = ${interaction === "accessibility"}
let expectedRole = ${JSON.stringify(expectedAccessibilityRole ?? "")}
let appKitWindowPrefix = "com.rionstudio.runtime.appkit-window.v1:"
let application = AXUIElementCreateApplication(targetPid)

guard let targetApplication = NSRunningApplication(processIdentifier: targetPid) else {
  fatalError("exact Rion application is unavailable")
}
if useAccessibilityAction {
  guard targetApplication.activate(options: [.activateAllWindows]) else {
    fatalError("exact Rion application rejected foreground activation")
  }
  RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
}

func normalizedLabel(_ value: String) -> String {
  value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return nil
  }
  return value as? String
}

func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
      let number = value as? NSNumber else {
    return false
  }
  return number.boolValue
}

func elementArrayAttribute(
  _ element: AXUIElement,
  _ attribute: CFString
) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
      let elements = value as? [AXUIElement] else {
    return []
  }
  return elements
}

func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
      let rawValue = value,
      CFGetTypeID(rawValue) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = rawValue as! AXValue
  guard AXValueGetType(axValue) == .cgPoint else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
  return point
}

func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
      let rawValue = value,
      CFGetTypeID(rawValue) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = rawValue as! AXValue
  guard AXValueGetType(axValue) == .cgSize else { return nil }
  var size = CGSize.zero
  guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
  return size
}

let roots = elementArrayAttribute(application, kAXWindowsAttribute as CFString)
guard !roots.isEmpty else {
  fatalError("exact Rion launcher AXWindow unavailable")
}
let launcherRoots = roots.filter { element in
  stringAttribute(element, kAXRoleAttribute as CFString) == (kAXWindowRole as String)
    && !(stringAttribute(element, kAXIdentifierAttribute as CFString)?
      .hasPrefix(appKitWindowPrefix) ?? false)
}
guard launcherRoots.count == 1 else {
  fatalError("exact Rion launcher AXWindow count was " + String(launcherRoots.count))
}
var queue = launcherRoots
var cursor = 0
var matches: [AXUIElement] = []
while cursor < queue.count {
  guard queue.count <= 4096 else {
    fatalError("exact Rion accessibility tree exceeded its bounded search")
  }
  let element = queue[cursor]
  cursor += 1
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid else {
    fatalError("accessibility control escaped the exact Rion process")
  }
  var actionValues: CFArray?
  let elementRole = stringAttribute(element, kAXRoleAttribute as CFString)
  let physicalRole = expectedRole.isEmpty
    ? (kAXMenuItemRole as String)
    : expectedRole
  if (useAccessibilityAction || elementRole == physicalRole),
      AXUIElementCopyActionNames(element, &actionValues) == .success,
      let actions = actionValues as? [String],
      actions.contains(kAXPressAction as String),
      boolAttribute(element, kAXFocusedAttribute as CFString) {
    let labels = [
      stringAttribute(element, kAXTitleAttribute as CFString),
      stringAttribute(element, kAXDescriptionAttribute as CFString),
      stringAttribute(element, kAXValueAttribute as CFString),
      stringAttribute(element, kAXHelpAttribute as CFString)
    ].compactMap { $0 }
    let normalizedExpectedLabel = normalizedLabel(expectedLabel)
    if labels.contains(where: {
      let candidate = normalizedLabel($0)
      return candidate == normalizedExpectedLabel
        || candidate.hasPrefix(normalizedExpectedLabel + " ")
    }) {
      if !matches.contains(where: { CFEqual($0, element) }) {
        matches.append(element)
      }
    }
  }
  queue.append(contentsOf: elementArrayAttribute(
    element,
    kAXChildrenAttribute as CFString
  ))
}
guard matches.count == 1 else {
  fatalError("exact Rion focused AXPress control count was " + String(matches.count))
}
guard AXUIElementPerformAction(
  launcherRoots[0],
  kAXRaiseAction as CFString
) == .success else {
  fatalError("exact Rion launcher AXWindow rejected AXRaise")
}
RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
if useAccessibilityAction {
  guard AXUIElementPerformAction(
    matches[0],
    kAXPressAction as CFString
  ) == .success else {
    fatalError("exact Rion visible control rejected AXPress")
  }
} else {
  guard stringAttribute(
    matches[0],
    kAXRoleAttribute as CFString
  ) == (expectedRole.isEmpty ? (kAXMenuItemRole as String) : expectedRole) else {
    fatalError("exact Rion destination has an unexpected accessibility role")
  }
  guard let position = pointAttribute(matches[0], kAXPositionAttribute as CFString),
      let size = sizeAttribute(matches[0], kAXSizeAttribute as CFString),
      size.width > 0, size.height > 0 else {
    fatalError("exact Rion visible control has invalid accessibility geometry")
  }
  let clickPoint = CGPoint(
    x: position.x + size.width / 2,
    y: position.y + size.height / 2
  )
  if !targetApplication.isActive {
    guard targetApplication.activate(options: []) else {
      fatalError("exact Rion application rejected physical-click activation")
    }
    let activationDeadline = Date(timeIntervalSinceNow: 2)
    while !targetApplication.isActive && Date() < activationDeadline {
      RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
  }
  guard targetApplication.isActive else {
    let foreground = NSWorkspace.shared.frontmostApplication
    let activationEvidence: [String: Any] = [
      "targetPid": Int(targetPid),
      "targetActive": targetApplication.isActive,
      "targetHidden": targetApplication.isHidden,
      "targetTerminated": targetApplication.isTerminated,
      "targetFinishedLaunching": targetApplication.isFinishedLaunching,
      "targetActivationPolicy": targetApplication.activationPolicy.rawValue,
      "foregroundPid": Int(foreground?.processIdentifier ?? 0)
    ]
    let evidenceData = try! JSONSerialization.data(withJSONObject: activationEvidence, options: [.sortedKeys])
    let evidence = String(data: evidenceData, encoding: .utf8)!
    // A rejected external activation is a test failure, not a Swift crash.
    // Keep stderr and a nonzero exit without spawning a crash-report dialog.
    let message = "exact Rion application did not become active for the physical click: " + evidence
    FileHandle.standardError.write(Data(message.utf8))
    FileHandle.standardError.write(Data([10]))
    exit(1)
  }
  for eventType in [
    CGEventType.mouseMoved,
    CGEventType.leftMouseDown,
    CGEventType.leftMouseUp
  ] {
    guard let event = CGEvent(
      mouseEventSource: nil,
      mouseType: eventType,
      mouseCursorPosition: clickPoint,
      mouseButton: .left
    ) else {
      fatalError("exact Rion visible control mouse event is unavailable")
    }
    event.post(tap: .cghidEventTap)
    usleep(50_000)
  }
}
RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
}

export async function createChromiumMacroWindow(
  id: string,
  name: string
): Promise<GameWindow> {
  const topology = await rendererCall("getDisplayTopology");
  const display = topology.displays.find((candidate) => candidate.isPrimary)
    ?? topology.displays[0];
  if (!display) throw new Error("Chromium Macro E2E requires one physical display");
  const work = display.workArea;
  return rendererCall("createGameWindow", {
    id,
    name,
    placement: {
      normalBounds: {
        height: Math.max(440, Math.min(620, work.height - 120)),
        width: Math.max(680, Math.min(960, work.width - 120)),
        x: work.x + 40,
        y: work.y + 50
      },
      presentation: "normal",
      savedWorkArea: work
    },
    targetDisplay: {
      id: display.id,
      fingerprint: {
        label: display.label,
        bounds: display.bounds,
        resolution: display.resolution,
        scaleFactor: display.scaleFactor,
        isPrimary: display.isPrimary,
        isInternal: display.isInternal
      }
    }
  });
}

export async function showChromiumMacroWindow(window: GameWindow): Promise<void> {
  const expectedTabIds = window.tabs.map((tab) => tab.id);
  const expectedActiveTabId = window.activeTabId ?? expectedTabIds.at(-1);
  const waitForExactRestore = async (): Promise<void> => {
    await browser.waitUntil(async () => {
      try {
        const [runtime, native] = await Promise.all([
          rendererCall("getEmbeddedRuntimeState"),
          electronDesktopE2eGameWindowRuntime(window.id)
        ]);
        const runtimeWindow = runtime.windows.find(
          (candidate) => candidate.windowId === window.id
        );
        const runtimeTabIds = runtime.tabs
          .filter((tab) => tab.windowId === window.id)
          .map((tab) => tab.id);
        const current = native.currentRuntime;
        const sameIds = (ids: readonly string[]) =>
          ids.length === expectedTabIds.length &&
          ids.every((id, index) => id === expectedTabIds[index]);
        return runtimeWindow?.visible === true && current?.visible === true &&
          runtimeWindow.activeTabId === expectedActiveTabId &&
          sameIds(runtimeTabIds) && sameIds(current.coreTabIds) &&
          sameIds(current.nativeTabIds);
      } catch {
        return false;
      }
    }, {
      timeout: 55_000,
      timeoutMsg: `Game Window ${window.id} did not complete its exact saved restore`
    });
  };
  await openChromiumSection("Windows", "/game-windows");
  if (window.tabs.length > 0) {
    await browser.waitUntil(async () => {
      const runtime = await rendererCall("getEmbeddedRuntimeState");
      return runtime.windows.some((candidate) => candidate.windowId === window.id)
        || runtime.savedWindows?.some((candidate) =>
          candidate.id === window.id && candidate.state !== "restoring"
        ) === true;
    }, {
      timeout: 10_000,
      timeoutMsg: `Game Window ${window.id} did not finish saved-state projection`
    });
  }
  const runtimeBeforeShow = await rendererCall("getEmbeddedRuntimeState");
  if (runtimeBeforeShow.windows.some((candidate) => candidate.windowId === window.id)) {
    await waitForExactRestore();
    return;
  }
  const show = await $(
    `[data-selection-id='${window.id}'] button[aria-label='Show']`
  );
  await show.waitForClickable({ timeout: 10_000 });
  await writeChromiumMacroEvidence("chromium-macro-window-show-before.json", {
    ariaDisabled: await show.getAttribute("aria-disabled"),
    disabled: await show.getAttribute("disabled"),
    enabled: await show.isEnabled(),
    runtime: runtimeBeforeShow,
    windowId: window.id
  });
  await pressVisibleControl(
    `[data-selection-id='${window.id}'] button[aria-label='Show']`,
    "Show",
    "physical",
    "AXButton"
  );
  try {
    await browser.waitUntil(async () => {
      const alert = await $("[role='alert']");
      if (await alert.isExisting() && await alert.isDisplayed()) {
        throw new Error(`Visible Game Window Show failed: ${await alert.getText()}`);
      }
      const runtime = await rendererCall("getEmbeddedRuntimeState");
      return runtime.windows.some((candidate) => candidate.windowId === window.id);
    }, {
      timeout: 20_000,
      timeoutMsg: `Game Window ${window.id} did not become visibly live`
    });
    await waitForExactRestore();
  } catch (error) {
    const runtimeAfterShow = await rendererCall("getEmbeddedRuntimeState");
    await writeChromiumMacroEvidence("chromium-macro-window-show-after.json", {
      ariaDisabled: await show.getAttribute("aria-disabled"),
      disabled: await show.getAttribute("disabled"),
      enabled: await show.isEnabled(),
      error: error instanceof Error ? error.message : String(error),
      runtime: runtimeAfterShow,
      windowId: window.id
    });
    throw error;
  }
}

export async function launchChromiumRoleVisible(
  role: Role,
  fixtureId: string,
  window: Readonly<Pick<GameWindow, "id"> & Partial<Pick<GameWindow, "name">>>,
  options?: Readonly<{
    /** Runs after remote readiness but before WebDriver re-enters the launcher. */
    beforeRendererInspection?: () => Promise<void>;
  }>
): Promise<ChromiumRoleTab> {
  await openChromiumSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(role.name);
  await pressVisibleControl(
    `[data-testid='quick-access-destination-role-${role.id}']`
  );
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${window.id}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  const fixtureAfter = await fixtureCursor();
  const projectionAfter = await rendererEventCursor();
  await pressVisibleControl(
    `[data-testid='quick-access-destination-option-window-${window.id}']`,
    undefined,
    "physical"
  );
  let projectionOutcome = "pending";
  const waitProjection = async (): Promise<void> => {
    try {
      await waitForRoleProjection({
        afterSequence: projectionAfter,
        roleId: role.id,
        state: "running"
      });
      projectionOutcome = "fulfilled";
    } catch (error) {
      projectionOutcome = error instanceof Error
        ? `rejected:${error.name}:${error.message}`
        : `rejected:${String(error)}`;
      throw error;
    }
  };
  try {
    const sessionReady = waitFixtureEvent({
      afterSequence: fixtureAfter,
      kind: "session",
      roleId: fixtureId
    });
    if (options?.beforeRendererInspection) {
      await sessionReady;
      await options.beforeRendererInspection();
      await waitProjection();
    } else {
      await Promise.all([sessionReady, waitProjection()]);
    }
  } catch (error) {
    const diagnostic = await chromiumRoleLaunchDiagnostic(
      role.id,
      window.id,
      projectionOutcome
    );
    throw new Error(
      `Visible Chromium Role launch failed: cause=${JSON.stringify(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )}; diagnostic=${JSON.stringify(diagnostic)}`,
      { cause: error }
    );
  }
  const runtime = await waitForRuntimeProjection({
    afterSequence: projectionAfter,
    sourceId: role.id
  });
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === role.id);
  if (!tab) throw new Error(`Chromium Role ${role.id} has no exact runtime tab`);
  return { role, tabId: tab.id, windowId: tab.windowId };
}

export async function launchChromiumWorkspaceVisible(
  workspace: LaunchWorkspace,
  fixtureIds: readonly string[],
  window: GameWindow
): Promise<Readonly<{ tabId: string; windowId: string }>> {
  await openChromiumSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(workspace.name);
  await $(`#quick-access-option-workspace-${workspace.id}`).waitForDisplayed({
    timeout: 10_000
  });
  await pressVisibleControl(
    `[data-testid='quick-access-destination-workspace-${workspace.id}']`
  );
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${window.id}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  const fixtureAfter = await fixtureCursor();
  const projectionAfter = await rendererEventCursor();
  await pressVisibleControl(
    `[data-testid='quick-access-destination-option-window-${window.id}']`,
    undefined,
    "physical"
  );
  const sessions = fixtureIds.map((roleId) => waitFixtureEvent({
    afterSequence: fixtureAfter,
    kind: "session",
    roleId
  }));
  const [runtime] = await Promise.all([
    waitForRuntimeProjection({ afterSequence: projectionAfter, sourceId: workspace.id }),
    ...sessions
  ]);
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === workspace.id);
  if (!tab) throw new Error(`Chromium Workspace ${workspace.id} has no runtime tab`);
  return { tabId: tab.id, windowId: tab.windowId };
}

export async function activateChromiumRoleVisible(
  context: ChromiumMacroScenarioContext,
  tab: ChromiumRoleTab
): Promise<void> {
  await clickVisibleRuntimeTab({
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform,
    tabId: tab.tabId,
    tabName: tab.role.name
  });
}

export async function clickChromiumMacroStartVisible(macro: Macro): Promise<number> {
  await openChromiumSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const cursor = await rendererEventCursor();
  const start = await row.$("button[aria-label='Start']");
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  return cursor;
}

export async function startChromiumMacroVisible(
  macro: Macro,
  roleIds: readonly string[]
): Promise<number> {
  const cursor = await clickChromiumMacroStartVisible(macro);
  await waitForMacroProjection({
    afterSequence: cursor,
    macroId: macro.id,
    roleIds: [...roleIds],
    state: "running"
  });
  return cursor;
}

export async function stopChromiumMacroVisible(
  macro: Macro,
  afterSequence: number
): Promise<void> {
  await openChromiumSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const stop = await row.$("button[aria-label='Stop']");
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await waitForMacroProjection({
    absent: true,
    afterSequence,
    macroId: macro.id
  });
}

export async function waitForChromiumMacroRoleReady(roleId: string): Promise<void> {
  await waitForRoleProjection({
    automationState: "ready",
    roleId,
    state: "running"
  });
}

export async function expectChromiumNativeRoleBinding(
  context: ChromiumMacroScenarioContext,
  tab: ChromiumRoleTab
): Promise<Readonly<{
  hostKind: "appkit-chromium" | "bundled-chromium";
  ownerGeneration: number;
  surfaceGeneration: number;
}>> {
  let roleRuntime: Awaited<ReturnType<
    typeof electronDesktopE2eRoleSessionRuntime
  >> | undefined;
  let windowRuntime: Awaited<ReturnType<
    typeof electronDesktopE2eGameWindowRuntime
  >> | undefined;
  await browser.waitUntil(async () => {
    try {
      [roleRuntime, windowRuntime] = await Promise.all([
        electronDesktopE2eRoleSessionRuntime(tab.role.id),
        electronDesktopE2eGameWindowRuntime(tab.windowId)
      ]);
      return roleRuntime.currentRuntime?.tabId === tab.tabId &&
        roleRuntime.currentRuntime.windowId === tab.windowId &&
        windowRuntime.currentRuntime !== null;
    } catch (error) {
      // The test harness can observe Core's next revision before Electron has
      // acknowledged the matching AppKit projection. Retry only that explicit
      // fence mismatch; the production transition remains event-bound.
      if (String(error).includes("stale Core/native Chromium fence")) return false;
      throw error;
    }
  }, {
    interval: 50,
    timeout: 10_000,
    timeoutMsg: `Chromium Role ${tab.role.id} did not reach an exact native projection fence`
  });
  if (!roleRuntime || !windowRuntime) {
    throw new Error("Exact Chromium native Role binding was not observed");
  }
  const role = roleRuntime.currentRuntime;
  const window = windowRuntime.currentRuntime;
  if (!role || !window) throw new Error("Exact Chromium native Role binding is absent");
  const hostKind = context.platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  expect(role.hostKind).toBe(hostKind);
  expect(window.hostKind).toBe(hostKind);
  expect(role.tabId).toBe(tab.tabId);
  expect(role.windowId).toBe(tab.windowId);
  expect(role.appKitIdentity === null).toBe(context.platform === "windows");
  if (context.platform === "macos") {
    expect(role.appKitIdentity).toEqual(expect.objectContaining({
      logicalWindowId: tab.windowId,
      nativeGeneration: expect.any(Number)
    }));
    expect(window.appKitIdentity).not.toBeNull();
  }
  return {
    hostKind,
    ownerGeneration: role.ownerGeneration,
    surfaceGeneration: role.generation
  };
}

export async function writeChromiumMacroEvidence(
  name: string,
  evidence: unknown
): Promise<void> {
  await writeFile(
    resolve(requiredMacroEnvironment("RION_STUDIO_E2E_ARTIFACT_DIR"), name),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
}

/** Invokes the exact foreground native application Quit accelerator/control. */
export async function quitChromiumApplicationVisible(
  context: ChromiumMacroScenarioContext
): Promise<void> {
  const pid = String((await electronDesktopE2eProbe()).processId);
  if (context.platform === "macos") {
    await executeFile("/usr/bin/osascript", ["-e", `
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set matches to application processes whose unix id is targetPid
    if (count of matches) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matches
    set frontmost of targetProcess to true
    keystroke "q" using command down
  end tell
end run`, "--", pid], { encoding: "utf8" });
    return;
  }
  await executeFile("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$pidValue=${pid}; Add-Type -AssemblyName UIAutomationClient; `
      + "$root=[System.Windows.Automation.AutomationElement]::RootElement; "
      + "$processCondition=New-Object System.Windows.Automation.PropertyCondition("
      + "[System.Windows.Automation.AutomationElement]::ProcessIdProperty,$pidValue); "
      + "$windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$processCondition); "
      + "if($windows.Count -ne 1){throw 'exact Rion main window unavailable'}; "
      + "$closeCondition=New-Object System.Windows.Automation.AndCondition("
      + "(New-Object System.Windows.Automation.PropertyCondition("
      + "[System.Windows.Automation.AutomationElement]::ControlTypeProperty,"
      + "[System.Windows.Automation.ControlType]::Button)),"
      + "(New-Object System.Windows.Automation.PropertyCondition("
      + "[System.Windows.Automation.AutomationElement]::NameProperty,'Close'))); "
      + "$buttons=$windows[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,"
      + "$closeCondition); if($buttons.Count -ne 1){throw 'exact native Close unavailable'}; "
      + "$invoke=$buttons[0].GetCurrentPattern("
      + "[System.Windows.Automation.InvokePattern]::Pattern); $invoke.Invoke();"
  ], { encoding: "utf8" });
}
