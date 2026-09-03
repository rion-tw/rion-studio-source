import type {
  AppKitRuntimeHostIdentityRecord,
  CoreEffectRequest,
  EmbeddedLaunchTargetRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";
import type {
  ChromiumRuntimeHostPort
} from "../src/electron/main/chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeWindowStateObservation,
  ChromiumRuntimeWindowStateObserver,
  ChromiumRuntimeWindowStateSource
} from "../src/electron/main/chromiumRuntimeHostPorts";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import {
  applyChromiumRuntimeWindowVisibilityEffect
} from "../src/electron/main/chromiumRuntimeWindowVisibility";
import { ChromiumRuntimeOwnershipTransitionCoordinator } from
  "../src/electron/main/chromiumRuntimeOwnershipTransitionCoordinator";

const identity: AppKitRuntimeHostIdentityRecord = {
  logicalWindowId: "window-1",
  launchGeneration: "launch-1",
  nativeGeneration: 9
};

interface HarnessOptions {
  readonly automaticEvents?: boolean;
  readonly initialVisible?: boolean;
  readonly platform?: "macos" | "windows";
  readonly quarantineFails?: boolean;
  readonly supportsShowInactive?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const platform = options.platform ?? "macos";
  const automaticEvents = options.automaticEvents ?? true;
  let visible = options.initialVisible ?? true;
  let sequence = 1;
  const observers = new Set<ChromiumRuntimeWindowStateObserver>();
  const readRuntimeWindowState = (
    source: ChromiumRuntimeWindowStateSource = "initial",
    overrides: Partial<ChromiumRuntimeWindowStateObservation> = {}
  ): ChromiumRuntimeWindowStateObservation => Object.freeze({
    platform,
    source,
    sequence,
    lifecycleEpoch: 1,
    logicalWindowId: "window-1",
    nativeHostId: 1,
    nativeGeneration: identity.nativeGeneration,
    windowGeneration: 3,
    topologyRevision: 7,
    visible,
    minimized: false,
    focused: false,
    foreground: false,
    ...(platform === "macos" ? { appKitIdentity: identity } : {}),
    ...overrides
  });
  const emit = (
    source: ChromiumRuntimeWindowStateSource,
    overrides: Partial<ChromiumRuntimeWindowStateObservation> = {}
  ): ChromiumRuntimeWindowStateObservation => {
    if (overrides.visible !== undefined) visible = overrides.visible;
    sequence += 1;
    const observation = readRuntimeWindowState(source, overrides);
    for (const observer of observers) observer(observation);
    return observation;
  };
  const hide = vi.fn(() => {
    visible = false;
    if (automaticEvents) emit("hide");
  });
  const show = vi.fn(() => {
    visible = true;
    if (automaticEvents) emit("show");
  });
  const showInactive = vi.fn(() => {
    visible = true;
    if (automaticEvents) emit("show");
  });
  const host: ChromiumRuntimeHostPort = {
    id: 1,
    logicalWindowId: "window-1",
    contentView: {} as ChromiumRuntimeHostPort["contentView"],
    close: vi.fn(async () => undefined),
    focus: vi.fn(),
    hide,
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
    readProjection: () => ({
      displayId: 1,
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      visible,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => false,
    isVisible: vi.fn(() => visible),
    show,
    ...(options.supportsShowInactive === false ? {} : { showInactive }),
    bindRuntimeWindowState: (observer) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    readRuntimeWindowState: () => readRuntimeWindowState(),
    ...(platform === "macos" ? { appKitIdentity: identity } : {})
  };
  const target: EmbeddedLaunchTargetRecord = {
    windowId: "window-1",
    displayId: 1,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 0, y: 0, width: 900, height: 600 },
    presentation: "normal"
  };
  const window: ChromiumRuntimeWindowRecord = {
    host,
    hostTarget: target,
    tabIds: ["tab-1"],
    hiddenTabIds: new Set(),
    activeTabId: "tab-1",
    windowGeneration: 3,
    topologyRevision: 7,
    lastAdapterSequence: 0
  };
  const role: ChromiumRuntimeRoleRecord = {
    roleId: "role-1",
    tabId: "tab-1",
    windowId: "window-1",
    generation: 1,
    ownerGeneration: 1,
    zoomFactor: 1
  };
  const setVisible = vi.fn();
  const quarantineWindows = options.quarantineFails
    ? vi.fn(async () => {
        throw new Error("quarantine failed");
      })
    : vi.fn(async () => undefined);
  const reconcileProjection = vi.fn(async () => undefined);
  const ownershipTransitions = new ChromiumRuntimeOwnershipTransitionCoordinator({
    lifecycleEpoch: () => 1,
    onError: vi.fn()
  });
  const base: Omit<
    Parameters<typeof applyChromiumRuntimeWindowVisibilityEffect>[0],
    "effect" | "action"
  > = {
    ports: {
      surfaces: { setVisible },
      webSurfaces: { setVisible: vi.fn() }
    },
    windows: new Map([["window-1", window]]),
    roles: new Map([["role-1", role]]),
    webSurfaces: new Map(),
    quarantineWindows,
    reconcileProjection,
    ownershipTransitions
  } as Omit<
    Parameters<typeof applyChromiumRuntimeWindowVisibilityEffect>[0],
    "effect" | "action"
  >;
  return {
    base,
    emit,
    hide,
    host,
    quarantineWindows,
    reconcileProjection,
    setNativeVisible(value: boolean): void {
      visible = value;
    },
    setVisible,
    show,
    showInactive,
    window
  };
}

function effect(
  base: Omit<
    Parameters<typeof applyChromiumRuntimeWindowVisibilityEffect>[0],
    "effect" | "action"
  >,
  visible: boolean,
  overrides: Partial<Extract<CoreEffectRequest["action"], {
    type: "embeddedSetRuntimeWindowVisibility";
  }>> = {},
  identifiers: Readonly<{
    effectId?: string;
    operationId?: string;
  }> = {}
): Parameters<typeof applyChromiumRuntimeWindowVisibilityEffect>[0] {
  const window = base.windows.get("window-1")!;
  const action = {
    type: "embeddedSetRuntimeWindowVisibility" as const,
    lifecycleEpoch: 1,
    windowId: "window-1",
    windowGeneration: 3,
    topologyRevision: 7,
    ...(window.host.appKitIdentity
      ? { appkitIdentity: window.host.appKitIdentity }
      : {}),
    visible,
    ...overrides
  };
  return {
    ...base,
    effect: {
      effectId: identifiers.effectId ?? "visibility-effect",
      operationId: identifiers.operationId ?? "visibility-operation",
      target: { kind: "app", handleId: "window-1" },
      completionPolicy: "eventBound",
      action
    },
    action
  };
}

describe("Chromium runtime window visibility transaction", () => {
  it("returns the exact asynchronous native receipt and projects its observation", async () => {
    const subject = harness({ automaticEvents: false });
    const continuation = applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, false)
    );

    expect(subject.hide).toHaveBeenCalledOnce();
    expect(subject.setVisible).not.toHaveBeenCalled();
    const observation = subject.emit("hide", { visible: false });
    subject.setNativeVisible(true);

    await expect(continuation.completion).resolves.toEqual({
      effectId: "visibility-effect",
      operationId: "visibility-operation",
      lifecycleEpoch: 1,
      status: "applied",
      windows: [observation]
    });
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, false);
    expect(subject.host.isVisible).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).toHaveBeenCalledOnce();
    expect(subject.quarantineWindows).not.toHaveBeenCalled();
  });

  it("reveals without claiming focus", async () => {
    const subject = harness({
      automaticEvents: false,
      initialVisible: false
    });
    const continuation = applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, true)
    );

    expect(subject.showInactive).toHaveBeenCalledOnce();
    expect(subject.host.focus).not.toHaveBeenCalled();
    const observation = subject.emit("show", {
      visible: true,
      focused: false,
      foreground: false
    });
    await expect(continuation.completion).resolves.toMatchObject({
      status: "applied",
      windows: [observation]
    });
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    expect(subject.reconcileProjection).toHaveBeenCalledOnce();
  });

  it.each(["macos", "windows"] as const)(
    "completes an already-satisfied %s host without native mutation",
    async (platform) => {
      const subject = harness({
        automaticEvents: false,
        initialVisible: true,
        platform
      });

      await expect(applyChromiumRuntimeWindowVisibilityEffect(
        effect(subject.base, true)
      ).completion).resolves.toMatchObject({
        status: "applied",
        windows: [{
          platform,
          source: "initial",
          visible: true,
          minimized: false
        }]
      });
      expect(subject.showInactive).not.toHaveBeenCalled();
      expect(subject.host.focus).not.toHaveBeenCalled();
      expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    }
  );

  it("resolves an inverse request as superseded and fences its late event", async () => {
    const subject = harness({ automaticEvents: false });
    const hide = applyChromiumRuntimeWindowVisibilityEffect(effect(
      subject.base,
      false,
      {},
      { effectId: "hide-effect", operationId: "hide-operation" }
    ));
    const reveal = applyChromiumRuntimeWindowVisibilityEffect(effect(
      subject.base,
      true,
      {},
      { effectId: "reveal-effect", operationId: "reveal-operation" }
    ));

    await expect(hide.completion).resolves.toEqual({
      effectId: "hide-effect",
      operationId: "hide-operation",
      lifecycleEpoch: 1,
      status: "superseded",
      windows: []
    });
    expect(subject.setVisible).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).not.toHaveBeenCalled();
    subject.emit("hide", { visible: false });
    expect(subject.setVisible).not.toHaveBeenCalled();
    const revealObservation = subject.emit("show", { visible: true });
    await expect(reveal.completion).resolves.toMatchObject({
      status: "applied",
      windows: [revealObservation]
    });
    expect(subject.setVisible).toHaveBeenCalledTimes(1);
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    expect(subject.reconcileProjection).toHaveBeenCalledOnce();
    expect(subject.quarantineWindows).not.toHaveBeenCalled();
  });

  it("rejects stale and missing AppKit fences before native submission", () => {
    const subject = harness();
    const stale = effect(subject.base, true, { windowGeneration: 2 });
    expect(() => applyChromiumRuntimeWindowVisibilityEffect(stale)).toThrow(
      expect.objectContaining({ code: "ELECTRON_CHROMIUM_WINDOW_VISIBILITY_STALE" })
    );
    const unfenced = effect(subject.base, true, { appkitIdentity: undefined });
    expect(() => applyChromiumRuntimeWindowVisibilityEffect(unfenced)).toThrow(
      expect.objectContaining({
        code: "ELECTRON_MACOS_APPKIT_VISIBILITY_FENCE_MISSING"
      })
    );
    expect(subject.hide).not.toHaveBeenCalled();
    expect(subject.showInactive).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).not.toHaveBeenCalled();
    expect(subject.quarantineWindows).not.toHaveBeenCalled();
  });

  it("does not quarantine a pre-submission capability failure", () => {
    const subject = harness({
      initialVisible: false,
      supportsShowInactive: false
    });

    expect(() => applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, true)
    )).toThrow(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_REVEAL_INACTIVE_UNAVAILABLE"
    }));
    expect(subject.show).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).not.toHaveBeenCalled();
    expect(subject.quarantineWindows).not.toHaveBeenCalled();
  });

  it("quarantines a post-submission indeterminate result with a stable code", async () => {
    const subject = harness();
    subject.hide.mockImplementationOnce(() => {
      throw new Error("native visibility submission failed");
    });

    await expect(applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, false)
    ).completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED"
    });
    expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1"]);
    expect(subject.show).not.toHaveBeenCalled();
    expect(subject.showInactive).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).not.toHaveBeenCalled();
  });

  it("quarantines when surface projection fails after an applied receipt", async () => {
    const subject = harness();
    subject.setVisible.mockImplementationOnce(() => {
      throw new Error("surface visibility projection failed");
    });

    await expect(applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, false)
    ).completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED"
    });
    expect(subject.hide).toHaveBeenCalledOnce();
    expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1"]);
    expect(subject.show).not.toHaveBeenCalled();
    expect(subject.reconcileProjection).not.toHaveBeenCalled();
  });

  it.each(["macos", "windows"] as const)(
    "quarantines the %s host when placeholder reconciliation fails after Applied",
    async (platform) => {
      const subject = harness({ platform });
      subject.reconcileProjection.mockRejectedValueOnce(
        new Error("placeholder projection failed")
      );

      await expect(applyChromiumRuntimeWindowVisibilityEffect(
        effect(subject.base, false)
      ).completion).rejects.toMatchObject({
        code: "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED"
      });
      expect(subject.hide).toHaveBeenCalledOnce();
      expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, false);
      expect(subject.reconcileProjection).toHaveBeenCalledOnce();
      expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1"]);
    }
  );

  it("reports a stable failure when quarantine cannot complete", async () => {
    const subject = harness({ quarantineFails: true });
    subject.hide.mockImplementationOnce(() => {
      throw new Error("native visibility submission failed");
    });

    await expect(applyChromiumRuntimeWindowVisibilityEffect(
      effect(subject.base, false)
    ).completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_QUARANTINE_FAILED"
    });
    expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1"]);
  });
});
