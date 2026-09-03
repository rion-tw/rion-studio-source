import ApplicationServices
import Foundation

private struct Input: Decodable {
  let actionLabels: [String]
  let hideLabels: [String]
  let moveToNewWindowLabels: [String]
  let processId: Int32
  let targetWindowName: String?
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(2)
}

private func stringAttribute(
  _ element: AXUIElement,
  _ attribute: CFString
) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return ""
  }
  return value as? String ?? ""
}

private func boolAttribute(
  _ element: AXUIElement,
  _ attribute: CFString
) -> Bool {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return false
  }
  return (value as? NSNumber)?.boolValue ?? false
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element,
    kAXChildrenAttribute as CFString,
    &value
  ) == .success else {
    return []
  }
  return value as? [AXUIElement] ?? []
}

private func nativeDescendants(
  _ root: AXUIElement,
  limit: Int = 4_096
) -> [AXUIElement] {
  var queue = children(root)
  var result: [AXUIElement] = []
  var index = 0
  while index < queue.count && result.count < limit {
    let element = queue[index]
    index += 1
    result.append(element)
    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    if role == "AXWebArea" || role == "AXHTMLContent" {
      continue
    }
    queue.append(contentsOf: children(element))
  }
  return result
}

private func menuItems(_ menu: AXUIElement) -> [AXUIElement] {
  return nativeDescendants(menu, limit: 256).filter {
    stringAttribute($0, kAXRoleAttribute as CFString) == "AXMenuItem"
  }
}

private func findMenuItem(
  application: AXUIElement,
  acceptedLabels: Set<String>,
  requiredSiblingLabels: [Set<String>]
) -> AXUIElement? {
  let menus = nativeDescendants(application).filter {
    stringAttribute($0, kAXRoleAttribute as CFString) == "AXMenu"
  }
  for menu in menus {
    let items = menuItems(menu)
    let titles = Set(items.map {
      stringAttribute($0, kAXTitleAttribute as CFString)
    })
    guard requiredSiblingLabels.allSatisfy({ !$0.isDisjoint(with: titles) }) else {
      continue
    }
    let matches = items.filter {
      acceptedLabels.contains(stringAttribute($0, kAXTitleAttribute as CFString)) &&
        boolAttribute($0, kAXEnabledAttribute as CFString)
    }
    if matches.count == 1 {
      return matches[0]
    }
  }
  return nil
}

private func waitForMenuItem(
  application: AXUIElement,
  acceptedLabels: Set<String>,
  requiredSiblingLabels: [Set<String>]
) -> AXUIElement {
  for _ in 0..<100 {
    if let item = findMenuItem(
      application: application,
      acceptedLabels: acceptedLabels,
      requiredSiblingLabels: requiredSiblingLabels
    ) {
      return item
    }
    usleep(50_000)
  }
  let diagnostics = nativeDescendants(application).compactMap { element -> String? in
    guard stringAttribute(element, kAXRoleAttribute as CFString) == "AXMenuItem" else {
      return nil
    }
    return stringAttribute(element, kAXTitleAttribute as CFString)
  }
  fail("visible native runtime-tab menu item unavailable; observed=" +
    diagnostics.joined(separator: "|"))
}

guard CommandLine.arguments.count == 2,
  let data = CommandLine.arguments[1].data(using: .utf8),
  let input = try? JSONDecoder().decode(Input.self, from: data),
  input.processId > 0,
  !input.actionLabels.isEmpty else {
  fail("invalid AppKit menu selection input")
}

let application = AXUIElementCreateApplication(input.processId)
let actionItem = waitForMenuItem(
  application: application,
  acceptedLabels: Set(input.actionLabels),
  requiredSiblingLabels: [
    Set(input.hideLabels),
    Set(input.moveToNewWindowLabels)
  ]
)
guard AXUIElementPerformAction(
  actionItem,
  kAXPressAction as CFString
) == .success else {
  fail("visible native runtime-tab menu action failed")
}

if let targetWindowName = input.targetWindowName {
  let targetItem = waitForMenuItem(
    application: application,
    acceptedLabels: Set([targetWindowName]),
    requiredSiblingLabels: []
  )
  guard AXUIElementPerformAction(
    targetItem,
    kAXPressAction as CFString
  ) == .success else {
    fail("visible native target-window menu action failed")
  }
}
