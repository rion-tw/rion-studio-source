import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe
} from "./electron-driver";
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
  const windowIdentifier = `com.rionstudio.runtime.appkit-window.v1:${windowId}`;
  const windowGeometry = exactGeometry(await readSystemEvents(`
on run argv
  set targetPid to (item 1 of argv) as integer
  set expectedIdentifier to item 2 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
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
    if frontmost of targetProcess is not true then error "exact Rion process is not foreground"
    set windowPosition to position of targetWindow
    set windowSize to size of targetWindow
    return (item 1 of windowPosition as text) & "," & ¬
      (item 2 of windowPosition as text) & "," & ¬
      (item 1 of windowSize as text) & "," & ¬
      (item 2 of windowSize as text)
  end tell
end run`, String(processId), windowIdentifier), "runtime-role-window");
  if (windowGeometry.length !== 4 || windowGeometry[2]! <= 0 ||
      windowGeometry[3]! <= 0) {
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
    set targetProcess to item 1 of matchingProcesses
    set frontmost of targetProcess to true
    click at {clickX, clickY}
  end tell
end run`, processId, String(x), String(y));
}

/** Clicks the real standard View-menu preference owned by Rust/Core. */
export async function clickMacosFullscreenToolbarViewMenuItem(): Promise<void> {
  await runSystemEvents(`
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  tell menu bar 1 of frontProcess
    click menu bar item "View"
    click menu item "Always Show Toolbar in Full Screen" of menu 1 of menu bar item "View"
  end tell
end tell`);
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
    set targetProcess to item 1 of matchingProcesses
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
    set targetProcess to item 1 of matchingProcesses
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
  deltaScreenPixels = 72
): Promise<void> {
  const processId = String((await electronDesktopE2eProbe()).processId);
  const dividerGeometryScript = `
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set windowDiagnostics to ""
    set splitterDiagnostics to ""
    repeat with appWindow in windows of targetProcess
      set allElements to entire contents of appWindow
      set windowDiagnostics to windowDiagnostics & (name of appWindow as text) & ":" & ¬
        (count of allElements as text) & ";"
      repeat with candidate in allElements
        try
          set candidateRole to role of candidate
          set candidateName to ""
          try
            set candidateName to name of candidate as text
          end try
          if candidateRole is "AXSplitter" then
            set candidateDescription to ""
            try
              set candidateDescription to description of candidate as text
            end try
            set splitterDiagnostics to splitterDiagnostics & candidateRole & ":" & ¬
              candidateName & ":" & candidateDescription & ";"
          end if
          if candidateRole is "AXSplitter" and ¬
              (candidateName is "Resize workspace columns" or ¬
               candidateDescription is "Resize workspace columns") then
            set frontmost of targetProcess to true
            repeat 40 times
              if frontmost of targetProcess then exit repeat
              delay 0.05
            end repeat
            if not frontmost of targetProcess then error "exact Rion process did not become frontmost"
            perform action "AXRaise" of appWindow
            set dividerPosition to position of candidate
            set dividerSize to size of candidate
            return (item 1 of dividerPosition as text) & "," & ¬
              (item 2 of dividerPosition as text) & "," & ¬
              (item 1 of dividerSize as text) & "," & ¬
              (item 2 of dividerSize as text)
          end if
        end try
      end repeat
    end repeat
    return "PENDING|windows=" & windowDiagnostics & ¬
      " splitters=" & splitterDiagnostics
  end tell
end run`;
  let geometry = "";
  let pendingDiagnostic = "";
  try {
    await browser.waitUntil(async () => {
      const candidate = await readSystemEvents(dividerGeometryScript, processId);
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
  const values = geometry.split(",").map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) ||
      values[2]! <= 0 || values[3]! <= 0) {
    throw new Error("The AppKit workspace-divider accessibility geometry is invalid");
  }
  const startX = values[0]! + values[2]! / 2;
  const startY = values[1]! + values[3]! / 2;
  const endX = startX + deltaScreenPixels;
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
    stringAttribute($0, kAXDescriptionAttribute) } ?? "")
)
`;
  const hitTest = await executeFile("/usr/bin/xcrun", ["swift", "-e", hitTestScript], {
    encoding: "utf8",
    timeout: 30_000
  });
  const [hitProcessId, hitRole, hitDescription, , hitChildren, hitParent,
    hitGrandparent] = hitTest.stdout.trim().split("\t");
  const exactSplitterHit = hitRole === "AXSplitter" &&
    hitDescription === "Resize workspace columns";
  if (hitProcessId !== processId || (!exactSplitterHit && hitRole !== "AXGroup")) {
    throw new Error(
      `The AppKit divider coordinate is not owned by the exact Rion host ` +
      `(geometry=${values.join(",")}; hitPid=${hitProcessId ?? ""}; ` +
      `hitRole=${hitRole ?? ""}; hitDescription=${hitDescription ?? ""}; ` +
      `hitChildren=${hitChildren ?? ""}; hitParent=${hitParent ?? ""}; ` +
      `hitGrandparent=${hitGrandparent ?? ""})`
    );
  }
  const script = `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: ${startX}, y: ${startY})
let end = CGPoint(x: ${endX}, y: ${startY})
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
  mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
for step in 1...8 {
  let progress = CGFloat(step) / 8.0
  let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y)
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
  const processId = String(probe.processId);
  const windowIdentifier =
    `com.rionstudio.runtime.appkit-window.v1:${input.windowId}`;
  await readSystemEvents(`
on run argv
  set expectedWindowIdentifier to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set targetWindowCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is ¬
            expectedWindowIdentifier then
          set targetWindowCount to targetWindowCount + 1
        end if
      end try
    end repeat
    if targetWindowCount is not 1 then error "exact AppKit drag window unavailable"
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is ¬
            expectedWindowIdentifier then
          perform action "AXRaise" of appWindow
          exit repeat
        end if
      end try
    end repeat
    set frontmost of targetProcess to true
    repeat 40 times
      if frontmost of targetProcess is true then exit repeat
      delay 0.05
    end repeat
    if frontmost of targetProcess is false then error "exact Rion process did not become frontmost"
    set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
    if focusedWindow is missing value then error "exact AppKit drag window did not focus"
    if value of attribute "AXIdentifier" of focusedWindow is not ¬
        expectedWindowIdentifier then error "wrong AppKit drag window focused"
    return "focused"
  end tell
end run`, windowIdentifier, processId);
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
  hide: Object.freeze([
    "Hide tab (keeps running)",
    "隱藏分頁（保持運行）",
    "隐藏标签页（保持运行）",
    "タブを非表示（実行を継続）"
  ]),
  move: Object.freeze([
    "Move to Game Window",
    "移至遊戲視窗",
    "移至游戏窗口",
    "ゲームウィンドウへ移動"
  ]),
  reload: Object.freeze([
    "Reload",
    "重新整理",
    "重新加载",
    "再読み込み"
  ]),
  moveToNewWindow: Object.freeze([
    "Move to New Game Window",
    "移至新遊戲視窗",
    "移至新游戏窗口",
    "新しいゲームウィンドウへ移動"
  ])
});

/** Opens the visible native NSMenu and selects one of its real menu items. */
export async function selectMacosVisibleRuntimeTabMenuAction(input: Readonly<{
  action: "hide" | "move" | "moveToNewWindow" | "reload";
  tabId: string;
  tabName: string;
  targetWindowName?: string;
  windowId: string;
}>): Promise<void> {
  if ((input.action === "move") !== (input.targetWindowName !== undefined)) {
    throw new Error("An AppKit move action requires one exact target Game Window");
  }
  const processId = String((await electronDesktopE2eProbe()).processId);
  const expectedWindowIdentifier =
    `com.rionstudio.runtime.appkit-window.v1:${input.windowId}`;
  const [inspection, runtimeInspection] = await Promise.all([
    electronDesktopE2eFullscreenToolbarRuntime(input.windowId),
    electronDesktopE2eGameWindowRuntime(input.windowId)
  ]);
  const bounds = inspection.native.appKit?.tabScreenBounds;
  const tabIndex = inspection.tabIds.indexOf(input.tabId);
  const anchor = inspection.native.appKit?.tabAnchors?.[input.tabId];
  const firstTabId = inspection.tabIds[0];
  const firstAnchor = firstTabId === undefined
    ? undefined
    : inspection.native.appKit?.tabAnchors?.[firstTabId];
  const previousTabId = tabIndex > 0 ? inspection.tabIds[tabIndex - 1] : undefined;
  const previousAnchor = previousTabId === undefined
    ? undefined
    : inspection.native.appKit?.tabAnchors?.[previousTabId];
  const runtime = runtimeInspection.currentRuntime;
  if (
    inspection.hostKind !== "appkit" ||
    inspection.tabIds.filter((tabId) => tabId === input.tabId).length !== 1 ||
    !sameOrderedStrings(runtime?.nativeTabIds ?? [], inspection.tabIds) ||
    tabIndex < 0 || firstAnchor === undefined ||
    (tabIndex > 0 && previousAnchor === undefined) ||
    bounds === undefined || anchor === undefined || !runtime ||
    runtime.hostKind !== "appkit-chromium" ||
    runtime.windowId !== input.windowId ||
    runtime.nativeTabIds.filter((tabId) => tabId === input.tabId).length !== 1
  ) {
    throw new Error(
      `The exact AppKit desktop-E2E geometry for ${input.tabName} is unavailable`
    );
  }
  // AppKit exposes the first rendered tab's absolute screen bounds plus every
  // tab's window-relative right-centre anchor. Use their shared first-tab edge
  // to translate all anchors into screen coordinates. Core's nativeDisplay
  // bounds describe Chromium content and can begin below the retained titlebar.
  const anchorScreenOffsetX = bounds.x + bounds.width - firstAnchor.x;
  const tabLeft = previousAnchor === undefined
    ? bounds.x
    : anchorScreenOffsetX + previousAnchor.x;
  const tabRight = anchorScreenOffsetX + anchor.x;
  const clickX = tabLeft + (tabRight - tabLeft) / 2;
  const clickY = bounds.y + bounds.height / 2;
  if (
    bounds.width <= 0 || bounds.height <= 0 ||
    anchor.x < 0 || anchor.y < 0 || firstAnchor.x < 0 ||
    tabLeft < bounds.x || tabRight <= tabLeft ||
    clickY < bounds.y || clickY > bounds.y + bounds.height ||
    ![
      anchorScreenOffsetX, tabLeft, tabRight, clickX, clickY,
      anchor.x, anchor.y, firstAnchor.x, firstAnchor.y,
      bounds.x, bounds.y, bounds.width, bounds.height
    ].every(Number.isFinite)
  ) {
    throw new Error("The AppKit native tab geometry escaped its exact window");
  }
  await readSystemEvents(`
on run argv
  set expectedWindowIdentifier to item 1 of argv
  set targetPid to (item 2 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set targetWindow to missing value
    set targetWindowCount to 0
    repeat with appWindow in windows of targetProcess
      try
        if value of attribute "AXIdentifier" of appWindow is ¬
            expectedWindowIdentifier then
          set targetWindow to appWindow
          set targetWindowCount to targetWindowCount + 1
        end if
      end try
    end repeat
    if targetWindowCount is not 1 then error "exact AppKit menu window unavailable"
    perform action "AXRaise" of targetWindow
    set frontmost of targetProcess to true
    repeat 40 times
      if frontmost of targetProcess is true then exit repeat
      delay 0.05
    end repeat
    if frontmost of targetProcess is false then ¬
      error "exact Rion process did not become frontmost"
    set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
    if focusedWindow is missing value then error "exact AppKit menu window did not focus"
    if value of attribute "AXIdentifier" of focusedWindow is not ¬
        expectedWindowIdentifier then error "wrong AppKit menu window focused"
    return "focused"
  end tell
end run`, expectedWindowIdentifier, processId);
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
  const selectionInput = JSON.stringify({
    actionLabels: TAB_MENU_LABELS[input.action],
    hideLabels: TAB_MENU_LABELS.hide,
    moveToNewWindowLabels: TAB_MENU_LABELS.moveToNewWindow,
    processId: Number(processId),
    targetWindowName: input.targetWindowName ?? null
  });
  await executeFile("/usr/bin/xcrun", [
    "swift",
    resolve(import.meta.dirname, "macos-appkit-menu.swift"),
    selectionInput
  ], { encoding: "utf8", timeout: 10_000 });
}
