import { describe, expect, it, vi } from "vitest";
import { submitOwnedChromiumClick, submitOwnedChromiumKey } from
  "../src/electron/main/chromiumOwnedInputSubmission";
import type { RawWindowsChromiumInputHwndProbeReceipt } from
  "../src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator";

function harness(platform: "win32") {
  expect(platform).toBe("win32");
  const identity = { roleId: "role", surfaceGeneration: 3, nativeGeneration: 2,
    bindingRevision: "4", surfaceHandleToken: "a".repeat(64), parentHandleToken: "b".repeat(64) };
  const facts: { -readonly [Key in keyof RawWindowsChromiumInputHwndProbeReceipt]: RawWindowsChromiumInputHwndProbeReceipt[Key] } = {
    abiVersion: 6, ...identity, processId: 42, uiThreadId: 7, parentUiThreadId: 7,
    currentProcessOwned: true, exactParent: true, childWindowStyle: true,
    popupWindowStyleAbsent: true, noActivateStyle: true, foregroundWindowPreserved: true,
    activeWindowPreserved: true, focusWindowPreserved: true, focusIdentity: "c".repeat(64),
    parentWasForeground: true, parentVisible: true, surfaceVisible: true,
    targetWasForeground: false, targetHadThreadFocus: false,
    clientWidth: 1600, clientHeight: 1200, dpi: 192
  };
  let now = 1000;
  const viewport = { width: 300, height: 200 };
  const sendInputEvent = vi.fn();
  const owner = { identity, probeRevision: "5", contents: { sendInputEvent },
    probe: () => ({ ...facts }), viewport: () => ({ ...viewport }), nowMs: () => now };
  const request = { roleId: "role", surfaceGeneration: 3, requestId: "request",
    inputEpoch: "6", deliveryMode: "foreground" as const, deadlineMs: "2000",
    eventType: "keyDown" as const, code: "KeyA", ctrl: false, alt: false,
    shift: false, meta: false, repeat: false as const };
  return { owner, request, facts, viewport, sendInputEvent, setNow: (value: number) => { now = value; } };
}

describe("Windows Chromium submission ownership", () => {
  it("returns submission evidence without claiming DOM completion", () => {
    const h = harness("win32");
    const receipt = submitOwnedChromiumKey(h.owner, h.request);
    expect(receipt).toMatchObject({ status: "submitted", submissionApi: "webContents.sendInputEvent",
      requestId: "request", inputEpoch: "6", probeRevision: "5", foregroundWindowPreserved: true });
    expect(receipt).not.toHaveProperty("keyboardStateRestored");
    expect(h.sendInputEvent).toHaveBeenCalledExactlyOnceWith({ type: "keyDown", keyCode: "A", modifiers: [] });
  });

  it.each(["identity", "deadline", "focus", "visibility"] as const)("rejects stale %s before delivery", kind => {
    const h = harness("win32");
    if (kind === "identity") h.request.surfaceGeneration++;
    if (kind === "deadline") h.setNow(2000);
    if (kind === "focus") h.facts.focusIdentity = "invalid";
    if (kind === "visibility") h.facts.surfaceVisible = false;
    expect(() => submitOwnedChromiumKey(h.owner, h.request)).toThrow();
    expect(h.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(["focus", "viewport", "deadline"] as const)("does not certify a submission after %s changes", kind => {
    const h = harness("win32");
    h.sendInputEvent.mockImplementation(() => {
      if (kind === "focus") h.facts.focusIdentity = "d".repeat(64);
      if (kind === "viewport") h.viewport.width++;
      if (kind === "deadline") h.setNow(2000);
    });
    expect(() => submitOwnedChromiumKey(h.owner, h.request)).toThrow();
    expect(h.sendInputEvent).toHaveBeenCalledTimes(1);
  });

  it("fences mouse-up after a partial delivery changes ownership", () => {
    const h = harness("win32");
    h.sendInputEvent.mockImplementation(() => { h.facts.surfaceHandleToken = "d".repeat(64); });
    expect(() => submitOwnedChromiumClick(h.owner, { ...h.request,
      clientX: 80, clientY: 96, zoomFactor: 1.25, button: 1 })).toThrow();
    expect(h.sendInputEvent).toHaveBeenCalledTimes(1);
    expect(h.sendInputEvent.mock.calls[0]?.[0]).toMatchObject({ type: "mouseDown", x: 100, y: 120 });
  });

  it("delivers hidden input without focus acquisition", () => {
    const h = harness("win32");
    h.facts.surfaceVisible = false;
    expect(submitOwnedChromiumKey(h.owner, { ...h.request, deliveryMode: "background" }))
      .toMatchObject({ surfaceVisible: false, targetHadThreadFocus: false });
  });
});
