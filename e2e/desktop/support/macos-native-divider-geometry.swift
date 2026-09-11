import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 4,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      ["horizontal", "vertical"].contains(CommandLine.arguments[2]),
      let dividerIndex = Int(CommandLine.arguments[3]), dividerIndex >= 0,
      AXIsProcessTrusted() else { fail("native divider input or Accessibility grant unavailable") }
let axis = CommandLine.arguments[2]
let expectedLabel = axis == "vertical"
  ? "Resize workspace columns"
  : "Resize workspace rows"
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var owner: pid_t = 0
  guard AXUIElementGetPid(element, &owner) == .success, owner == targetPid else {
    fail("native divider AX object escaped the exact process")
  }
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}
func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var result = [root]
  var cursor = 0
  while cursor < result.count {
    guard result.count <= 4096 else { fail("native divider AX tree exceeds bounded search") }
    let current = result[cursor]
    cursor += 1
    // Remote Web content cannot supply this retained native splitter.
    if text(current, "AXRole") == "AXWebArea" { continue }
    for child in attribute(current, "AXChildren") as? [AXUIElement] ?? [] {
      if !result.contains(where: { CFEqual($0, child) }) { result.append(child) }
    }
  }
  return result
}
let prefix = "com.rionstudio.runtime.appkit-window.v1:"
let application = AXUIElementCreateApplication(targetPid)
let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
var matches: [(String, AXUIElement)] = []
for window in windows {
  let identifier = text(window, "AXIdentifier")
  if !identifier.hasPrefix(prefix) { continue }
  for candidate in descendants(window) where text(candidate, "AXRole") == "AXSplitter" {
    if text(candidate, "AXTitle") == expectedLabel ||
       text(candidate, "AXDescription") == expectedLabel,
       let value = attribute(candidate, "AXValue") as? NSNumber,
       value.intValue == dividerIndex {
      matches.append((String(identifier.dropFirst(prefix.count)), candidate))
    }
  }
}
guard matches.count <= 1 else { fail("duplicate exact native workspace splitter") }
guard let (windowId, divider) = matches.first else {
  print("PENDING|no exact native \(axis) splitter at index \(dividerIndex)")
  exit(0)
}
guard let position = attribute(divider, "AXPosition"), CFGetTypeID(position) == AXValueGetTypeID(),
      let size = attribute(divider, "AXSize"), CFGetTypeID(size) == AXValueGetTypeID() else {
  fail("exact native divider geometry unavailable")
}
var point = CGPoint.zero
var extent = CGSize.zero
guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &extent),
      [point.x, point.y, extent.width, extent.height].allSatisfy({ $0.isFinite }),
      extent.width > 0, extent.height > 0 else { fail("native divider geometry invalid") }
let data = try JSONSerialization.data(withJSONObject: [
  "windowId": windowId, "axis": axis, "dividerIndex": dividerIndex,
  "x": point.x, "y": point.y,
  "width": extent.width, "height": extent.height
], options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
