import { browser, expect } from "@wdio/globals";

import { verifyVisibleChromiumTabAudio } from "./chromium-tab-audio-support";

import type { Role } from "../../../src/shared/types";
import {
  electronDesktopE2eRuntimeTabReload,
  failNextElectronDesktopE2eRuntimeTabReload,
  type ElectronDesktopE2eRuntimeTabReloadInspection
} from "../support/electron-driver";
import { clickVisibleElectronPageElement } from
  "../support/electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { selectMacosVisibleRuntimeTabMenuAction } from
  "../support/macos-appkit-ui";
import {
  installRuntimeTabShellErrorJournal,
  runtimeTabShellErrors,
  selectVisibleWindowsRuntimeTabMenuAction
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  bootstrapChromiumMacroCutover,
  createChromiumMacroWindow,
  launchChromiumRoleVisible,
  macroFixtureUrl
} from "./chromium-macro-cutover-support";

// [journey:CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031]
// [journey:CHROMIUM-WINDOWS-RUNTIME-TAB-RELOAD-031]
// [journey:CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-AUDIO-032]
// [journey:CHROMIUM-WINDOWS-RUNTIME-TAB-AUDIO-032]

const WINDOW_ID = "c8e00000-0000-4000-8000-000000000031";
const WINDOW_NAME = "Chromium Controlled Reload Window";
const GAME_NAME = "Chromium Controlled Reload Game";
const ROLE_NAME = "Chromium Controlled Reload Role";
const ROLE_FIXTURE = "chromium-controlled-role-reload";
const POPUP_FIXTURE = "e2e-workspace-popup";
const INJECTED_FAILURE = "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED";

async function createRole(): Promise<Role> {
  const launchUrl = macroFixtureUrl(ROLE_FIXTURE, "mode=observe");
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: launchUrl,
    name: GAME_NAME
  });
  return rendererCall("createRole", {
    gameId: game.id,
    launchUrl,
    name: ROLE_NAME
  });
}

