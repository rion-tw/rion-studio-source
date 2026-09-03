import type {
  AppKitRuntimeHostIdentityRecord,
  CoreEffectRequest,
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeHostPort
} from "../src/electron/main/chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import {
  provisionChromiumRuntimeWindowForTabMove,
  retireChromiumRuntimeProvisionedWindow
} from "../src/electron/main/chromiumRuntimeWindowProvision";

function target(windowId: string): EmbeddedLaunchTargetRecord {
  return {
    windowId,
    persistedName: `Window ${windowId}`,
    displayId: 7,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1600, height: 1000 },
    bounds: { x: 100, y: 80, width: 1000, height: 700 },
    presentation: "normal"
  };
}

class FakeHost implements ChromiumRuntimeHostPort {
  readonly id: number;
  readonly logicalWindowId: string;
  readonly contentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn()
  };
  readonly appKitIdentity?: AppKitRuntimeHostIdentityRecord;
  readonly close = vi.fn(async () => { this.destroyed = true; });
  readonly focus = vi.fn();
  readonly hide = vi.fn(() => { this.visible = false; });
  readonly show = vi.fn(() => { this.visible = true; });
  destroyed = false;
  visible = false;
  focused = false;

  constructor(
    id: number,
    readonly launchTarget: EmbeddedLaunchTargetRecord,
    appKitLaunchGeneration?: string
  ) {
    this.id = id;
    this.logicalWindowId = launchTarget.windowId;
    if (appKitLaunchGeneration) {
      this.appKitIdentity = {
        logicalWindowId: launchTarget.windowId,
        launchGeneration: appKitLaunchGeneration,
        nativeGeneration: 1
      };
    }
  }

  getContentBounds() {
    return { x: 0, y: 40, width: 1000, height: 660 };
  }

  readProjection() {
    return {
      displayId: this.launchTarget.displayId,
      bounds: { ...this.launchTarget.bounds },
      visible: this.visible,
      focused: this.focused,
      presentation: this.launchTarget.presentation
    };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }
}

function tabRecord(windowId: string): ChromiumRuntimeTabRecord {
  return {
    specification: {
      tabId: "tab-1",
      audioMuted: false,
      attemptGeneration: "attempt-1",
      sourceId: "role-1",
      name: "Role 1",
      workspaceAppearance: { background: "material", gap: 4 },
      target: target(windowId),
      slots: [],
      roles: []
    } as EmbeddedTabEffectRecord,
    windowId,
    roleViews: new Map(),
    webViews: new Map(),
    audioMuted: false
  };
}

function windowRecord(
  host: FakeHost,
  tabIds: string[],
  windowGeneration = 3,
  topologyRevision = 8
): ChromiumRuntimeWindowRecord {
  return {
    host,
    hostTarget: host.launchTarget,
    tabIds: [...tabIds],
    hiddenTabIds: new Set(),
    activeTabId: tabIds[0] ?? "",
    windowGeneration,
    topologyRevision,
    lastAdapterSequence: 0
  };
}

function provisionEffect(
  targetWindow = target("target-window")
): CoreEffectRequest & {
  action: Extract<CoreEffectRequest["action"], {
    type: "embeddedProvisionWindowForTabMove";
  }>;
} {
  return {
    effectId: "effect-provision-1",
    operationId: "operation-provision-1",
    target: { kind: "app", handleId: "tab-1" },
    completionPolicy: "eventBound",
    action: {
      type: "embeddedProvisionWindowForTabMove",
      tabId: "tab-1",
      sourceWindowId: "source-window",
      sourceWindowGeneration: 3,
      sourceTopologyRevision: 8,
      target: targetWindow,
      targetWindowGeneration: 11,
      targetTopologyRevision: 12
    }
  };
}

function retireEffect(windowId = "target-window"): CoreEffectRequest & {
  action: Extract<CoreEffectRequest["action"], {
    type: "embeddedRetireProvisionedWindow";
  }>;
} {
  return {
    effectId: "effect-retire-1",
    operationId: "operation-retire-1",
    target: { kind: "app", handleId: windowId },
    completionPolicy: "eventBound",
    action: {
      type: "embeddedRetireProvisionedWindow",
      windowId,
      windowGeneration: 11,
      topologyRevision: 12
    }
  };
}

function state(appKit = false) {
  const sourceHost = new FakeHost(
    1,
    target("source-window"),
    appKit ? "source-attempt" : undefined
  );
  const created: FakeHost[] = [];
  const createEmpty = vi.fn(async (
    launchTarget: EmbeddedLaunchTargetRecord,
    identity: Readonly<{ attemptGeneration: string }>
  ) => {
    const host = new FakeHost(
      created.length + 2,
      launchTarget,
      appKit ? identity.attemptGeneration : undefined
    );
    created.push(host);
    return host;
  });
  const windows = new Map<string, ChromiumRuntimeWindowRecord>([[
    "source-window",
    windowRecord(sourceHost, ["tab-1"])
  ]]);
  const tabs = new Map<string, ChromiumRuntimeTabRecord>([[
    "tab-1",
    tabRecord("source-window")
  ]]);
  const ports = {
    hosts: { create: vi.fn(), createEmpty }
  } as unknown as ChromiumRuntimeEffectExecutorInput;
  return { sourceHost, created, createEmpty, windows, tabs, ports };
}

