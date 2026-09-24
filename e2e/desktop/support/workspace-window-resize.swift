import AppKit
import ApplicationServices
import Foundation

let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let pid = (input["processId"] as! NSNumber).int32Value
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
  return value
}
let application = AXUIElementCreateApplication(pid)
let identifier = "com.rionstudio.runtime.appkit-window.v1:" + (input["windowId"] as! String)
let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
guard let window = windows.first(where: { attribute($0, "AXIdentifier") as? String == identifier }),
      let position = attribute(window, "AXPosition"), let size = attribute(window, "AXSize"),
      let source = CGEventSource(stateID: .hidSystemState) else { fatalError("exact resize host missing") }
var origin = CGPoint.zero; var extent = CGSize.zero
AXValueGetValue(position as! AXValue, .cgPoint, &origin)
AXValueGetValue(size as! AXValue, .cgSize, &extent)
let phase = input["phase"] as! String
var point = CGPoint(x: (input["x"] as? NSNumber)?.doubleValue ?? 0, y: (input["y"] as? NSNumber)?.doubleValue ?? 0)
if phase == "start" {
  let edge = input["edge"] as! String
  // The outermost bottom-right pixel is outside the rounded AppKit resize hit
  // region on the CI host. Begin inside both native border hit regions.
  point = CGPoint(x: origin.x + extent.width - 1, y: origin.y + extent.height - 1)
  if edge == "bottomRight" { point = CGPoint(x: point.x - 7, y: point.y - 7) }
  if edge == "right" { point.y = origin.y + extent.height / 2 }
  if edge == "bottom" { point.x = origin.x + extent.width / 2 }
  if edge == "left" { point = CGPoint(x: origin.x + 1, y: origin.y + extent.height / 2) }
  if edge == "top" { point = CGPoint(x: origin.x + extent.width / 2, y: origin.y + 1) }
  CGWarpMouseCursorPosition(point)
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
if phase == "move" {
  let previous = CGEvent(source: nil)!.location
  let rapid = input["rapid"] as? Bool ?? false
  let fractions = rapid ? [0.25,0.9,0.4,1.0,0.25,1.0] : [1.0/6,2.0/6,3.0/6,4.0/6,5.0/6]
  for fraction in fractions {
    let sample = CGPoint(x: previous.x + (point.x-previous.x)*fraction,
                         y: previous.y + (point.y-previous.y)*fraction)
    CGWarpMouseCursorPosition(sample)
    let drag = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: sample, mouseButton: .left)!
    drag.flags = []
    drag.setIntegerValueField(.mouseEventClickState, value: 1)
    drag.post(tap: .cghidEventTap)
    usleep(rapid ? 8_000 : 30_000)
  }
}
CGWarpMouseCursorPosition(point)
usleep(50_000) // Input pacing only; assertions use native geometry and actual pixels.
let type: CGEventType = phase == "start" ? .leftMouseDown : phase == "end" ? .leftMouseUp : .leftMouseDragged
guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fatalError("resize event unavailable") }
event.flags = []
event.setIntegerValueField(.mouseEventClickState, value: 1)
event.post(tap: .cghidEventTap)
usleep(100_000)
let expected = input["expected"] as? [String: NSNumber]
let deadline = Date().addingTimeInterval(10)
while true {
  guard let currentSize = attribute(window, "AXSize"),
        let currentPosition = attribute(window, "AXPosition") else {
    fatalError("resize acknowledgement frame unavailable")
  }
  AXValueGetValue(currentSize as! AXValue, .cgSize, &extent)
  AXValueGetValue(currentPosition as! AXValue, .cgPoint, &origin)
  guard let expected else { break }
  if abs(extent.width - expected["x"]!.doubleValue) <= 1 &&
      abs(extent.height - expected["y"]!.doubleValue) <= 1 { break }
  if Date() >= deadline {
    fatalError("native resize did not reach requested frame: \(expected), actual \(extent)")
  }
  usleep(10_000)
}
print(String(decoding: try JSONSerialization.data(withJSONObject: ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height, "windowX":origin.x, "windowY":origin.y]), as: UTF8.self))
