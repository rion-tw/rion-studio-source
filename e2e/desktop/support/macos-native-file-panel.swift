import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count >= 3,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      AXIsProcessTrusted() else { fail("exact file-panel input or Accessibility grant unavailable") }
let action = CommandLine.arguments[2]
guard (action == "cancel" && CommandLine.arguments.count == 3)
    || (action == "select-directory" && CommandLine.arguments.count == 4) else {
  fail("unsupported exact native file-panel action")
}
let fixturePath = action == "select-directory" ? CommandLine.arguments[3] : ""
let application = AXUIElementCreateApplication(targetPid)
let expiry = Date().addingTimeInterval(10)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success else { fail("file-panel control has no native owner") }
  // macOS publishes the exact app's attached NSOpenPanel through its system XPC
  // service. These objects are reached only through that app's AXWindows tree;
  // never discover a panel by enumerating unrelated processes or window names.
  if ownerPid != targetPid {
    let owner = NSRunningApplication(processIdentifier: ownerPid)
    guard owner?.bundleIdentifier == "com.apple.appkit.xpc.openAndSavePanelService",
          owner?.executableURL?.path == "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/com.apple.appkit.xpc.openAndSavePanelService.xpc/Contents/MacOS/com.apple.appkit.xpc.openAndSavePanelService" else {
      fail("file-panel control escaped its exact app/attached system panel")
    }
  }
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var nodes = [root]
  var cursor = 0
  while cursor < nodes.count {
    guard nodes.count <= 4096 else { fail("file-panel AX tree exceeds bounded search") }
    let node = nodes[cursor]
    cursor += 1
    if text(node, "AXRole") == "AXWebArea" { continue }
    for child in children(node) where !nodes.contains(where: { CFEqual($0, child) }) { nodes.append(child) }
  }
  return nodes
}
func panels() -> [AXUIElement] {
  let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
  var result: [AXUIElement] = []
  func visit(_ element: AXUIElement, _ depth: Int) {
    guard depth < 12 else { fail("file-panel hierarchy exceeds bounded search") }
    let role = text(element, "AXRole")
    if role == "AXWebArea" { return }
    if role == "AXSheet" || text(element, "AXSubrole") == "AXDialog" {
      if !result.contains(where: { CFEqual($0, element) }) { result.append(element) }
      return
    }
    for child in children(element) { visit(child, depth + 1) }
  }
  for window in windows { visit(window, 0) }
  return result
}
func awaitCondition(_ stage: String, _ condition: () -> Bool) {
  while !condition() {
    if Date() >= expiry { fail("native file-panel action did not complete: " + stage) }
    usleep(50_000)
  }
}
func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
        let source = CGEventSource(stateID: .hidSystemState),
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
    fail("exact foreground native folder input unavailable")
  }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
}
awaitCondition("unique panel") {
  let count = panels().count
  if count > 1 { fail("multiple exact-owner file panels") }
  return count == 1
}
let panel = panels()[0]
guard let running = NSRunningApplication(processIdentifier: targetPid) else { fail("file-panel process exited") }
running.activate(options: [])
awaitCondition("foreground") { NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid }
if action == "cancel" {
  let buttons = descendants(panel).filter {
    text($0, "AXRole") == "AXButton" && text($0, "AXTitle") == "Cancel"
  }
  let currentPanels = panels()
  guard currentPanels.count == 1, CFEqual(currentPanels[0], panel),
        buttons.count == 1,
        (attribute(buttons[0], "AXEnabled") as? NSNumber)?.boolValue == true else {
    fail("exact enabled Cancel button unavailable in the same attached panel")
  }
  guard AXUIElementPerformAction(buttons[0], kAXPressAction as CFString) == .success else {
    fail("native Cancel action failed")
  }
  awaitCondition("cancelled panel closure") { panels().isEmpty }
  print("cancelled")
  exit(0)
}

key(5, flags: [.maskCommand, .maskShift]) // Visible Go to Folder command.
var sheets: [AXUIElement] = []
awaitCondition("Go to Folder sheet") {
  sheets = descendants(panel).filter { !CFEqual($0, panel) && text($0, "AXRole") == "AXSheet" }
  if sheets.count > 1 { fail("ambiguous Go to Folder sheet") }
  return sheets.count == 1
}
let fields = descendants(sheets[0]).filter { text($0, "AXRole") == "AXTextField" }
guard fields.count == 1,
      AXUIElementSetAttributeValue(fields[0], kAXValueAttribute as CFString, fixturePath as CFString) == .success,
      text(fields[0], "AXValue") == fixturePath else { fail("exact folder field did not accept the fixture path") }
key(36)
awaitCondition("resolved folder") {
  descendants(panel).filter { !CFEqual($0, panel) && text($0, "AXRole") == "AXSheet" }.isEmpty
}
let buttons = descendants(panel).filter { text($0, "AXRole") == "AXButton" && text($0, "AXTitle") == "Open" }
let currentPanels = panels()
guard currentPanels.count == 1, CFEqual(currentPanels[0], panel) else { fail("exact attached folder panel changed") }
guard buttons.count == 1, (attribute(buttons[0], "AXEnabled") as? NSNumber)?.boolValue == true else {
  fail("exact enabled Open button unavailable")
}
guard AXUIElementPerformAction(buttons[0], kAXPressAction as CFString) == .success else {
  fail("native Open action failed")
}
awaitCondition("panel closure") { panels().isEmpty }
print("selected")
