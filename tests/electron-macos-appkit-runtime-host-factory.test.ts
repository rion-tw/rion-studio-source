import type { EmbeddedTabEffectRecord } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  buildMacosAppKitRuntimeWindowOptions,
  MacosAppKitChromiumRuntimeHostFactory,
  RION_APPKIT_RUNTIME_ABI_VERSION
} from "../src/electron/main/macosAppKitRuntimeHostFactory";
import {
  expectPending,
  FakeAddon,
  FakeNativeHost,
  Fixture,
  popupAdmission,
  tab,
  target
} from "./support/macosAppKitRuntimeHostFactoryFixtures";

describe("macOS AppKit Chromium runtime host", () => {
  it("projects popup chrome through the retained AppKit controller only", async () => {
    const fixture = new Fixture();
    const admission = popupAdmission();
    const created = await fixture.factory.createPopup(admission);
    const identity = created.host.appKitIdentity!;
    expect(created.receipt).toEqual({
      platform: "macos",
      nativeHostId: 1,
      logicalWindowId: admission.target.windowId,
      windowGeneration: 1,
      topologyRevision: 1,
      appkitIdentity: identity
    });
    expect(identity).toEqual({
      logicalWindowId: admission.target.windowId,
      launchGeneration: admission.openOperationId,
      nativeGeneration: 1
    });
    expect(fixture.options[0]).toEqual(
      buildMacosAppKitRuntimeWindowOptions(admission.target)
    );
    expect(fixture.options[0]).not.toHaveProperty("webPreferences");
    expect(fixture.addon.controllers[0]!.verifiedProjectionTabs).toEqual([{
      tabId: admission.popupId,
      name: admission.title,
      phase: "ready",
      tabType: "popup"
    }]);
    expect(fixture.addon.controllers[0]!.verifiedProjectionActiveTabId)
      .toBe(admission.popupId);
    expect(created.host.isVisible()).toBe(false);

    const observer = {
      closeRequested: vi.fn(),
      closed: vi.fn(),
      layoutChanged: vi.fn()
    };
    created.host.bindPopupLifecycle?.(observer);
    fixture.addon.emit(0, {
      type: "layout",
      identity,
      layout: { heightInset: 44, yOffset: 4, valid: true }
    });
    expect(observer.layoutChanged).toHaveBeenCalledWith({
      x: 0,
      y: 4,
      width: 960,
      height: 636
    });
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: identity.logicalWindowId,
        focused: false,
        minimized: false,
        visible: false
      }
    });
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: identity.logicalWindowId
      }
    });
    expect(observer.closeRequested).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: { type: "stop", tabId: admission.popupId }
    });
    expect(observer.closeRequested).toHaveBeenCalledOnce();
    expect(fixture.onAction).not.toHaveBeenCalled();

    const close = created.host.close();
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    fixture.windows[0]!.emit("closed");
    await close;
    expect(observer.closed).toHaveBeenCalledOnce();
  });

  it("creates an invisible exact zero-tab host before a Core-owned move", async () => {
    const fixture = new Fixture();

    const host = await fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 1,
      topologyRevision: 1
    });

    expect(host.appKitIdentity).toEqual({
      logicalWindowId: "window-1",
      launchGeneration: "launch-generation-1",
      nativeGeneration: 1
    });
    expect(host.isVisible()).toBe(false);
    expect(fixture.windows[0]!.isVisible()).toBe(false);
    expect(fixture.addon.controllers[0]!.verifiedProjectionTabCount).toBe(0);
    expect(fixture.addon.controllers[0]!.verifiedProjectionActiveTabId).toBeUndefined();
    expect(fixture.order).not.toContain("window-show");
    expect(fixture.order).not.toContain("window-focus");
  });

  it("keeps Core bounds while AppKit installs its native chrome", async () => {
    const fixture = new Fixture();
    const creation = fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 1,
      topologyRevision: 1
    });
    await vi.waitFor(() => expect(fixture.windows).toHaveLength(1));
    fixture.windows[0]!.normalBounds = {
      x: 100,
      y: 80,
      width: 960,
      height: 708
    };

    const host = await creation;

    expect(host.readProjection()).toEqual({
      displayId: 7,
      bounds: { x: 100, y: 80, width: 960, height: 680 },
      visible: false,
      focused: false,
      presentation: "normal"
    });
  });

  it("uses the exact AppKit placement callback only as the pending Core effect ack", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 1,
      topologyRevision: 1
    });
    const identity = host.appKitIdentity!;
    const operation = host.setRuntimeWindowPresentation!({
      presentation: "fullscreen",
      topologyRevision: 1,
      windowGeneration: 1,
      windowId: "window-1"
    });

    expect(fixture.order.slice(-2)).toEqual([
      "controller-prepare-fullscreen-true",
      "window-fullscreen-true"
    ]);
    await expectPending(operation);
    fixture.windows[0]!.fullScreen = true;
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: "window-1"
      }
    });

    await expect(operation).resolves.toEqual(expect.objectContaining({
      presentation: "fullscreen"
    }));
    expect(fixture.onAction).not.toHaveBeenCalled();

    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: false
      }
    });
    expect(fixture.onAction).not.toHaveBeenCalled();

    const coreProjection = host.prepareAppKitProjection!({
      identity,
      adapterSequence: 1,
      windowGeneration: 1,
      topologyRevision: 2,
      logicalTabIds: [],
      hiddenTabIds: [],
      tabs: [],
      roles: [],
      webSurfaces: [],
      workspaceDividers: [],
      windowVisible: true
    });
    coreProjection.commit();
    coreProjection.finalize?.();
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: false
      }
    });
    expect(fixture.onAction).toHaveBeenCalledOnce();
    expect(fixture.onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ type: "windowFocusChanged" }),
      hosts: [expect.objectContaining({ topologyRevision: 2 })]
    }));
  });

  it("updates v22 bounds only from an authoritative AppKit placement event", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 1,
      topologyRevision: 1
    });
    const identity = host.appKitIdentity!;
    fixture.windows[0]!.normalBounds = {
      x: 140,
      y: 110,
      width: 1000,
      height: 748
    };
    fixture.windows[0]!.contentBounds = {
      x: 140,
      y: 110,
      width: 1000,
      height: 748
    };
    fixture.addon.controllers[0]!.layout = {
      heightInset: 48,
      yOffset: 0,
      valid: true
    };

    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: "window-1"
      }
    });

    expect(host.readProjection().bounds).toEqual({
      x: 140,
      y: 110,
      width: 1000,
      height: 700
    });
    expect(fixture.onAction).toHaveBeenCalledWith({
      identity,
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: "window-1"
      },
      hosts: [expect.objectContaining({
        normalBounds: { x: 140, y: 110, width: 1000, height: 700 }
      })]
    });
  });

  it("fails closed when native AppKit cannot verify a zero-tab projection", async () => {
    const fixture = new Fixture();
    const controller = new FakeNativeHost({
      logicalWindowId: "window-1",
      launchGeneration: "launch-generation-1",
      nativeGeneration: 1
    }, fixture.order);
    controller.projectionTabCountOverride = 1;
    fixture.addon.nextControllerOverride = controller;

    const creation = fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 1,
      topologyRevision: 1
    });
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    await expectPending(creation);
    fixture.windows[0]!.emit("closed");

    await expect(creation).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID"
    });
    expect(controller.destroyed).toBe(true);
    expect(fixture.order).not.toContain("window-show");
  });

  it("applies Core loading-to-ready phases without an AppKit callback", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;
    expect(controller.verifiedProjectionTabs[0]).toMatchObject({
      tabId: "tab-1", phase: "activating"
    });
    host.applyAppKitPhaseProjection!({
      windowId: "window-1",
      windowGeneration: 1,
      topologyRevision: 1,
      tabIds: ["tab-1"],
      tabPhases: [{ tabId: "tab-1", phase: "ready" }],
      hiddenTabIds: [],
      activeTabId: "tab-1"
    });
    expect(controller.verifiedProjectionTabs[0]).toMatchObject({
      tabId: "tab-1", phase: "ready"
    });
  });

  it("does not rewrite an unchanged native tab projection for a layout event", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const priorProjects = fixture.order.filter((item) =>
      item === "controller-project"
    ).length;
    const transaction = host.prepareAppKitProjection!({
      identity: host.appKitIdentity!,
      adapterSequence: 1,
      windowGeneration: 1,
      topologyRevision: 1,
      logicalTabIds: ["tab-1"],
      hiddenTabIds: [],
      tabs: [{
        tabId: "tab-1",
        name: "Role 1",
        phase: "activating",
        tabType: "role",
        audioMuted: false
      }],
      activeTabId: "tab-1",
      roles: [],
      webSurfaces: [],
      workspaceDividers: [],
      windowVisible: true
    });

    transaction.commit();
    transaction.finalize?.();

    expect(fixture.order.filter((item) => item === "controller-project"))
      .toHaveLength(priorProjects);
  });

  it("restores the verified native phase projection after readback failure", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;
    const projection = {
      windowId: "window-1",
      windowGeneration: 1,
      topologyRevision: 1,
      tabIds: ["tab-1"],
      tabPhases: [{ tabId: "tab-1", phase: "ready" as const }],
      hiddenTabIds: [],
      activeTabId: "tab-1"
    };
    controller.projectionRevisionOverride = "forged";
    expect(() => host.applyAppKitPhaseProjection!(projection)).toThrow();
    expect(fixture.order).toContain("controller-project-restore");
    expect(controller.verifiedProjectionTabs[0]).toMatchObject({
      tabId: "tab-1", phase: "activating"
    });
    expect(fixture.onError).not.toHaveBeenCalled();
    controller.projectionRevisionOverride = undefined;
    expect(() => host.applyAppKitPhaseProjection!(projection)).not.toThrow();
    expect(controller.verifiedProjectionRevision).toBe("2");
    expect(controller.verifiedProjectionTabs[0]).toMatchObject({
      tabId: "tab-1", phase: "ready"
    });
  });

  it("poisons the AppKit host when phase compensation cannot be verified", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;
    const projection = {
      windowId: "window-1",
      windowGeneration: 1,
      topologyRevision: 1,
      tabIds: ["tab-1"],
      tabPhases: [{ tabId: "tab-1", phase: "failed" as const }],
      hiddenTabIds: [],
      activeTabId: "tab-1"
    };
    controller.projectionRevisionOverride = "forged";
    controller.restoreThrows = true;
    expect(() => host.applyAppKitPhaseProjection!(projection)).toThrow();
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID"
    }));
    expect(() => host.applyAppKitPhaseProjection!(projection)).toThrow();
  });

  it("installs AppKit before exposing a hidden BaseWindow and detaches before exact close", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));

    expect(fixture.options).toEqual([buildMacosAppKitRuntimeWindowOptions(launchTarget)]);
    expect(fixture.options[0]).toMatchObject({
      frame: true,
      show: false,
      useContentSize: true
    });
    expect(fixture.options[0]).not.toHaveProperty("webPreferences");
    expect(fixture.order.slice(0, 7)).toEqual([
      "window-created-hidden",
      "controller-attach",
      "controller-window-name-Game Window 1",
      "controller-fullscreen-policy-false",
      "controller-tab-close-hidden-false",
      "controller-project",
      "controller-layout"
    ]);
    expect(host.getContentBounds()).toEqual({ x: 0, y: 0, width: 960, height: 640 });
    expect(host.readProjection()).toEqual({
      displayId: 7,
      bounds: { x: 100, y: 80, width: 960, height: 680 },
      visible: false,
      focused: false,
      presentation: "normal"
    });
    expect(host.readFullscreenToolbar?.()).toMatchObject({
      topologyRevision: 1,
      windowGeneration: 1,
      windowId: "window-1"
    });
    expect(fixture.order).toContain("controller-fullscreen-toolbar-readback");
    expect(fixture.factory.resolveInputHost(host)).toMatchObject({
      identity: host.appKitIdentity,
      native: fixture.addon.controllers[0]
    });
    expect(fixture.factory.resolveInputHost(host)?.isFocused()).toBe(false);
    host.show();
    expect(fixture.order.at(-1)).toBe("window-show");
    host.focus();
    expect(fixture.order.at(-1)).toBe("controller-window-focus");
    expect(fixture.order).not.toContain("window-focus");
    expect(host.desktopE2eShowAppKitTabMenu?.("tab-1")).toBe(true);
    expect(fixture.order.at(-1)).toBe("controller-tab-menu-tab-1");
    host.hide();
    expect(fixture.order.at(-1)).toBe("window-hide");
    expect(host.readProjection().visible).toBe(false);

    const close = host.close();
    await Promise.resolve();
    expect(fixture.order.slice(-3)).toEqual([
      "input-host-close",
      "controller-destroy",
      "window-destroy-submitted"
    ]);
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    await expectPending(close);
    fixture.windows[0]!.emit("closed");
    await expect(close).resolves.toBeUndefined();
    expect(host.isDestroyed()).toBe(true);
  });

  it("submits one non-vetoable destroy and cleans exact listeners once across repeated close", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));

    const first = host.close();
    const repeated = host.close();
    expect(repeated).toBe(first);
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    fixture.windows[0]!.emit("closed");
    fixture.windows[0]!.emit("closed");

    await expect(first).resolves.toBeUndefined();
    expect(host.close()).toBe(first);
    expect(fixture.windows[0]!.removedListeners.map(([event]) => event)).toEqual([
      "close",
      "closed",
      "enter-full-screen",
      "hide",
      "leave-full-screen",
      "maximize",
      "minimize",
      "move",
      "resize",
      "restore",
      "show"
    ]);
    expect([...fixture.windows[0]!.listeners.values()].every(
      (listeners) => listeners.size === 0
    )).toBe(true);
  });

  it("rejects a thrown native destroy and retries only after exact controller detach", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    fixture.windows[0]!.destroyError = new Error("native destroy rejected");

    await expect(host.close()).rejects.toThrow("native destroy rejected");
    expect(fixture.windows[0]!.destroyCalls).toBe(1);
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    expect(fixture.addon.controllers[0]!.destroyAttempts).toHaveLength(1);

    fixture.windows[0]!.destroyError = null;
    const retry = host.close();
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(2));
    expect(fixture.addon.controllers[0]!.destroyAttempts).toHaveLength(1);
    fixture.windows[0]!.emit("closed");
    await expect(retry).resolves.toBeUndefined();
  });

  it("blocks an unfenced native close request and reports the exact identity", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    await fixture.factory.create(launchTarget, tab(launchTarget));
    const event = { preventDefault: vi.fn() };

    fixture.windows[0]!.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.onCloseRequested).toHaveBeenCalledWith(
      {
        logicalWindowId: "window-1",
        launchGeneration: "launch-generation-1",
        nativeGeneration: 1
      },
      [expect.objectContaining({ windowGeneration: 1, topologyRevision: 1 })]
    );
    expect(fixture.addon.controllers[0]!.destroyed).toBe(false);
    expect(fixture.windows[0]!.destroyCalls).toBe(0);
  });

  it("waits for exact AppKit presentation evidence without a timer", async () => {
    const fixture = new Fixture();
    const launchTarget = target({ presentation: "fullscreen" });
    const creation = fixture.factory.create(launchTarget, tab(launchTarget));

    await expectPending(creation);
    expect(fixture.order.indexOf("controller-prepare-fullscreen-true"))
      .toBeLessThan(fixture.order.indexOf("window-fullscreen-true"));
    expect(fixture.order).toContain("window-fullscreen-true");
    fixture.windows[0]!.emit("enter-full-screen");
    await expect(creation).resolves.toMatchObject({ logicalWindowId: "window-1" });
    fixture.windows[0]!.emit("leave-full-screen");
    expect(fixture.order).toContain("controller-prepare-fullscreen-false");
  });

  it("projects Core preferences transactionally and captures only exact AppKit owners", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;

    fixture.factory.applyWindowPreferences({
      alwaysHideTabCloseButton: true,
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: true
    });
    expect(controller.fullscreenPolicy).toBe(true);
    expect(controller.tabCloseButtonsHidden).toBe(true);
    expect(fixture.factory.captureHostObservations(["window-1"]))
      .toEqual([expect.objectContaining({
        identity: expect.objectContaining({ logicalWindowId: "window-1" }),
        windowGeneration: 1,
        topologyRevision: 1
      })]);
    expect(() => fixture.factory.captureHostObservations(["window-1", "window-1"]))
      .toThrow(expect.objectContaining({
        code: "ELECTRON_MACOS_APPKIT_OBSERVATION_SET_INVALID"
      }));

    controller.throwTabClosePolicyFor = false;
    expect(() => fixture.factory.applyWindowPreferences({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    })).toThrow("native tab-close policy failed after mutation");
    expect(controller.tabCloseButtonsHidden).toBe(true);
    expect(controller.fullscreenPolicy).toBe(true);
    expect(fixture.onError).not.toHaveBeenCalled();
  });

  it("rejects and poisons a reentrant preference projection that loses its Core fence", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;
    controller.onSetFullscreenPolicy = () => {
      controller.onSetFullscreenPolicy = undefined;
      host.prepareAppKitProjection!({
        identity: host.appKitIdentity!,
        adapterSequence: 1,
        windowGeneration: 1,
        topologyRevision: 2,
        logicalTabIds: ["tab-1"],
        hiddenTabIds: [],
        tabs: [{
          tabId: "tab-1",
          name: "Role 1",
          phase: "loading",
          tabType: "role",
          audioMuted: false
        }],
        activeTabId: "tab-1",
        roles: [],
        webSurfaces: [],
        workspaceDividers: [],
        windowVisible: true
      }).commit();
    };

    expect(() => fixture.factory.applyWindowPreferences({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: true
    })).toThrow(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PREFERENCES_ROLLBACK_FAILED"
    }));
    expect(controller.fullscreenPolicy).toBe(false);
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PREFERENCES_FENCE_STALE"
    }));
  });

  it("renames only the exact AppKit generation and compensates mutation failures", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const identity = host.appKitIdentity!;
    const controller = fixture.addon.controllers[0]!;

    expect(fixture.factory.applyWindowName(identity, "Renamed Window")).toEqual({
      identity,
      name: "Renamed Window"
    });
    expect(controller.windowName).toBe("Renamed Window");
    expect(() => fixture.factory.applyWindowName(
      { ...identity, nativeGeneration: identity.nativeGeneration + 1 },
      "Stale Rename"
    )).toThrow(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_STALE_GENERATION"
    }));

    controller.windowNameFailures.add("Broken Rename");
    expect(() => fixture.factory.applyWindowName(identity, "Broken Rename"))
      .toThrow("native window-name Broken Rename failed after mutation");
    expect(controller.windowName).toBe("Renamed Window");
    expect(fixture.onError).not.toHaveBeenCalled();
  });

  it("quarantines the exact AppKit host when window-name compensation is unknown", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const identity = host.appKitIdentity!;
    const controller = fixture.addon.controllers[0]!;
    controller.windowNameFailures.add("Unverified Rename");
    controller.windowNameFailures.add("Game Window 1");

    expect(() => fixture.factory.applyWindowName(identity, "Unverified Rename"))
      .toThrow(expect.objectContaining({
        code: "ELECTRON_MACOS_APPKIT_WINDOW_NAME_ROLLBACK_FAILED"
      }));
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_MUTATION_UNVERIFIED"
    }));
    expect(() => fixture.factory.applyWindowName(identity, "Retry"))
      .toThrow(expect.objectContaining({
        code: "ELECTRON_MACOS_APPKIT_STALE_GENERATION"
      }));
    expect(fixture.order).not.toContain("window-close-submitted");
    expect(fixture.order).not.toContain("window-destroy-submitted");
  });

  it("exposes an exact public quarantine fence for Core compensation failure", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const identity = host.appKitIdentity!;

    expect(() => fixture.factory.quarantineHost(
      { ...identity, nativeGeneration: identity.nativeGeneration + 1 },
      new Error("foreign failure")
    )).toThrow(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_STALE_GENERATION"
    }));
    fixture.factory.quarantineHost(identity, new Error("Core rollback failed"));
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_MUTATION_UNVERIFIED"
    }));
    expect(() => host.show()).toThrow(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_STALE_GENERATION"
    }));
  });

  it("coalesces initial presentation callbacks until the exact tab surfaces release", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const identity = {
      logicalWindowId: "window-1",
      launchGeneration: "launch-generation-1",
      nativeGeneration: 1
    };

    fixture.addon.emit(0, {
      type: "layout",
      identity,
      layout: { heightInset: 44, yOffset: 4, valid: true }
    });
    fixture.addon.emit(0, {
      type: "layout",
      identity,
      layout: { heightInset: 48, yOffset: 8, valid: true }
    });
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: false
      }
    });
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "selectTab",
        tabId: "tab-1",
        sourceWindowId: "window-1"
      }
    });

    expect(fixture.onLayout).not.toHaveBeenCalled();
    expect(fixture.onAction).toHaveBeenCalledOnce();
    host.releaseAppKitSurfaceAttachment?.("tab-1");

    expect(fixture.onLayout).toHaveBeenCalledOnce();
    expect(fixture.onLayout).toHaveBeenCalledWith({
      identity,
      hosts: [expect.objectContaining({
        contentBounds: { x: 0, y: 8, width: 960, height: 632 }
      })]
    });
    expect(fixture.onAction).toHaveBeenCalledWith({
      identity,
      action: {
        type: "selectTab",
        tabId: "tab-1",
        sourceWindowId: "window-1"
      },
      hosts: [expect.objectContaining({
        windowGeneration: 1,
        topologyRevision: 1
      })]
    });
    expect(fixture.onAction).toHaveBeenLastCalledWith({
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: false
      },
      hosts: [expect.objectContaining({
        windowGeneration: 1,
        topologyRevision: 1
      })]
    });
    expect(fixture.onLayout.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.onAction.mock.invocationCallOrder[1]!);
  });

  it("re-arms the presentation gate when an existing host admits a new tab", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const identity = host.appKitIdentity!;
    host.releaseAppKitSurfaceAttachment?.("tab-1");
    fixture.onLayout.mockClear();
    fixture.onAction.mockClear();

    host.initializeAppKitTab?.({
      ...tab(launchTarget),
      tabId: "tab-2",
      appkitTopologyRevision: 2,
      attemptGeneration: "launch-generation-2",
      sourceId: "role-2",
      name: "Role 2"
    });
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: "window-1"
      }
    });
    fixture.addon.emit(0, {
      type: "layout",
      identity,
      layout: { heightInset: 52, yOffset: 12, valid: true }
    });
    expect(fixture.onAction).not.toHaveBeenCalled();
    expect(fixture.onLayout).not.toHaveBeenCalled();

    host.releaseAppKitSurfaceAttachment?.("tab-2");
    expect(fixture.onAction).toHaveBeenCalledOnce();
    expect(fixture.onLayout).toHaveBeenCalledOnce();
    expect(fixture.onAction.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.onLayout.mock.invocationCallOrder[0]!);
    expect(() => host.releaseAppKitSurfaceAttachment?.("missing-tab"))
      .toThrow(expect.objectContaining({
        code: "ELECTRON_MACOS_APPKIT_SURFACE_ATTACHMENT_STALE"
      }));

    fixture.onLayout.mockClear();
    fixture.onAction.mockClear();
    host.initializeAppKitTab?.({
      ...tab(launchTarget),
      tabId: "tab-3",
      appkitTopologyRevision: 3,
      attemptGeneration: "launch-generation-3"
    });
    fixture.addon.emit(0, {
      type: "layout",
      identity,
      layout: { heightInset: 56, yOffset: 16, valid: true }
    });
    host.discardAppKitSurfaceAttachment?.("tab-3");
    expect(fixture.onLayout).not.toHaveBeenCalled();
    expect(fixture.onAction).not.toHaveBeenCalled();
  });

  it("poisons and closes a host on stale native callback evidence", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));

    fixture.addon.emit(0, {
      type: "layout",
      identity: {
        logicalWindowId: "window-1",
        launchGeneration: "launch-generation-1",
        nativeGeneration: 2
      },
      layout: { heightInset: 40, yOffset: 0, valid: true }
    });

    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_EVENT_STALE"
    }));
    await vi.waitFor(() => expect(fixture.order).toContain("window-destroy-submitted"));
    expect(fixture.order.slice(-3)).toEqual([
      "input-host-close",
      "controller-destroy",
      "window-destroy-submitted"
    ]);
    fixture.windows[0]!.emit("closed");
    await Promise.resolve();
    expect(host.isDestroyed()).toBe(true);
  });

  it("quarantines a native projection without closing before surface compensation", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    fixture.addon.controllers[0]!.projectionRevisionOverride = "stale";
    fixture.addon.controllers[0]!.restoreThrows = true;

    const transaction = host.prepareAppKitProjection!({
      identity: host.appKitIdentity!,
      adapterSequence: 1,
      windowGeneration: 1,
      topologyRevision: 2,
      logicalTabIds: ["tab-1"],
      hiddenTabIds: [],
      tabs: [{
        tabId: "tab-1",
        name: "Role 1",
        phase: "ready",
        tabType: "role",
        audioMuted: false
      }],
      activeTabId: "tab-1",
      roles: [],
      webSurfaces: [],
      workspaceDividers: [],
      windowVisible: true
    });
    expect(() => transaction.commit()).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID"
    }));
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID"
    }));
    expect(fixture.order).not.toContain("window-close-submitted");
    expect(fixture.order).not.toContain("window-destroy-submitted");
    const close = host.close();
    await vi.waitFor(() => expect(fixture.order).toContain("window-destroy-submitted"));
    expect(fixture.order.slice(-3)).toEqual([
      "input-host-close",
      "controller-destroy",
      "window-destroy-submitted"
    ]);
    fixture.windows[0]!.emit("closed");
    await close;
    expect(host.isDestroyed()).toBe(true);
  });

  it("restores a receipt-mismatched mutation to the last verified native projection", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const controller = fixture.addon.controllers[0]!;
    controller.projectionRevisionOverride = "stale";
    const projection = {
      identity: host.appKitIdentity!,
      adapterSequence: 1,
      windowGeneration: 1,
      topologyRevision: 2,
      logicalTabIds: ["tab-1"],
      hiddenTabIds: [],
      tabs: [{
        tabId: "tab-1",
        name: "Role 1 renamed",
        phase: "degraded" as const,
        tabType: "role" as const,
        audioMuted: false
      }],
      activeTabId: "tab-1",
      roles: [],
      webSurfaces: [],
      workspaceDividers: [],
      windowVisible: true
    };
    const failed = host.prepareAppKitProjection!(projection);

    expect(() => failed.commit()).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID"
    }));
    expect(failed.requiresQuarantine()).toBe(false);
    expect(fixture.order).toContain("controller-project-restore");
    expect(fixture.order).not.toContain("window-close-submitted");
    expect(fixture.order).not.toContain("window-destroy-submitted");

    controller.projectionRevisionOverride = undefined;
    const retry = host.prepareAppKitProjection!(projection);
    expect(() => retry.commit()).not.toThrow();
    expect(host.isDestroyed()).toBe(false);
  });

  it("restores the prior verified AppKit projection with a higher native revision", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const projection = {
      identity: host.appKitIdentity!,
      adapterSequence: 1,
      windowGeneration: 1,
      topologyRevision: 2,
      logicalTabIds: ["tab-1"],
      hiddenTabIds: [],
      tabs: [{
        tabId: "tab-1",
        name: "Renamed Role",
        phase: "ready" as const,
        tabType: "role" as const,
        audioMuted: false
      }],
      activeTabId: "tab-1",
      roles: [],
      webSurfaces: [],
      workspaceDividers: [],
      windowVisible: true
    };
    const transaction = host.prepareAppKitProjection!(projection);

    transaction.commit();
    transaction.rollback();
    const replay = host.prepareAppKitProjection!(projection);
    replay.commit();

    expect(fixture.order.filter((item) => item === "controller-project"))
      .toHaveLength(4);
    expect(fixture.order).not.toContain("window-close-submitted");
    expect(fixture.order).not.toContain("window-destroy-submitted");
  });

  it("discards native callbacks already queued behind an exact destroy fence", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    const close = host.close();

    fixture.addon.emit(0, {
      type: "action",
      identity: {
        logicalWindowId: "window-1",
        launchGeneration: "launch-generation-1",
        nativeGeneration: 1
      },
      action: { type: "selectTab", tabId: "tab-1" }
    });

    expect(fixture.onAction).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fixture.order).toContain("window-destroy-submitted"));
    fixture.windows[0]!.emit("closed");
    await expect(close).resolves.toBeUndefined();
  });

  it("does not submit a native close when exact controller detach fails", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));
    fixture.addon.controllers[0]!.destroyResult = false;

    await expect(host.close()).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_CONTROLLER_STALE"
    });
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    expect(fixture.windows[0]!.destroyCalls).toBe(0);
  });

  it("never turns an unfenced external native close into later close success", async () => {
    const fixture = new Fixture();
    const launchTarget = target();
    const host = await fixture.factory.create(launchTarget, tab(launchTarget));

    fixture.windows[0]!.emit("closed");

    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_NATIVE_CLOSE_UNFENCED"
    }));
    await expect(host.close()).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_NATIVE_CLOSE_UNFENCED"
    });
  });

  it("rejects ABI and controller identity mismatches without a fallback host", async () => {
    const order: string[] = [];
    const addon = new FakeAddon(order);
    expect(RION_APPKIT_RUNTIME_ABI_VERSION).toBe(6);
    addon.abiVersion = 1;
    expect(() => new MacosAppKitChromiumRuntimeHostFactory({
      addon,
      displays: {
        displayMatching: () => ({
          id: 7,
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        })
      },
      windows: { create: vi.fn() },
      onAction: vi.fn(),
      onCloseRequested: vi.fn(),
      onError: vi.fn()
    })).toThrow(expect.objectContaining({ code: "ELECTRON_MACOS_APPKIT_ABI_MISMATCH" }));

    const fixture = new Fixture();
    fixture.addon.mismatchIdentity = true;
    const launchTarget = target();
    const creation = fixture.factory.create(launchTarget, tab(launchTarget));
    await Promise.resolve();
    expect(fixture.addon.controllers[0]!.destroyAttempts).toEqual([{
      logicalWindowId: "window-1",
      launchGeneration: "launch-generation-1",
      nativeGeneration: 1
    }]);
    expect(fixture.addon.controllers[0]!.destroyed).toBe(false);
    expect(fixture.windows[0]!.destroyCalls).toBe(1);
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    fixture.windows[0]!.emit("closed");
    await expect(creation).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_CONTROLLER_IDENTITY_MISMATCH"
    });
  });

  it.each([
    "beginInputSurfaceCapture",
    "commitInputSurfaceCapture",
    "cancelInputSurfaceCapture",
    "retireInputSurface"
  ] as const)(
    "rejects an ABI v4 controller missing required %s support",
    async (method) => {
      const fixture = new Fixture();
      const controller = new FakeNativeHost({
        logicalWindowId: "window-1",
        launchGeneration: "launch-generation-1",
        nativeGeneration: 1
      }, fixture.order);
      Object.defineProperty(controller, method, { value: undefined });
      fixture.addon.nextControllerOverride = controller;
      const launchTarget = target();

      const creation = fixture.factory.create(launchTarget, tab(launchTarget));
      await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
      expect(fixture.windows[0]!.closeCalls).toBe(0);
      fixture.windows[0]!.emit("closed");

      await expect(creation).rejects.toMatchObject({
        code: "ELECTRON_MACOS_APPKIT_INPUT_SURFACE_ABI_MISSING"
      });
      expect(controller.destroyed).toBe(true);
    }
  );

  it.each([
    "applyWorkspaceDividerProjection",
    "restoreLastVerifiedWorkspaceDividerProjection"
  ] as const)(
    "rejects an ABI v4 controller missing required %s support",
    async (method) => {
      const fixture = new Fixture();
      const controller = new FakeNativeHost({
        logicalWindowId: "window-1",
        launchGeneration: "launch-generation-1",
        nativeGeneration: 1
      }, fixture.order);
      Object.defineProperty(controller, method, { value: undefined });
      fixture.addon.nextControllerOverride = controller;
      const launchTarget = target();

      const creation = fixture.factory.create(launchTarget, tab(launchTarget));
      await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
      fixture.windows[0]!.emit("closed");

      await expect(creation).rejects.toMatchObject({
        code: "ELECTRON_MACOS_APPKIT_WORKSPACE_DIVIDER_ABI_MISSING"
      });
      expect(controller.destroyed).toBe(true);
    }
  );

  it("closes the provisional BaseWindow when the addon returns no controller", async () => {
    const fixture = new Fixture();
    fixture.addon.invalidControllerResult = true;
    const launchTarget = target();

    const creation = fixture.factory.create(launchTarget, tab(launchTarget));
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    fixture.windows[0]!.emit("closed");

    await expect(creation).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_CONTROLLER_IDENTITY_MISMATCH"
    });
    expect(fixture.addon.controllers[0]!.destroyed).toBe(false);
    expect(fixture.onError).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_NATIVE_CLOSE_UNFENCED"
    }));
  });

  it("never destroys a foreign controller returned for a provisional BaseWindow", async () => {
    const fixture = new Fixture();
    const firstTarget = target();
    const firstHost = await fixture.factory.create(firstTarget, tab(firstTarget));
    const foreignController = fixture.addon.controllers[0]!;
    fixture.addon.nextControllerOverride = foreignController;
    const secondTarget = target({
      windowId: "window-2",
      persistedName: "Game Window 2"
    });
    const secondTab = {
      ...tab(secondTarget),
      tabId: "tab-2",
      sourceId: "role-2",
      attemptGeneration: "launch-generation-2"
    } as EmbeddedTabEffectRecord;

    const creation = fixture.factory.create(secondTarget, secondTab);
    await vi.waitFor(() => expect(fixture.windows[1]!.destroyCalls).toBe(1));
    expect(fixture.windows[1]!.closeCalls).toBe(0);

    expect(foreignController.destroyAttempts).toEqual([{
      logicalWindowId: "window-2",
      launchGeneration: "launch-generation-2",
      nativeGeneration: 1
    }]);
    expect(foreignController.destroyed).toBe(false);
    expect(fixture.windows[0]!.closeCalls).toBe(0);
    expect(fixture.windows[0]!.destroyCalls).toBe(0);
    expect(fixture.factory.resolveInputHost(firstHost)).toMatchObject({
      identity: firstHost.appKitIdentity,
      native: foreignController
    });

    fixture.windows[1]!.emit("closed");
    await expect(creation).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_CONTROLLER_IDENTITY_MISMATCH"
    });
    expect(foreignController.destroyed).toBe(false);
  });
});
