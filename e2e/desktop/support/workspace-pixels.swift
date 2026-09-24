import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never { fatalError(message) }
let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let pid = (input["processId"] as! NSNumber).int32Value
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var result = [root]; var cursor = 0
  while cursor < result.count {
    guard result.count < 4096 else { fail("workspace AX tree exceeds bound") }
    let current = result[cursor]; cursor += 1
    if attribute(current, "AXRole") as? String == "AXWebArea" { continue }
    for child in attribute(current, "AXChildren") as? [AXUIElement] ?? [] {
      if !result.contains(where: { CFEqual($0, child) }) { result.append(child) }
    }
  }
  return result
}
let windows = attribute(AXUIElementCreateApplication(pid), "AXWindows") as? [AXUIElement] ?? []
let windowId = "com.rionstudio.runtime.appkit-window.v1:" + (input["windowId"] as! String)
guard let window = windows.first(where: { attribute($0, "AXIdentifier") as? String == windowId }) else { fail("exact window missing") }
let nodes = descendants(window)
func readLabels() -> [String] {
  descendants(window).filter { attribute($0, "AXDescription") as? String == "Workspace size ratio" }
    .map { attribute($0, "AXValue") as? String ?? "" }
}
var labels = readLabels()
if let expectedLabels = input["expectedLabels"] as? [String] {
  let deadline = Date().addingTimeInterval(10)
  while labels.sorted() != expectedLabels.sorted() {
    if Date() >= deadline { fail("native size labels did not match Core: expected \(expectedLabels), actual \(labels)") }
    Thread.sleep(forTimeInterval: 0.05)
    labels = readLabels()
  }
}
let windowEdges = input["windowEdges"] as? Bool == true
let divider = nodes.first { attribute($0, "AXRole") as? String == "AXSplitter" && (attribute($0, "AXValue") as? NSNumber)?.intValue == 0 }
guard let referenceElement = windowEdges ? window : divider,
      let position = attribute(referenceElement, "AXPosition") else { fail("exact reference missing") }
var point = CGPoint.zero
AXValueGetValue(position as! AXValue, .cgPoint, &point)
let reference = input["reference"] as! [String: Double]
var region = input["region"] as! [String: Double]
var points = input["points"] as! [[String: Double]]
if windowEdges {
  guard let sizeValue = attribute(window, "AXSize") else { fail("exact window size missing") }
  var size = CGSize.zero
  AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  region = ["x": 0, "y": 0, "width": size.width, "height": size.height]
  points = [["x": 16, "y": size.height - 24], ["x": size.width - 16, "y": size.height - 24]]
}
let origin = windowEdges ? point : CGPoint(x: point.x - reference["x"]!, y: point.y - reference["y"]!)
let path = input["path"] as! String
let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
task.arguments = ["-x", "-R\(Int(origin.x + region["x"]!)),\(Int(origin.y + region["y"]!)),\(Int(region["width"]!)),\(Int(region["height"]!))", path]
try task.run(); task.waitUntilExit()
guard task.terminationStatus == 0, let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: path))) else { fail("native screen capture failed") }
let samples = points.map { item -> [Int] in
  let x = Int((item["x"]! - region["x"]!) * Double(bitmap.pixelsWide) / region["width"]!)
  let y = Int((item["y"]! - region["y"]!) * Double(bitmap.pixelsHigh) / region["height"]!)
  guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { fail("pixel outside screenshot") }
  return [color.redComponent, color.greenComponent, color.blueComponent].map { Int(($0 * 255).rounded()) }
}
print(String(decoding: try JSONSerialization.data(withJSONObject: ["samples": samples, "labels": labels], options: [.sortedKeys]), as: UTF8.self))
