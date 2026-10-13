import { execFile } from "node:child_process";

/** Keep one HID source alive until the read-only held-gesture evidence finishes. */
export async function dragMacosNativeDivider(input: {
  startX: number; startY: number; endX: number; endY: number;
  whileDragging?: () => Promise<void>;
}): Promise<void> {
  const coordinates = [input.startX, input.startY, input.endX, input.endY];
  if (coordinates.some(value => !Number.isFinite(value))) throw new Error("Invalid native divider coordinates");
  const script = `
import CoreGraphics
import Foundation
guard let source = CGEventSource(stateID: .hidSystemState),
      let initial = CGEvent(source: nil)?.location else {
  fatalError("system pointer source unavailable")
}
let start = CGPoint(x: ${input.startX}, y: ${input.startY})
let end = CGPoint(x: ${input.endX}, y: ${input.endY})
guard let release = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                           mouseCursorPosition: end, mouseButton: .left) else {
  fatalError("system pointer release unavailable")
}
release.flags = []
release.setIntegerValueField(.mouseEventClickState, value: 1)
var previous = initial
func post(_ type: CGEventType, _ point: CGPoint) throws {
  guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                            mouseCursorPosition: point, mouseButton: .left) else {
    throw NSError(domain: "NativeDividerInput", code: 1)
  }
  event.flags = []
  event.setIntegerValueField(.mouseEventClickState, value: 1)
  event.setIntegerValueField(.mouseEventDeltaX, value: Int64((point.x - previous.x).rounded()))
  event.setIntegerValueField(.mouseEventDeltaY, value: Int64((point.y - previous.y).rounded()))
  event.post(tap: .cghidEventTap)
  previous = point
}
func drag() throws {
  try post(.mouseMoved, start)
  usleep(100_000)
  try post(.leftMouseDown, start)
  defer {
    // EOF also releases on a failed assertion or disconnected parent.
    release.post(tap: .cghidEventTap)
    usleep(100_000) // Input pacing; E2E separately requires native/Core terminal evidence.
  }
  usleep(150_000)
  for fraction in [0.5, 1.0, 1.0] {
    try post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * fraction,
                                      y: start.y + (end.y - start.y) * fraction))
    usleep(200_000)
  }
  guard let point = CGEvent(source: nil)?.location,
        abs(point.x - end.x) <= 2, abs(point.y - end.y) <= 2 else {
    throw NSError(domain: "NativeDividerInput", code: 2)
  }
  print("HELD")
  fflush(stdout)
  _ = readLine()
}
try drag()
`;
  let held = false;
  let resolveHeld!: () => void;
  let rejectHeld!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveHeld = resolve; rejectHeld = reject; });
  let complete!: (error: Error | null) => void;
  const completion = new Promise<Error | null>(resolve => { complete = resolve; });
  const child = execFile("/usr/bin/xcrun", ["swift", "-e", script], { timeout: 120_000 }, error => {
    if (!held) rejectHeld(error ?? new Error("Native divider input exited before its held observation"));
    complete(error);
  });
  let output = "";
  child.stdout?.on("data", chunk => {
    output += String(chunk);
    if (!held && output.split(/\r?\n/u).includes("HELD")) { held = true; resolveHeld(); }
  });
  let primaryError: unknown;
  try { await ready; await input.whileDragging?.(); }
  catch (error) { primaryError = error; }
  finally { child.stdin?.end(); }
  const releaseError = await completion;
  if (primaryError && releaseError) throw new AggregateError([primaryError, releaseError], "Divider evidence and input cleanup failed");
  if (releaseError) throw releaseError;
  if (primaryError) throw primaryError;
}
