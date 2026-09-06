import { describe, expect, it, vi } from "vitest";
import { ChromiumViewInputSubmission, type ChromiumViewInputObservation } from
  "../src/electron/main/chromiumViewInputSubmission";

function fixture(platform: "macos" | "windows", background = true) {
  const identity = { roleId: "role-a", surfaceGeneration: 2, nativeGeneration: 3,
    bindingRevision: "4", parentIdentity: "a".repeat(64), webContentsId: 5 };
  const observation: ChromiumViewInputObservation = {
    identity, focusIdentity: "b".repeat(64), parentForeground: true,
    parentVisible: true, parentMinimized: false, viewAttached: true,
    viewVisible: !background, contentsDestroyed: false, contentsFocused: !background,
    focusedWebContentsId: background ? 6 : 5,
    bounds: { x: 40, y: 36, width: 300, height: 200 }, zoomFactor: 1.25
  };
  let current = observation;
  let now = 100;
  const sendInputEvent = vi.fn();
  const owner = new ChromiumViewInputSubmission({ identity, contents: { sendInputEvent },
    observe: () => current, nowMs: () => now });
  const request = { roleId: identity.roleId, surfaceGeneration: 2, requestId: "request-a",
    inputEpoch: "7", deadlineMs: "200", deliveryMode: background ? "background" as const : "foreground" as const };
  return { owner, request, sendInputEvent, observation,
    key: { ...request, eventType: "keyDown" as const, code: "KeyB", ctrl: platform === "windows",
      meta: platform === "macos", alt: false, shift: true, repeat: false as const },
    click: { ...request, clientX: 80, clientY: 96, zoomFactor: 1.25, button: 1 as const },
    change: (patch: Partial<ChromiumViewInputObservation>) => { current = { ...current, ...patch }; },
    advance: () => { now = 200; }
  };
}

describe.each(["macos", "windows"] as const)("%s exact Chromium View input owner", platform => {
  it.each([true, false])("submits with an honest View receipt (background=%s)", background => {
    const f = fixture(platform, background);
    const key = f.owner.key(f.key);
    const click = f.owner.click(f.click);
    expect(key).toMatchObject({ status: "submitted", dispatchSequence: "1", webContentsId: 5 });
    expect(click).toMatchObject({ dispatchSequence: "2", inputX: 100, inputY: 120,
      expectedDomClientX: 80, expectedDomClientY: 96, dispatchedEventCount: 2 });
    expect(click).not.toHaveProperty("childWindowStyle");
    expect(click).not.toHaveProperty("surfaceHandleToken");
    expect(f.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "keyDown", "mouseDown", "mouseUp"
    ]);
  });

  it.each([
    { viewAttached: false }, { contentsDestroyed: true }, { parentForeground: false },
    { parentVisible: false }, { parentMinimized: true }, { contentsFocused: true },
    { focusedWebContentsId: 5 }, { viewVisible: true }
  ])("rejects invalid admission before any input: %j", patch => {
    const f = fixture(platform);
    f.change(patch);
    expect(() => f.owner.key(f.key)).toThrow();
    expect(f.sendInputEvent).not.toHaveBeenCalled();
  });

  it("rejects a different Role View sharing the same native parent", () => {
    const f = fixture(platform);
    f.change({ identity: { ...f.observation.identity, webContentsId: 6 } });
    expect(() => f.owner.click(f.click)).toThrow();
    expect(f.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(["focus", "binding", "bounds", "deadline"])(
    "does not claim a complete click when %s changes after mouseDown", boundary => {
      const f = fixture(platform);
      f.sendInputEvent.mockImplementationOnce(() => {
        if (boundary === "focus") f.change({ focusIdentity: "c".repeat(64) });
        if (boundary === "binding") f.change({ identity: { ...f.observation.identity, bindingRevision: "5" } });
        if (boundary === "bounds") f.change({ bounds: { ...f.observation.bounds, x: 60 } });
        if (boundary === "deadline") f.advance();
      });
      expect(() => f.owner.click(f.click)).toThrow();
      expect(f.sendInputEvent).toHaveBeenCalledTimes(1);
    }
  );

  it("detects an adapter mutating its prior observation object", () => {
    const f = fixture(platform);
    f.sendInputEvent.mockImplementationOnce(() => {
      Object.assign(f.observation, { focusIdentity: "c".repeat(64) });
    });
    expect(() => f.owner.click(f.click)).toThrow();
    expect(f.sendInputEvent).toHaveBeenCalledTimes(1);
  });

  it("prevents reentrant input from interleaving a click and releases the lane afterward", () => {
    const f = fixture(platform);
    f.sendInputEvent.mockImplementationOnce(() => {
      expect(() => f.owner.key(f.key)).toThrow("already active");
    });
    expect(f.owner.click(f.click).dispatchSequence).toBe("1");
    expect(f.owner.key(f.key).dispatchSequence).toBe("2");
    expect(f.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "mouseDown", "mouseUp", "keyDown"
    ]);
  });

  it("requires zoom agreement and an unexpired request before mouseDown", () => {
    const f = fixture(platform);
    expect(() => f.owner.click({ ...f.click, zoomFactor: 1 })).toThrow();
    f.advance();
    expect(() => f.owner.key(f.key)).toThrow();
    expect(f.sendInputEvent).not.toHaveBeenCalled();
  });
});
