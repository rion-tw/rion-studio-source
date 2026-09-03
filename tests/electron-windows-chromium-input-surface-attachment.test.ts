import { describe, expect, it, vi } from "vitest";

import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import {
  WindowsChromiumInputSurfaceAttachmentCoordinator,
  type RawWindowsChromiumInputHwndProbeReceipt,
  type WindowsChromiumInputBaseWindowPort,
  type WindowsChromiumInputRuntimeParentBinding
} from "../src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator";

type HostEvent = "move" | "resize" | "show" | "hide" | "minimize" |
  "restore" | "focus" | "blur" | "closed";

class FakeWindow implements WindowsChromiumInputBaseWindowPort {
  readonly contentView = {
    children: [] as unknown[],
    addChildView: (view: ChromiumRoleWebContentsViewPort) => {
      if (this.contentView.children.includes(view)) throw new Error("duplicate child");
      this.contentView.children.push(view);
    },
    removeChildView: (view: ChromiumRoleWebContentsViewPort) => {
      const index = this.contentView.children.indexOf(view);
      if (index < 0) throw new Error("missing child");
      this.contentView.children.splice(index, 1);
    }
  };
  readonly #listeners = new Map<HostEvent, Set<() => void>>();
  focusCalls = 0;
  showCalls = 0;
  #bounds: ChromiumRoleSurfaceBounds;
  #destroyed = false;
  #focused = false;
  #visible: boolean;

  constructor(
    readonly id: number,
    bounds: ChromiumRoleSurfaceBounds,
    visible: boolean
  ) {
    this.#bounds = { ...bounds };
    this.#visible = visible;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#visible = false;
    this.emit("closed");
  }

