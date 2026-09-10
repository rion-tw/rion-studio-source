import ApplicationServices
import CoreGraphics
import Foundation

private struct Input: Decodable {
  let actionLabel: String
  let groupLabel: String
  let launcherLabels: [String]
  let processId: Int32
  let windowId: String
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(2)
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success else { return nil }
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name, &value) == .success
    ? value
    : nil
}

private func text(_ element: AXUIElement, _ name: CFString) -> String {
  return attribute(element, name) as? String ?? ""
}

private func enabled(_ element: AXUIElement) -> Bool {
  return (attribute(element, kAXEnabledAttribute as CFString) as? NSNumber)?
    .boolValue ?? false
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
  return attribute(element, kAXChildrenAttribute as CFString)
    as? [AXUIElement] ?? []
}

private func descendants(_ root: AXUIElement, limit: Int = 4_096) -> [AXUIElement] {
  var values = children(root)
  var index = 0
  while index < values.count && values.count <= limit {
    let current = values[index]
    index += 1
    let role = text(current, kAXRoleAttribute as CFString)
    if role != "AXWebArea" && role != "AXHTMLContent" {
      values.append(contentsOf: children(current))
    }
  }
  guard values.count <= limit else { fail("AppKit launcher AX tree is oversized") }
  return values
}

private func waitForMenuItem(
  _ application: AXUIElement,
  title: String
) -> AXUIElement {
  for _ in 0..<100 {
    let matches = descendants(application, limit: 4096).filter {
      text($0, kAXRoleAttribute as CFString) == "AXMenuItem" &&
        text($0, kAXTitleAttribute as CFString) == title && enabled($0)
    }
    if matches.count == 1 { return matches[0] }
    if matches.count > 1 { fail("ambiguous AppKit launcher menu item \(title)") }
    usleep(50_000)
  }
  fail("AppKit launcher menu item \(title) is unavailable")
}

guard CommandLine.arguments.count == 2,
      let data = CommandLine.arguments[1].data(using: .utf8),
      let input = try? JSONDecoder().decode(Input.self, from: data),
      input.processId > 0, !input.windowId.isEmpty,
      !input.groupLabel.isEmpty, !input.actionLabel.isEmpty,
      !input.launcherLabels.isEmpty else {
  fail("invalid AppKit launcher input")
}

let application = AXUIElementCreateApplication(input.processId)
let windowIdentifier = "com.rionstudio.runtime.appkit-window.v1:" + input.windowId
let windows = (attribute(application, kAXWindowsAttribute as CFString)
  as? [AXUIElement] ?? []).filter {
    text($0, kAXIdentifierAttribute as CFString) == windowIdentifier
  }
guard windows.count == 1 else { fail("exact AppKit launcher window is unavailable") }
let buttons = descendants(windows[0]).filter {
  let identifier = text($0, kAXIdentifierAttribute as CFString)
  let label = text($0, kAXDescriptionAttribute as CFString)
  return text($0, kAXRoleAttribute as CFString) == "AXButton" &&
    (identifier == "com.rionstudio.runtime.appkit-launcher.v1" ||
      input.launcherLabels.contains(label))
}
guard buttons.count == 1, enabled(buttons[0]),
      let position = attribute(buttons[0], kAXPositionAttribute as CFString),
      CFGetTypeID(position) == AXValueGetTypeID(),
      let size = attribute(buttons[0], kAXSizeAttribute as CFString),
      CFGetTypeID(size) == AXValueGetTypeID() else {
  let diagnostics = descendants(windows[0]).compactMap { element -> String? in
    guard text(element, kAXRoleAttribute as CFString) == "AXButton" else {
      return nil
    }
    return [
      text(element, kAXSubroleAttribute as CFString),
      text(element, kAXIdentifierAttribute as CFString),
      text(element, kAXTitleAttribute as CFString),
      text(element, kAXDescriptionAttribute as CFString),
      text(element, kAXHelpAttribute as CFString),
      enabled(element) ? "enabled" : "disabled"
    ].joined(separator: ":")
  }
  fail("exact AppKit launcher button is unavailable; observed=" +
    diagnostics.joined(separator: "|"))
}
var origin = CGPoint.zero
var extent = CGSize.zero
guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
      AXValueGetValue(size as! AXValue, .cgSize, &extent),
      extent.width > 0, extent.height > 0,
      let source = CGEventSource(stateID: .hidSystemState) else {
  fail("exact AppKit launcher geometry is unavailable")
}
let point = CGPoint(x: origin.x + extent.width / 2,
                    y: origin.y + extent.height / 2)
for eventType in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
  guard let event = CGEvent(mouseEventSource: source,
                            mouseType: eventType,
                            mouseCursorPosition: point,
                            mouseButton: .left) else {
    fail("exact AppKit launcher pointer event is unavailable")
  }
  event.post(tap: .cghidEventTap)
  usleep(25_000)
}
let group = waitForMenuItem(application, title: input.groupLabel)
guard AXUIElementPerformAction(group, kAXPressAction as CFString) == .success else {
  fail("AppKit launcher submenu did not open")
}
let action = waitForMenuItem(application, title: input.actionLabel)
guard AXUIElementPerformAction(action, kAXPressAction as CFString) == .success else {
  fail("AppKit launcher action did not execute")
}
