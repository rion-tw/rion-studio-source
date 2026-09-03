import { browser, expect } from "@wdio/globals";

import {
  electronDesktopE2eRolePlaceholderRuntime,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { clickVisibleElectronPageElement } from
  "../support/electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  createCutoverGame,
  createCutoverRole,
  createCutoverRoleWorkspace,
  cutoverFixtureUrl,
  openCutoverWorkspace,
  prepareWorkspaceCutover,
  requiredCutoverEnvironment,
  waitCutoverWorkspaceTab
} from "../support/chromium-workspace-cutover";

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-SHARED-ROLE-025]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025]

const GAME_NAME = "Chromium Shared Role Game";
const SHARED_ROLE_NAME = "Chromium Shared Role";
const UNIQUE_A_NAME = "Chromium Shared Workspace A Role";
const UNIQUE_B_NAME = "Chromium Shared Workspace B Role";
const WORKSPACE_A_NAME = "Chromium Shared Workspace A";
const WORKSPACE_B_NAME = "Chromium Shared Workspace B";
const SHARED_FIXTURE = "chromium-workspace-shared-role";
const UNIQUE_A_FIXTURE = "chromium-workspace-shared-unique-a";
const UNIQUE_B_FIXTURE = "chromium-workspace-shared-unique-b";

function expectPlatformHost(
  hostKind: "appkit-chromium" | "bundled-chromium",
  platform: "macos" | "windows"
): void {
  expect(hostKind).toBe(
    platform === "macos" ? "appkit-chromium" : "bundled-chromium"
  );
}

