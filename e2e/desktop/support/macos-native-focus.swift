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
guard ["focus", "observe", "roleKey", "shortcut"].contains(mode) else { fail("unknown focus mode") }
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

let expiry = Date().addingTimeInterval(
  mode == "shortcut" || mode == "roleKey" ? 0 : 10
)
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
    let exactIdentity = mode == "shortcut" || mode == "roleKey"
      ? (expectedWindowIdentifier.isEmpty
          ? focusedWindowIdentifier.hasPrefix(appKitPrefix)
          : focusedWindowIdentifier == expectedWindowIdentifier)
      : candidates.count == 1 && focusedWindowIdentifier == expectedWindowIdentifier
    if foreground(), exactIdentity, mainWindowIdentifier == focusedWindowIdentifier,
       text(focusedWindow, "AXRole") == "AXWindow", boolean(focusedWindow, "AXMain") {
      let restoringFullscreen = mode == "shortcut" && command == "toggleFullscreen" && boolean(focusedWindow, "AXFullScreen")
      if (mode == "shortcut" || mode == "roleKey") && !restoringFullscreen && runtimeTabName.isEmpty && expectedWindowIdentifier.isEmpty {
        fail("exact focused runtime tab name or window identifier is required")
      }
      if !restoringFullscreen && !runtimeTabName.isEmpty {
        let tabs = descendants(focusedWindow).filter {
          text($0, "AXRole") == "AXRadioButton" && text($0, "AXDescription") == runtimeTabName
        }
        guard tabs.count <= 1 else { fail("ambiguous exact AppKit runtime tab") }
        let requiresActiveTab = command == "active" || mode == "roleKey" ||
          (mode == "shortcut" && (command == "nextTab" || command == "previousTab"))
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

if mode == "shortcut" || mode == "roleKey" {
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
  case "AltDown" where mode == "roleKey": key = 58; flags = [.maskAlternate]
  case "AltUp" where mode == "roleKey": key = 58; flags = []
  case "Alt+Digit1" where mode == "roleKey": key = 18; flags = [.maskAlternate]
  case "Alt+Digit1Tap" where mode == "roleKey": key = 18; flags = [.maskAlternate]
  case "KeyY" where mode == "roleKey": key = 16; flags = []
  case "Shift+Digit3" where mode == "roleKey": key = 20; flags = [.maskShift]
  case "Shift+Digit4" where mode == "roleKey": key = 21; flags = [.maskShift]
  case "Shift+Digit5Hold" where mode == "roleKey": key = 23; flags = [.maskShift]
  case "Shift+Digit5Release" where mode == "roleKey": key = 23; flags = [.maskShift]
  case "Shift+Digit3Twice" where mode == "roleKey": key = 20; flags = [.maskShift]
  case "Shift+Digit2ThenDigit3Hold" where mode == "roleKey": key = 19; flags = [.maskShift]
  case "Shift+Digit3ThenDigit2Hold" where mode == "roleKey": key = 20; flags = [.maskShift]
  case "ShiftUp" where mode == "roleKey": key = 56; flags = []
  case "escape": key = 53; flags = []
  case "nextTab": key = 48; flags = [.maskControl]
  case "previousTab": key = 48; flags = [.maskControl, .maskShift]
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
  if command == "AltDown" {
    down.post(tap: .cghidEventTap)
  } else if command == "AltUp" {
    up.post(tap: .cghidEventTap)
  } else if command == "Alt+Digit1" || command == "Alt+Digit1Tap" {
    guard let altDown = CGEvent(keyboardEventSource: source, virtualKey: 58, keyDown: true),
          let altUp = CGEvent(keyboardEventSource: source, virtualKey: 58, keyDown: false)
      else { fail("native Alt shortcut events unavailable") }
    altDown.flags = [.maskAlternate]
    altUp.flags = []
    let events = command == "Alt+Digit1Tap" ? [altDown, down, up, altUp] : [down, up]
    for event in events {
      event.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  } else if command == "Shift+Digit3Twice" {
    guard let shiftDown = CGEvent(
      keyboardEventSource: source, virtualKey: 56, keyDown: true
    ), let shiftUp = CGEvent(
      keyboardEventSource: source, virtualKey: 56, keyDown: false
    ) else { fail("native repeated Role shortcut events unavailable") }
    shiftDown.flags = [.maskShift]
    shiftUp.flags = []
    shiftDown.post(tap: .cghidEventTap)
    usleep(20_000)
    for index in 0..<2 {
      down.post(tap: .cghidEventTap)
      usleep(20_000)
      up.post(tap: .cghidEventTap)
      if index == 0 { usleep(600_000) }
    }
    usleep(20_000)
    shiftUp.post(tap: .cghidEventTap)
  } else if command == "Shift+Digit2ThenDigit3Hold" || command == "Shift+Digit3ThenDigit2Hold" {
    let secondKey: CGKeyCode = command == "Shift+Digit2ThenDigit3Hold" ? 20 : 19
    guard let shiftDown = CGEvent(
      keyboardEventSource: source, virtualKey: 56, keyDown: true
    ), let secondDown = CGEvent(
      keyboardEventSource: source, virtualKey: secondKey, keyDown: true
    ), let secondUp = CGEvent(
      keyboardEventSource: source, virtualKey: secondKey, keyDown: false
    ) else { fail("native overlapping Role shortcut events unavailable") }
    shiftDown.flags = [.maskShift]
    secondDown.flags = [.maskShift]
    secondUp.flags = [.maskShift]
    for event in [shiftDown, down, up, secondDown, secondUp] {
      event.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  } else if command == "Shift+Digit5Hold" || command == "Shift+Digit5Release" {
    let releasing = command == "Shift+Digit5Release"
    guard let shift = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: !releasing)
      else { fail("native held Shift shortcut unavailable") }
    shift.flags = releasing ? [] : [.maskShift]
    for event in releasing ? [up, shift] : [shift, down] {
      event.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  } else if command == "ShiftUp" {
    up.post(tap: .cghidEventTap)
  } else if command == "Shift+Digit4" || command == "Shift+Digit3" {
    guard let shiftDown = CGEvent(
      keyboardEventSource: source, virtualKey: 56, keyDown: true
    ), let shiftUp = CGEvent(
      keyboardEventSource: source, virtualKey: 56, keyDown: false
    ) else { fail("native Shift modifier events unavailable") }
    shiftDown.flags = [.maskShift]
    shiftUp.flags = []
    shiftDown.post(tap: .cghidEventTap)
    usleep(20_000)
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
    usleep(20_000)
    shiftUp.post(tap: .cghidEventTap)
  } else if command == "nextTab" || command == "previousTab" {
    guard let controlDown = CGEvent(
      keyboardEventSource: source, virtualKey: 59, keyDown: true
    ), let controlUp = CGEvent(
      keyboardEventSource: source, virtualKey: 59, keyDown: false
    ) else { fail("native Control modifier events unavailable") }
    controlDown.flags = [.maskControl]
    controlUp.flags = []
    var events = [controlDown, down, up, controlUp]
    if command == "previousTab" {
      guard let shiftDown = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: true),
            let shiftUp = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: false)
      else { fail("native reverse-tab Shift events unavailable") }
      shiftDown.flags = [.maskControl, .maskShift]
      shiftUp.flags = [.maskControl]
      events = [controlDown, shiftDown, down, up, shiftUp, controlUp]
    }
    for event in events {
      event.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  } else {
    down.post(tap: .cghidEventTap)
    // A Role key deliberately uses a zero-gap lifecycle so the product proof
    // covers keyup racing the managed keydown acknowledgement.
    if mode != "roleKey" { usleep(20_000) }
    up.post(tap: .cghidEventTap)
  }
  // PresentationOnly: keep WebDriver outside the Space animation; the caller
  // still requires the exact Core/AppKit terminal presentation event.
  if command == "toggleFullscreen" { usleep(2_000_000) }
}
print("focused")
