import type {
  BrowserActionRequest,
  BrowserRuntimeRoleRecord,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";
import { CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES } from
  "../src/electron/main/chromiumRoleBrowserDataClearCoordinator";
import { isCoreEffectEventContinuation } from
  "../src/electron/main/coreEffectContinuation";
import {
  browserActionEffect,
  effect,
  globalWebProfile,
  mixedTab,
  rolePaths,
  tab,
  webTab
} from "./support/electronChromiumRuntimeEffectFixtures";
import { FakeChromiumRuntimeEffectHost as FakeHost } from
  "./support/electronChromiumRuntimeEffectHostFixture";
import {
  createTab,
  harness,
  loadRoles,
  loadWebSurfaces
} from "./support/electronChromiumRuntimeEffectExecutorHarness";


describe("Electron Chromium runtime effect executor", () => {
  it("routes all v23 Chrome-import effects through the dedicated coordinator", async () => {
    const subject = harness();
    const importRoleId = "11111111-1111-4111-8111-111111111111";
    const importEffect = effect(importRoleId, {
      type: "chromeProfileImportCommit",
      transactionId: "22222222-2222-4222-8222-222222222222",
      roleId: importRoleId,
      chromiumUserDataDir: `/RionData/roles/${importRoleId}/browser/chromium`,
      journalPhase: "metadataCommitted",
      journalRevision: 7n
    });
    const controller = new AbortController();
    await expect(subject.executor.execute(importEffect, { signal: controller.signal }))
      .resolves.toEqual({ status: "applied" });
    expect(subject.executeChromeProfileImport).toHaveBeenCalledWith(
      importEffect, controller.signal
    );
  });

  it("clears global Web only with the Core operation and exact Chromium receipt", async () => {
    const subject = harness();
    const profile = globalWebProfile();
    const clear = effect("global-web", {
      type: "globalWebProfileClear",
      profile
    }, "clear-global-web");

    await expect(subject.executor.execute(clear)).resolves.toEqual({
      operationId: "clear-global-web-operation",
      profile,
      status: "applied"
    });
    expect(subject.clearGlobalWebBrowserData).toHaveBeenCalledWith({
      operationId: "clear-global-web-operation",
      profile
    });

    await expect(subject.executor.execute(effect("confused", {
      type: "globalWebProfileClear",
      profile
    }, "clear-global-confused"))).rejects.toMatchObject({
      code: "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_EFFECT_IDENTITY_MISMATCH"
    });
    subject.clearGlobalWebBrowserData.mockResolvedValueOnce({
      status: "applied",
      receipt: {
        profileKey: "global-web",
        operationId: "wrong-operation",
        clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
        cookieReadbackCount: 0,
        evidence: "electron-clear-storage-data-promise-and-cookie-readback"
      }
    });
    await expect(subject.executor.execute(effect("global-web", {
      type: "globalWebProfileClear",
      profile
    }, "clear-global-bad-receipt"))).rejects.toMatchObject({
      code: "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_RECEIPT_INVALID"
    });

    const liveWeb = webTab();
    await createTab(subject, liveWeb);
    await loadWebSurfaces(subject, liveWeb);
    subject.clearGlobalWebBrowserData.mockClear();
    await expect(subject.executor.execute(effect("global-web", {
      type: "globalWebProfileClear",
      profile
    }, "clear-global-live"))).rejects.toMatchObject({
      code: "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_SESSION_ACTIVE"
    });
    expect(subject.clearGlobalWebBrowserData).not.toHaveBeenCalled();
  });

  it("clears the exact resolved v23 role only after v22 identity fences match", async () => {
    const subject = harness();
    const paths = rolePaths("role-1");
    const clearEffect = effect("role-1", {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: paths.webview2UserDataDir,
      webkitDataStoreIdentifier: paths.webkitDataStoreIdentifier
    }, "clear-role-1");
    const signal = new AbortController().signal;
    await expect(subject.executor.execute(clearEffect, { signal })).resolves.toEqual({
      roleId: "role-1",
      operationId: "clear-role-1-operation",
      clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
      cookieReadbackCount: 0,
      evidence: "electron-clear-storage-data-promise-and-cookie-readback"
    });
    expect(subject.resolvePaths).toHaveBeenCalledWith("role-1");
    expect(subject.clearBrowserData).toHaveBeenCalledWith({
      roleId: "role-1",
      effectId: clearEffect.effectId,
      operationId: "clear-role-1-operation",
      rolePaths: paths
    }, signal);
  });
  it.each([
    ["target", "role-2"],
    ["webview2", "/RionData/roles/role-1/browser/chromium"],
    ["webkit", "role-2"]
  ] as const)("rejects a confused clear %s identity before mutation", async (
    field,
    confusedValue
  ) => {
    const subject = harness();
    const paths = rolePaths("role-1");
    const clearEffect = effect(field === "target" ? confusedValue : "role-1", {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: field === "webview2"
        ? confusedValue
        : paths.webview2UserDataDir,
      webkitDataStoreIdentifier: field === "webkit"
        ? confusedValue
        : paths.webkitDataStoreIdentifier
    }, `clear-confused-${field}`);

    await expect(subject.executor.execute(clearEffect)).rejects.toMatchObject({
      code: field === "target"
        ? "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_EFFECT_IDENTITY_MISMATCH"
        : "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SOURCE_IDENTITY_MISMATCH"
    });
    expect(subject.clearBrowserData).not.toHaveBeenCalled();
  });

  it("rejects clear while the exact role owns a live Chromium surface", async () => {
    const subject = harness();
    await createTab(subject);
    await loadRoles(subject);
    const paths = rolePaths("role-1");

    await expect(subject.executor.execute(effect("role-1", {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: paths.webview2UserDataDir,
      webkitDataStoreIdentifier: paths.webkitDataStoreIdentifier
    }, "clear-active-role"))).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_SESSION_ACTIVE"
    });
    expect(subject.clearBrowserData).not.toHaveBeenCalled();
  });

  it("never turns a failed or indeterminate native clear into a Core receipt", async () => {
    const subject = harness();
    const paths = rolePaths("role-1");
    subject.clearBrowserData.mockResolvedValueOnce({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE",
      mutation: "unknown"
    });

    await expect(subject.executor.execute(effect("role-1", {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: paths.webview2UserDataDir,
      webkitDataStoreIdentifier: paths.webkitDataStoreIdentifier
    }, "clear-indeterminate"))).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RELEASE_INDETERMINATE"
    });
  });

  it("rejects an applied clear that lacks the exact canonical receipt", async () => {
    const subject = harness();
    const paths = rolePaths("role-1");
    subject.clearBrowserData.mockResolvedValueOnce({
      status: "applied",
      receipt: {
        roleId: "role-1",
        operationId: "clear-bad-receipt-operation",
        clearedStorages: ["cookies"],
        cookieReadbackCount: 0,
        evidence: "electron-clear-storage-data-promise-and-cookie-readback"
      }
    });

    await expect(subject.executor.execute(effect("role-1", {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: paths.webview2UserDataDir,
      webkitDataStoreIdentifier: paths.webkitDataStoreIdentifier
    }, "clear-bad-receipt"))).rejects.toMatchObject({
      code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_RECEIPT_INVALID"
    });
  });

  it("creates a Rust-identified host and loads an isolated role surface", async () => {
    const subject = harness();
    const specification = tab();

    await createTab(subject, specification);
    await loadRoles(subject, specification);

    expect(subject.createHost).toHaveBeenCalledWith(
      specification.target,
      specification
    );
    expect(subject.hosts[0]!.initializeAppKitTab).not.toHaveBeenCalled();
    expect(subject.createSurface).toHaveBeenCalledWith(expect.objectContaining({
      roleId: "role-1",
      generation: 1,
      rolePaths: rolePaths("role-1"),
      parent: subject.hosts[0],
      url: "https://role-1.test/play",
      preloadPath: "/Rion/app/out/preload/role.cjs",
      bounds: { x: 0, y: 44, width: 500, height: 656 },
      visible: true,
      zoomFactor: 1,
      audioMuted: false
    }));
    expect(subject.executor.snapshot()).toEqual({
      windows: [{
        windowId: "window-1",
        activeTabId: "tab-1",
        tabIds: ["tab-1"],
        displayId: 101,
        bounds: { x: 120, y: 80, width: 1152, height: 720 },
        visible: true,
        focused: false,
        presentation: "normal",
        windowZoomFactor: 1,
        windowGeneration: 3,
        topologyRevision: 7,
        parentNativeHostId: 1,
        appKitIdentity: subject.hosts[0]!.appKitIdentity,
        target: specification.target
      }],
      tabs: [{
        tabId: "tab-1",
        windowId: "window-1",
        attemptGeneration: specification.attemptGeneration,
        audioMuted: false,
        audible: false
      }],
      roles: [{
        roleId: "role-1",
        tabId: "tab-1",
        windowId: "window-1",
        generation: 1,
        ownerGeneration: 1,
        zoomFactor: 1
      }],
      webSurfaces: []
    });
  });

  it("keeps a saved-window hydration hidden until its exact restore reveal", async () => {
    const subject = harness();
    const specification = tab();
    subject.executor.beginSavedWindowRestore(specification.target.windowId);

    await createTab(subject, specification);
    subject.hosts[0]!.hide();
    subject.hosts[0]!.show.mockClear();
    await loadRoles(subject, specification);

    expect(subject.hosts[0]!.show).not.toHaveBeenCalled();
    expect(subject.hosts[0]!.isVisible()).toBe(false);
    subject.executor.finishSavedWindowRestore(specification.target.windowId);
    expect(subject.hosts[0]!.show).toHaveBeenCalledOnce();
    expect(subject.hosts[0]!.isVisible()).toBe(true);
  });

  it("reveals an initially hidden host only after its role surface is attached", async () => {
    const subject = harness();
    subject.createHost.mockImplementationOnce(async (
      target: EmbeddedTabEffectRecord["target"]
    ) => {
      const host = new FakeHost(target.windowId, 1, target);
      host.visible = false;
      subject.hosts.push(host);
      return host;
    });
    const specification = tab();

    await createTab(subject, specification);
    expect(subject.hosts[0]?.isVisible()).toBe(false);
    expect(subject.hosts[0]?.show).not.toHaveBeenCalled();

    await loadRoles(subject, specification);
    expect(subject.createSurface).toHaveBeenCalledWith(expect.objectContaining({
      roleId: "role-1",
      visible: false
    }));
    expect(subject.hosts[0]?.show).toHaveBeenCalledOnce();
    expect(subject.hosts[0]?.isVisible()).toBe(true);
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    expect(subject.hosts[0]?.releaseAppKitSurfaceAttachment)
      .toHaveBeenCalledWith("tab-1");
  });

  it("releases mixed AppKit presentation only after the final Web surface readback", async () => {
    const subject = harness();
    const specification = mixedTab();
    await createTab(subject, specification);
    const managed = specification.roles[0]!;
    await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedLoadRoles",
      roles: [{
        roleId: managed.role.id,
        resolvedEngine: "chromium",
        url: managed.role.launchUrl,
        zoomFactor: managed.zoomFactor
      }]
    }));
    expect(subject.hosts[0]!.releaseAppKitSurfaceAttachment).not.toHaveBeenCalled();

    let finishWebSurface!: () => void;
    subject.createWebSurface.mockImplementationOnce((input) => new Promise((resolve) => {
      finishWebSurface = () => resolve({
        surfaceId: input.surfaceId,
        slotId: input.slotId,
        generation: input.generation,
        parentId: input.parent.id,
        url: input.url
      });
    }));
    const loading = loadWebSurfaces(subject, specification);
    await vi.waitFor(() => expect(subject.createWebSurface).toHaveBeenCalledOnce());
    expect(subject.hosts[0]!.releaseAppKitSurfaceAttachment).not.toHaveBeenCalled();
    finishWebSurface();
    await loading;
    expect(subject.hosts[0]!.releaseAppKitSurfaceAttachment)
      .toHaveBeenCalledOnce();
    expect(subject.hosts[0]!.releaseAppKitSurfaceAttachment)
      .toHaveBeenCalledWith(specification.tabId);
  });

  it("dispatches browser actions only through the exact native trusted-input fence", async () => {
    const subject = harness();
    await createTab(subject);
    await loadRoles(subject);
    const request: BrowserActionRequest = {
      requestId: "input-request-1",
      roleId: "role-1",
      origin: "macro",
      inputEpoch: 4,
      intent: "normal",
      scheduledAtMs: 1_000,
      deadlineMs: 2_000,
      action: { type: "focus" }
    };

    await expect(subject.executor.execute(browserActionEffect(request)))
      .resolves.toMatchObject({
        requestId: request.requestId,
        roleId: request.roleId,
        surfaceGeneration: 1,
        status: "applied"
      });
    expect(subject.trustedExecute).toHaveBeenCalledWith(request);

    await expect(subject.executor.execute(browserActionEffect(request, {
      target: { kind: "app", handleId: request.roleId }
    }))).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_INPUT_EFFECT_IDENTITY_MISMATCH"
    });
    subject.trustedExecute.mockResolvedValueOnce({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: 2,
      status: "applied",
      completedAtMs: 1_001,
      errorCode: null,
      errorMessage: null,
      confirmedInputNeutrality: true
    });
    await expect(subject.executor.execute(browserActionEffect(request)))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });
  });

  it("loads a Web-only tab through the isolated shared-profile surface registry", async () => {
    const subject = harness();
    const specification = webTab();

    await createTab(subject, specification);
    await loadWebSurfaces(subject, specification);

    expect(subject.resolvePaths).not.toHaveBeenCalled();
    expect(subject.createSurface).not.toHaveBeenCalled();
    expect(subject.createWebSurface).toHaveBeenCalledWith({
      attemptGeneration: "web-tab-1-attempt-1", surfaceId: "web-surface-1",
      slotId: "web-slot-1",
      generation: 1,
      profile: globalWebProfile(),
      parent: subject.hosts[0],
      url: "https://web-surface-1.example.test/start",
      bounds: { x: 0, y: 44, width: 500, height: 656 },
      visible: true,
      zoomFactor: 1.25, audioMuted: false,
      tabId: "web-tab-1", windowGeneration: 3, windowId: "web-window-1"
    });
    expect(subject.executor.snapshot()).toMatchObject({
      roles: [],
      webSurfaces: [{
        surfaceId: "web-surface-1",
        slotId: "web-slot-1",
        tabId: "web-tab-1",
        windowId: "web-window-1",
        generation: 1
      }],
      tabs: [{
        tabId: "web-tab-1",
        windowId: "web-window-1",
        audible: false
      }]
    });
    await expect(subject.executor.execute(effect("global-web", {
      type: "globalWebProfileClear",
      profile: globalWebProfile()
    }, "clear-active-global-web"))).rejects.toMatchObject({
      code: "CHROMIUM_GLOBAL_WEB_BROWSER_DATA_CLEAR_SESSION_ACTIVE"
    });
  });

  it("rejects stale or confused global Web effects before native creation", async () => {
    const subject = harness();
    const specification = webTab();
    await createTab(subject, specification);
    const exact = {
      type: "embeddedLoadWebSurfaces" as const,
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration!,
      profile: globalWebProfile(),
      surfaces: [{
        surfaceId: "web-surface-1",
        slotId: "web-slot-1",
        url: "https://web-surface-1.example.test/start",
        zoomFactor: 1.25,
        resolvedEngine: "chromium" as const
      }]
    };

    await expect(subject.executor.execute(effect("other-tab", exact)))
      .rejects.toMatchObject({
        code: "ELECTRON_GLOBAL_WEB_EFFECT_TARGET_MISMATCH"
      });
    await expect(subject.executor.execute(effect(specification.tabId, {
      ...exact,
      attemptGeneration: "stale-attempt"
    }, "stale-web-attempt"))).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_TAB_STALE"
    });
    await expect(subject.executor.execute(effect(specification.tabId, {
      ...exact,
      surfaces: [{ ...exact.surfaces[0], slotId: "wrong-slot" }]
    }, "confused-web-slot"))).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_EFFECT_INVALID"
    });
    expect(subject.createWebSurface).not.toHaveBeenCalled();
  });

  it("includes exact global Web audible state and closes it before its host", async () => {
    const subject = harness();
    const specification = webTab();
    await createTab(subject, specification);
    await loadWebSurfaces(subject, specification);
    subject.isWebCurrentlyAudible.mockReturnValue(true);

    expect(subject.executor.snapshot().tabs[0]?.audible).toBe(true);
    expect(subject.isWebCurrentlyAudible).toHaveBeenCalledWith(
      "web-surface-1",
      1
    );
    await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab",
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration
    }));

    expect(subject.closeWebSurface).toHaveBeenCalledWith("web-surface-1", 1);
    expect(subject.hosts[0]!.close).toHaveBeenCalledOnce();
    expect(subject.executor.snapshot()).toEqual({
      windows: [], tabs: [], roles: [], webSurfaces: []
    });
  });

  it("retires successful mixed-tab surfaces and retries only the failed native close", async () => {
    const subject = harness();
    const specification = mixedTab();
    await createTab(subject, specification);
    const managed = specification.roles[0]!;
    await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedLoadRoles",
      roles: [{
        roleId: managed.role.id,
        resolvedEngine: "chromium",
        url: managed.role.launchUrl,
        zoomFactor: managed.zoomFactor
      }]
    }));
    await loadWebSurfaces(subject, specification);
    subject.closeWebSurface.mockRejectedValueOnce(new Error("native close unknown"));

    await expect(subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab",
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration
    }, "mixed-close-first"))).rejects.toThrow("native close unknown");
    expect(subject.executor.snapshot()).toMatchObject({
      roles: [],
      webSurfaces: [{ surfaceId: "web-surface-1" }],
      tabs: [{ tabId: specification.tabId }]
    });
    expect(subject.hosts[0]!.close).not.toHaveBeenCalled();

    await expect(subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab",
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration
    }, "mixed-close-retry"))).resolves.toBe(true);
    expect(subject.closeRole).toHaveBeenCalledTimes(1);
    expect(subject.closeWebSurface).toHaveBeenCalledTimes(2);
    expect(subject.hosts[0]!.close).toHaveBeenCalledOnce();
  });

  it("fails closed when v22 emits a System WebView engine", async () => {
    const subject = harness();
    await createTab(subject);

    await expect(loadRoles(subject, tab(), "wkwebview")).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_ENGINE_MISMATCH"
    });
    expect(subject.createSurface).not.toHaveBeenCalled();
  });

  it("reads audible state from each exact live Chromium surface", async () => {
    const subject = harness();
    await createTab(subject);
    await loadRoles(subject);
    subject.isCurrentlyAudible.mockReturnValue(true);

    expect(subject.executor.snapshot().tabs[0]?.audible).toBe(true);
    expect(subject.isCurrentlyAudible).toHaveBeenCalledWith("role-1", 1);
  });

  it("waits for exact overlay readiness and projects fenced role geometry", async () => {
    const subject = harness();
    await createTab(subject);
    await loadRoles(subject);

    await subject.executor.execute(effect("tab-1", {
      type: "embeddedInstallOverlays",
      roleIds: ["role-1"]
    }));
    expect(subject.installOverlays).toHaveBeenCalledOnce();
    expect(subject.installOverlays.mock.calls[0][0]).toEqual(["role-1"]);
    expect(subject.installOverlays.mock.calls[0][1]("role-1")).toBe(1);

    const identity = {
      roleId: "role-1",
      generation: 1,
      frame: {},
      frameToken: "frame-token-1",
      documentInstanceId: "document-1"
    };
    expect(subject.executor.overlayCoordinateContext(identity)).toEqual({
      appliedPageZoom: 1,
      surfaceGeneration: 1,
      topologyRevision: 7
    });
    expect(subject.executor.overlayManagedShortcutIdentity(identity, "keyDown"))
      .toMatchObject({ roleId: "role-1", tabId: "tab-1" });
    subject.executor.overlayActivate(identity);
    expect(subject.hosts[0].focus).toHaveBeenCalledOnce();

    subject.hosts[0].hide();
    expect(() => subject.executor.overlayManagedShortcutIdentity(identity, "keyDown"))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_MANAGED_SHORTCUT_SURFACE_INACTIVE"
      }));
    expect(subject.executor.overlayManagedShortcutIdentity(identity, "keyUp"))
      .toMatchObject({ roleId: "role-1", tabId: "tab-1" });

    await subject.executor.execute(effect("role-1", {
      type: "embeddedDestroyRole",
      roleId: "role-1"
    }));
    expect(subject.retireOverlay).toHaveBeenCalledWith("role-1", 1);
  });

  it("applies shell overlay effects only for their exact live role owner", async () => {
    const subject = harness();
    await createTab(subject);
    await loadRoles(subject);
    const coordinate = {
      anchor: "top-left" as const,
      appliedPageZoom: 0.75,
      referenceViewportHeightPx: 540,
      referenceViewportWidthPx: 960,
      xPercent: 22.27,
      xPx: 285,
      xReferencePx: 214,
      viewportHeightPx: 720,
      viewportWidthPx: 1280,
      yPercent: 0,
      yPx: 0,
      yReferencePx: 0
    };

    await expect(subject.executor.execute(effect("role-1", {
      type: "overlayOpenMacroPage",
      roleId: "role-1"
    }))).resolves.toEqual({ roleId: "role-1" });
    await expect(subject.executor.execute(effect("role-1", {
      type: "overlayCopyCoordinate",
      coordinate
    }))).resolves.toEqual({ coordinate });
    expect(subject.openMacroPage).toHaveBeenCalledWith("role-1");
    expect(subject.copyCoordinate).toHaveBeenCalledWith(coordinate);

    await expect(subject.executor.execute(effect("role-2", {
      type: "overlayOpenMacroPage",
      roleId: "role-1"
    }, "mismatched-overlay"))).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_EFFECT_TARGET_MISMATCH"
    });
    await subject.executor.execute(effect("role-1", {
      type: "embeddedDestroyRole",
      roleId: "role-1"
    }));
    await expect(subject.executor.execute(effect("role-1", {
      type: "overlayCopyCoordinate",
      coordinate
    }, "stale-overlay"))).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_EFFECT_OWNER_STALE"
    });
  });

  it("applies initial and changed audio only to exact Core-owned surfaces", async () => {
    const subject = harness();
    const specification = { ...tab(), audioMuted: true };
    await createTab(subject, specification);
    await loadRoles(subject, specification);

    expect(subject.createSurface).toHaveBeenCalledWith(expect.objectContaining({
      roleId: "role-1",
      generation: 1,
      audioMuted: true
    }));
    const result = await subject.executor.execute(effect("tab-1", {
      type: "embeddedSetTabAudioMuted",
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "tab-1-attempt-1",
      roles: [{ roleId: "role-1", ownerGeneration: 1 }],
      webSurfaces: [],
      previousMuted: true,
      muted: false
    }));

    expect(subject.setAudioMuted).toHaveBeenCalledWith("role-1", 1, false);
    expect(subject.audioStates.get("role-1:1")).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "tab-1-attempt-1",
      muted: false
    }));
  });

  it("mutes a Web-only tab through its separate surface and slot fence", async () => {
    const subject = harness();
    const specification = webTab();
    await createTab(subject, specification);
    await loadWebSurfaces(subject, specification);

    const result = await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedSetTabAudioMuted",
      tabId: specification.tabId,
      windowId: specification.target.windowId,
      attemptGeneration: specification.attemptGeneration!,
      roles: [],
      webSurfaces: [{ surfaceId: "web-surface-1", slotId: "web-slot-1" }],
      previousMuted: false,
      muted: true
    }));
    expect(subject.setWebAudioMuted).toHaveBeenCalledWith(
      "web-surface-1",
      1,
      true
    );
    expect(result).toMatchObject({
      muted: true,
      roles: [],
      webSurfaces: [{ surfaceId: "web-surface-1", slotId: "web-slot-1" }]
    });

    subject.setWebAudioMuted.mockClear();
    await expect(subject.executor.execute(effect(specification.tabId, {
      type: "embeddedSetTabAudioMuted",
      tabId: specification.tabId,
      windowId: specification.target.windowId,
      attemptGeneration: specification.attemptGeneration!,
      roles: [],
      webSurfaces: [{ surfaceId: "web-surface-1", slotId: "wrong-slot" }],
      previousMuted: true,
      muted: false
    }, "confused-web-audio"))).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_AUDIO_STALE"
    });
    expect(subject.setWebAudioMuted).not.toHaveBeenCalled();
  });

  it("rejects stale audio attempts and owner generations before native mutation", async () => {
    const subject = harness();
    const specification = tab();
    await createTab(subject, specification);
    await loadRoles(subject, specification);
    subject.setAudioMuted.mockClear();

    await expect(subject.executor.execute(effect("tab-1", {
      type: "embeddedSetTabAudioMuted",
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "stale-attempt",
      roles: [{ roleId: "role-1", ownerGeneration: 1 }],
      webSurfaces: [],
      previousMuted: false,
      muted: true
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_AUDIO_STALE" });
    await expect(subject.executor.execute(effect("tab-1", {
      type: "embeddedSetTabAudioMuted",
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "tab-1-attempt-1",
      roles: [{ roleId: "role-1", ownerGeneration: 2 }],
      webSurfaces: [],
      previousMuted: false,
      muted: true
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_AUDIO_STALE" });
    expect(subject.setAudioMuted).not.toHaveBeenCalled();
  });

  it("restores every attempted surface when an audio fan-out fails", async () => {
    const subject = harness();
    const specification = tab("tab-1", "window-1", ["role-1", "role-2"]);
    await createTab(subject, specification);
    await loadRoles(subject, specification);
    subject.setAudioMuted.mockImplementation(
      (roleId: string, generation: number, muted: boolean) => {
        if (roleId === "role-2" && muted) throw new Error("native rejection");
        subject.audioStates.set(`${roleId}:${generation}`, muted);
      }
    );

    await expect(subject.executor.execute(effect("tab-1", {
      type: "embeddedSetTabAudioMuted",
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "tab-1-attempt-1",
      roles: [
        { roleId: "role-1", ownerGeneration: 1 },
        { roleId: "role-2", ownerGeneration: 1 }
      ],
      webSurfaces: [],
      previousMuted: false,
      muted: true
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_AUDIO_APPLY_FAILED" });
    expect(subject.audioStates.get("role-1:1")).toBe(false);
    expect(subject.audioStates.get("role-2:1")).toBe(false);
  });

  it("reports shell-neutral indeterminate evidence when native rollback fails", async () => {
    const subject = harness();
    const specification = tab("tab-1", "window-1", ["role-1", "role-2"]);
    await createTab(subject, specification);
    await loadRoles(subject, specification);
    subject.setAudioMuted.mockImplementation(
      (roleId: string, generation: number, muted: boolean) => {
        if ((roleId === "role-2" && muted) || (roleId === "role-1" && !muted)) {
          throw new Error("native rejection");
        }
        subject.audioStates.set(`${roleId}:${generation}`, muted);
      }
    );

    await expect(subject.executor.execute(effect("tab-1", {
      type: "embeddedSetTabAudioMuted",
      tabId: "tab-1",
      windowId: "window-1",
      attemptGeneration: "tab-1-attempt-1",
      roles: [
        { roleId: "role-1", ownerGeneration: 1 },
        { roleId: "role-2", ownerGeneration: 1 }
      ],
      webSurfaces: [],
      previousMuted: false,
      muted: true
    }))).rejects.toMatchObject({ code: "BROWSER_RUNTIME_AUDIO_ROLLBACK_FAILED" });
    expect(subject.audioStates.get("role-1:1")).toBe(true);
    expect(subject.audioStates.get("role-2:1")).toBe(false);
  });

  it("retires a failed page before a retry receives a new native generation", async () => {
    let attempt = 0;
    const subject = harness(async (input) => {
      attempt += 1;
      if (attempt === 1) throw new Error("main-frame load failed");
      return {
        roleId: input.roleId,
        generation: input.generation,
        parentId: input.parent.id,
        url: input.url
      };
    });
    const specification = tab();
    await createTab(subject, specification);

    await expect(loadRoles(subject, specification)).rejects.toThrow("main-frame load failed");
    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    await loadRoles(subject, specification);

    expect(subject.createSurface.mock.calls.map(([input]) => input.generation)).toEqual([1, 2]);
    expect(subject.executor.snapshot().roles[0]?.generation).toBe(2);
  });

  it("retires an opening Role surface when Core cancels its event-bound load", async () => {
    let rejectCreation!: (error: unknown) => void;
    const subject = harness(() => new Promise((_resolve, reject) => {
      rejectCreation = reject;
    }));
    subject.closeRole.mockImplementation(async () => {
      rejectCreation(new Error("cancelled opening surface"));
      return true;
    });
    const specification = tab();
    await createTab(subject, specification);
    const controller = new AbortController();
    const loading = subject.executor.execute(effect(
      specification.tabId,
      {
        type: "embeddedLoadRoles",
        roles: specification.roles.map((role) => ({
          roleId: role.role.id,
          resolvedEngine: "chromium",
          url: role.role.launchUrl,
          zoomFactor: role.zoomFactor
        }))
      }
    ), { signal: controller.signal });
    await vi.waitFor(() => expect(subject.createSurface).toHaveBeenCalledOnce());

    controller.abort("coreCancelled");

    await expect(loading).rejects.toThrow("cancelled opening surface");
    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    expect(subject.executor.snapshot().roles).toEqual([]);
  });

  it("retires an opening Web surface when Core cancels its event-bound load", async () => {
    const subject = harness();
    let rejectCreation!: (error: unknown) => void;
    subject.createWebSurface.mockImplementationOnce(() =>
      new Promise((_resolve, reject) => {
        rejectCreation = reject;
      })
    );
    subject.closeWebSurface.mockImplementation(async () => {
      rejectCreation(new Error("cancelled opening Web surface"));
      return true;
    });
    const specification = webTab();
    await createTab(subject, specification);
    const controller = new AbortController();
    const action = {
      type: "embeddedLoadWebSurfaces" as const,
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration!,
      profile: globalWebProfile(),
      surfaces: specification.roles
        .filter((role) => role.web !== undefined)
        .map((role) => ({
          surfaceId: role.role.id,
          slotId: specification.slots.find(
            (slot) => slot.role.id === role.role.id
          )!.slotId,
          url: role.web!.startUrl,
          zoomFactor: role.zoomFactor,
          resolvedEngine: "chromium" as const
        }))
    };
    const loading = subject.executor.execute(
      effect(specification.tabId, action),
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(subject.createWebSurface).toHaveBeenCalledOnce());

    controller.abort("coreCancelled");

    await expect(loading).rejects.toThrow("cancelled opening Web surface");
    expect(subject.closeWebSurface).toHaveBeenCalledWith("web-surface-1", 1);
    expect(subject.executor.snapshot().webSurfaces).toEqual([]);
  });

  it("keeps one active tab visible and follows Core focus ownership", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    const second = tab("tab-2", "window-1", ["role-2"]);
    await createTab(subject, first);
    await loadRoles(subject, first);
    await createTab(subject, second);
    await loadRoles(subject, second);
    subject.setVisible.mockClear();

    const execution = await subject.executor.execute(effect("window-1", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [
        {
          roleId: "role-1",
          runtime: "embedded",
          owner: { tabId: "tab-1", slotId: "slot-1", generation: 1 },
          state: "running"
        },
        {
          roleId: "role-2",
          runtime: "embedded",
          owner: { tabId: "tab-2", slotId: "slot-1", generation: 1 },
          state: "running"
        }
      ],
      windows: [{
        windowId: "window-1",
        windowGeneration: 3,
        topologyRevision: 7,
        tabIds: ["tab-1", "tab-2"],
        tabPhases: [
          { tabId: "tab-1", phase: "ready" },
          { tabId: "tab-2", phase: "ready" }
        ],
        hiddenTabIds: [],
        activeTabId: "tab-2"
      }],
      revealWindowIds: ["window-1"],
      focusWindowIds: ["window-1"],
      focusTabId: "tab-1"
    }));
    expect(isCoreEffectEventContinuation(execution)).toBe(true);
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing continuation");
    await expect(execution.completion).resolves.toMatchObject({
      lifecycleEpoch: 1,
      status: "applied"
    });

    expect(subject.hosts[0].showInactive).toHaveBeenCalled();
    expect(subject.hosts[0].focus).toHaveBeenCalled();
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    expect(subject.setVisible).toHaveBeenCalledWith("role-2", 1, false);
    expect(subject.executor.snapshot().windows[0]?.activeTabId).toBe("tab-1");
  });

  it("quarantines exact native ownership after Applied visibility placeholder failure", async () => {
    const subject = harness(), specification = tab("tab-1", "window-1", ["role-1"]);
    await createTab(subject, specification); await loadRoles(subject, specification);
    const host = subject.hosts[0]!;
    subject.reconcileRolePlaceholders.mockClear().mockRejectedValueOnce(new Error("failed"));
    const execution = await subject.executor.execute(effect("window-1", { type: "embeddedSetRuntimeWindowVisibility", lifecycleEpoch: 1,
      windowId: "window-1", windowGeneration: 3, topologyRevision: 7, appkitIdentity: host.appKitIdentity, visible: false }, "visibility-placeholder-failure"));
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing continuation");
    await expect(execution.completion).rejects.toMatchObject({ code: "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED" });
    expect(host.hide).toHaveBeenCalledOnce(); expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, false);
    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1); expect(host.close).toHaveBeenCalledOnce();
    expect(subject.reconcileRolePlaceholders).toHaveBeenCalledTimes(2); expect(subject.executor.snapshot()).toMatchObject({ windows: [], tabs: [], roles: [] });
  });

  it("reveals every projected window without creating competing focus owners", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    const second = tab("tab-2", "window-2", ["role-2"]);
    await createTab(subject, first);
    await createTab(subject, second);
    for (const host of subject.hosts) {
      host.hide();
      host.showInactive.mockClear();
      host.focus.mockClear();
    }
    const native = subject.executor.snapshot();
    const execution = await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: native.windows.map((window) => ({
        windowId: window.windowId,
        windowGeneration: window.windowGeneration,
        topologyRevision: window.topologyRevision,
        tabIds: [...window.tabIds],
        tabPhases: window.tabIds.map((tabId) => ({ tabId, phase: "ready" as const })),
        hiddenTabIds: [],
        activeTabId: window.activeTabId
      })),
      revealWindowIds: native.windows.map((window) => window.windowId),
      focusWindowIds: []
    }));
    expect(isCoreEffectEventContinuation(execution)).toBe(true);
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing continuation");
    await expect(execution.completion).resolves.toMatchObject({
      status: "applied",
      windows: [expect.any(Object), expect.any(Object)]
    });
    for (const host of subject.hosts) {
      expect(host.showInactive).toHaveBeenCalledOnce();
      expect(host.focus).not.toHaveBeenCalled();
    }
  });

  it("rejects omitted and duplicated AppKit phase window projections", async () => {
    const subject = harness();
    const specification = tab("tab-1", "window-1", ["role-1"]);
    await createTab(subject, specification);
    await loadRoles(subject, specification);
    const projected = {
      windowId: "window-1",
      windowGeneration: 3,
      topologyRevision: 7,
      tabIds: ["tab-1"],
      tabPhases: [{ tabId: "tab-1", phase: "ready" as const }],
      hiddenTabIds: [],
      activeTabId: "tab-1"
    };
    const base = {
      type: "embeddedFollowRoleOwnership" as const,
      lifecycleEpoch: 1,
      roles: [],
      revealWindowIds: [],
      focusWindowIds: []
    };
    await expect(subject.executor.execute(effect("window-1", {
      ...base,
      windows: []
    }))).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INCOMPLETE"
    });
    await expect(subject.executor.execute(effect("window-1", {
      ...base,
      windows: [projected, projected]
    }))).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INVALID"
    });
  });

  it("does not let an unrelated superseded AppKit projection reject an exact focus", async () => {
    const subject = harness();
    await createTab(subject, tab("tab-1", "window-1", ["role-1"]));
    await createTab(subject, tab("tab-2", "window-2", ["role-2"]));
    const initialWindows = subject.executor.snapshot().windows;
    const project = (
      window: typeof initialWindows[number],
      topologyRevision = window.topologyRevision
    ) => ({
      windowId: window.windowId,
      windowGeneration: window.windowGeneration,
      topologyRevision,
      tabIds: [...window.tabIds],
      tabPhases: window.tabIds.map((tabId) => ({
        tabId,
        phase: "ready" as const
      })),
      hiddenTabIds: [],
      activeTabId: window.activeTabId
    });
    const firstWindow = initialWindows.find(
      (window) => window.windowId === "window-1"
    )!;
    const secondWindow = initialWindows.find(
      (window) => window.windowId === "window-2"
    )!;
    const staleFirstProjection = project(firstWindow);
    const secondProjection = project(secondWindow);

    await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: [
        project(firstWindow, firstWindow.topologyRevision + 1),
        secondProjection
      ],
      revealWindowIds: [],
      focusWindowIds: []
    }));

    const execution = await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: [staleFirstProjection, secondProjection],
      revealWindowIds: ["window-2"],
      focusWindowIds: ["window-2"],
      focusTabId: "tab-2"
    }));
    if (!isCoreEffectEventContinuation(execution)) {
      throw new Error("missing continuation");
    }
    await expect(execution.completion).resolves.toMatchObject({ status: "applied" });
    expect(subject.hosts[1]?.focus).toHaveBeenCalledOnce();
    expect(subject.hosts[0]?.applyAppKitPhaseProjection).toHaveBeenCalledOnce();
  });

  it("rejects a superseded AppKit projection for the exact focus target", async () => {
    const subject = harness();
    await createTab(subject, tab("tab-1", "window-1", ["role-1"]));
    const window = subject.executor.snapshot().windows[0]!;
    const projection = {
      windowId: window.windowId,
      windowGeneration: window.windowGeneration,
      topologyRevision: window.topologyRevision,
      tabIds: [...window.tabIds],
      tabPhases: window.tabIds.map((tabId) => ({
        tabId,
        phase: "ready" as const
      })),
      hiddenTabIds: [],
      activeTabId: window.activeTabId
    };
    const base = {
      type: "embeddedFollowRoleOwnership" as const,
      lifecycleEpoch: 1,
      roles: [],
      revealWindowIds: [] as string[],
      focusWindowIds: [] as string[]
    };
    await subject.executor.execute(effect("embedded-runtime", {
      ...base,
      windows: [{
        ...projection,
        topologyRevision: projection.topologyRevision + 1
      }]
    }));

    await expect(subject.executor.execute(effect("embedded-runtime", {
      ...base,
      windows: [projection],
      revealWindowIds: ["window-1"],
      focusWindowIds: ["window-1"],
      focusTabId: "tab-1"
    }))).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_OWNERSHIP_FENCE_STALE"
    });
  });

  it("keeps the visible blocked slot until Core returns terminal ownership", async () => {
    const subject = harness();
    const source = tab("source-tab", "source-window", ["role-1"]);
    const target = tab("target-tab", "target-window", ["role-1"]);
    target.slots[0] = {
      ...target.slots[0]!,
      state: "blocked",
      owner: { tabId: "source-tab", slotId: "slot-1", generation: 1 }
    };
    await createTab(subject, source);
    await loadRoles(subject, source);
    await createTab(subject, target);
    await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1,
      roles: [{ roleId: "role-1", runtime: "embedded", state: "running",
        owner: { tabId: source.tabId, slotId: "slot-1", generation: 1 } }],
      windows: [source, target].map(specification => ({
        windowId: specification.target.windowId, windowGeneration: 3, topologyRevision: 7,
        tabIds: [specification.tabId], hiddenTabIds: [], activeTabId: specification.tabId,
        tabPhases: [{ tabId: specification.tabId, phase: "ready" as const }]
      })), revealWindowIds: [], focusWindowIds: []
    }));
    const beforeClaim = subject.reconcileRolePlaceholders.mock.calls.at(-1)?.[0];
    expect(beforeClaim).toEqual([
      expect.objectContaining({ tabId: "target-tab", ownerGeneration: 1 })
    ]);

    await subject.executor.execute(effect("role-1", {
      type: "embeddedDestroyRole",
      roleId: "role-1"
    }));
    const claimedSlot = {
      ...target.slots[0]!,
      state: "launching" as const,
      owner: { tabId: "target-tab", slotId: "slot-1", generation: 2 }
    };
    await subject.executor.execute(effect("target-tab", {
      type: "embeddedClaimRoleSlot",
      tabId: "target-tab",
      slot: claimedSlot,
      role: target.roles[0]!
    }));
    expect(subject.reconcileRolePlaceholders.mock.calls.at(-1)?.[0])
      .toEqual(beforeClaim);
    await loadRoles(subject, { ...target, slots: [claimedSlot] });

    const terminalRoles: BrowserRuntimeRoleRecord[] = [{
      roleId: "role-1",
      runtime: "embedded",
      owner: { tabId: "target-tab", slotId: "slot-1", generation: 2 },
      state: "running",
      launchedAt: "2026-08-31T00:00:00Z"
    }];
    await subject.executor.commitTerminalRoleOwnership(terminalRoles);

    expect(subject.executor.snapshot().roles).toEqual([
      expect.objectContaining({
        roleId: "role-1",
        tabId: "target-tab",
        ownerGeneration: 2
      })
    ]);
    expect(subject.reconcileRolePlaceholders.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ tabId: "source-tab", ownerGeneration: 2 })
    ]);
  });

  it("creates an empty saved window only from an exact event-bound Core projection", async () => {
    const subject = harness();
    const target = tab("unused-tab", "empty-window", []).target;
    const request = effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: [{
        windowId: "empty-window",
        windowGeneration: 4,
        topologyRevision: 9,
        tabIds: [],
        tabPhases: [],
        hiddenTabIds: []
      }],
      target,
      revealWindowIds: ["empty-window"],
      focusWindowIds: ["empty-window"]
    }, "empty-window-effect");

    await subject.executor.execute(request);

    expect(subject.createHost).not.toHaveBeenCalled();
    expect(subject.createEmptyHost).toHaveBeenCalledWith(target, {
      attemptGeneration: "empty-window-effect", windowGeneration: 4, topologyRevision: 9
    });
    expect(subject.hosts[0]?.showInactive).toHaveBeenCalled();
    expect(subject.hosts[0]?.focus).toHaveBeenCalled();
    expect(subject.executor.snapshot().windows[0]).toMatchObject({
      windowId: "empty-window",
      tabIds: [],
      visible: true,
      windowGeneration: 4,
      topologyRevision: 9,
      appKitIdentity: {
        logicalWindowId: "empty-window",
        launchGeneration: "empty-window-effect",
        nativeGeneration: 1
      }
    });
    await subject.executor.dispose();
    expect(subject.hosts[0]?.close).toHaveBeenCalledOnce();
  });

  it("initializes the first AppKit tab when an existing empty host is populated", async () => {
    const subject = harness();
    const target = tab("unused-tab", "empty-window", []).target;
    await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: [{
        windowId: "empty-window",
        windowGeneration: 4,
        topologyRevision: 9,
        tabIds: [],
        tabPhases: [],
        hiddenTabIds: []
      }],
      target,
      revealWindowIds: ["empty-window"],
      focusWindowIds: ["empty-window"]
    }, "empty-window-effect"));
    const specification = tab("tab-1", "empty-window", ["role-1"]);
    specification.target = target;
    specification.appkitWindowGeneration = 4;
    specification.appkitTopologyRevision = 10;

    await createTab(subject, specification);
    expect(subject.hosts[0]!.initializeAppKitTab).toHaveBeenCalledOnce();
    expect(subject.hosts[0]!.initializeAppKitTab).toHaveBeenCalledWith(specification);

    await loadRoles(subject, specification);
    expect(subject.hosts[0]!.releaseAppKitSurfaceAttachment)
      .toHaveBeenCalledWith("tab-1");
    expect(subject.executor.snapshot().windows[0]).toMatchObject({
      tabIds: ["tab-1"],
      topologyRevision: 10,
      windowGeneration: 4,
      windowId: "empty-window"
    });
  });

  it("destroys a newly provisioned empty host when the same effect cannot complete", async () => {
    const subject = harness();
    const target = tab("unused-tab", "empty-window", []).target;

    await expect(subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      windows: [{
        windowId: "empty-window",
        windowGeneration: 1,
        topologyRevision: 1,
        tabIds: [],
        tabPhases: [],
        hiddenTabIds: []
      }],
      target,
      revealWindowIds: ["empty-window", "missing-window"],
      focusWindowIds: ["empty-window"]
    }, "empty-window-failed-effect"))).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_NOT_FOUND"
    });

    expect(subject.hosts[0]?.close).toHaveBeenCalledOnce();
    expect(subject.executor.snapshot().windows).toEqual([]);
  });

  it("admits a new tab against current native geometry and rejects the stale initial target", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    await createTab(subject, first);
    const host = subject.hosts[0]!;
    host.projection = {
      displayId: 202,
      bounds: { x: 1600, y: 32, width: 1280, height: 800 },
      visible: true,
      focused: false,
      presentation: "maximized"
    };
    const second = tab("tab-2", "window-1", ["role-2"]);
    second.target = {
      windowId: "window-1",
      displayId: 202,
      scaleFactor: 1.5,
      workArea: { x: 1440, y: 0, width: 1600, height: 900 },
      bounds: { ...host.projection.bounds },
      presentation: "maximized"
    };

    await expect(createTab(subject, second)).resolves.toBeUndefined();
    expect(subject.createHost).toHaveBeenCalledOnce();
    expect(host.initializeAppKitTab).toHaveBeenCalledWith(second);

    const stale = tab("tab-3", "window-1", ["role-3"]);
    await expect(createTab(subject, stale)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOW_TARGET_CONFLICT"
    });
    expect(subject.executor.snapshot().tabs.map((item) => item.tabId)).toEqual([
      "tab-1",
      "tab-2"
    ]);
  });

  it("awaits role destruction before closing the last native host", async () => {
    const subject = harness();
    const specification = tab();
    await createTab(subject, specification);
    await loadRoles(subject, specification);

    await subject.executor.execute(effect("tab-1", {
      type: "embeddedDestroyTab",
      tabId: "tab-1"
    }));

    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    expect(subject.managedRetireSurface).toHaveBeenCalledWith("role-1", 1);
    expect(subject.trustedRetireSurface).not.toHaveBeenCalled();
    expect(subject.trustedRetireSurfaceForDestruction)
      .toHaveBeenCalledWith("role-1", 1);
    expect(subject.managedRetireSurface.mock.invocationCallOrder[0])
      .toBeLessThan(
        subject.trustedRetireSurfaceForDestruction.mock.invocationCallOrder[0]!
      );
    expect(subject.trustedRetireSurfaceForDestruction.mock.invocationCallOrder[0])
      .toBeLessThan(subject.closeRole.mock.invocationCallOrder[0]!);
    expect(subject.hosts[0].close).toHaveBeenCalledOnce();
    expect(subject.executor.snapshot()).toEqual({
      windows: [],
      tabs: [],
      roles: [],
      webSurfaces: []
    });
  });

  it("retries an exact failed host close before completing runtime drain", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    const second = tab("tab-2", "window-2", ["role-2"]);
    await createTab(subject, first);
    await loadRoles(subject, first);
    await createTab(subject, second);
    await loadRoles(subject, second);
    subject.hosts[0].close.mockRejectedValueOnce(new Error("host close failed"));

    const firstDispose = subject.executor.dispose();
    const secondDispose = subject.executor.dispose();
    expect(secondDispose).toBe(firstDispose);
    await expect(firstDispose).rejects.toThrow("host close failed");
    expect(subject.executor.snapshot().tabs.map((item) => item.tabId)).toEqual(["tab-1"]);
    await subject.executor.dispose();

    expect(subject.hosts[0].close).toHaveBeenCalledTimes(2);
    expect(subject.hosts[1].close).toHaveBeenCalledOnce();
    expect(subject.disposeSurfaces).toHaveBeenCalledOnce();
    await expect(subject.executor.execute(effect("tab-3", {
      type: "embeddedCreateTab", tab: tab("tab-3", "window-3", ["role-3"])
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_RUNTIME_DRAINING" });
  });

  it("does not reproject sibling visibility while a shared host is draining", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    const second = tab("tab-2", "window-1", ["role-2"]);
    await createTab(subject, first);
    await loadRoles(subject, first);
    await createTab(subject, second);
    await loadRoles(subject, second);
    const visibilityCallsBeforeDrain = subject.setVisible.mock.calls.length;

    await subject.executor.dispose();

    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    expect(subject.closeRole).toHaveBeenCalledWith("role-2", 1);
    expect(subject.setVisible).toHaveBeenCalledTimes(visibilityCallsBeforeDrain);
    expect(subject.executor.snapshot()).toEqual({
      windows: [], tabs: [], roles: [], webSurfaces: []
    });
  });

  it("serializes destruction for tabs sharing one native host", async () => {
    const subject = harness();
    const first = tab("tab-1", "window-1", ["role-1"]);
    const second = tab("tab-2", "window-1", ["role-2"]);
    await createTab(subject, first);
    await loadRoles(subject, first);
    await createTab(subject, second);
    await loadRoles(subject, second);
    let releaseFirst!: (closed: boolean) => void;
    const firstClosed = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    subject.closeRole.mockImplementation(async (roleId: string) =>
      roleId === "role-1" ? firstClosed : true
    );

    const draining = subject.executor.dispose();
    await vi.waitFor(() => {
      expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    });
    expect(subject.closeRole).not.toHaveBeenCalledWith("role-2", 1);
    releaseFirst(true);
    await draining;

    expect(subject.closeRole).toHaveBeenCalledWith("role-2", 1);
    expect(subject.hosts[0]!.close).toHaveBeenCalledOnce();
  });
});
