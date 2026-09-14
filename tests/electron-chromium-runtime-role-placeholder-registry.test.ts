import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_ROLE_PLACEHOLDER_CHANNEL,
  RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION,
  type RuntimeRolePlaceholderClaimReceipt,
  type RuntimeRolePlaceholderState
} from "../src/shared/runtimeRolePlaceholder";
import {
  ChromiumRuntimeRolePlaceholderRegistry,
  type ChromiumRuntimeRolePlaceholderDescriptor,
  type ChromiumRuntimeRolePlaceholderIpcEvent
} from "../src/electron/main/chromiumRuntimeRolePlaceholderRegistry";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";
import type {
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";

function testDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeContents implements ChromiumRoleSurfaceWebContentsPort {
  readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>();
  readonly sent: Array<readonly [string, ...unknown[]]> = [];
  readonly session: ChromiumRoleSessionPort;
  url = "";
  destroyed = false;
  autoFinishLoad = true;
  readonly loadStarted = testDeferred<void>();

  constructor(session: ChromiumRoleSessionPort) {
    this.session = session;
  }

  close(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  getURL(): string { return this.url; }
  getZoomFactor(): number { return 1; }
  isAudioMuted(): boolean { return false; }
  isCurrentlyAudible(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  loadURL(url: string): Promise<void> {
    this.url = url;
    this.loadStarted.resolve();
    if (this.autoFinishLoad) queueMicrotask(() => this.emit("did-finish-load"));
    return Promise.resolve();
  }

  reload(): void {}
  on<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ): unknown {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...arguments_: never[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }
  removeListener<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ): unknown {
    this.listeners.get(event)?.delete(listener as (...arguments_: never[]) => void);
    return this;
  }
  send(channel: string, ...arguments_: unknown[]): void {
    this.sent.push([channel, ...arguments_]);
  }
  setWindowOpenHandler(): void {}
  setAudioMuted(): void {}
  setZoomFactor(): void {}

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...arguments_);
    }
  }
}

class FakeView implements ChromiumRoleWebContentsViewPort {
  readonly setBackgroundColor = vi.fn();
  bounds = { x: 0, y: 0, width: 1, height: 1 };
  visible = false;
  setBoundsCount = 0;
  setVisibleCount = 0;
  constructor(readonly webContents: FakeContents) {}
  getBounds() { return { ...this.bounds }; }
  getVisible() { return this.visible; }
  setBounds(bounds: typeof this.bounds) {
    this.setBoundsCount += 1;
    this.bounds = { ...bounds };
  }
  setVisible(visible: boolean) {
    this.setVisibleCount += 1;
    this.visible = visible;
  }
}

