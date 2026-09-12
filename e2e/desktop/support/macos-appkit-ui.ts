import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { resolveMacosNativeTabPoint } from "./macos-native-tab-geometry";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe
} from "./electron-driver";
import type { AppLanguage } from "../../../src/shared/types";
import type { VisibleElectronPagePoint } from "./electron-role-surface";

const executeFile = promisify(execFile);

async function runSystemEvents(script: string, ...arguments_: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The retained AppKit visible control is macOS-only");
  }
  await executeFile("/usr/bin/osascript", ["-e", script, "--", ...arguments_], {
    encoding: "utf8",
    timeout: 10_000
  });
}

async function readSystemEvents(script: string, ...arguments_: string[]): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The retained AppKit visible control is macOS-only");
  }
  const result = await executeFile(
    "/usr/bin/osascript",
    ["-e", script, "--", ...arguments_],
    {
    encoding: "utf8",
    timeout: 10_000
    }
  );
  return result.stdout.trim();
}

/** Clicks one exact visible Role-page point through the retained AppKit host. */
export async function clickMacosVisibleRoleControl(
  windowId: string,
  roleId: string,
  point: VisibleElectronPagePoint
): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !windowId || windowId !== windowId.trim() ||
    !roleId || roleId !== roleId.trim() ||
    ![point.x, point.y, point.viewport.width, point.viewport.height]
      .every(Number.isFinite) ||
    point.viewport.width <= 0 || point.viewport.height <= 0 ||
    point.x < 0 || point.x > point.viewport.width ||
    point.y < 0 || point.y > point.viewport.height
  ) {
    throw new Error("The retained AppKit Role control identity is invalid");
  }
  const [probe, inspection] = await Promise.all([
    electronDesktopE2eProbe(),
    electronDesktopE2eFullscreenToolbarRuntime(windowId)
  ]);
  const surface = inspection.surfaces.find((candidate) =>
    candidate.kind === "role" && candidate.id === roleId && candidate.visible
  );
  const appKit = inspection.native.appKit;
  const visibleSurfaceTop = Math.min(
    ...inspection.surfaces
      .filter((candidate) => candidate.visible)
      .map((candidate) => candidate.bounds.y)
  );
  if (inspection.hostKind !== "appkit" || !appKit || !surface ||
      !Number.isFinite(visibleSurfaceTop) ||
      appKit.accessoryVisibleHeight < visibleSurfaceTop) {
    throw new Error("The exact visible AppKit Role surface is unavailable");
  }
  const processId = probe.processId;
  await focusVisibleMacosAppKitRuntime({ processId, windowId });
  const geometryResult = await executeFile("/usr/bin/xcrun", [
    "swift", resolve(import.meta.dirname, "macos-native-window-controls.swift"),
    String(processId), windowId, "geometry"
  ], { encoding: "utf8", timeout: 15_000 });
  const geometry = JSON.parse(geometryResult.stdout) as {
    x: number; y: number; width: number; height: number;
  };
  const windowGeometry = [geometry.x, geometry.y, geometry.width, geometry.height];
  if (windowGeometry.some((value) => !Number.isFinite(value)) ||
      windowGeometry[2]! <= 0 || windowGeometry[3]! <= 0) {
    throw new Error("The exact AppKit Role window geometry is invalid");
  }
  const scaleX = surface.bounds.width / point.viewport.width;
  const scaleY = surface.bounds.height / point.viewport.height;
  const nativeFrameInsetY = appKit.accessoryVisibleHeight - visibleSurfaceTop;
  const clickX = windowGeometry[0]! + surface.bounds.x + point.x * scaleX;
  const clickY = windowGeometry[1]! + nativeFrameInsetY + surface.bounds.y +
    point.y * scaleY;
  const windowRight = windowGeometry[0]! + windowGeometry[2]!;
  const windowBottom = windowGeometry[1]! + windowGeometry[3]!;
  if (clickX < windowGeometry[0]! || clickX > windowRight ||
      clickY < windowGeometry[1]! || clickY > windowBottom) {
    throw new Error("The exact AppKit Role click point escaped its native window");
  }
  console.info("AppKit native Role control geometry", JSON.stringify({
    windowId, roleId, point, surfaceBounds: surface.bounds,
    windowGeometry, nativeFrameInsetY, clickX, clickY
  }));
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState) else {
  fatalError("system pointer source unavailable")
}
let point = CGPoint(x: ${clickX}, y: ${clickY})
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

