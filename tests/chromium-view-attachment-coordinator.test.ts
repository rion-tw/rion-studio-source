import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChromiumViewAttachmentCoordinator, type ChromiumViewParentBinding } from
  "../src/electron/main/chromiumViewAttachmentCoordinator";
import type { ChromiumRoleWebContentsViewPort, ChromiumRoleSurfaceParentPort } from "../src/electron/main/chromiumRoleSurfacePorts";

function fixture(platform: "macos" | "windows") {
  const bindings = new Map<object, ChromiumViewParentBinding>();
  const parent = (id: number) => {
    const children: unknown[] = [];
    const events = new EventEmitter();
    const window = { id, isDestroyed: () => false, contentView: {
      addChildView: (view: unknown) => { children.push(view); },
      removeChildView: (view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }
    } };
    const binding: ChromiumViewParentBinding = { parent: window, nativeGeneration: 1, revision: "1",
      children: () => children, contentsFocused: () => false,
      read: () => ({ parentIdentity: String(id).repeat(64), focusIdentity: "a".repeat(64),
        parentForeground: true, parentVisible: true, parentMinimized: false, focusedWebContentsId: null }),
      subscribe: listener => { events.on("event", listener); return () => { events.off("event", listener); }; } };
    bindings.set(window, binding);
    return { window, binding, children, events };
  };
  const view = (id: number) => {
    let visible = false;
    const events = new EventEmitter();
    const contents = { id, isDestroyed: () => false, getZoomFactor: () => 1,
      on: events.on.bind(events), removeListener: events.removeListener.bind(events), sendInputEvent: vi.fn() };
    const value = { webContents: contents, getVisible: () => visible,
      setVisible: (value: boolean) => { visible = value; },
      getBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }) } as unknown as ChromiumRoleWebContentsViewPort;
    return { value, contents, events };
  };
  const source = parent(1);
  const target = parent(2);
  const one = view(11);
  const two = view(12);
  const onError = vi.fn();
  const owner = new ChromiumViewAttachmentCoordinator({ resolveParent: parent => bindings.get(parent) ?? null,
    nowMs: () => 100, onError });
  const attach = (roleId: string, value = one.value) => ({ roleId, generation: 1, parent: source.window,
    view: value, isCancelled: () => false, attach: () => source.window.contentView.addChildView(value),
    attachTo: (parent: ChromiumRoleSurfaceParentPort) => parent.contentView.addChildView(value),
    detach: () => source.window.contentView.removeChildView(value) });
  const move = () => ({ roleId: "one", generation: 1, sourceParent: source.window, targetParent: target.window,
    view: one.value, isCancelled: () => false,
    detachSource: () => source.window.contentView.removeChildView(one.value),
    attachTarget: () => target.window.contentView.addChildView(one.value),
    attachTargetTo: (parent: ChromiumRoleSurfaceParentPort) => parent.contentView.addChildView(one.value),
    detachTarget: () => target.window.contentView.removeChildView(one.value),
    restoreSource: () => source.window.contentView.addChildView(one.value),
    restoreSourceTo: (parent: ChromiumRoleSurfaceParentPort) => parent.contentView.addChildView(one.value) });
  const key = { roleId: "one", surfaceGeneration: 1, requestId: "key", inputEpoch: "1", deadlineMs: "200",
    deliveryMode: "background" as const, eventType: "keyDown" as const, code: "KeyA", repeat: false as const,
    ctrl: platform === "windows", meta: platform === "macos", shift: false, alt: false };
  return { owner, source, target, one, two, attach, move, onError, key, bindings };
}