  emit(event: HostEvent): void {
    for (const listener of this.#listeners.get(event) ?? []) listener();
  }

  focus(): void {
    this.focusCalls += 1;
    this.#focused = true;
    this.emit("focus");
  }

  getBounds(): ChromiumRoleSurfaceBounds {
    return { ...this.#bounds };
  }

  getContentBounds(): ChromiumRoleSurfaceBounds {
    return { ...this.#bounds };
  }

  getNativeWindowHandle(): Buffer {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(this.id));
    return handle;
  }

  hide(): void {
    this.#visible = false;
    this.#focused = false;
  }

  isFocused(): boolean {
    return this.#focused;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  isVisible(): boolean {
    return this.#visible;
  }

  on(event: HostEvent, listener: () => void): unknown {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  removeListener(event: HostEvent, listener: () => void): unknown {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  setBounds(bounds: ChromiumRoleSurfaceBounds): void {
    this.#bounds = { ...bounds };
  }

  setContentBounds(bounds: ChromiumRoleSurfaceBounds): void {
    this.#bounds = { ...bounds };
  }

  show(): void {
    this.showCalls += 1;
    this.#visible = true;
  }

  showInactive(): void {
    this.#visible = true;
  }
}

function token(buffer: Buffer, domain: number): string {
  const value = buffer.readBigUInt64LE() * 2n + BigInt(domain);
  return value.toString(16).padStart(64, "0");
}

function probe(
  surfaceHandle: Buffer,
  parentHandle: Buffer
): RawWindowsChromiumInputHwndProbeReceipt {
  return {
    abiVersion: 3,
    surfaceHandleToken: token(surfaceHandle, 0),
    parentHandleToken: token(parentHandle, 1),
    processId: 42,
    uiThreadId: 7,
    parentUiThreadId: 7,
    currentProcessOwned: true,
    exactParent: true,
    childWindowStyle: true,
    popupWindowStyleAbsent: true,
    noActivateStyle: true,
    foregroundWindowPreserved: true,
    activeWindowPreserved: true,
    focusWindowPreserved: true,
    parentWasForeground: false,
    parentVisible: true,
    surfaceVisible: false,
    targetWasForeground: false,
    targetHadThreadFocus: false,
    clientWidth: 800,
    clientHeight: 600,
    dpi: 144
  };
}

function fakeView(
  initialBounds: ChromiumRoleSurfaceBounds = { x: 20, y: 30, width: 300, height: 200 }
): ChromiumRoleWebContentsViewPort {
  let bounds = { ...initialBounds };
  let visible = true;
  return {
    webContents: {} as ChromiumRoleWebContentsViewPort["webContents"],
    getBounds: () => ({ ...bounds }),
    getVisible: () => visible,
    setBounds: (next) => { bounds = { ...next }; },
    setVisible: (next) => { visible = next; }
  };
}

function harness() {
  const parentA = new FakeWindow(1, { x: 10, y: 20, width: 800, height: 600 }, true);
  const parentB = new FakeWindow(2, { x: 100, y: 200, width: 900, height: 700 }, true);
  const bindings = new Map<ChromiumRoleSurfaceParentPort,
    WindowsChromiumInputRuntimeParentBinding>([
      [parentA, {
        identity: { nativeGeneration: 11, ownerRevision: "1" },
        logicalParent: parentA,
        window: parentA
      }],
      [parentB, {
        identity: { nativeGeneration: 12, ownerRevision: "2" },
        logicalParent: parentB,
        window: parentB
      }]
    ]);
  const children: FakeWindow[] = [];
  const windowsById = new Map<number, FakeWindow>([
    [parentA.id, parentA],
    [parentB.id, parentB]
  ]);
  const keyRequests: Record<string, unknown>[] = [];
  const mouseRequests: Record<string, unknown>[] = [];
  let nextChildId = 100;
  let nativeForegroundOverride: boolean | undefined;
  const onError = vi.fn();
  let nowMs = 1_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const coordinator = new WindowsChromiumInputSurfaceAttachmentCoordinator({
    addon: {
      windowsChromiumInputProbeAbiVersion: () => 3,
      probeWindowsChromiumInputHwnd: (surfaceHandle, parentHandle) => {
        const receipt = probe(surfaceHandle, parentHandle);
        const child = windowsById.get(Number(surfaceHandle.readBigUInt64LE()))!;
        const parent = windowsById.get(Number(parentHandle.readBigUInt64LE()))!;
        const bounds = child.getContentBounds();
        const deviceScale = receipt.dpi / 96;
        return {
          ...receipt,
          parentWasForeground: nativeForegroundOverride ?? parent.isFocused(),
          parentVisible: parent.isVisible(),
          surfaceVisible: child.isVisible(),
          clientWidth: Math.round(bounds.width * deviceScale),
          clientHeight: Math.round(bounds.height * deviceScale)
        };
      },
      submitWindowsChromiumBackgroundKey: (_surface, _parent, requestJson) => {
        keyRequests.push(JSON.parse(requestJson) as Record<string, unknown>);
        return JSON.stringify({ status: "submitted", kind: "key" });
      },
      submitWindowsChromiumBackgroundMouse: (_surface, _parent, requestJson) => {
        mouseRequests.push(JSON.parse(requestJson) as Record<string, unknown>);
        return JSON.stringify({ status: "submitted", kind: "mouse" });
      }
    },
    baseWindows: {
      create: (options) => {
        expect(options.focusable).toBe(false);
        expect(options.transparent).toBe(true);
        expect(options.parent).toBeInstanceOf(FakeWindow);
        const child = new FakeWindow(
          nextChildId++,
          { x: 0, y: 0, width: 1, height: 1 },
          false
        );
        children.push(child);
        windowsById.set(child.id, child);
        return child;
      }
    },
    deadlines: {
      schedule: (callback) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      cancel: (handle) => {
        if (typeof handle === "number") timers.delete(handle);
      }
    },
    nowMs: () => nowMs,
    parents: { resolve: (parent) => bindings.get(parent) ?? null },
    onError
  });

  const view = fakeView();
  let physicalParent: ChromiumRoleSurfaceParentPort | null = null;
  const attach = (parent = parentA, generation = 3) => coordinator.attach({
    roleId: "role-1",
    generation,
    parent,
    isCancelled: () => false,
    view,
    attach: () => {
      parent.contentView.addChildView(view);
      physicalParent = parent;
    },
    attachTo: (target) => {
      target.contentView.addChildView(view);
      physicalParent = target;
    },
    detach: () => {
      if (!physicalParent) throw new Error("missing physical parent");
      physicalParent.contentView.removeChildView(view);
      physicalParent = null;
    }
  });

  return {
    attach,
    bindings,
    children,
    coordinator,
    keyRequests,
    mouseRequests,
    onError,
    parentA,
    parentB,
    physicalParent: () => physicalParent,
    setPhysicalParent: (parent: ChromiumRoleSurfaceParentPort | null) => {
      physicalParent = parent;
    },
    setNowMs: (value: number) => { nowMs = value; },
    setNativeForeground: (value: boolean | undefined) => {
      nativeForegroundOverride = value;
    },
    timers,
    view
  };
}

describe("Windows Chromium input child-host ownership", () => {
  it("owns one exact child per surface and emits fenced native requests", async () => {
    const subject = harness();
    await subject.attach();

    const child = subject.children[0]!;
    expect(subject.physicalParent()).toBe(child);
    expect(child.contentView.children).toEqual([subject.view]);
    expect(child.getBounds()).toEqual(subject.parentA.getContentBounds());
    expect(child.isVisible()).toBe(true);

    const binding = subject.coordinator.resolve("role-1", 3)!;
    expect(subject.coordinator.resolve("role-1", 2)).toBeNull();
    subject.parentA.focus();
    const nativeProbe = binding.native.probeExactInputSurface(
      binding.identity,
      "foreground"
    );
    expect(nativeProbe).toEqual(expect.objectContaining({
      status: "verified",
      singleWebContentsSurface: true,
      parentWasForeground: true,
      dpi: 144,
      clientWidth: 1200,
      clientHeight: 900
    }));

    binding.native.submitNativeBackgroundKey(binding.identity, {
      requestId: "request-1",
      roleId: "role-1",
      surfaceGeneration: 3,
      inputEpoch: "4",
      deadlineMs: "9999999999999",
      deliveryMode: "foreground",
      eventType: "keyDown",
      code: "KeyA",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      repeat: false
    });
    binding.native.submitNativeBackgroundMouse(binding.identity, {
      requestId: "request-2",
      roleId: "role-1",
      surfaceGeneration: 3,
      inputEpoch: "5",
      deadlineMs: "9999999999999",
      deliveryMode: "foreground",
      clientX: 4,
      clientY: 5,
      zoomFactor: 1.25,
      button: 0
    });
    expect(subject.keyRequests[0]).toEqual(expect.objectContaining({
      roleId: "role-1",
      nativeGeneration: binding.identity.nativeGeneration,
      probeRevision: nativeProbe.probeRevision
    }));
    expect(subject.mouseRequests[0]).toEqual(expect.objectContaining({
      nativeOriginX: 20,
      nativeOriginY: 30
    }));
  });

  it("settles foreground focus only from exact native focus readback", async () => {
    const subject = harness();
    await subject.attach();
    const binding = subject.coordinator.resolve("role-1", 3)!;
    const receipt = await binding.native.focusForeground(binding.identity, {
      requestId: "focus-1",
      roleId: "role-1",
      inputEpoch: 1,
      intent: "normal",
      scheduledAtMs: 900,
      deadlineMs: 2_000,
      surfaceGeneration: 3,
      expectedInputNeutralityBefore: true,
      expectedInputNeutralityAfter: true,
      action: { type: "focus" }
    });
    expect(receipt).toMatchObject({
      requestId: "focus-1",
      status: "applied",
      confirmedInputNeutrality: true
    });
    expect(subject.parentA.isFocused()).toBe(true);
    expect(binding.native.isInputReady(binding.identity, "foreground")).toBe(true);
    expect(subject.timers.size).toBe(0);
  });

  it("reports an exact visible-to-hidden transition without showing or focusing target", async () => {
    const subject = harness();
    await subject.attach();
    subject.parentA.focus();
    const transitions: unknown[] = [];
    const unsubscribe = subject.coordinator.subscribePresentation((event) => {
      transitions.push(event);
    });
    subject.view.setVisible(false);
    subject.coordinator.syncPresentation({
      roleId: "role-1",
      generation: 3,
      parent: subject.parentA,
      physicalParent: subject.children[0]!,
      view: subject.view
    });
    const binding = subject.coordinator.resolve("role-1", 3)!;
    expect(binding.native.currentInputDeliveryMode(binding.identity)).toBe("background");
    expect(binding.native.probeExactInputSurface(
      binding.identity,
      "background"
    )).toMatchObject({
      deliveryMode: "background",
      parentVisible: true,
      surfaceVisible: false,
      targetWasForeground: false,
      targetHadThreadFocus: false
    });
    expect(subject.children[0]!.isVisible()).toBe(false);
    expect(subject.parentA.isFocused()).toBe(true);
    expect(transitions).toEqual([{
      roleId: "role-1",
      surfaceGeneration: 3,
      previousVisible: true,
      visible: false
    }]);
    unsubscribe();
  });

  it("admits hidden input context without showing or focusing the target", async () => {
    const subject = harness();
    await subject.attach();
    subject.parentA.focus();
    subject.view.setVisible(false);
    subject.coordinator.syncPresentation({
      roleId: "role-1",
      generation: 3,
      parent: subject.parentA,
      physicalParent: subject.children[0]!,
      view: subject.view
    });
    const binding = subject.coordinator.resolve("role-1", 3)!;
    const focusCalls = subject.parentA.focusCalls;
    const showCalls = subject.parentA.showCalls;
    const receipt = await binding.native.focusForeground(binding.identity, {
      requestId: "background-admission-1",
      roleId: "role-1",
      inputEpoch: 2,
      intent: "normal",
      scheduledAtMs: 900,
      deadlineMs: 2_000,
      surfaceGeneration: 3,
      expectedInputNeutralityBefore: true,
      expectedInputNeutralityAfter: true,
      action: { type: "focus" }
    });

    expect(receipt).toMatchObject({
      requestId: "background-admission-1",
      status: "applied",
      confirmedInputNeutrality: true
    });
    expect(subject.view.getVisible()).toBe(false);
    expect(subject.children[0]!.isVisible()).toBe(false);
    expect(subject.parentA.isFocused()).toBe(true);
    expect(subject.parentA.focusCalls).toBe(focusCalls);
    expect(subject.parentA.showCalls).toBe(showCalls);
    expect(binding.native.isInputReady(binding.identity, "background")).toBe(true);
    expect(subject.timers.size).toBe(0);
  });

  it("fails focus when Electron focus lacks exact native foreground ownership", async () => {
    const subject = harness();
    await subject.attach();
    subject.setNativeForeground(false);
    const binding = subject.coordinator.resolve("role-1", 3)!;
    const result = binding.native.focusForeground(binding.identity, {
      requestId: "focus-native-mismatch",
      roleId: "role-1",
      inputEpoch: 1,
      intent: "normal",
      scheduledAtMs: 900,
      deadlineMs: 2_000,
      surfaceGeneration: 3,
      expectedInputNeutralityBefore: true,
      expectedInputNeutralityAfter: true,
      action: { type: "focus" }
    });
    expect(subject.parentA.isFocused()).toBe(true);
    expect(binding.native.isInputReady(binding.identity, "foreground")).toBe(false);
    expect(subject.timers).toHaveLength(1);
    [...subject.timers.values()][0]!();
    await expect(result).resolves.toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE",
      confirmedInputNeutrality: true
    }));
    expect(subject.keyRequests).toEqual([]);
    expect(subject.mouseRequests).toEqual([]);
  });

  it("rejects duplicate replay and stale parent generations", async () => {
    const subject = harness();
    await subject.attach();
    await expect(subject.attach()).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_INPUT_OWNERSHIP_CONFLICT"
    });
    const prior = subject.bindings.get(subject.parentA)!;
    subject.bindings.set(subject.parentA, {
      identity: {
        nativeGeneration: prior.identity.nativeGeneration + 1,
        ownerRevision: "3"
      },
      logicalParent: subject.parentA,
      window: subject.parentA
    });
    expect(subject.coordinator.resolve("role-1", 3)).toBeNull();
  });