/** Presses the visible green AppKit fullscreen traffic-light control. */
export async function clickMacosVisibleFullscreenControl(
  windowId: string
): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  const bounds = inspection.native.appKit?.fullscreenControlScreenBounds;
  if (
    inspection.hostKind !== "appkit" ||
    inspection.windowId !== windowId ||
    !inspection.native.nativeControlsVisible || !bounds ||
    bounds.width <= 0 || bounds.height <= 0
  ) {
    throw new Error("The exact visible AppKit fullscreen control is unavailable");
  }
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const processId = String((await electronDesktopE2eProbe()).processId);
  await runSystemEvents(`
on run argv
  set targetPid to (item 1 of argv) as integer
  set clickX to (item 2 of argv) as number
  set clickY to (item 3 of argv) as number
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set frontmost of targetProcess to true
    click at {clickX, clickY}
  end tell
end run`, processId, String(x), String(y));
}

/** Clicks the real standard View-menu preference owned by Rust/Core. */
export async function clickMacosFullscreenToolbarViewMenuItem(): Promise<void> {
  const processId = (await electronDesktopE2eProbe()).processId;
  await runSystemEvents(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set frontmost of targetProcess to true
    tell menu bar 1 of targetProcess
      click menu bar item "View"
      click menu item "Always Show Toolbar in Full Screen" of menu 1 of menu bar item "View"
    end tell
  end tell
end run`, String(processId));
}

/** Moves the real system pointer away from native chrome into exact AppKit content. */
export async function movePointerToMacosRuntimeContent(
  windowId: string
): Promise<void> {
  const probe = await electronDesktopE2eProbe();
  const processId = String(probe.processId);
  const expectedIdentifier = `com.rionstudio.runtime.appkit-window.v1:${windowId}`;
  const geometry = exactGeometry(await readSystemEvents(`
on run argv
  set targetPid to (item 1 of argv) as integer
  set expectedIdentifier to item 2 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set targetWindow to missing value
    set targetCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is expectedIdentifier then
          set targetWindow to appWindow
          set targetCount to targetCount + 1
        end if
      end try
    end repeat
    if targetCount is not 1 then error "exact AppKit runtime window unavailable"
    set frontmost of targetProcess to true
    perform action "AXRaise" of targetWindow
    set windowPosition to position of targetWindow
    set windowSize to size of targetWindow
    return (item 1 of windowPosition as text) & "," & ¬
      (item 2 of windowPosition as text) & "," & ¬
      (item 1 of windowSize as text) & "," & ¬
      (item 2 of windowSize as text)
  end tell
end run`, processId, expectedIdentifier), "runtime-window-content");
  if (geometry.length !== 4 || geometry[2]! <= 0 || geometry[3]! <= 0) {
    throw new Error("The exact AppKit runtime content geometry is invalid");
  }
  const pointX = geometry[0]! + Math.round(geometry[2]! * 0.5);
  const pointY = geometry[1]! + Math.round(geometry[3]! * 0.65);
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState) else {
  fatalError("system pointer source unavailable")
}
let point = CGPoint(x: ${pointX}, y: ${pointY})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
}

/** Pushes the real system pointer into the exact AppKit fullscreen display edge. */
export async function movePointerToMacosFullscreenRevealEdge(
  windowId: string
): Promise<void> {
  const [probe, inspection] = await Promise.all([
    electronDesktopE2eProbe(),
    electronDesktopE2eGameWindowRuntime(windowId)
  ]);
  const runtime = inspection.currentRuntime;
  if (
    runtime?.hostKind !== "appkit-chromium" ||
    runtime.windowId !== windowId ||
    runtime.nativeDisplay.presentation !== "fullscreen"
  ) {
    throw new Error("The exact fullscreen AppKit display edge is unavailable");
  }
  const processId = String(probe.processId);
  const expectedIdentifier = `com.rionstudio.runtime.appkit-window.v1:${windowId}`;
  const geometry = exactGeometry(await readSystemEvents(`
on run argv
  set targetPid to (item 1 of argv) as integer
  set expectedIdentifier to item 2 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set targetWindow to missing value
    set targetCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is expectedIdentifier then
          set targetWindow to appWindow
          set targetCount to targetCount + 1
        end if
      end try
    end repeat
    if targetCount is not 1 then error "exact AppKit fullscreen window unavailable"
    if value of attribute "AXFullScreen" of targetWindow is not true then ¬
      error "exact AppKit window is not fullscreen"
    set frontmost of targetProcess to true
    perform action "AXRaise" of targetWindow
    set windowPosition to position of targetWindow
    set windowSize to size of targetWindow
    return (item 1 of windowPosition as text) & "," & ¬
      (item 2 of windowPosition as text) & "," & ¬
      (item 1 of windowSize as text) & "," & ¬
      (item 2 of windowSize as text)
  end tell
end run`, processId, expectedIdentifier), "fullscreen-window");
  if (geometry.length !== 4) {
    throw new Error("The exact fullscreen AppKit window geometry is invalid");
  }
  const bounds = {
    x: geometry[0]!,
    y: geometry[1]!,
    width: geometry[2]!,
    height: geometry[3]!
  };
  if (
    !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
    bounds.width <= 160 || bounds.height <= 160
  ) {
    throw new Error("The fullscreen AppKit display bounds are invalid");
  }
  const x = bounds.x + Math.round(bounds.width * 0.25);
  const startY = bounds.y + 96;
  const edgeY = bounds.y;
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState) else {
  fatalError("system pointer source unavailable")
}
let start = CGPoint(x: ${x}, y: ${startY})
let edge = CGPoint(x: ${x}, y: ${edgeY})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
for step in 1...12 {
  let progress = CGFloat(step) / 12.0
  let point = CGPoint(x: edge.x, y: start.y + (edge.y - start.y) * progress)
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
    mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
}
for _ in 1...3 {
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
    mouseCursorPosition: edge, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(200_000)
}
guard let settled = CGEvent(source: nil)?.location else {
  fatalError("system pointer readback unavailable")
}
print("\\(settled.x),\\(settled.y)")
`;
  const result = await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
  const settled = result.stdout.trim().split(",").map(Number);
  if (
    settled.length !== 2 || settled.some((value) => !Number.isFinite(value)) ||
    Math.abs(settled[0]! - x) > 2 || Math.abs(settled[1]! - edgeY) > 2
  ) {
    throw new Error(
      `The system pointer missed the exact AppKit reveal edge (${result.stdout.trim()})`
    );
  }
}

/** Drags the retained native NSSplitter hit surface with platform CGEvents. */
export async function dragMacosVisibleWorkspaceDivider(
  input: Readonly<{
    axis: "horizontal" | "vertical";
    dividerIndex: number;
    deltaScreenPixels?: number;
    expectedThickness?: number;
    windowId: string;
  }>
): Promise<void> {
  const { axis, dividerIndex, windowId } = input;
  const deltaScreenPixels = input.deltaScreenPixels ?? 72;
  const expectedThickness = input.expectedThickness;
  const processId = String((await electronDesktopE2eProbe()).processId);
  let geometry = "";
  let pendingDiagnostic = "";
  try {
    await browser.waitUntil(async () => {
      const result = await executeFile("/usr/bin/xcrun", [
        "swift", resolve(import.meta.dirname, "macos-native-divider-geometry.swift"),
        processId, windowId, axis, String(dividerIndex)
      ], { encoding: "utf8", timeout: 10_000 });
      const candidate = result.stdout.trim();
      if (candidate.startsWith("PENDING|")) {
        pendingDiagnostic = candidate;
        return false;
      }
      geometry = candidate;
      return true;
    }, {
      interval: 100,
      timeout: 10_000,
      timeoutMsg: "The exact AppKit workspace divider did not become accessible"
    });
  } catch (error) {
    throw new Error(
      `The exact AppKit workspace divider did not become accessible: ` +
        `${pendingDiagnostic || "no accessibility diagnostic"}`,
      { cause: error }
    );
  }
  const divider = JSON.parse(geometry) as {
    axis: "horizontal" | "vertical"; dividerIndex: number;
    windowId: string; x: number; y: number; width: number; height: number;
  };
  if (divider.axis !== axis || divider.dividerIndex !== dividerIndex) {
    throw new Error("The AppKit workspace-divider accessibility identity is stale");
  }
  if (divider.windowId !== windowId) {
    throw new Error("The AppKit workspace-divider window identity is stale");
  }
  await focusVisibleMacosAppKitRuntime({ processId: Number(processId), windowId: divider.windowId });
  const values = [divider.x, divider.y, divider.width, divider.height];
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) ||
      values[2]! <= 0 || values[3]! <= 0) {
    throw new Error("The AppKit workspace-divider accessibility geometry is invalid");
  }
  const thickness = axis === "vertical" ? divider.width : divider.height;
  if (expectedThickness !== undefined && thickness !== expectedThickness) {
    throw new Error(
      `The AppKit ${axis} workspace-divider thickness is ${thickness}, ` +
      `expected ${expectedThickness}`
    );
  }
  const startX = values[0]! + values[2]! / 2;
  const startY = values[1]! + values[3]! / 2;
  const endX = startX + (axis === "vertical" ? deltaScreenPixels : 0);
  const endY = startY + (axis === "horizontal" ? deltaScreenPixels : 0);
  const hitTestScript = `
import ApplicationServices
import Foundation
func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element, attribute as CFString, &value
  ) == .success else { return "" }
  return value as? String ?? ""
}
func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element, attribute as CFString, &value
  ) == .success else { return nil }
  return (value as! AXUIElement)
}
func childrenSummary(_ element: AXUIElement) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element, kAXChildrenAttribute as CFString, &value
  ) == .success, let children = value as? [AXUIElement] else { return "" }
  return children.prefix(16).map {
    stringAttribute($0, kAXRoleAttribute) + ":" +
    stringAttribute($0, kAXDescriptionAttribute)
  }.joined(separator: ";")
}
func ancestorWindowIdentifier(_ element: AXUIElement) -> String {
  var current: AXUIElement? = element
  for _ in 0..<64 {
    guard let candidate = current else { return "" }
    if stringAttribute(candidate, kAXRoleAttribute) == "AXWindow" {
      return stringAttribute(candidate, kAXIdentifierAttribute)
    }
    current = elementAttribute(candidate, kAXParentAttribute)
  }
  return ""
}
let systemWide = AXUIElementCreateSystemWide()
var hit: AXUIElement?
let result = AXUIElementCopyElementAtPosition(
  systemWide, Float(${startX}), Float(${startY}), &hit
)
guard result == .success, let hit else {
  print("0\\t\\t\\t\\(result.rawValue)")
  exit(2)
}
var processId: pid_t = 0
AXUIElementGetPid(hit, &processId)
let parent = elementAttribute(hit, kAXParentAttribute)
let grandparent = parent.flatMap { elementAttribute($0, kAXParentAttribute) }
print(
  "\\(processId)\\t" + stringAttribute(hit, kAXRoleAttribute) + "\\t" +
  stringAttribute(hit, kAXDescriptionAttribute) + "\\t\\(result.rawValue)\\t" +
  childrenSummary(hit) + "\\t" +
  (parent.map { stringAttribute($0, kAXRoleAttribute) + ":" +
    stringAttribute($0, kAXDescriptionAttribute) } ?? "") + "\\t" +
  (grandparent.map { stringAttribute($0, kAXRoleAttribute) + ":" +
    stringAttribute($0, kAXDescriptionAttribute) } ?? "") + "\\t" +
  ancestorWindowIdentifier(hit)
)
`;
  const hitTest = await executeFile("/usr/bin/xcrun", ["swift", "-e", hitTestScript], {
    encoding: "utf8",
    timeout: 30_000
  });
  const [hitProcessId, hitRole, hitDescription, , hitChildren, hitParent,
    hitGrandparent, hitWindowIdentifier] = hitTest.stdout.trim().split("\t");
  const expectedDescription = axis === "vertical"
    ? "Resize workspace columns"
    : "Resize workspace rows";
  const exactSplitterHit = hitRole === "AXSplitter" &&
    hitDescription === expectedDescription;
  const exactWindowIdentifier =
    `com.rionstudio.runtime.appkit-window.v1:${divider.windowId}`;
  if (hitProcessId !== processId || hitWindowIdentifier !== exactWindowIdentifier ||
      (!exactSplitterHit && hitRole !== "AXGroup" && hitRole !== "AXWebArea")) {
    throw new Error(
      `The AppKit divider coordinate is not owned by the exact Rion host ` +
      `(geometry=${values.join(",")}; hitPid=${hitProcessId ?? ""}; ` +
      `hitRole=${hitRole ?? ""}; hitDescription=${hitDescription ?? ""}; ` +
      `hitChildren=${hitChildren ?? ""}; hitParent=${hitParent ?? ""}; ` +
      `hitGrandparent=${hitGrandparent ?? ""}; ` +
      `hitWindowIdentifier=${hitWindowIdentifier ?? ""})`
    );
  }
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState) else {
  fatalError("system pointer source unavailable")
}
let start = CGPoint(x: ${startX}, y: ${startY})
let midpoint = CGPoint(
  x: ${startX} + (${endX} - ${startX}) * 0.5,
  y: ${startY} + (${endY} - ${startY}) * 0.5
)
let end = CGPoint(x: ${endX}, y: ${endY})
func warp(_ point: CGPoint) {
  guard CGWarpMouseCursorPosition(point) == .success else {
    fatalError("system pointer warp failed")
  }
  usleep(50_000)
}
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(150_000)
// Space meaningful samples far enough apart that a loaded AppKit run loop
// cannot coalesce the only destination with mouse-up. Every sample remains a
// real CGEvent and the test still requires Core's terminal persisted receipt.
warp(midpoint)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
  mouseCursorPosition: midpoint, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(150_000)
