import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChromiumViewAttachmentCoordinator, type ChromiumViewParentBinding } from "../src/electron/main/chromiumViewAttachmentCoordinator";
import { ChromiumViewFocusAdmission } from "../src/electron/main/chromiumViewFocusAdmission";
import type { ChromiumRoleWebContentsViewPort } from "../src/electron/main/chromiumRoleSurfacePorts";
import type { ChromiumNativeTrustedInputRequest } from "../src/electron/main/chromiumTrustedInputCoordinator";

async function fixture(platform: "macos" | "windows", visible = true) {
  const events = new EventEmitter();
  const parentEvents = new EventEmitter();
  const children: unknown[] = [];
  let focused = false;
  let foreground = true;
  let now = 100;
  let deadline = () => {};
  const parent = { id: 1, isDestroyed: () => false, contentView: {
    addChildView: (view: unknown) => { children.push(view); },
    removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1); }
  } };
  const contents = { id: 12, isDestroyed: () => false, getZoomFactor: () => 1,
    isFocused: () => focused, focus: vi.fn(), on: events.on.bind(events), removeListener: events.removeListener.bind(events) };
  const view = { webContents: contents, getVisible: () => visible,
    setVisible: (value: boolean) => { visible = value; },
    getBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }) } as unknown as ChromiumRoleWebContentsViewPort;
  const binding: ChromiumViewParentBinding = { parent, nativeGeneration: 1, revision: "1",
    children: () => children, contentsFocused: () => focused,
    read: () => ({ parentIdentity: "a".repeat(64), focusIdentity: "b".repeat(64),
      parentForeground: foreground, parentVisible: true, parentMinimized: false,
      focusedWebContentsId: focused ? 12 : 13 }),
    subscribe: callback => { parentEvents.on("event", callback); return () => { parentEvents.off("event", callback); }; } };
  const attachments = new ChromiumViewAttachmentCoordinator({ resolveParent: () => binding, nowMs: () => now, onError: vi.fn() });
  await attachments.attach({ roleId: "role", generation: 1, parent, view,
    isCancelled: () => false, attach: () => parent.contentView.addChildView(view),
    attachTo: target => target.contentView.addChildView(view), detach: () => parent.contentView.removeChildView(view) });
  const activateParent = vi.fn();
  const cancel = vi.fn();
  const focus = new ChromiumViewFocusAdmission({ attachments, nowMs: () => now, activateParent,
    deadlines: { schedule: callback => { deadline = callback; return 1; }, cancel } });
  const request: ChromiumNativeTrustedInputRequest = { requestId: platform, roleId: "role", surfaceGeneration: 1,
    inputEpoch: 0, intent: "normal", scheduledAtMs: 100, deadlineMs: 200,
    expectedInputNeutralityBefore: true, expectedInputNeutralityAfter: true, action: { type: "focus" } };
  return { focus, request, events, parentEvents, contents, activateParent, attachments, parent, view, cancel,
    setFocused: (value: boolean) => { focused = value; }, setForeground: (value: boolean) => { foreground = value; },
    expire: () => { now = 200; deadline(); } };
}

describe.each(["macos", "windows"] as const)("%s View focus admission", platform => {
  it("waits for the exact View focus event, not parent activation", async () => {
    const f = await fixture(platform);
    const settled = vi.fn();
    const pending = f.focus.focus(f.request).then(value => { settled(value); return value; });
    f.parentEvents.emit("event", "changed");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(f.contents.focus).toHaveBeenCalledOnce();
    f.setFocused(true);
    f.events.emit("focus");
    expect(await pending).toMatchObject({ status: "applied", inputEpoch: 0 });
    expect(f.events.listenerCount("focus")).toBe(0);
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it("waits for parent focus after its root WebContents restoration", async () => {
    const f = await fixture(platform);
    f.setForeground(false);
    const settled = vi.fn();
    const pending = f.focus.focus(f.request).then(settled);
    // Native readback and a transient View focus cannot replace the parent event.
    f.setForeground(true);
    f.setFocused(true);
    f.events.emit("focus");
    f.parentEvents.emit("event", "changed");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(f.contents.focus).not.toHaveBeenCalled();
    f.setFocused(false);
    f.events.emit("blur");
    f.contents.focus.mockImplementation(() => { f.setFocused(true); f.events.emit("focus"); });
    f.parentEvents.emit("event", "focused");
    await pending;
    expect(f.contents.focus).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }));
  });

  it("defers View focus until a synchronous parent activation callback returns", async () => {
    const f = await fixture(platform);
    f.setForeground(false);
    const order: string[] = [];
    f.activateParent.mockImplementation(() => {
      order.push("parent-start");
      f.setForeground(true);
      f.parentEvents.emit("event", "focused");
      expect(f.contents.focus).not.toHaveBeenCalled();
      order.push("parent-return");
    });
    f.contents.focus.mockImplementation(() => {
      order.push("view-focus");
      f.setFocused(true);
      f.events.emit("focus");
    });
    expect(await f.focus.focus(f.request)).toMatchObject({ status: "applied" });
    expect(order).toEqual(["parent-start", "parent-return", "view-focus"]);
  });

  it("admits a hidden View without selecting or activating it", async () => {
    const f = await fixture(platform, false);
    expect(await f.focus.focus(f.request)).toMatchObject({ status: "applied" });
    expect(f.activateParent).not.toHaveBeenCalled();
    expect(f.contents.focus).not.toHaveBeenCalled();
    f.setForeground(false);
    expect(await f.focus.focus(f.request)).toMatchObject({ status: "failed" });
  });
  it("fails at the Core deadline without treating elapsed time as focus", async () => {
    const f = await fixture(platform);
    const pending = f.focus.focus(f.request);
    f.expire();
    f.setFocused(true);
    f.events.emit("focus");
    expect(await pending).toMatchObject({ status: "failed", errorCode: "SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE" });
  });
  it("supersedes pending focus when the exact attachment retires", async () => {
    const f = await fixture(platform);
    const pending = f.focus.focus(f.request);
    await f.attachments.retire("role", 1, f.parent);
    expect(await pending).toMatchObject({ status: "superseded" });
    expect(f.events.listenerCount("focus")).toBe(0);
  });
  it("supersedes visible focus admission when presentation hides the View", async () => {
    const f = await fixture(platform);
    const pending = f.focus.focus(f.request);
    f.view.setVisible(false);
    f.attachments.syncPresentation({ roleId: "role", generation: 1, parent: f.parent,
      physicalParent: f.parent, view: f.view });
    expect(await pending).toMatchObject({ status: "superseded" });
  });
  it("does not replace an in-flight request and cancels it on disposal", async () => {
    const f = await fixture(platform);
    const pending = f.focus.focus(f.request);
    expect(await f.focus.focus({ ...f.request, requestId: "other" })).toMatchObject({ status: "failed" });
    f.focus.dispose();
    expect(await pending).toMatchObject({ status: "superseded" });
    expect(f.contents.focus).toHaveBeenCalledOnce();
  });
  it("stops before View activation if parent activation retires ownership", async () => {
    const f = await fixture(platform);
    f.activateParent.mockImplementation(() => { void f.attachments.dispose(); });
    expect(await f.focus.focus(f.request)).toMatchObject({ status: "superseded" });
    expect(f.contents.focus).not.toHaveBeenCalled();
  });
});