function harness(storagePath: string | null = null, autoFinishLoad = true) {
  const documentPath = resolve("/bundle/runtime-role-placeholder-electron.html");
  const session = { storagePath } as unknown as ChromiumRoleSessionPort;
  const views: FakeView[] = [];
  let handler: ((event: ChromiumRuntimeRolePlaceholderIpcEvent, value: unknown) => unknown) |
    undefined;
  const claim = vi.fn(async (
    state: RuntimeRolePlaceholderState
  ): Promise<RuntimeRolePlaceholderClaimReceipt> => ({
    generation: state.generation,
    ownerGeneration: state.ownerGeneration,
    placeholderId: state.placeholderId,
    roleId: state.roleId,
    slotId: state.slotId,
    status: "applied",
    tabId: state.tabId,
    topologyRevision: state.topologyRevision,
    windowGeneration: state.windowGeneration,
    windowId: state.windowId
  }));
  const onError = vi.fn();
  const attached: string[] = [];
  const detached: string[] = [];
  const nativeDetach = new Map<string, () => void>();
  const failAttachForHost = new Set<number>();
  const registry = new ChromiumRuntimeRolePlaceholderRegistry({
    claim,
    onError,
    nativeAttachments: {
      attachNonInputSurface: async (input) => {
        attached.push(input.surfaceId);
        nativeDetach.set(input.surfaceId, input.detach);
        input.attach();
        if (failAttachForHost.delete(input.parent.id)) {
          throw new Error("native attach readback failed");
        }
      },
      detachNonInputSurface: async (surfaceId) => {
        detached.push(surfaceId);
        nativeDetach.get(surfaceId)?.();
        nativeDetach.delete(surfaceId);
      }
    },
    shell: {
      documentPath,
      ipcMain: {
        handle: (channel, listener) => {
          expect(channel).toBe(RUNTIME_ROLE_PLACEHOLDER_CHANNEL);
          handler = listener;
        },
        removeHandler: () => { handler = undefined; }
      },
      preloadPath: resolve("/bundle/workspaceWebChrome.cjs"),
      session,
      sessionIdentity: RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION
    },
    views: {
      create: () => {
        const view = new FakeView(new FakeContents(session));
        view.webContents.autoFinishLoad = autoFinishLoad;
        views.push(view);
        return view;
      }
    }
  });
  const host = {
    id: 41,
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn((view: ChromiumRoleWebContentsViewPort) => {
        expect(views).toContain(view);
      })
    },
    isDestroyed: () => false
  };
  const descriptor = (
    revision = 7,
    parent = host
  ): ChromiumRuntimeRolePlaceholderDescriptor => ({
    bounds: { x: 20, y: 30, width: 420, height: 300 },
    ownerGeneration: 9,
    ownerTabName: "Source workspace",
    parent,
    placeholderId: "role-placeholder:tab-target:slot-shared",
    roleId: "role-shared",
    roleName: "Shared Role",
    slotId: "slot-shared",
    tabId: "tab-target",
    topologyRevision: revision,
    visible: true,
    windowGeneration: 3,
    windowId: "window-target"
  });
  return {
    attached,
    onError,
    claim,
    descriptor,
    detached,
    failAttachForHost,
    host,
    invoke: (sender: object, value: unknown) => handler?.({ sender }, value),
    registry,
    views
  };
}