warp(end)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
  mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(200_000)
warp(end)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
  mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(200_000)
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
  mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
guard let settled = CGEvent(source: nil)?.location else {
  fatalError("system pointer readback unavailable")
}
print("\\(settled.x),\\(settled.y)")
`;
  const result = await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
  const settled = result.stdout.trim().split(",").map(Number);
  if (
    settled.length !== 2 || settled.some((value) => !Number.isFinite(value)) ||
    Math.abs(settled[0]! - endX) > 2 || Math.abs(settled[1]! - endY) > 2
  ) {
    throw new Error(
      `The system pointer missed the exact AppKit divider destination ` +
      `(${result.stdout.trim()})`
    );
  }
}

function exactGeometry(raw: string, field: string): readonly number[] {
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (
    values.length === 0 || values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`The AppKit ${field} accessibility geometry is invalid`);
  }
  return values;
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/** Reorders one visible retained-AppKit tab with a real CGEvent drag stream. */
export async function dragMacosVisibleRuntimeTab(input: Readonly<{
  placement: "after" | "before";
  sourceTabId: string;
  targetTabId: string;
  windowId: string;
}>): Promise<void> {
  const [probe, toolbar, runtimeInspection] = await Promise.all([
    electronDesktopE2eProbe(),
    electronDesktopE2eFullscreenToolbarRuntime(input.windowId),
    electronDesktopE2eGameWindowRuntime(input.windowId)
  ]);
  const runtime = runtimeInspection.currentRuntime;
  const anchors = toolbar.native.appKit?.tabAnchors;
  const tabBounds = toolbar.native.appKit?.tabScreenBounds;
  const sourceIndex = toolbar.tabIds.indexOf(input.sourceTabId);
  const targetIndex = toolbar.tabIds.indexOf(input.targetTabId);
  const sourceAnchor = anchors?.[input.sourceTabId];
  const targetAnchor = anchors?.[input.targetTabId];
  const firstAnchor = anchors?.[toolbar.tabIds[0]!];
  if (
    toolbar.hostKind !== "appkit" || !runtime ||
    runtime.hostKind !== "appkit-chromium" ||
    runtime.windowId !== input.windowId ||
    !sameOrderedStrings(runtime.nativeTabIds, toolbar.tabIds) ||
    sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex ||
    !sourceAnchor || !targetAnchor || !firstAnchor || !tabBounds
  ) {
    throw new Error("The exact AppKit runtime-tab drag geometry is unavailable");
  }
  await focusVisibleMacosAppKitRuntime({ processId: probe.processId, windowId: input.windowId });
  // The Core projection describes the Chromium content bounds, while AppKit's
  // titlebar can live above that content rect. Translate every window-relative
  // anchor through the first rendered tab's absolute on-screen frame so the
  // CGEvent stream follows the actual retained-AppKit pixels.
  const anchorScreenOffsetX =
    tabBounds.x + tabBounds.width - firstAnchor.x;
  const previousSourceAnchor = sourceIndex === 0
    ? undefined
    : anchors[toolbar.tabIds[sourceIndex - 1]!];
  const previousTargetAnchor = targetIndex === 0
    ? undefined
    : anchors[toolbar.tabIds[targetIndex - 1]!];
  const sourceLeft = previousSourceAnchor
    ? anchorScreenOffsetX + previousSourceAnchor.x
    : tabBounds.x;
  const sourceRight = anchorScreenOffsetX + sourceAnchor.x;
  const targetLeft = previousTargetAnchor
    ? anchorScreenOffsetX + previousTargetAnchor.x
    : tabBounds.x;
  const targetRight = anchorScreenOffsetX + targetAnchor.x;
  const sourceWidth = sourceRight - sourceLeft;
  const targetWidth = targetRight - targetLeft;
  if (sourceWidth <= 0 || targetWidth <= 0) {
    throw new Error("The exact AppKit runtime-tab drag anchors are invalid");
  }
  const startX = sourceLeft + sourceWidth / 2;
  const tabScreenCenterY = tabBounds.y + tabBounds.height / 2;
  const startY = tabScreenCenterY;
  const targetInset = Math.min(10, targetWidth / 5);
  const endX = input.placement === "before"
    ? targetLeft + targetInset
    : targetRight - targetInset;
  const endY = tabScreenCenterY;
  const script = `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: ${startX}, y: ${startY})
