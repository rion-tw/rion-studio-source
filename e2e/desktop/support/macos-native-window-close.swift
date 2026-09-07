import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 3,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      AXIsProcessTrusted() else { fail("native close input or Accessibility grant unavailable") }
let identifier = "com.rionstudio.runtime.appkit-window.v1:" + CommandLine.arguments[2]
let application = AXUIElementCreateApplication(targetPid)

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid else {
    fail("native close AX object escaped the exact process")
  }
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func object(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
let matches = windows.filter { attribute($0, "AXIdentifier") as? String == identifier }
guard matches.count == 1, let window = matches.first,
      NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
      let focused = object(application, "AXFocusedWindow"), CFEqual(focused, window),
      let button = object(window, "AXCloseButton"),
      attribute(button, "AXRole") as? String == "AXButton",
      attribute(button, "AXSubrole") as? String == "AXCloseButton",
      (attribute(button, "AXEnabled") as? NSNumber)?.boolValue == true,
      let owner = object(button, "AXWindow"), CFEqual(owner, window) else {
  fail("exact focused AppKit close control or its native owner unavailable")
}
guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
  fail("exact native AppKit close button rejected AXPress")
}
print("pressed")
