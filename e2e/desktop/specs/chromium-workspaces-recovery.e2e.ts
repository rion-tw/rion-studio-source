import { browser, expect } from "@wdio/globals";

import type { EmbeddedRuntimeTabSummary } from "../../../src/shared/types";
import { electronDesktopE2eProbe, electronDesktopE2eRolePlaceholderRuntime } from
  "../support/electron-driver";
import { clickVisibleElectronPageElement } from
  "../support/electron-role-surface";
import { fixtureCursor, fixtureRequest, waitFixtureEvent } from
  "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import { closeLoadingWindowsRuntimeTab } from "../support/windows-runtime-tab-close";
import {
  createCutoverGame,
  createCutoverRole,
  createCutoverRoleWorkspace,
  cutoverFixtureUrl,
  openCutoverWorkspace,
  prepareWorkspaceCutover,
  requiredCutoverEnvironment,
  stopCutoverWindow,
  waitCutoverWorkspaceTab
} from "../support/chromium-workspace-cutover";

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026]
// [journey:CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026]

const GAME_NAME = "Chromium Workspaces Recovery Game";
const HEALTHY_ROLE_NAME = "Chromium Workspaces Recovery Healthy";
const FAILING_ROLE_NAME = "Chromium Workspaces Recovery Failing";
const WORKSPACE_NAME = "Chromium Workspaces Recovery";
const HEALTHY_FIXTURE = "chromium-workspaces-recovery-healthy";
const FAILING_FIXTURE = "chromium-workspaces-recovery-failing";

type RoleInspection = Awaited<ReturnType<
  typeof electronDesktopE2eRolePlaceholderRuntime
>>;

async function waitFixturePath(path: string): Promise<void> {
  const response = await fetch(
    `${requiredCutoverEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`,
    { signal: AbortSignal.timeout(55_000) }
  );
  if (!response.ok) throw new Error(`Fixture path ${path} failed with ${response.status}`);
}

async function waitRoleInspection(
  roleId: string,
  accept: (inspection: RoleInspection) => boolean,
  outcome: string
): Promise<RoleInspection> {
  let inspection: RoleInspection | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eRolePlaceholderRuntime(roleId);
      return accept(inspection);
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Role ${roleId} did not reach ${outcome}`
  });
  return inspection!;
}

function expectExactNativeOwner(
  inspection: RoleInspection,
  platform: "macos" | "windows"
): void {
  expect(inspection.nativeOwner).toEqual(expect.objectContaining({
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    ownerGeneration: inspection.coreOwner.generation,
    roleId: inspection.roleId,
    tabId: inspection.coreOwner.tabId,
    visible: true,
    windowId: inspection.coreOwner.windowId
  }));
  expect(inspection.nativeOwner.parentNativeHostId).toBeGreaterThan(0);
  if (platform === "macos") {
    expect(inspection.nativeOwner.appKitIdentity).toEqual(expect.objectContaining({
      launchGeneration: inspection.nativeOwner.attemptGeneration,
      logicalWindowId: inspection.nativeOwner.windowId
    }));
  } else {
    expect(inspection.nativeOwner.appKitIdentity).toBeNull();
  }
}

async function waitWorkspaceTab(workspaceId: string): Promise<EmbeddedRuntimeTabSummary> {
  let tab: EmbeddedRuntimeTabSummary | undefined;
  await browser.waitUntil(async () => {
    tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
      (candidate) => candidate.sourceId === workspaceId && candidate.type === "workspace"
    );
    return tab !== undefined;
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Workspace ${workspaceId} did not expose a cancellable runtime tab`
  });
  return tab!;
}

