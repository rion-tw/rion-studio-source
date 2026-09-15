import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 4,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      AXIsProcessTrusted(),
      let application = NSRunningApplication(processIdentifier: targetPid),
      let bundleURL = application.bundleURL else {
  fail("exact Quick Menu application or Accessibility grant unavailable")
}
let windowLabel = CommandLine.arguments[2]
let absentWindowLabel = CommandLine.arguments[3]
let docks = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock")
guard docks.count == 1 else { fail("exact Dock process unavailable") }
let dockPid = docks[0].processIdentifier
let dock = AXUIElementCreateApplication(dockPid)

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  // Dock descendants and the application's exported menu can have different
  // AX providers. Identity comes from the exact bundle item and its shown menu.
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func label(_ element: AXUIElement) -> String {
  let title = text(element, "AXTitle")
  return title.isEmpty ? text(element, "AXDescription") : title
}
func object(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

// Each E2E process runs from its own bundle. Resolve its exact URL so a user's
// concurrent development app with the same display name is never selected.
let lists = children(dock).filter { text($0, "AXRole") == "AXList" }
let items = lists.flatMap { children($0) }.filter { candidate in
  guard let url = attribute(candidate, "AXURL") as? URL else { return false }
  return url.resolvingSymlinksInPath().standardizedFileURL ==
    bundleURL.resolvingSymlinksInPath().standardizedFileURL
}
guard items.count == 1 else { fail("exact application-bundle Dock item unavailable; matches=\(items.count)") }
application.activate(options: [])
guard AXUIElementPerformAction(items[0], "AXShowMenu" as CFString) == .success else {
  fail("exact Dock item could not show its Quick Menu")
}
let expiry = Date().addingTimeInterval(10)
var menu: AXUIElement?
while menu == nil {
  menu = object(items[0], "AXShownMenuUIElement")
  if Date() >= expiry { fail("Rion Dock Quick Menu unavailable") }
  if menu == nil { usleep(50_000) }
}
let directItems = children(menu!).filter { text($0, "AXRole") == "AXMenuItem" }
let labels = directItems.map { label($0) }
let openLabels = ["Open Rion Studio", "開啟 Rion Studio", "打开 Rion Studio", "Rion Studio を開く"]
for candidates in [
  openLabels, ["Roles", "角色", "ロール"],
  ["Workspaces", "工作區", "工作区", "ワークスペース"],
  ["Windows", "視窗", "窗口", "ウインドウ"]
] {
  guard candidates.contains(where: { labels.contains($0) }) else {
    fail("complete localized Quick Menu unavailable; items=\(labels)")
  }
}
// macOS prepends its own window list. Exercise the application's explicit
// section between Open and Roles, never the OS-provided duplicate title.
guard let openIndex = directItems.firstIndex(where: { openLabels.contains(label($0)) }),
      let rolesIndex = directItems.indices.first(where: {
        $0 > openIndex && ["Roles", "角色", "ロール"].contains(label(directItems[$0]))
      }) else { fail("explicit Quick Menu window section unavailable") }
let windowItems = directItems[(openIndex + 1)..<rolesIndex]
if !absentWindowLabel.isEmpty && windowItems.contains(where: { label($0) == absentWindowLabel }) {
  fail("closed runtime window remains in the top-level Dock menu")
}
let selected = windowLabel.isEmpty ? [directItems[openIndex]] :
  windowItems.filter { label($0) == windowLabel }
guard selected.count == 1 else {
  fail("exact top-level Quick Menu item unavailable; items=\(labels)")
}
guard AXUIElementPerformAction(selected[0], kAXPressAction as CFString) == .success else {
  fail("exact top-level Quick Menu item could not be pressed")
}