let end = CGPoint(x: ${endX}, y: ${endY})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
for step in 1...12 {
  let progress = CGFloat(step) / 12.0
  let point = CGPoint(
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress
  )
  CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
    mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(25_000)
}
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
  mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
}

const TAB_MENU_LABELS = Object.freeze({
  en: Object.freeze({
    hide: "Hide tab (keeps running)",
    move: "Move to Game Window",
    moveToNewWindow: "Move to New Game Window",
    mute: "Mute Tab",
    reload: "Reload",
    unmute: "Unmute Tab"
  }),
  "zh-TW": Object.freeze({
    hide: "隱藏分頁（保持運行）",
    move: "移至遊戲視窗",
    moveToNewWindow: "移至新遊戲視窗",
    mute: "將分頁靜音",
    reload: "重新整理",
    unmute: "取消分頁靜音"
  }),
  "zh-CN": Object.freeze({
    hide: "隐藏标签页（保持运行）",
    move: "移至游戏窗口",
    moveToNewWindow: "移至新游戏窗口",
    mute: "将标签页静音",
    reload: "重新加载",
    unmute: "取消标签页静音"
  }),
  ja: Object.freeze({
    hide: "タブを非表示（実行を継続）",
    move: "ゲームウィンドウへ移動",
    moveToNewWindow: "新しいゲームウィンドウへ移動",
    mute: "タブをミュート",
    reload: "再読み込み",
    unmute: "タブのミュートを解除"
  })
} satisfies Readonly<Record<AppLanguage, Readonly<Record<
  "hide" | "move" | "moveToNewWindow" | "mute" | "reload" | "unmute",
  string
>>>>);