async function waitForReloads(
  windowId: string,
  count: number,
  platform: "macos" | "windows",
  failures = 0,
  windowsMenuCaptures = count
): Promise<ElectronDesktopE2eRuntimeTabReloadInspection> {
  let inspection: ElectronDesktopE2eRuntimeTabReloadInspection | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eRuntimeTabReload(windowId);
      return inspection.failures.length === failures &&
        inspection.observations.length === count &&
        inspection.windowsMenuCaptures.length ===
          (platform === "windows" ? windowsMenuCaptures : 0);
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Visible controlled Reload ${count} did not reach input-ready`
  });
  return inspection!;
}

async function selectReload(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  tabId: string;
}>): Promise<void> {
  if (input.platform === "macos") {
    await selectMacosVisibleRuntimeTabMenuAction({
      action: "reload",
      tabId: input.tabId,
      tabName: input.role.name,
      windowId: WINDOW_ID
    });
    return;
  }
  await selectVisibleWindowsRuntimeTabMenuAction({
    action: "reload",
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.tabId
  });
}

function stableRoleIdentity(
  inspection: ElectronDesktopE2eRuntimeTabReloadInspection
): unknown {
  return inspection.roles.map((role) => ({
    ownerGeneration: role.ownerGeneration,
    roleId: role.roleId,
    surfaceGeneration: role.surfaceGeneration,
    tabId: role.tabId
  }));
}

function stableNativeWindowIdentity(
  inspection: ElectronDesktopE2eRuntimeTabReloadInspection
): unknown {
  const { topologyRevision: _presentationRevision, ...identity } =
    inspection.nativeWindow;
  return identity;
}

describe("Chromium controlled Role Reload", () => {
  it("reloads twice, fails once, and recovers through visible native menus", async () => {
    const context = await bootstrapChromiumMacroCutover();
    await installRuntimeTabShellErrorJournal();
    const role = await createRole();
    const gameWindow = await createChromiumMacroWindow(WINDOW_ID, WINDOW_NAME);
    const tab = await launchChromiumRoleVisible(role, ROLE_FIXTURE, gameWindow);
    expect(tab.windowId).toBe(WINDOW_ID);

    const popupAfter = await fixtureCursor();
    await clickVisibleElectronPageElement(
      macroFixtureUrl(ROLE_FIXTURE, "mode=observe"),
      context.mainWindowHandle,
      "#contained-fullscreen-popup"
    );
    expect(await waitFixtureEvent({
      afterSequence: popupAfter,
      kind: "contained-popup-requested",
      roleId: ROLE_FIXTURE
    })).toEqual(expect.objectContaining({ isTrusted: true }));
    await waitFixtureEvent({
      afterSequence: popupAfter,
      kind: "contained-popup-ready",
      roleId: POPUP_FIXTURE
    });

    if (context.platform === "macos") {
      // Establish a deterministic foreground precondition. The behavior under
      // test remains the three user-visible AppKit context-menu Reload actions.
      await rendererCall("showGameWindowTab", tab.tabId);
    }

    await verifyVisibleChromiumTabAudio({
      ...context, muted: true, tabId: tab.tabId, tabName: role.name, windowId: WINDOW_ID
    });

    const initial = await waitForReloads(WINDOW_ID, 0, context.platform);
    expect(initial.roles).toHaveLength(1);
    expect(initial.roles[0]).toEqual(expect.objectContaining({
      roleId: role.id,
      tabId: tab.tabId,
      visible: true
    }));
    expect(initial.popups).toHaveLength(1);
    expect(initial.popups[0]).toEqual(expect.objectContaining({ visible: true }));
    if (context.platform === "macos") {
      expect(initial.platform).toBe("darwin");
      expect(initial.nativeWindow).toEqual(expect.objectContaining({
        hostKind: "appkit-chromium",
        appKitIdentity: expect.objectContaining({ logicalWindowId: WINDOW_ID })
      }));
      expect(initial.popups[0]).toEqual(expect.objectContaining({
        hostKind: "appkit-chromium",
        appKitIdentity: expect.objectContaining({
          logicalWindowId: initial.popups[0]!.logicalWindowId
        })
      }));
    } else {
      expect(initial.platform).toBe("win32");
      expect(initial.nativeWindow).toEqual(expect.objectContaining({
        appKitIdentity: null,
        hostKind: "bundled-chromium"
      }));
      expect(initial.popups[0]).toEqual(expect.objectContaining({
        appKitIdentity: null,
        hostKind: "bundled-chromium"
      }));
    }

    await selectReload({ ...context, role, tabId: tab.tabId });
    const first = await waitForReloads(WINDOW_ID, 1, context.platform);
    await selectReload({ ...context, role, tabId: tab.tabId });
    const second = await waitForReloads(WINDOW_ID, 2, context.platform);

    expect(stableNativeWindowIdentity(first)).toEqual(
      stableNativeWindowIdentity(initial)
    );
    expect(stableNativeWindowIdentity(second)).toEqual(
      stableNativeWindowIdentity(initial)
    );
    expect(first.nativeWindow.topologyRevision).toBeGreaterThanOrEqual(
      initial.nativeWindow.topologyRevision
    );
    expect(second.nativeWindow.topologyRevision).toBe(
      first.nativeWindow.topologyRevision
    );
    expect(stableRoleIdentity(first)).toEqual(stableRoleIdentity(initial));
    expect(stableRoleIdentity(second)).toEqual(stableRoleIdentity(initial));
    expect(first.popups).toEqual(initial.popups);
    expect(second.popups).toEqual(initial.popups);

    const [firstReload, secondReload] = second.observations;
    expect(firstReload!.request).toEqual(expect.objectContaining({
      tabId: tab.tabId,
      topologyRevision: first.nativeWindow.topologyRevision,
      windowGeneration: initial.nativeWindow.windowGeneration,
      windowId: WINDOW_ID
    }));
    expect(secondReload!.request).toEqual(expect.objectContaining({
      tabId: tab.tabId,
      topologyRevision: second.nativeWindow.topologyRevision,
      windowGeneration: initial.nativeWindow.windowGeneration,
      windowId: WINDOW_ID
    }));
    const firstRole = firstReload!.receipt.roles[0]!;
    const secondRole = secondReload!.receipt.roles[0]!;
    expect(firstRole.afterDocumentInstanceId).not.toBe(
      firstRole.beforeDocumentInstanceId
    );
    expect(secondRole.beforeDocumentInstanceId).toBe(
      firstRole.afterDocumentInstanceId
    );
    expect(secondRole.afterDocumentInstanceId).not.toBe(
      firstRole.afterDocumentInstanceId
    );
    expect(secondRole.navigationSequence).toBeGreaterThan(
      firstRole.navigationSequence!
    );
    expect(second.roles[0]!.documentInstanceId).toBe(
      secondRole.afterDocumentInstanceId
    );
    expect(second.observations.map(({ receipt }) => receipt.receipt)).toEqual([
      expect.objectContaining({
        completionPolicy: "eventBound",
        completionScope: "inputReady",
        status: "applied",
        subsystem: "navigation"
      }),
      expect.objectContaining({
        completionPolicy: "eventBound",
        completionScope: "inputReady",
        status: "applied",
        subsystem: "navigation"
      })
    ]);
    expect(second.observations.flatMap(({ receipt }) => receipt.roles)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coreInputResumed: true,
          nativeInputResumed: true,
          restartRequired: false,
          status: "applied",
          submissionState: "submitted"
        })
      ])
    );
    if (context.platform === "windows") {
      expect(second.windowsMenuCaptures[1]!.projectionRevision).toBeGreaterThan(
        second.windowsMenuCaptures[0]!.projectionRevision
      );
      expect(second.windowsMenuCaptures.map((capture) => ({
        lifecycleEpoch: capture.lifecycleEpoch,
        tabId: capture.tabId,
        topologyRevision: capture.topologyRevision,
        windowGeneration: capture.windowGeneration,
        windowId: capture.windowId
      }))).toEqual(second.observations.map(({ request }) => ({
        lifecycleEpoch: request.lifecycleEpoch,
        tabId: request.tabId,
        topologyRevision: request.topologyRevision,
        windowGeneration: request.windowGeneration,
        windowId: request.windowId
      })));
    }
    expect(await runtimeTabShellErrors()).toEqual([]);

    await failNextElectronDesktopE2eRuntimeTabReload(WINDOW_ID, tab.tabId);
    await selectReload({ ...context, role, tabId: tab.tabId });
    const failed = await waitForReloads(
      WINDOW_ID,
      2,
      context.platform,
      1,
      3
    );
    await browser.waitUntil(async () =>
      (await runtimeTabShellErrors()).length === 1, {
      interval: 100,
      timeout: 10_000,
      timeoutMsg: "Injected visible Reload did not publish one shell error"
    });
    expect(await runtimeTabShellErrors()).toEqual([{
      code: INJECTED_FAILURE,
      message: "The desktop E2E harness injected one controlled Reload failure."
    }]);
    expect(failed.observations).toEqual(second.observations);
    expect(stableNativeWindowIdentity(failed)).toEqual(
      stableNativeWindowIdentity(second)
    );
    expect(failed.nativeWindow.topologyRevision).toBeGreaterThanOrEqual(
      second.nativeWindow.topologyRevision
    );
    expect(second.roles.every((role) => role.audioMuted)).toBe(true);
    expect(failed.roles).toEqual(second.roles);
    expect(failed.popups).toEqual(second.popups);
    expect(failed.failures).toEqual([
      expect.objectContaining({
        failureCode: INJECTED_FAILURE,
        request: expect.objectContaining({
          lifecycleEpoch: secondReload!.request.lifecycleEpoch,
          tabId: tab.tabId,
          topologyRevision: secondReload!.request.topologyRevision,
          windowGeneration: secondReload!.request.windowGeneration,
          windowId: WINDOW_ID
        }),
        sequence: 1
      })
    ]);
    if (context.platform === "windows") {
      const failedCapture = failed.windowsMenuCaptures[2]!;
      expect(failed.failures[0]!.menuProjectionRevision).toBe(
        failedCapture.projectionRevision
      );
      expect(failedCapture.projectionRevision).toBeGreaterThan(
        second.windowsMenuCaptures[1]!.projectionRevision
      );
      expect(failedCapture).toEqual(expect.objectContaining({
        lifecycleEpoch: failed.failures[0]!.request.lifecycleEpoch,
        tabId: failed.failures[0]!.request.tabId,
        topologyRevision: failed.failures[0]!.request.topologyRevision,
        windowGeneration: failed.failures[0]!.request.windowGeneration,
        windowId: failed.failures[0]!.request.windowId
      }));
    } else {
      expect(failed.failures[0]!.menuProjectionRevision).toBeNull();
    }

    await selectReload({ ...context, role, tabId: tab.tabId });
    const recovered = await waitForReloads(
      WINDOW_ID,
      3,
      context.platform,
      1,
      4
    );
    const recoveredRole = recovered.observations[2]!.receipt.roles[0]!;
    expect(recoveredRole.beforeDocumentInstanceId).toBe(
      secondRole.afterDocumentInstanceId
    );
    expect(recoveredRole.afterDocumentInstanceId).not.toBe(
      secondRole.afterDocumentInstanceId
    );
    expect(recoveredRole.navigationSequence).toBeGreaterThan(
      secondRole.navigationSequence!
    );
    expect(stableRoleIdentity(recovered)).toEqual(stableRoleIdentity(second));
    expect(stableNativeWindowIdentity(recovered)).toEqual(
      stableNativeWindowIdentity(second)
    );
    expect(recovered.nativeWindow.topologyRevision).toBeGreaterThanOrEqual(
      failed.nativeWindow.topologyRevision
    );
    expect(recovered.popups).toEqual(second.popups);
    expect(recovered.roles.every((role) => role.audioMuted)).toBe(true);
    await verifyVisibleChromiumTabAudio({
      ...context, muted: false, tabId: tab.tabId, tabName: role.name, windowId: WINDOW_ID
    });
    expect(await runtimeTabShellErrors()).toHaveLength(1);
  });
});
