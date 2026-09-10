import AppKit
import ApplicationServices
import Foundation

// Retain native AX objects. System Events can serialize an AXWindow back into
// a name-based reference and select another Electron process or same-title window.
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 6,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 0,
      AXIsProcessTrusted() else { fail("exact native focus input or Accessibility grant unavailable") }
let expectedWindowIdentifier = CommandLine.arguments[2]
let runtimeTabName = CommandLine.arguments[3]
let mode = CommandLine.arguments[4]
let command = CommandLine.arguments[5]
guard ["focus", "observe", "shortcut"].contains(mode) else { fail("unknown focus mode") }
let appKitPrefix = "com.rionstudio.runtime.appkit-window.v1:"
let application = AXUIElementCreateApplication(targetPid)

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid else {
    fail("AX object escaped the exact process")
  }
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}
func boolean(_ element: AXUIElement, _ name: String) -> Bool {
  (attribute(element, name) as? NSNumber)?.boolValue ?? false
}
func object(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var result = [root]
  var cursor = 0
  while cursor < result.count {
    guard result.count <= 4096 else { fail("exact native AX tree exceeds its bounded search") }
    let current = result[cursor]
    cursor += 1
    if text(current, "AXRole") == "AXWebArea" { continue }
    for child in children(current) where !result.contains(where: { CFEqual($0, child) }) {
      result.append(child)
    }
  }
  return result
}
func foreground() -> Bool {
  NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid
}

let expiry = Date().addingTimeInterval(mode == "shortcut" ? 0 : 10)
var diagnostic = ""
while true {
  let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
  let candidates = windows.filter { text($0, "AXIdentifier") == expectedWindowIdentifier }
  if mode != "shortcut" {
    guard candidates.count <= 1 else { fail("ambiguous exact AppKit runtime window") }
    if mode == "focus", let target = candidates.first {
      guard let running = NSRunningApplication(processIdentifier: targetPid) else { fail("exact process exited") }
      running.activate(options: [])
      guard AXUIElementPerformAction(target, kAXRaiseAction as CFString) == .success else {
        fail("exact AppKit runtime AXRaise failed")
      }
    }
  }
  if let focusedWindow = object(application, "AXFocusedWindow"),
     let mainWindow = object(application, "AXMainWindow") {
    let focusedWindowIdentifier = text(focusedWindow, "AXIdentifier")
    let mainWindowIdentifier = text(mainWindow, "AXIdentifier")
    let exactIdentity = mode == "shortcut"
      ? (expectedWindowIdentifier.isEmpty
          ? focusedWindowIdentifier.hasPrefix(appKitPrefix)
          : focusedWindowIdentifier == expectedWindowIdentifier)
      : candidates.count == 1 && focusedWindowIdentifier == expectedWindowIdentifier
    if foreground(), exactIdentity, mainWindowIdentifier == focusedWindowIdentifier,
       text(focusedWindow, "AXRole") == "AXWindow", boolean(focusedWindow, "AXMain") {
      let restoringFullscreen = mode == "shortcut" && command == "toggleFullscreen" && boolean(focusedWindow, "AXFullScreen")
      if mode == "shortcut" && !restoringFullscreen && runtimeTabName.isEmpty && expectedWindowIdentifier.isEmpty {
        fail("exact focused runtime tab name or window identifier is required")
      }
      if !restoringFullscreen && !runtimeTabName.isEmpty {
        let tabs = descendants(focusedWindow).filter {
          text($0, "AXRole") == "AXRadioButton" && text($0, "AXDescription") == runtimeTabName
        }
        guard tabs.count <= 1 else { fail("ambiguous exact AppKit runtime tab") }
        let requiresActiveTab = command == "active" ||
          (mode == "shortcut" && command == "nextTab")
        if let tab = tabs.first, let owner = object(tab, "AXWindow"),
           text(owner, "AXRole") == "AXWindow",
           text(owner, "AXIdentifier") == focusedWindowIdentifier,
           !requiresActiveTab || boolean(tab, "AXValue") {
          break
        }
        diagnostic = requiresActiveTab
          ? "exact runtime tab is not the active AppKit visual owner"
          : "exact runtime tab or its AXWindow owner unavailable"
      } else { break }
    } else {
      diagnostic = "focused=\(focusedWindowIdentifier); main=\(mainWindowIdentifier); foreground=\(foreground())"
    }
  } else { diagnostic = "AXFocusedWindow or AXMainWindow unavailable" }
  if Date() >= expiry { fail("exact AppKit runtime focus did not settle; " + diagnostic) }
  usleep(50_000)
}

if mode == "shortcut" {
  if command == "toggleFullscreen" {
    guard let menuBar = object(application, "AXMenuBar") else { fail("exact menu bar unavailable") }
    let views = children(menuBar).filter { text($0, "AXTitle") == "View" }
    guard views.count == 1 else { fail("exact View NSMenu unavailable") }
    let items = descendants(views[0]).filter { text($0, "AXRole") == "AXMenuItem" && text($0, "AXTitle") == "Toggle Full Screen" }
    guard items.count == 1, boolean(items[0], "AXEnabled") else { fail("exact fullscreen NSMenu item unavailable or disabled") }
  }
  let key: CGKeyCode
  let flags: CGEventFlags
  switch command {
  case "escape": key = 53; flags = []
  case "nextTab": key = 48; flags = [.maskControl]
  case "newGameWindow": key = 45; flags = [.maskCommand]
  case "quickAccess": key = 40; flags = [.maskCommand]
  case "toggleFullscreen": key = 3; flags = [.maskCommand, .maskControl]
  case "zoomIn": key = 24; flags = [.maskCommand, .maskShift]
  case "zoomReset": key = 29; flags = [.maskCommand]
  default: fail("unsupported native shortcut")
  }
  guard foreground(), let source = CGEventSource(stateID: .hidSystemState),
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
    fail("exact native shortcut source unavailable")
  }
  down.flags = flags
  up.flags = flags
  if command == "nextTab" {
    guard let controlDown = CGEvent(
      keyboardEventSource: source, virtualKey: 59, keyDown: true
    ), let controlUp = CGEvent(
      keyboardEventSource: source, virtualKey: 59, keyDown: false
    ) else { fail("native Control modifier events unavailable") }
    controlDown.flags = [.maskControl]
    controlUp.flags = []
    for event in [controlDown, down, up, controlUp] {
      event.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  } else {
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
  }
  // PresentationOnly: keep WebDriver outside the Space animation; the caller
  // still requires the exact Core/AppKit terminal presentation event.
  if command == "toggleFullscreen" { usleep(2_000_000) }
}
print("focused")