const LAUNCHER_ROLE_LABELS = Object.freeze({
  en: "Roles",
  "zh-TW": "角色",
  "zh-CN": "角色",
  ja: "ロール"
} satisfies Readonly<Record<AppLanguage, string>>);

const APPKIT_LAUNCHER_LABELS = Object.freeze([
  "Open role or workspace",
  "開啟角色或工作區",
  "打开角色或工作区",
  "ロールまたはワークスペースを開く"
]);

/** Reads the exact retained AppKit tab centre; it never submits an action. */
export async function readMacosVisibleRuntimeTabPoint(input: Readonly<{
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<Readonly<{ x: number; y: number }>> {
  const [inspection, runtimeInspection] = await Promise.all([
    electronDesktopE2eFullscreenToolbarRuntime(input.windowId),
    electronDesktopE2eGameWindowRuntime(input.windowId)
  ]);
  return resolveMacosNativeTabPoint(input, inspection, runtimeInspection.currentRuntime);
}

/** Opens the visible native NSMenu and selects one of its real menu items. */
export async function selectMacosVisibleRuntimeTabMenuAction(input: Readonly<{
  action: "hide" | "move" | "moveToNewWindow" | "reload" | "mute" | "unmute";
  language?: AppLanguage;
  tabId: string;
  tabName: string;
  targetWindowName?: string;
  windowId: string;
}>): Promise<void> {
  if ((input.action === "move") !== (input.targetWindowName !== undefined)) {
    throw new Error("An AppKit move action requires one exact target Game Window");
  }
  const processId = String((await electronDesktopE2eProbe()).processId);
  await focusVisibleMacosAppKitRuntime({ processId: Number(processId), windowId: input.windowId });
  const { x: clickX, y: clickY } = await readMacosVisibleRuntimeTabPoint(input);
  const rightClickScript = `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let point = CGPoint(x: ${clickX}, y: ${clickY})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .rightMouseDown,
  mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
usleep(25_000)
CGEvent(mouseEventSource: source, mouseType: .rightMouseUp,
  mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", rightClickScript], {
    encoding: "utf8",
    timeout: 30_000
  });
  const labels = TAB_MENU_LABELS[input.language ?? "en"];
  const selectionInput = JSON.stringify({
    actionLabels: [labels[input.action]],
    hideLabels: [labels.hide],
    moveToNewWindowLabels: [labels.moveToNewWindow],
    processId: Number(processId),
    targetWindowName: input.targetWindowName ?? null
  });
  await executeFile("/usr/bin/xcrun", [
    "swift",
    resolve(import.meta.dirname, "macos-appkit-menu.swift"),
    selectionInput
  ], { encoding: "utf8", timeout: 10_000 });
}

/** Presses the retained AppKit `+` control and selects one scoped source. */
export async function selectMacosVisibleRuntimeLauncherRole(input: Readonly<{
  language?: AppLanguage;
  roleName: string;
  windowId: string;
}>): Promise<void> {
  if (!input.roleName || !input.windowId) {
    throw new Error("The exact AppKit launcher Role input is invalid");
  }
  const processId = (await electronDesktopE2eProbe()).processId;
  await focusVisibleMacosAppKitRuntime({
    processId,
    windowId: input.windowId
  });
  await executeFile("/usr/bin/xcrun", [
    "swift",
    resolve(import.meta.dirname, "macos-appkit-launcher-menu.swift"),
    JSON.stringify({
      actionLabel: input.roleName,
      groupLabel: LAUNCHER_ROLE_LABELS[input.language ?? "en"],
      launcherLabels: APPKIT_LAUNCHER_LABELS,
      processId,
      windowId: input.windowId
    })
  ], { encoding: "utf8", timeout: 15_000 });
}
