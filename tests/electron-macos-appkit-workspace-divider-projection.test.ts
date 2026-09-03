import { describe, expect, it, vi } from "vitest";

import type { AppKitRuntimeWindowProjectionRecord } from
  "../src/shared/generated";
import {
  createMacosAppKitWorkspaceDividerProjectionState,
  prepareMacosAppKitWorkspaceDividerProjection
} from "../src/electron/main/macosAppKitWorkspaceDividerProjection";

const identity = Object.freeze({
  logicalWindowId: "window-1",
  launchGeneration: "launch-1",
  nativeGeneration: 1
});
const contentBounds = Object.freeze({ x: 0, y: 40, width: 960, height: 640 });

function projection(
  bounds = { x: 478, y: 40, width: 4, height: 640 }
): AppKitRuntimeWindowProjectionRecord {
  return {
    identity,
    adapterSequence: 1,
    windowGeneration: 3,
    topologyRevision: 7,
    logicalTabIds: ["tab-1"],
    hiddenTabIds: [],
    tabs: [{
      tabId: "tab-1",
      name: "Mixed workspace",
      phase: "ready",
      tabType: "workspace",
      audioMuted: false
    }],
    activeTabId: "tab-1",
    roles: [],
    webSurfaces: [],
    workspaceDividers: [{
      tabId: "tab-1",
      attemptGeneration: "workspace-attempt-1",
      dividerIndex: 0,
      axis: "vertical",
      bounds,
      visible: true
    }],
    windowVisible: true
  };
}

describe("macOS retained AppKit workspace-divider projection", () => {
  it("commits exact native geometry and rolls back with a higher revision", () => {
    const state = createMacosAppKitWorkspaceDividerProjectionState();
    const apply = vi.fn((revision: string, bounds, dividers) => ({
      projectionRevision: revision,
      dividerCount: dividers.length,
      contentBounds: { ...bounds }
    }));
    const transaction = prepareMacosAppKitWorkspaceDividerProjection({
      identity,
      projection: projection(),
      state,
      contentBounds: () => contentBounds,
      currentFenceMatches: () => true,
      apply
    });

    transaction.commit();
    transaction.rollback();

    expect(apply.mock.calls).toEqual([
      ["1", contentBounds, [expect.objectContaining({
        dividerIndex: 0,
        axis: "vertical",
        bounds: { x: 478, y: 40, width: 4, height: 640 }
      })]],
      ["2", contentBounds, []]
    ]);
    expect(state).toMatchObject({
      nativeRevision: 2,
      poisoned: false,
      dividers: []
    });
  });

  it("does not rewrite an unchanged divider projection", () => {
    const state = createMacosAppKitWorkspaceDividerProjectionState();
    const apply = vi.fn((revision: string, bounds, dividers) => ({
      projectionRevision: revision,
      dividerCount: dividers.length,
      contentBounds: { ...bounds }
    }));
    prepareMacosAppKitWorkspaceDividerProjection({
      identity,
      projection: projection(),
      state,
      contentBounds: () => contentBounds,
      currentFenceMatches: () => true,
      apply
    }).commit();
    const replay = prepareMacosAppKitWorkspaceDividerProjection({
      identity,
      projection: { ...projection(), adapterSequence: 2 },
      state,
      contentBounds: () => contentBounds,
      currentFenceMatches: () => true,
      apply
    });

    replay.commit();
    replay.rollback();

    expect(apply).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ nativeRevision: 1, version: 1 });
  });

  it("fails before native mutation when a divider escapes the content host", () => {
    const apply = vi.fn();
    const transaction = prepareMacosAppKitWorkspaceDividerProjection({
      identity,
      projection: projection({ x: 958, y: 40, width: 4, height: 640 }),
      state: createMacosAppKitWorkspaceDividerProjectionState(),
      contentBounds: () => contentBounds,
      currentFenceMatches: () => true,
      apply
    });

    expect(() => transaction.commit()).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_DIVIDER_BOUNDS_INVALID"
    }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("quarantines an unverified native receipt when compensation is unknown", () => {
    const state = createMacosAppKitWorkspaceDividerProjectionState();
    const apply = vi.fn()
      .mockReturnValueOnce({
        projectionRevision: "stale",
        dividerCount: 1,
        contentBounds
      })
      .mockImplementation(() => {
        throw new Error("native revision already advanced");
      });
    const transaction = prepareMacosAppKitWorkspaceDividerProjection({
      identity,
      projection: projection(),
      state,
      contentBounds: () => contentBounds,
      currentFenceMatches: () => true,
      apply
    });

    expect(() => transaction.commit()).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_DIVIDER_RECEIPT_INVALID"
    }));
    expect(transaction.requiresQuarantine()).toBe(true);
    expect(state.poisoned).toBe(true);
  });
});
