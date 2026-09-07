import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 4,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      AXIsProcessTrusted() else { fail("native window input or Accessibility grant unavailable") }
let identifier = "com.rionstudio.runtime.appkit-window.v1:" + CommandLine.arguments[2]
let command = CommandLine.arguments[3]
let application = AXUIElementCreateApplication(targetPid)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid else {
    fail("native window AX object escaped the exact process")
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
guard matches.count == 1, let window = matches.first else { fail("exact AppKit window unavailable") }
if command == "minimized" {
  guard let value = attribute(window, "AXMinimized") as? NSNumber else {
    fail("exact AppKit minimized state unavailable")
  }
  print(value.boolValue ? "true" : "false")
  exit(0)
}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
      let focused = object(application, "AXFocusedWindow"), CFEqual(focused, window) else {
  fail("exact AppKit window is not foreground and focused")
}
if command == "minimize" {
  guard let button = object(window, "AXMinimizeButton"),
        attribute(button, "AXRole") as? String == "AXButton",
        attribute(button, "AXSubrole") as? String == "AXMinimizeButton",
        (attribute(button, "AXEnabled") as? NSNumber)?.boolValue == true,
        let owner = object(button, "AXWindow"), CFEqual(owner, window),
        AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
    fail("exact AppKit minimize control rejected AXPress")
  }
  print("pressed")
  exit(0)
}
guard ["drag", "resize"].contains(command),
      let position = attribute(window, "AXPosition"), CFGetTypeID(position) == AXValueGetTypeID(),
      let size = attribute(window, "AXSize"), CFGetTypeID(size) == AXValueGetTypeID() else {
  fail("exact native window geometry unavailable")
}
var point = CGPoint.zero
var extent = CGSize.zero
guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &extent),
      [point.x, point.y, extent.width, extent.height].allSatisfy({ $0.isFinite }),
      extent.width > 0, extent.height > 0,
      let source = CGEventSource(stateID: .hidSystemState) else {
  fail("exact native window geometry or pointer source invalid")
}
let start = command == "drag"
  ? CGPoint(x: point.x + extent.width / 2, y: point.y + 16)
  : CGPoint(x: point.x + extent.width - 2, y: point.y + extent.height - 2)
let delta = command == "drag" ? CGPoint(x: 64, y: 38) : CGPoint(x: 72, y: 48)
func post(_ type: CGEventType, _ point: CGPoint) {
  guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                            mouseCursorPosition: point, mouseButton: .left) else {
    fail("native window pointer event unavailable")
  }
  event.flags = []
  event.setIntegerValueField(.mouseEventClickState, value: 1)
  event.post(tap: .cghidEventTap)
}
post(.mouseMoved, start)
post(.leftMouseDown, start)
for step in 1...10 {
  usleep(20_000) // Pace the physical gesture; does not establish domain completion.
  post(.leftMouseDragged, CGPoint(x: start.x + delta.x * CGFloat(step) / 10,
                                 y: start.y + delta.y * CGFloat(step) / 10))
}
post(.leftMouseUp, CGPoint(x: start.x + delta.x, y: start.y + delta.y))
print("submitted")
