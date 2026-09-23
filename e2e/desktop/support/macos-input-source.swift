import Carbon
import Foundation

func fail(_ message: String) -> Never {
  fputs("\(message)\n", stderr)
  exit(1)
}

func sourceId(_ source: TISInputSource) -> String? {
  guard let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
    return nil
  }
  return Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
}

func currentSourceId() -> String {
  let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  guard let id = sourceId(source) else {
    fail("current macOS keyboard input source has no identity")
  }
  return id
}

let arguments = CommandLine.arguments
guard arguments.count == 2 || arguments.count == 3 else {
  fail("expected current or select with one exact input source ID")
}
if arguments[1] == "current" && arguments.count == 2 {
  print(currentSourceId())
  exit(0)
}
guard arguments[1] == "select", arguments.count == 3 else {
  fail("invalid macOS input source command")
}
let expected = arguments[2]
let sources = TISCreateInputSourceList(nil, false).takeRetainedValue() as! [TISInputSource]
guard let source = sources.first(where: { sourceId($0) == expected }) else {
  fail("exact macOS input source unavailable: \(expected)")
}
guard TISSelectInputSource(source) == noErr else {
  fail("exact macOS input source selection failed: \(expected)")
}
guard currentSourceId() == expected else {
  fail("exact macOS input source selection was not applied: \(expected)")
}
print(expected)
