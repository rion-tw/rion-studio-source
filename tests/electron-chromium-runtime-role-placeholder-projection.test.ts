import { describe, expect, it, vi } from "vitest";

import type {
  BrowserRuntimeRoleRecord,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import type { ChromiumRuntimeEffectExecutorInput } from
  "../src/electron/main/chromiumRuntimeEffectPorts";
import type {
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import {
  type ChromiumRuntimeRolePlaceholderDescriptor,
} from "../src/electron/main/chromiumRuntimeRolePlaceholderRegistry";
import {
  projectChromiumRuntimeRolePlaceholderSlots,
  reconcileChromiumRuntimeRolePlaceholders
} from "../src/electron/main/chromiumRuntimeRolePlaceholderProjection";
import { tab } from "./support/electronChromiumRuntimeEffectFixtures";

function host(id: number, windowId: string, visible = true) {
  return {
    id,
    logicalWindowId: windowId,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    close: vi.fn(async () => undefined),
    focus: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 40, width: 900, height: 600 }),
    hide: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => visible,
    readProjection: () => ({
      bounds: { x: 0, y: 0, width: 900, height: 640 },
      displayId: 1,
      focused: false,
      presentation: "normal" as const,
      visible
    }),
    show: vi.fn()
  };
}

function topology() {
  const source = tab();
  const sharedRole = source.slots[0]!.role;
  const sourceOwner = source.slots[0]!.owner!;
  const target = {
    ...tab(),
    tabId: "target-tab",
    name: "Target workspace",
    target: { ...source.target, windowId: "target-window" },
    roles: [],
    slots: [{
      ...source.slots[0]!,
      slotId: "target-slot",
      state: "blocked" as const,
      owner: { ...sourceOwner }
    }]
  };
  const tabs = new Map<string, ChromiumRuntimeTabRecord>([
    [source.tabId, {
      audioMuted: false,
      roleViews: new Map([[sharedRole.id, source.roles[0]!]]),
      specification: source,
      webViews: new Map(),
      windowId: source.target.windowId
    }],
    [target.tabId, {
      audioMuted: false,
      roleViews: new Map(),
      specification: target,
      webViews: new Map(),
      windowId: target.target.windowId
    }]
  ]);
  const sourceHost = host(11, source.target.windowId);
  const targetHost = host(12, target.target.windowId);
  const windows = new Map<string, ChromiumRuntimeWindowRecord>([
    [source.target.windowId, {
      activeTabId: source.tabId,
      hiddenTabIds: new Set(),
      host: sourceHost,
      hostTarget: source.target,
      lastAdapterSequence: 0,
      tabIds: [source.tabId],
      topologyRevision: 7,
      windowGeneration: 3
    }],
    [target.target.windowId, {
      activeTabId: target.tabId,
      hiddenTabIds: new Set(),
      host: targetHost,
      hostTarget: target.target,
      lastAdapterSequence: 0,
      tabIds: [target.tabId],
      topologyRevision: 8,
      windowGeneration: 4
    }]
  ]);
  return { sharedRole, source, sourceOwner, tabs, target, targetHost, windows };
}

describe("Chromium blocked Role-slot projection", () => {
  it("projects one visible placeholder into the exact retained target host", async () => {
    const state = topology();
    const reconcile = vi.fn(async (
      _descriptors: readonly ChromiumRuntimeRolePlaceholderDescriptor[]
    ) => undefined);
    await reconcileChromiumRuntimeRolePlaceholders({
      ports: {
        layout: {
          resolveRoleBounds: async (specification: EmbeddedTabEffectRecord) => new Map(
            specification.slots.map((slot, index) => [
              slot.role.id,
              { x: index * 450, y: 40, width: 450, height: 600 }
            ])
          )
        },
        rolePlaceholders: {
          dispose: async () => undefined,
          readEvidence: vi.fn(),
          reconcile
        }
      } as unknown as ChromiumRuntimeEffectExecutorInput,
      tabs: state.tabs,
      windows: state.windows
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        ownerGeneration: state.sourceOwner.generation,
        ownerTabName: state.source.name,
        parent: state.targetHost,
        roleId: state.sharedRole.id,
        slotId: "target-slot",
        tabId: "target-tab",
        topologyRevision: 8,
        visible: true,
        windowGeneration: 4,
        windowId: "target-window"
      })
    ]);
  });

  it("moves the blocked demand only from a Core-projected owner", () => {
    const state = topology();
    const projected: BrowserRuntimeRoleRecord = {
      launchedAt: "2026-08-31T00:00:00Z",
      owner: { generation: 10, slotId: "target-slot", tabId: "target-tab" },
      roleId: state.sharedRole.id,
      runtime: "embedded",
      state: "running"
    };
    projectChromiumRuntimeRolePlaceholderSlots(state.tabs, [projected]);
    expect(state.tabs.get(state.source.tabId)?.specification.slots[0]).toEqual(
      expect.objectContaining({ state: "blocked", owner: projected.owner })
    );
    expect(state.tabs.get("target-tab")?.specification.slots[0]).toEqual(
      expect.objectContaining({ state: "running", owner: projected.owner })
    );
  });

  it("retains the exact blocked owner fence while its tab detaches", async () => {
    const state = topology();
    state.tabs.delete(state.source.tabId);
    const reconcile = vi.fn(async (
      _descriptors: readonly ChromiumRuntimeRolePlaceholderDescriptor[]
    ) => undefined);
    await reconcileChromiumRuntimeRolePlaceholders({
      ports: {
        layout: {
          resolveRoleBounds: async () => new Map([[
            state.sharedRole.id,
            { x: 0, y: 40, width: 900, height: 600 }
          ]])
        },
        rolePlaceholders: {
          dispose: async () => undefined,
          readEvidence: vi.fn(),
          reconcile
        }
      } as unknown as ChromiumRuntimeEffectExecutorInput,
      tabs: state.tabs,
      windows: state.windows
    });
    expect(reconcile).toHaveBeenCalledWith([
      expect.objectContaining({
        ownerGeneration: state.sourceOwner.generation,
        ownerTabName: null,
        roleId: state.sharedRole.id,
        slotId: "target-slot",
        tabId: "target-tab"
      })
    ]);
  });
});