describe("ChromiumRuntimeRolePlaceholderRegistry", () => {
  it("attaches a sandboxed local placeholder through the retained native host", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const evidence = subject.registry.readEvidence(subject.descriptor().placeholderId);
    expect(evidence).toEqual(expect.objectContaining({
      blocked: true,
      bounds: subject.descriptor().bounds,
      nativeHostId: 41,
      ownerGeneration: 9,
      shellSession: RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION,
      shellStoragePath: null,
      topologyRevision: 7,
      visible: true
    }));
    expect(evidence.shellUrl).toBe(pathToFileURL(
      resolve("/bundle/runtime-role-placeholder-electron.html")
    ).href);
    expect(subject.attached).toEqual([subject.descriptor().placeholderId]);
    expect(subject.views[0]?.webContents.sent).toHaveLength(1);
    await subject.registry.dispose();
    expect(subject.detached).toEqual([subject.descriptor().placeholderId]);
  });

  it("returns state to its exact sender and accepts one revision-fenced claim", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const sender = subject.views[0]!.webContents;
    const state = await subject.invoke(sender, { type: "ready" }) as
      RuntimeRolePlaceholderState;
    expect(state).toEqual(expect.objectContaining({
      generation: 1,
      ownerGeneration: 9,
      topologyRevision: 7
    }));
    const receipt = await subject.invoke(sender, {
      generation: state.generation,
      ownerGeneration: state.ownerGeneration,
      placeholderId: state.placeholderId,
      roleId: state.roleId,
      slotId: state.slotId,
      tabId: state.tabId,
      topologyRevision: state.topologyRevision,
      type: "claim",
      windowGeneration: state.windowGeneration,
      windowId: state.windowId
    });
    expect(receipt).toEqual(expect.objectContaining({ status: "applied" }));
    expect(subject.claim).toHaveBeenCalledWith(state);
    await subject.registry.dispose();
  });

  it("does not rewrite native geometry for an unchanged or owner-name-only projection", async () => {
    const subject = harness();
    const initial = subject.descriptor();
    await subject.registry.reconcile([initial]);
    const view = subject.views[0]!;
    expect([view.setBoundsCount, view.setVisibleCount]).toEqual([1, 1]);
    expect(view.webContents.sent).toHaveLength(1);

    await subject.registry.reconcile([subject.descriptor()]);
    expect([view.setBoundsCount, view.setVisibleCount]).toEqual([1, 1]);
    expect(view.webContents.sent).toHaveLength(1);

    await subject.registry.reconcile([{
      ...subject.descriptor(8),
      ownerTabName: null
    }]);
    expect([view.setBoundsCount, view.setVisibleCount]).toEqual([1, 1]);
    expect(view.webContents.sent).toHaveLength(2);
    expect(view.webContents.sent.at(-1)?.[1]).toEqual(expect.objectContaining({
      ownerTabName: null,
      topologyRevision: 8
    }));
    await subject.registry.dispose();
  });

  it("rejects stale owner/revision actions and an aliased sender", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const sender = subject.views[0]!.webContents;
    const state = await subject.invoke(sender, { type: "ready" }) as
      RuntimeRolePlaceholderState;
    await subject.registry.reconcile([subject.descriptor(8)]);
    await expect(Promise.resolve(subject.invoke(sender, {
      generation: state.generation,
      ownerGeneration: state.ownerGeneration,
      placeholderId: state.placeholderId,
      roleId: state.roleId,
      slotId: state.slotId,
      tabId: state.tabId,
      topologyRevision: state.topologyRevision,
      type: "claim",
      windowGeneration: state.windowGeneration,
      windowId: state.windowId
    }))).rejects.toMatchObject({ code: "ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE" });
    await expect(Promise.resolve(subject.invoke({}, { type: "ready" })))
      .rejects.toMatchObject({ code: "ELECTRON_ROLE_PLACEHOLDER_ACTION_UNAUTHORIZED" });
    expect(subject.claim).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });

  it("waits for activation when ready arrives at DOMContentLoaded", async () => {
    const subject = harness(null, false);
    const creation = subject.registry.reconcile([subject.descriptor()]);
    await creation;
    const contents = subject.views[0]!.webContents;
    contents.autoFinishLoad = false;
    await contents.loadStarted.promise;
    const ready = Promise.resolve(subject.invoke(contents, { type: "ready" }));
    const settled = vi.fn();
    void ready.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    contents.emit("did-finish-load");
    await creation;
    await expect(ready).resolves.toMatchObject({ generation: 1 });
    expect(subject.onError).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });

  it.each(["close", "load-failure"])("terminalizes pending ready on %s", async (failure) => {
    const subject = harness(null, false);
    const creation = subject.registry.reconcile([subject.descriptor()]);
    await creation;
    const contents = subject.views[0]!.webContents;
    contents.autoFinishLoad = false;
    await contents.loadStarted.promise;
    const ready = Promise.resolve(subject.invoke(contents, { type: "ready" }));
    const rejected = expect(ready).rejects.toBeInstanceOf(Error);
    await expect(creation).resolves.toBeUndefined();
    if (failure === "close") contents.close();
    else contents.emit("did-fail-load", {}, -2, "failed", contents.url, true);
    await rejected;

    expect(subject.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('"action":"ready"')
    }));
    await subject.registry.dispose();
  });

  it("keeps a released slot claimable without trusting its former owner", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const contents = subject.views[0]!.webContents;
    const old = await subject.invoke(contents, { type: "ready" }) as RuntimeRolePlaceholderState;
    await subject.registry.reconcile([{
      ...subject.descriptor(8), ownerGeneration: null, ownerTabName: null
    }]);
    const next = await subject.invoke(contents, { type: "ready" }) as RuntimeRolePlaceholderState;
    const action = (state: RuntimeRolePlaceholderState) => {
      const { blocked: _blocked, ownerTabName: _name, roleName: _role, ...identity } = state;
      return { ...identity, type: "claim" };
    };
    expect(next).toMatchObject({ blocked: true, ownerGeneration: null, ownerTabName: null });
    await expect(Promise.resolve(subject.invoke(contents, action(old))))
      .rejects.toMatchObject({ code: "ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE" });
    await expect(Promise.resolve(subject.invoke(contents, action(next))))
      .resolves.toMatchObject({ status: "applied", ownerGeneration: null });
    expect(subject.claim).toHaveBeenCalledExactlyOnceWith(next);
    await subject.registry.dispose();
  });

  it("coalesces claims through layout updates and allows manual retry after failure", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const contents = subject.views[0]!.webContents;
    const pending = testDeferred<RuntimeRolePlaceholderClaimReceipt>();
    subject.claim.mockImplementationOnce(() => pending.promise);
    const claim = async () => {
      const { blocked: _blocked, ownerTabName: _name, roleName: _role, ...identity } =
        await subject.invoke(contents, { type: "ready" }) as RuntimeRolePlaceholderState;
      return subject.invoke(contents, { ...identity, type: "claim" });
    };
    const first = claim();
    await subject.registry.reconcile([{
      ...subject.descriptor(), bounds: { ...subject.descriptor().bounds, width: 500 }
    }]);
    const second = claim();
    const firstRejected = expect(first).rejects.toThrow("creation failed");
    const secondRejected = expect(second).rejects.toThrow("creation failed");
    await Promise.resolve();
    expect(subject.claim).toHaveBeenCalledOnce();
    pending.reject(new Error("creation failed"));
    await Promise.all([firstRejected, secondRejected]);
    await expect(claim()).resolves.toMatchObject({ status: "applied" });
    expect(subject.claim).toHaveBeenCalledTimes(2);
    await subject.registry.dispose();
  });

  it("rejects closed and replaced documents before admitting any claim", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const oldContents = subject.views[0]!.webContents;
    const { blocked: _blocked, ownerTabName: _name, roleName: _role, ...identity } =
      await subject.invoke(oldContents, { type: "ready" }) as RuntimeRolePlaceholderState;
    const action = { ...identity, type: "claim" };
    await subject.registry.reconcile([]);
    await expect(Promise.resolve(subject.invoke(oldContents, action)))
      .rejects.toMatchObject({ message: expect.stringContaining("removed") });
    await subject.registry.reconcile([subject.descriptor()]);
    await expect(Promise.resolve(subject.invoke(oldContents, action)))
      .rejects.toMatchObject({ message: expect.stringContaining("replaced") });
    const newContents = subject.views[1]!.webContents;
    await expect(Promise.resolve(subject.invoke(newContents, action)))
      .rejects.toMatchObject({ code: "ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE" });
    await expect(Promise.resolve(subject.invoke(newContents, { type: "claim" })))
      .rejects.toMatchObject({ message: expect.stringContaining("payload is invalid") });
    expect(subject.claim).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });

  it("supersedes queued creation before attaching a removed placeholder", async () => {
    const subject = harness();
    const opening = subject.registry.reconcile([subject.descriptor()]);
    const removed = subject.registry.reconcile([]);
    await Promise.all([opening, removed]);
    expect(subject.views).toHaveLength(0);
    expect(subject.attached).toHaveLength(0);
    expect(subject.onError).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });

  it("closes an unfinished document without reporting cancellation as a load fault", async () => {
    const subject = harness(null, false);
    await subject.registry.reconcile([subject.descriptor()]);
    await subject.registry.reconcile([]);
    expect(subject.views[0]!.webContents.destroyed).toBe(true);
    expect(subject.registry.activeCount).toBe(0);
    expect(subject.onError).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });

  it("fails closed when a forged shell identity claims persistent storage", () => {
    expect(() => harness("/persistent/role-profile")).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_PLACEHOLDER_SHELL_INVALID" })
    );
  });

  it("restores the prior native parent and quarantines a failed reparent", async () => {
    const subject = harness();
    await subject.registry.reconcile([subject.descriptor()]);
    const replacement = {
      id: 42,
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn()
      },
      isDestroyed: () => false
    };
    subject.failAttachForHost.add(replacement.id);

    await expect(subject.registry.reconcile([
      subject.descriptor(8, replacement)
    ])).rejects.toThrow("native attach readback failed");

    expect(replacement.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(subject.host.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(() => subject.registry.readEvidence(subject.descriptor().placeholderId))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_ROLE_PLACEHOLDER_STALE" }));
    await expect(Promise.resolve(subject.invoke(subject.views[0]!.webContents, { type: "ready" })))
      .rejects.toMatchObject({ message: expect.stringContaining("state=quarantined") });
    expect(subject.claim).not.toHaveBeenCalled();
    await subject.registry.dispose();
  });
});
