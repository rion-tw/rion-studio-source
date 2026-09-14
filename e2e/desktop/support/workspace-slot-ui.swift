import ApplicationServices
import Foundation

struct Input: Decodable { let processId: Int32; let windowId: String; let slotId: String; let action: String }
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data(message.utf8)); exit(2) }
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: CFString) -> String { attribute(element, name) as? String ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] }
func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var values = children(root), index = 0
  while index < values.count && values.count <= 4096 {
    let current = values[index]; index += 1
    let role = text(current, kAXRoleAttribute as CFString)
    if role != "AXWebArea" && role != "AXHTMLContent" { values.append(contentsOf: children(current)) }
  }
  guard values.count <= 4096 else { fail("Native workspace tree exceeds bound") }
  return values
}
guard CommandLine.arguments.count == 2,
  let data = CommandLine.arguments[1].data(using: .utf8),
  let input = try? JSONDecoder().decode(Input.self, from: data) else { fail("Invalid slot input") }
let application = AXUIElementCreateApplication(input.processId)
let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
let matches = windows.filter { text($0, kAXIdentifierAttribute as CFString) == "com.rionstudio.runtime.appkit-window.v1:\(input.windowId)" }
guard matches.count == 1 else { fail("Exact AppKit workspace window missing") }
let slots = descendants(matches[0]).filter { text($0, kAXIdentifierAttribute as CFString) == "workspace-slot-status:\(input.slotId)" }
guard slots.count <= 1 else { fail("Duplicate native slot status") }
if slots.isEmpty { print("{\"phase\":\"ready\"}"); exit(0) }
let slot = slots[0]
let phase = text(slot, kAXValueAttribute as CFString)
if input.action == "retry" {
  let buttons = descendants(slot).filter { text($0, kAXRoleAttribute as CFString) == "AXButton" }
  guard buttons.count == 1, (attribute(buttons[0], kAXEnabledAttribute as CFString) as? Bool) == true,
    AXUIElementPerformAction(buttons[0], kAXPressAction as CFString) == .success else { fail("Visible slot retry unavailable") }
}
var width = 0.0, height = 0.0
if let value = attribute(slot, kAXSizeAttribute as CFString), CFGetTypeID(value) == AXValueGetTypeID() {
  var size = CGSize.zero
  if AXValueGetValue(value as! AXValue, .cgSize, &size) { width = size.width; height = size.height }
}
let output: [String: Any] = ["phase": phase, "width": width, "height": height]
let json = try JSONSerialization.data(withJSONObject: output)
print(String(data: json, encoding: .utf8)!)