describe.each(["macos", "windows"] as const)("%s direct View attachment lifetime", platform => {
  it("shares one parent while retaining separate exact View owners", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    await f.owner.attach(f.attach("two", f.two.value));
    expect(f.source.children).toEqual([f.one.value, f.two.value]);
    const one = f.owner.resolve("one", 1)!;
    const two = f.owner.resolve("two", 1)!;
    expect(one.identity.parentIdentity).toBe(two.identity.parentIdentity);
    expect(one.identity.webContentsId).not.toBe(two.identity.webContentsId);
    expect(one.input.key(f.key).status).toBe("submitted");
    await expect(f.owner.attach(f.attach("alias"))).rejects.toThrow();
    expect(f.source.children).toHaveLength(2);
  });

  it("cancels before attachment without mutating the parent", async () => {
    const f = fixture(platform);
    const attachTo = vi.fn();
    await expect(f.owner.attach({ ...f.attach("one"), isCancelled: () => true, attachTo })).rejects.toThrow();
    expect(attachTo).not.toHaveBeenCalled();
    expect(f.source.children).toEqual([]);
    expect(f.owner.resolve("one", 1)).toBeNull();
  });

  it("cleans up listeners and membership if parent subscription fails", async () => {
    const f = fixture(platform);
    f.bindings.set(f.source.window, { ...f.source.binding, subscribe: () => { throw new Error("stream failed"); } });
    await expect(f.owner.attach(f.attach("one"))).rejects.toThrow("stream failed");
    expect(f.source.children).toEqual([]);
    expect(f.one.events.listenerCount("destroyed")).toBe(0);
    f.bindings.set(f.source.window, f.source.binding);
    await f.owner.attach(f.attach("one"));
    expect(f.owner.resolve("one", 1)).not.toBeNull();
  });

  it("rejects a parent revision changed by mutation of the resolver's original object", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    Object.assign(f.source.binding, { revision: "2" });
    expect(f.owner.resolve("one", 1)).toBeNull();
  });

  it("moves only the exact View and invalidates the previous input binding", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    await f.owner.attach(f.attach("two", f.two.value));
    const previous = f.owner.resolve("one", 1)!;
    const move = f.move();
    await f.owner.reparent({ ...move, detachSource: () => {
      move.detachSource();
      f.source.events.emit("event", "changed");
      expect(() => previous.input.key(f.key)).toThrow();
    } });
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.source.children).toEqual([f.two.value]);
    expect(f.target.children).toEqual([f.one.value]);
    expect(() => previous.input.key(f.key)).toThrow();
    expect(f.owner.resolve("one", 1)!.input.key(f.key).status).toBe("submitted");
  });

  it("restores exact source ownership when a target move fails", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    const previous = f.owner.resolve("one", 1)!.identity;
    await expect(f.owner.reparent({ ...f.move(), attachTargetTo: () => { throw new Error("target failed"); } })).rejects.toThrow();
    expect(f.source.children).toEqual([f.one.value]);
    expect(f.target.children).toEqual([]);
    expect(f.owner.resolve("one", 1)!.identity).toEqual(previous);
    expect(f.one.events.listenerCount("destroyed")).toBe(1);
  });

  it("restores source visibility when cancellation arrives during target attachment", async () => {
    const f = fixture(platform);
    f.one.value.setVisible(true);
    await f.owner.attach(f.attach("one"));
    let cancelled = false;
    const move = f.move();
    await expect(f.owner.reparent({ ...move, isCancelled: () => cancelled,
      attachTargetTo: parent => {
        move.attachTargetTo(parent);
        f.one.value.setVisible(false);
        cancelled = true;
      } })).rejects.toThrow();
    expect(f.source.children).toEqual([f.one.value]);
    expect(f.target.children).toEqual([]);
    expect(f.one.value.getVisible()).toBe(true);
    expect(f.owner.resolve("one", 1)).not.toBeNull();
  });

  it("disposal revokes input without taking the registry's Views or shared parent lifetime", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    const prior = f.owner.resolve("one", 1)!;
    await f.owner.dispose();
    expect(() => prior.input.key(f.key)).toThrow();
    expect(f.source.children).toEqual([f.one.value]);
    expect(f.one.events.listenerCount("destroyed")).toBe(0);
    expect(f.source.events.listenerCount("event")).toBe(0);
  });

  it("quarantines only the affected View if source restoration fails", async () => {
    const f = fixture(platform);
    f.one.value.setVisible(true);
    f.two.value.setVisible(true);
    await f.owner.attach(f.attach("one"));
    await f.owner.attach(f.attach("two", f.two.value));
    await expect(f.owner.reparent({ ...f.move(), attachTargetTo: () => { throw new Error("target failed"); },
      restoreSourceTo: () => { throw new Error("restore failed"); } })).rejects.toThrow();
    expect(f.owner.resolve("one", 1)).toBeNull();
    expect(f.one.value.getVisible()).toBe(false);
    expect(f.two.value.getVisible()).toBe(true);
    expect(f.source.children).toEqual([f.two.value]);
    expect(f.owner.resolve("two", 1)).not.toBeNull();
  });

  it("rejects a stale retirement and retires exactly one sibling", async () => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    await f.owner.attach(f.attach("two", f.two.value));
    await expect(f.owner.retire("one", 2, f.source.window)).rejects.toThrow();
    await f.owner.retire("one", 1, f.source.window, { roleId: "one", generation: 1,
      parent: f.source.window, physicalParent: f.source.window, view: f.one.value,
      detach: () => f.source.window.contentView.removeChildView(f.one.value) });
    expect(f.source.children).toEqual([f.two.value]);
    expect(f.owner.resolve("one", 1)).toBeNull();
    expect(f.owner.resolve("two", 1)).not.toBeNull();
    expect(f.one.events.listenerCount("destroyed")).toBe(0);
  });

  it("publishes one exact visibility change for held-input continuity", async () => {
    const f = fixture(platform);
    f.one.value.setVisible(true);
    await f.owner.attach(f.attach("one"));
    const listener = vi.fn();
    f.owner.subscribePresentation(listener);
    f.one.value.setVisible(false);
    const projection = { roleId: "one", generation: 1, parent: f.source.window,
      physicalParent: f.source.window, view: f.one.value };
    f.owner.syncPresentation(projection);
    f.owner.syncPresentation(projection);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ roleId: "one", surfaceGeneration: 1,
      previousVisible: true, visible: false });
  });

  it.each(["closed", "destroyed"])("revokes admission from the exact %s event", async event => {
    const f = fixture(platform);
    await f.owner.attach(f.attach("one"));
    const binding = f.owner.resolve("one", 1)!;
    if (event === "closed") f.source.events.emit("event", "closed");
    else f.one.events.emit("destroyed");
    expect(f.owner.resolve("one", 1)).toBeNull();
    expect(() => binding.input.key(f.key)).toThrow();
    expect(f.onError).toHaveBeenCalledTimes(1);
  });
});
