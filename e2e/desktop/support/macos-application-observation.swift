import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> Any? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}
func describeWindow(_ element: AXUIElement) -> [String: Any] {
  var result: [String: Any] = [:]
  for name in [kAXIdentifierAttribute, kAXMainAttribute, kAXFocusedAttribute,
               kAXMinimizedAttribute, kAXRoleAttribute] {
    if let value = attribute(element, name) as? String { result[name] = value }
    else if let value = attribute(element, name) as? NSNumber { result[name] = value }
  }
  return result
}
guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 1 else { exit(2) }
let target = NSRunningApplication(processIdentifier: pid)
let foreground = NSWorkspace.shared.frontmostApplication
let application = AXUIElementCreateApplication(pid)
var windowsValue: CFTypeRef?
let windowsError = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowsValue)
let windows = (windowsValue as? [AXUIElement]) ?? []
var result: [String: Any] = [
  "processId": pid,
  "targetExists": target != nil,
  "targetActive": target?.isActive ?? false,
  "targetTerminated": target?.isTerminated ?? true,
  "activationPolicy": target?.activationPolicy.rawValue ?? -1,
  "foregroundProcessId": foreground?.processIdentifier ?? -1,
  "foregroundBundleId": foreground?.bundleIdentifier ?? "",
  "axTrusted": AXIsProcessTrusted(),
  "windowsError": windowsError.rawValue,
  "windowCount": windows.count,
  "windows": windows.prefix(32).map(describeWindow)
]
if let focused = attribute(application, kAXFocusedWindowAttribute) {
  let value = focused as CFTypeRef
  if CFGetTypeID(value) == AXUIElementGetTypeID() {
    result["focusedWindow"] = describeWindow(unsafeBitCast(value, to: AXUIElement.self))
  }
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
