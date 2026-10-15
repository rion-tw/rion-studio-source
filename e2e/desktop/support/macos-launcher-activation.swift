import AppKit
import ApplicationServices
import Foundation

// Desktop E2E only: bounded external AX publication/activation acknowledgement.
// Retain the admitted native object; System Events window-index proxies can expire.
// The caller's ten-second budget is unchanged. Raise once, never reacquire another
// launcher, and never submit/retry keyboard or pointer input here.
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
guard CommandLine.arguments.count == 2,
      let targetPid = Int32(CommandLine.arguments[1]), targetPid > 1,
      AXIsProcessTrusted(),
      let running = NSRunningApplication(processIdentifier: targetPid) else {
  fail("exact launcher process or Accessibility grant unavailable")
}
let application = AXUIElementCreateApplication(targetPid)
let appKitPrefix = "com.rionstudio.runtime.appkit-window.v1:"
let expiry = Date().addingTimeInterval(10)

func owner(_ element: AXUIElement) -> pid_t {
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success, pid == targetPid else {
    fail("retained launcher AX object escaped its exact process or retired")
  }
  return pid
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  _ = owner(element)
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}
func boolean(_ element: AXUIElement, _ name: String) -> Bool {
  (attribute(element, name) as? NSNumber)?.boolValue ?? false
}
func launchers() -> [AXUIElement] {
  guard !running.isTerminated else { fail("exact launcher process exited") }
  let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
  guard windows.count <= 128 else { fail("exact launcher AX window list exceeds its bounded scope") }
  let candidates = windows.filter {
    text($0, "AXRole") == "AXWindow" && !text($0, "AXIdentifier").hasPrefix(appKitPrefix)
  }
  guard candidates.count <= 1 else { fail("ambiguous exact non-AppKit launcher AXWindow") }
  return candidates
}
var admitted: AXUIElement?
while admitted == nil {
  admitted = launchers().first
  if admitted != nil { break }
  if Date() >= expiry { fail("exact launcher AXWindow was not published") }
  usleep(50_000)
}
guard let launcher = admitted else { fail("exact launcher AXWindow was not admitted") }
guard text(launcher, "AXRole") == "AXWindow",
      !text(launcher, "AXIdentifier").hasPrefix(appKitPrefix),
      running.activate(options: []) else { fail("exact launcher activation failed") }
guard AXUIElementPerformAction(launcher, kAXRaiseAction as CFString) == .success else {
  fail("retained exact launcher AXRaise failed")
}
while true {
  let candidates = launchers()
  if let current = candidates.first, !CFEqual(current, launcher) {
    fail("exact launcher AX identity changed after admission")
  }
  let role = text(launcher, "AXRole")
  guard role.isEmpty || role == "AXWindow",
        !text(launcher, "AXIdentifier").hasPrefix(appKitPrefix) else {
    fail("retained launcher changed its native AX owner kind")
  }
  if candidates.count == 1, role == "AXWindow", boolean(launcher, "AXMain"),
     NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid {
    let result: [String: Any] = [
      "processId": targetPid, "ownerProcessId": owner(launcher),
      "foregroundProcessId": targetPid, "role": role, "main": true,
      "launcherCount": candidates.count, "retainedOwner": true
    ]
    let data = try JSONSerialization.data(withJSONObject: result)
    print(String(data: data, encoding: .utf8)!)
    break
  }
  if Date() >= expiry { fail("retained exact launcher did not become AXMain and foreground") }
  usleep(50_000)
}