describe("Chromium runtime empty-window provision", () => {
  it.each([false, true])(
    "creates one hidden zero-tab %s host and replays idempotently",
    async (appKit) => {
      const fixture = state(appKit);
      const effect = provisionEffect();

      const receipt = await provisionChromiumRuntimeWindowForTabMove(
        fixture,
        effect,
        effect.action
      );
      const replay = await provisionChromiumRuntimeWindowForTabMove(
        fixture,
        effect,
        effect.action
      );

      expect(receipt).toEqual({
        windowId: "target-window",
        windowGeneration: 11,
        topologyRevision: 12
      });
      expect(replay).toEqual(receipt);
      expect(fixture.createEmpty).toHaveBeenCalledOnce();
      expect(fixture.createEmpty).toHaveBeenCalledWith(target("target-window"), {
        attemptGeneration: "attempt-1",
        windowGeneration: 11,
        topologyRevision: 12
      });
      expect(fixture.windows.get("target-window")).toMatchObject({
        tabIds: [],
        activeTabId: "",
        windowGeneration: 11,
        topologyRevision: 12
      });
      expect(fixture.tabs.get("tab-1")?.windowId).toBe("source-window");
      expect(fixture.created[0]!.show).not.toHaveBeenCalled();
      expect(fixture.created[0]!.focus).not.toHaveBeenCalled();
      expect(fixture.created[0]!.appKitIdentity !== undefined).toBe(appKit);
    }
  );

  it("rejects a stale source before asking either platform to create a host", async () => {
    const fixture = state();
    fixture.windows.get("source-window")!.topologyRevision = 9;
    const effect = provisionEffect();

    await expect(provisionChromiumRuntimeWindowForTabMove(
      fixture,
      effect,
      effect.action
    )).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_PROVISION_SOURCE_STALE"
    });
    expect(fixture.createEmpty).not.toHaveBeenCalled();
  });

  it("closes a mismatched platform host and preserves the source owner", async () => {
    const fixture = state(true);
    fixture.createEmpty.mockImplementationOnce(async (launchTarget) => {
      const wrong = new FakeHost(2, launchTarget);
      fixture.created.push(wrong);
      return wrong;
    });
    const effect = provisionEffect();

    await expect(provisionChromiumRuntimeWindowForTabMove(
      fixture,
      effect,
      effect.action
    )).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_PROVISION_NATIVE_RECEIPT_INVALID"
    });
    expect(fixture.created[0]!.close).toHaveBeenCalledOnce();
    expect(fixture.windows.has("target-window")).toBe(false);
    expect(fixture.tabs.get("tab-1")?.windowId).toBe("source-window");
  });

  it("retires exact empty hosts, replays absence, and refuses nonempty state", async () => {
    const fixture = state();
    const provision = provisionEffect();
    await provisionChromiumRuntimeWindowForTabMove(
      fixture,
      provision,
      provision.action
    );
    const host = fixture.created[0]!;
    const retire = retireEffect();

    await expect(retireChromiumRuntimeProvisionedWindow(
      fixture,
      retire,
      retire.action
    )).resolves.toEqual({ windowId: "target-window", retired: true });
    await expect(retireChromiumRuntimeProvisionedWindow(
      fixture,
      retire,
      retire.action
    )).resolves.toEqual({ windowId: "target-window", retired: false });
    expect(host.close).toHaveBeenCalledOnce();

    fixture.windows.set(
      "target-window",
      windowRecord(new FakeHost(3, target("target-window")), ["tab-1"], 11, 12)
    );
    await expect(retireChromiumRuntimeProvisionedWindow(
      fixture,
      retire,
      retire.action
    )).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_RETIRE_STALE"
    });
  });

  it("keeps an empty logical owner quarantined when close is indeterminate", async () => {
    const fixture = state();
    const provision = provisionEffect();
    await provisionChromiumRuntimeWindowForTabMove(
      fixture,
      provision,
      provision.action
    );
    fixture.created[0]!.close.mockRejectedValueOnce(new Error("close unknown"));
    const retire = retireEffect();

    await expect(retireChromiumRuntimeProvisionedWindow(
      fixture,
      retire,
      retire.action
    )).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_RETIRE_INDETERMINATE"
    });
    expect(fixture.windows.has("target-window")).toBe(true);
  });
});
