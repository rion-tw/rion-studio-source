import { describe, expect, it, vi } from "vitest";

import { maximizeWindowsRuntimeInitialPresentation } from "../src/electron/main/windowsRuntimeInitialPresentation";
import type { WindowsRuntimeHostWindowPort } from "../src/electron/main/windowsRuntimeHostNativePorts";
import { FakeWindow } from "./support/windowsRuntimeHostFactoryFixtures";

function harness() {
  const native = new FakeWindow(7);
  native.visible = true;
  let topologyRevision = 9;
  let current = true;
  const before = { parentIdentity: "a".repeat(64), focusIdentity: "f".repeat(64),
    parentWasForeground: false, parentVisible: true, parentMinimized: false };
  const port = {
    readWindowsRuntimeForeground: vi.fn(() => before),
    maximizeWindowsRuntimeParentInactive: vi.fn(() => {
      native.maximized = true;
      return { ...before };
    })
  };
  const input = {
    native: native as unknown as WindowsRuntimeHostWindowPort,
    nativeHandle: native.getNativeWindowHandle(), port,
    windowId: "window-1", request: { windowId: "window-1", windowGeneration: 4,
      topologyRevision: 9, presentation: "maximized" as const },
    requireCurrent: () => { if (!current) throw new Error("native owner retired"); },
    readCoreFence: () => ({ windowGeneration: 4, topologyRevision })
  };
  return { native, before, port, input,
    supersede: () => { topologyRevision += 1; }, retire: () => { current = false; } };
}

describe("exact initial Windows inactive native submission", () => {
  it("uses native foreground proof for background mode even when the Electron focus flag disagrees", () => {
    const subject = harness();
    subject.native.focused = true;
    maximizeWindowsRuntimeInitialPresentation(subject.input);
    expect(subject.port.maximizeWindowsRuntimeParentInactive).toHaveBeenCalledExactlyOnceWith(
      subject.native.getNativeWindowHandle(), subject.before.parentIdentity);
    expect(subject.native.maximizeCalls).toBe(0);
    expect(subject.native.maximized).toBe(true);
  });

  it("preserves the existing maximize path for the exact native foreground parent", () => {
    const subject = harness();
    subject.before.parentWasForeground = true;
    subject.native.focused = false;
    maximizeWindowsRuntimeInitialPresentation(subject.input);
    expect(subject.native.maximizeCalls).toBe(1);
    expect(subject.port.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
  });

  it.each(["revision", "owner"] as const)("revalidates %s immediately before native mutation", changed => {
    const subject = harness();
    subject.port.readWindowsRuntimeForeground.mockImplementation(() => {
      if (changed === "revision") subject.supersede();
      else subject.retire();
      return subject.before;
    });
    expect(() => maximizeWindowsRuntimeInitialPresentation(subject.input)).toThrow();
    expect(subject.port.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    expect(subject.native.maximizeCalls).toBe(0);
  });

  it("keeps refused native submission terminal with no activating fallback", () => {
    const subject = harness();
    subject.port.maximizeWindowsRuntimeParentInactive.mockImplementation(() => {
      throw new Error("native hook install refused");
    });
    expect(() => maximizeWindowsRuntimeInitialPresentation(subject.input)).toThrow("native hook install refused");
    expect(subject.native.maximizeCalls).toBe(0);
    expect(subject.native.maximized).toBe(false);
  });

  it("refuses a changed raw HWND under the same Electron object before native mutation", () => {
    const subject = harness();
    subject.port.readWindowsRuntimeForeground.mockImplementation(() => {
      vi.spyOn(subject.native, "getNativeWindowHandle").mockReturnValue(new FakeWindow(8).getNativeWindowHandle());
      return subject.before;
    });
    expect(() => maximizeWindowsRuntimeInitialPresentation(subject.input)).toThrow("exact visible Core-owned host");
    expect(subject.port.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    expect(subject.native.maximizeCalls).toBe(0);
  });

  it.each(["parentIdentity", "focusIdentity", "parentWasForeground"] as const)("refuses changed native %s acknowledgement", changed => {
    const subject = harness();
    subject.port.maximizeWindowsRuntimeParentInactive.mockImplementation(() => ({
      ...subject.before, [changed]: changed === "parentWasForeground" ? true : "b".repeat(64)
    }));
    expect(() => maximizeWindowsRuntimeInitialPresentation(subject.input)).toThrow("changed its native parent or focus identity");
    expect(subject.native.maximizeCalls).toBe(0);
  });

  it("fails when the exact inactive native lane is unavailable", () => {
    const subject = harness();
    expect(() => maximizeWindowsRuntimeInitialPresentation({ ...subject.input, port: null })).toThrow("inactive presentation lane is unavailable");
    expect(subject.native.maximizeCalls).toBe(0);
  });

  it("refuses matching unadmitted zero Core fences before native observation", () => {
    const subject = harness();
    expect(() => maximizeWindowsRuntimeInitialPresentation({ ...subject.input,
      request: { ...subject.input.request, windowGeneration: 0, topologyRevision: 0 },
      readCoreFence: () => ({ windowGeneration: 0, topologyRevision: 0 })
    })).toThrow("exact visible Core-owned host");
    expect(subject.port.readWindowsRuntimeForeground).not.toHaveBeenCalled();
    expect(subject.port.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    expect(subject.native.maximizeCalls).toBe(0);
  });
});