  it("moves the exact view across fresh child hosts and retires the old host", async () => {
    const subject = harness();
    await subject.attach();
    const source = subject.children[0]!;
    const before = subject.coordinator.resolve("role-1", 3)!;

    await subject.coordinator.reparent({
      roleId: "role-1",
      generation: 3,
      sourceParent: subject.parentA,
      targetParent: subject.parentB,
      isCancelled: () => false,
      view: subject.view,
      detachSource: () => {
        subject.physicalParent()!.contentView.removeChildView(subject.view);
        subject.setPhysicalParent(null);
      },
      attachTarget: () => { throw new Error("logical attach is forbidden"); },
      attachTargetTo: (target) => {
        target.contentView.addChildView(subject.view);
        subject.setPhysicalParent(target);
      },
      detachTarget: () => {
        subject.physicalParent()!.contentView.removeChildView(subject.view);
        subject.setPhysicalParent(null);
      },
      restoreSource: () => { throw new Error("logical restore is forbidden"); },
      restoreSourceTo: (target) => {
        target.contentView.addChildView(subject.view);
        subject.setPhysicalParent(target);
      }
    });

    const target = subject.children[1]!;
    expect(source.isDestroyed()).toBe(true);
    expect(target.contentView.children).toEqual([subject.view]);
    expect(target.getBounds()).toEqual(subject.parentB.getContentBounds());
    const after = subject.coordinator.resolve("role-1", 3)!;
    expect(after.identity.nativeGeneration).toBeGreaterThan(
      before.identity.nativeGeneration
    );
    expect(after.identity.parentHandleToken).not.toBe(before.identity.parentHandleToken);
  });