describe("Chromium Workspace navigation-failure recovery exact replacement", () => {
  it("isolates one failed Role and requires visible stop, relaunch, and cancel", async () => {
    const input = await prepareWorkspaceCutover();
    const phase = requiredCutoverEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase !== "chromium-workspaces-recovery") {
      throw new Error(`Unexpected Workspace recovery phase ${phase}`);
    }
    const game = await createCutoverGame(
      GAME_NAME,
      cutoverFixtureUrl(HEALTHY_FIXTURE)
    );
    const healthyRole = await createCutoverRole(
      game,
      HEALTHY_ROLE_NAME,
      cutoverFixtureUrl(HEALTHY_FIXTURE)
    );
    const failingRole = await createCutoverRole(
      game,
      FAILING_ROLE_NAME,
      cutoverFixtureUrl(FAILING_FIXTURE)
    );
    const workspace = await createCutoverRoleWorkspace(
      WORKSPACE_NAME,
      [healthyRole, failingRole]
    );

    await openCutoverWorkspace(workspace);
    const initialTab = await waitCutoverWorkspaceTab(workspace, [
      { roleId: healthyRole.id, state: "running" },
      { roleId: failingRole.id, state: "running" }
    ]);
    const healthyBefore = await waitRoleInspection(
      healthyRole.id,
      (inspection) => inspection.phase === "ready" &&
        inspection.coreStatus.issueReason === null,
      "healthy ready ownership"
    );
    const failingBefore = await waitRoleInspection(
      failingRole.id,
      (inspection) => inspection.phase === "ready" &&
        inspection.coreStatus.issueReason === null,
      "failing Role initial ready ownership"
    );
    expect(healthyBefore.placeholders).toEqual([]);
    expect(failingBefore.placeholders).toEqual([]);
    expectExactNativeOwner(healthyBefore, input.platform);
    expectExactNativeOwner(failingBefore, input.platform);
    expect(healthyBefore.coreOwner.tabId).toBe(initialTab.id);
    expect(failingBefore.coreOwner.tabId).toBe(initialTab.id);

    await fixtureRequest("/api/navigation-failure", {
      enabled: true,
      roleId: FAILING_FIXTURE
    });
    try {
      const navigationCursor = await fixtureCursor();
      await clickVisibleElectronPageElement(
        failingRole.launchUrl,
        input.mainWindowHandle,
        "#active-navigation-failure"
      );
      expect(await waitFixtureEvent({
        afterSequence: navigationCursor,
        kind: "navigation-requested",
        roleId: FAILING_FIXTURE
      })).toEqual(expect.objectContaining({
        isTrusted: true,
        targetId: "active-navigation-failure"
      }));
      await waitFixturePath(
        `/api/navigation-failures/${FAILING_FIXTURE}/attempted`
      );

      const failingAfter = await waitRoleInspection(
        failingRole.id,
        (inspection) => inspection.phase === "degraded" &&
          inspection.coreStatus.issueReason === "runtime-crashed",
        "authoritative degraded navigation failure"
      );
      expect(failingAfter.coreStatus).toEqual(expect.objectContaining({
        automationState: "unavailable",
        issueReason: "runtime-crashed",
        state: "running"
      }));
      expect(failingAfter.nativeOwner.generation)
        .toBe(failingBefore.nativeOwner.generation);
      expect(failingAfter.coreOwner).toEqual(failingBefore.coreOwner);

      const healthyAfter = await waitRoleInspection(
        healthyRole.id,
        (inspection) => inspection.coreStatus.issueReason === null &&
          inspection.coreStatus.automationState === "ready",
        "healthy authoritative sibling isolation"
      );
      expect(healthyAfter.coreStatus).toEqual(healthyBefore.coreStatus);
      expect(healthyAfter.coreOwner).toEqual(healthyBefore.coreOwner);
      expect(healthyAfter.nativeOwner.generation)
        .toBe(healthyBefore.nativeOwner.generation);
      expectExactNativeOwner(healthyAfter, input.platform);

      const healthyCursor = await fixtureCursor();
      await clickVisibleElectronPageElement(
        healthyRole.launchUrl,
        input.mainWindowHandle,
        "#qa-target"
      );
      expect(await waitFixtureEvent({
        afterSequence: healthyCursor,
        kind: "click",
        roleId: HEALTHY_FIXTURE
      })).toEqual(expect.objectContaining({ isTrusted: true, targetId: "qa-target" }));
      const stillFailed = await electronDesktopE2eRolePlaceholderRuntime(
        failingRole.id
      );
      expect(stillFailed).toEqual(expect.objectContaining({
        coreOwner: failingAfter.coreOwner,
        coreStatus: failingAfter.coreStatus,
        nativeOwner: expect.objectContaining({
          generation: failingAfter.nativeOwner.generation
        })
      }));

      await stopCutoverWindow({
        mainWindowHandle: input.mainWindowHandle,
        platform: input.platform,
        tab: initialTab
      });
    } finally {
      await fixtureRequest("/api/navigation-failure", {
        enabled: false,
        roleId: FAILING_FIXTURE
      });
    }

    await openCutoverWorkspace(workspace);
    const relaunchedTab = await waitCutoverWorkspaceTab(workspace, [
      { roleId: healthyRole.id, state: "running" },
      { roleId: failingRole.id, state: "running" }
    ]);
    const healthyRelaunched = await waitRoleInspection(
      healthyRole.id,
      (inspection) => inspection.phase === "ready" &&
        inspection.coreStatus.issueReason === null,
      "healthy visible relaunch"
    );
    const failingRelaunched = await waitRoleInspection(
      failingRole.id,
      (inspection) => inspection.phase === "ready" &&
        inspection.coreStatus.issueReason === null,
      "failed Role visible relaunch"
    );
    expect(healthyRelaunched.nativeOwner.generation)
      .toBeGreaterThan(healthyBefore.nativeOwner.generation);
    expect(failingRelaunched.nativeOwner.generation)
      .toBeGreaterThan(failingBefore.nativeOwner.generation);
    expectExactNativeOwner(healthyRelaunched, input.platform);
    expectExactNativeOwner(failingRelaunched, input.platform);
    await stopCutoverWindow({
      mainWindowHandle: input.mainWindowHandle,
      platform: input.platform,
      tab: relaunchedTab
    });

    const processId = (await electronDesktopE2eProbe()).processId;
    const cancelCursor = await fixtureCursor();
    await fixtureRequest("/api/gate", { roleId: HEALTHY_FIXTURE });
    await fixtureRequest("/api/gate", { roleId: FAILING_FIXTURE });
    try {
      await openCutoverWorkspace(workspace);
      await Promise.all([
        waitFixturePath(`/api/gates/${HEALTHY_FIXTURE}/waiting`),
        waitFixturePath(`/api/gates/${FAILING_FIXTURE}/waiting`)
      ]);
      if (input.platform === "windows") {
        // Core/native projection reads wait for loading; ChromeDriver can also
        // wait for a gated target. Cancel through its exact visible native row.
        await closeLoadingWindowsRuntimeTab({ processId, tabName: workspace.name });
      } else {
        const gatedTab = await waitWorkspaceTab(workspace.id);
        await stopCutoverWindow({
          mainWindowHandle: input.mainWindowHandle,
          platform: input.platform,
          tab: gatedTab
        });
      }
      await Promise.all([HEALTHY_FIXTURE, FAILING_FIXTURE].map((roleId) =>
        waitFixtureEvent({ afterSequence: cancelCursor,
          kind: "gated-navigation-transport-cancelled", roleId })
      ));
    } finally {
      await fixtureRequest("/api/release", { roleId: HEALTHY_FIXTURE });
      await fixtureRequest("/api/release", { roleId: FAILING_FIXTURE });
    }
    const cancelled = await rendererCall("getEmbeddedRuntimeState");
    expect(cancelled.tabs.some((tab) => tab.sourceId === workspace.id)).toBe(false);
    expect((await rendererCall("listRoleStatuses")).some((status) =>
      status.roleId === healthyRole.id || status.roleId === failingRole.id
    )).toBe(false);
  });
});
