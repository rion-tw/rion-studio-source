import { browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GameWindow, Role } from "../../../src/shared/types";
import { electronDesktopE2eGameWindowRuntime, electronDesktopE2eProbe } from "../support/electron-driver";
import { selectWindowsNativeMenuItem } from "../support/windows-native-menu";
import { pressWindowsRuntimeWindowControl } from "../support/windows-runtime-window-control";
import { readWindowsRuntimeTabLoadingEvidence } from "../support/windows-runtime-tab-close";
import { fixtureRequest } from "../support/fixture";
import { selectMacosVisibleRuntimeLauncherRole } from "../support/macos-appkit-ui";
import { closeVisibleRuntimeTab, runtimeTabShellErrors } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";

/** Holds the native menu across the sibling's authoritative navigation completion. */
export async function exerciseLauncherDuringLoading(input: {
  platform: "macos" | "windows";
  mainWindowHandle: string;
  window: GameWindow;
  roles: readonly Role[];
  launchRole: (role: Role, window: GameWindow, afterSubmit: () => Promise<void>) => Promise<string>;
}): Promise<void> {
  const first = input.roles[0]!;
  const second = input.roles[1]!;
  const fixtureId = new URL(first.launchUrl).pathname.split("/").at(-1)!;
  const evidence: unknown[] = [];
  const launch = async (afterOpen?: () => Promise<void>) => {
    if (input.platform === "macos") {
      await selectMacosVisibleRuntimeLauncherRole({ windowId: input.window.id, roleName: second.name, afterOpen });
    } else {
      const processId = (await electronDesktopE2eProbe()).processId;
      const owner = await readWindowsRuntimeTabLoadingEvidence({ processId, tabName: first.name });
      await pressWindowsRuntimeWindowControl({ processId, nativeWindowHandle: owner.nativeHandle, command: "openLauncher" });
      await afterOpen?.();
      await selectWindowsNativeMenuItem({ processId, nativeWindowHandle: owner.nativeHandle, path: ["Roles", second.name] });
    }
  };
  const roleTab = async (role: Role) => (await rendererCall("getEmbeddedRuntimeState"))
    .tabs.find(tab => tab.sourceId === role.id && tab.windowId === input.window.id);
  const ready = async (role: Role) => (await rendererCall("listRoleStatuses"))
    .find(status => status.roleId === role.id)?.state === "running";
  const waitForSecond = async () => {
    await browser.waitUntil(async () => {
      expect(await runtimeTabShellErrors()).toEqual([]);
      return !!(await roleTab(second)) && await ready(second);
    }, { timeout: 30_000, timeoutMsg: "Native launcher did not admit the second role" });
    const tab = (await roleTab(second))!;
    const runtime = await electronDesktopE2eGameWindowRuntime(input.window.id);
    expect(runtime.currentRuntime!.nativeTabIds).toContain(tab.id);
    evidence.push(runtime);
    return tab.id;
  };
  const close = async (role: Role, tabId: string) => {
    await closeVisibleRuntimeTab({ platform: input.platform, mainWindowHandle: input.mainWindowHandle,
      windowId: input.window.id, tabId, tabName: role.name });
    await browser.waitUntil(async () => !(await roleTab(role)), { timeout: 20_000 });
  };
  await fixtureRequest("/api/gate", { roleId: fixtureId });
  try {
    const firstTabId = await input.launchRole(first, input.window, async () => {
      const waiting = await fetch(`${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/api/gates/${fixtureId}/waiting`,
        { signal: AbortSignal.timeout(30_000) });
      expect(waiting.ok).toBe(true);
      await launch();
      const secondTabId = await waitForSecond();
      expect(await ready(first)).toBe(false);
      await close(second, secondTabId);
      await launch(async () => {
          const before = await electronDesktopE2eGameWindowRuntime(input.window.id);
          await fixtureRequest("/api/release", { roleId: fixtureId });
          await browser.waitUntil(async () => await ready(first), { timeout: 30_000 });
          const after = await electronDesktopE2eGameWindowRuntime(input.window.id);
          expect(after.currentRuntime!.topologyRevision).toBeGreaterThan(before.currentRuntime!.topologyRevision);
          expect(after.currentRuntime!.appKitIdentity).toEqual(before.currentRuntime!.appKitIdentity);
          expect(after.currentRuntime!.windowGeneration).toBe(before.currentRuntime!.windowGeneration);
          expect(after.currentRuntime!.parentNativeHostId).toBe(before.currentRuntime!.parentNativeHostId);
          evidence.push({ stage: "navigation-completed-with-menu-open", before, after });
        });
      await waitForSecond();
    });
    await close(second, (await roleTab(second))!.id);
    await close(first, firstTabId);
    expect(await runtimeTabShellErrors()).toEqual([]);
  } finally {
    await fixtureRequest("/api/release", { roleId: fixtureId });
    await writeFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "native-launcher-loading-evidence.json"),
      JSON.stringify(evidence, null, 2));
  }
}