  it("tracks authoritative parent bounds events and quarantines surface aliases", async () => {
    const subject = harness();
    await subject.attach();
    const binding = subject.coordinator.resolve("role-1", 3)!;
    subject.parentA.focus();
    const priorRevision = binding.native.probeExactInputSurface(
      binding.identity,
      "foreground"
    ).probeRevision;
    subject.parentA.setContentBounds({ x: 30, y: 40, width: 700, height: 500 });
    subject.parentA.emit("resize");
    expect(subject.children[0]!.getBounds()).toEqual({
      x: 30, y: 40, width: 700, height: 500
    });
    const nextRevision = binding.native.probeExactInputSurface(
      binding.identity,
      "foreground"
    ).probeRevision;
    expect(BigInt(nextRevision)).toBeGreaterThan(BigInt(priorRevision));

    subject.children[0]!.contentView.children.push({});
    expect(subject.coordinator.resolve("role-1", 3)).toBeNull();
  });

  it("retires only through the exact physical owner receipt", async () => {
    const subject = harness();
    await subject.attach();
    const child = subject.children[0]!;
    await expect(subject.coordinator.retire(
      "role-1",
      4,
      subject.parentA
    )).rejects.toMatchObject({ code: "ELECTRON_WINDOWS_INPUT_RETIRE_STALE" });

    await subject.coordinator.retire("role-1", 3, subject.parentA, {
      roleId: "role-1",
      generation: 3,
      parent: subject.parentA,
      physicalParent: child,
      view: subject.view,
      detach: () => {
        child.contentView.removeChildView(subject.view);
        subject.setPhysicalParent(null);
      }
    });
    expect(child.isDestroyed()).toBe(true);
    expect(subject.coordinator.resolve("role-1", 3)).toBeNull();
    expect(subject.onError).not.toHaveBeenCalled();
  });
});
