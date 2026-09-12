import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

function validatePopupIdentity(input: Readonly<{
  processId: number;
  title: string;
}>): void {
  if (
    process.platform !== "darwin" || !Number.isSafeInteger(input.processId) ||
    input.processId <= 1 || !/^Rion Popup — [A-Za-z0-9.-]+$/u.test(input.title)
  ) {
    throw new Error("The exact Electron popup pointer identity is invalid");
  }
}

/** Clicks the centered fixture control in one exact frontmost popup window. */
export async function clickVisibleMacosElectronPopupCenter(input: Readonly<{
  processId: number;
  title: string;
}>): Promise<void> {
  validatePopupIdentity(input);
  const script = `
import AppKit
import CoreGraphics
import Foundation
let targetPid = pid_t(${input.processId})
let targetTitle = ${JSON.stringify(input.title)}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {
  fatalError("exact Electron popup process is not foreground")
}
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
  as? [[String: Any]] else { fatalError("native window inventory unavailable") }
let owned = windows.filter { entry in
  (entry[kCGWindowOwnerPID as String] as? Int32) == targetPid &&
    (entry[kCGWindowLayer as String] as? Int) == 0
}
let matches = owned.filter {
  ($0[kCGWindowName as String] as? String) == targetTitle
}
guard matches.count == 1, let firstOwned = owned.first,
  (firstOwned[kCGWindowNumber as String] as? Int) ==
    (matches[0][kCGWindowNumber as String] as? Int),
  let boundsDictionary = matches[0][kCGWindowBounds as String] as? NSDictionary
else { fatalError("exact Electron popup is not the front native window") }
var bounds = CGRect.zero
guard CGRectMakeWithDictionaryRepresentation(boundsDictionary, &bounds),
  bounds.width >= 320, bounds.height >= 240 else {
  fatalError("exact Electron popup bounds are unavailable")
}
let point = CGPoint(x: bounds.midX, y: bounds.midY)
guard let source = CGEventSource(stateID: .hidSystemState),
  let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
    mouseCursorPosition: point, mouseButton: .left),
  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
    mouseCursorPosition: point, mouseButton: .left) else {
  fatalError("system popup pointer source unavailable")
}
down.post(tap: .cghidEventTap)
usleep(50_000)
up.post(tap: .cghidEventTap)
usleep(100_000)
`;
  await executeFile("/usr/bin/xcrun", ["swift", "-e", script], {
    encoding: "utf8",
    timeout: 30_000
  });
}
