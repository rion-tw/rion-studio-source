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

class FakeContents implements ChromiumRoleSurfaceWebContentsPort {
  readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>();
  readonly sent: Array<readonly [string, ...unknown[]]> = [];
  readonly session: ChromiumRoleSessionPort;
  url = "";
  destroyed = false;

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
    queueMicrotask(() => this.emit("did-finish-load"));
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

function harness(storagePath: string | null = null) {
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
  const attached: string[] = [];
  const detached: string[] = [];
  const nativeDetach = new Map<string, () => void>();
  const failAttachForHost = new Set<number>();
  const registry = new ChromiumRuntimeRolePlaceholderRegistry({
    claim,
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
      documentPath: "/bundle/runtime-role-placeholder-electron.html",
      ipcMain: {
        handle: (channel, listener) => {
          expect(channel).toBe(RUNTIME_ROLE_PLACEHOLDER_CHANNEL);
          handler = listener;
        },
        removeHandler: () => { handler = undefined; }
      },
      preloadPath: "/bundle/workspaceWebChrome.cjs",
      session,
      sessionIdentity: RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION
    },
    views: {
      create: () => {
        const view = new FakeView(new FakeContents(session));
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
    expect(evidence.shellUrl).toBe(
      "file:///bundle/runtime-role-placeholder-electron.html"
    );
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
    await subject.registry.dispose();
  });
});