async function waitPlaceholderOwner(
  roleId: string,
  ownerTabId?: string
) {
  let inspection: Awaited<ReturnType<
    typeof electronDesktopE2eRolePlaceholderRuntime
  >> | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eRolePlaceholderRuntime(roleId);
      return inspection.placeholders.length === 1 &&
        (ownerTabId === undefined || inspection.coreOwner.tabId === ownerTabId);
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Role ${roleId} did not expose one exact blocked placeholder`
  });
  return inspection!;
}

describe("Chromium shared Workspace Role exact replacement", () => {
  it("moves one Core-owned Role between two visible native hosts with exact placeholders", async () => {
    const input = await prepareWorkspaceCutover();
    const phase = requiredCutoverEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase !== "chromium-workspace-shared-role") {
      throw new Error(`Unexpected shared Role phase ${phase}`);
    }
    const game = await createCutoverGame(
      GAME_NAME,
      cutoverFixtureUrl(SHARED_FIXTURE)
    );
    const shared = await createCutoverRole(
      game,
      SHARED_ROLE_NAME,
      cutoverFixtureUrl(SHARED_FIXTURE)
    );
    const uniqueA = await createCutoverRole(
      game,
      UNIQUE_A_NAME,
      cutoverFixtureUrl(UNIQUE_A_FIXTURE)
    );
    const uniqueB = await createCutoverRole(
      game,
      UNIQUE_B_NAME,
      cutoverFixtureUrl(UNIQUE_B_FIXTURE)
    );
    const workspaceA = await createCutoverRoleWorkspace(
      WORKSPACE_A_NAME,
      [shared, uniqueA]
    );
    const workspaceB = await createCutoverRoleWorkspace(
      WORKSPACE_B_NAME,
      [shared, uniqueB]
    );

    await openCutoverWorkspace(workspaceA, "new-window");
    const tabA = await waitCutoverWorkspaceTab(workspaceA, [
      { roleId: shared.id, state: "running" },
      { roleId: uniqueA.id, state: "running" }
    ]);
    await openCutoverWorkspace(workspaceB, "new-window");
    const tabB = await waitCutoverWorkspaceTab(workspaceB, [
      { roleId: shared.id, state: "blocked" },
      { roleId: uniqueB.id, state: "running" }
    ]);
    expect(tabB.windowId).not.toBe(tabA.windowId);
    expect((await rendererCall("getEmbeddedRuntimeState")).windows).toHaveLength(2);

    const before = await waitPlaceholderOwner(shared.id, tabA.id);
    const targetPlaceholder = before.placeholders[0]!;
    expect(before.coreStatus).toEqual(expect.objectContaining({
      issueReason: null,
      state: "running"
    }));
    expect(before.nativeOwner).toEqual(expect.objectContaining({
      tabId: tabA.id,
      windowId: tabA.windowId
    }));
    expect(targetPlaceholder).toEqual(expect.objectContaining({
      blocked: true,
      ownerGeneration: before.coreOwner.generation,
      shellSession: "rion-web-chrome-shell:memory",
      shellStoragePath: null,
      tabId: tabB.id,
      visible: true,
      windowId: tabB.windowId
    }));
    expectPlatformHost(before.nativeOwner.hostKind, input.platform);
    expectPlatformHost(targetPlaceholder.hostKind, input.platform);

    const uniqueABefore = await electronDesktopE2eRoleSessionRuntime(uniqueA.id);
    const uniqueBBefore = await electronDesktopE2eRoleSessionRuntime(uniqueB.id);
    const sourceCursor = await fixtureCursor();
    await clickVisibleElectronPageElement(
      shared.launchUrl,
      input.mainWindowHandle,
      "#qa-target"
    );
    const sourceClick = await waitFixtureEvent({
      afterSequence: sourceCursor,
      kind: "click",
      roleId: SHARED_FIXTURE
    });
    expect(sourceClick).toEqual(expect.objectContaining({
      isTrusted: true,
      targetId: "qa-target"
    }));

    const targetSessionCursor = await fixtureCursor();
    await clickVisibleElectronPageElement(
      targetPlaceholder.shellUrl,
      input.mainWindowHandle,
      "#claim"
    );
    const targetSession = await waitFixtureEvent({
      afterSequence: targetSessionCursor,
      kind: "session",
      roleId: SHARED_FIXTURE
    });
    expect(targetSession.roleId).toBe(SHARED_FIXTURE);
    const after = await waitPlaceholderOwner(shared.id, tabB.id);
    const sourcePlaceholder = after.placeholders[0]!;
    expect(after.coreOwner).toEqual(expect.objectContaining({
      slotId: workspaceB.slots.find((slot) => slot.roleId === shared.id)?.id,
      tabId: tabB.id,
      windowId: tabB.windowId
    }));
    expect(after.coreOwner.generation).toBeGreaterThan(before.coreOwner.generation);
    expect(after.nativeOwner).toEqual(expect.objectContaining({
      ownerGeneration: after.coreOwner.generation,
      tabId: tabB.id,
      visible: true,
      windowId: tabB.windowId
    }));
    expect(after.nativeOwner.generation).toBeGreaterThan(before.nativeOwner.generation);
    expect(sourcePlaceholder).toEqual(expect.objectContaining({
      ownerGeneration: after.coreOwner.generation,
      tabId: tabA.id,
      visible: true,
      windowId: tabA.windowId
    }));
    expectPlatformHost(after.nativeOwner.hostKind, input.platform);
    expectPlatformHost(sourcePlaceholder.hostKind, input.platform);

    const uniqueAAfter = (await electronDesktopE2eRoleSessionRuntime(
      uniqueA.id
    )).currentRuntime;
    const uniqueBAfter = (await electronDesktopE2eRoleSessionRuntime(
      uniqueB.id
    )).currentRuntime;
    for (const [beforeOwner, afterOwner] of [
      [uniqueABefore.currentRuntime, uniqueAAfter],
      [uniqueBBefore.currentRuntime, uniqueBAfter]
    ] as const) {
      expect(afterOwner).toEqual(expect.objectContaining({
        generation: beforeOwner?.generation,
        ownerGeneration: beforeOwner?.ownerGeneration,
        parentNativeHostId: beforeOwner?.parentNativeHostId,
        tabId: beforeOwner?.tabId,
        windowId: beforeOwner?.windowId
      }));
    }
    const targetCursor = await fixtureCursor();
    await clickVisibleElectronPageElement(
      shared.launchUrl,
      input.mainWindowHandle,
      "#qa-target"
    );
    expect(await waitFixtureEvent({
      afterSequence: targetCursor,
      kind: "click",
      roleId: SHARED_FIXTURE
    })).toEqual(expect.objectContaining({ isTrusted: true }));
  });
});
