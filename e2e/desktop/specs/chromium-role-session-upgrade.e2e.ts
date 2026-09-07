import { $, browser, expect } from "@wdio/globals";
import { electronDesktopE2eProbe, electronDesktopE2eRoleSessionMigration, electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { acceptLegalAndSkipFirstRun, clickDialogButton, ensureEnglishUi, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-ROLE-SESSION-UPGRADE-034]
// [journey:CHROMIUM-WINDOWS-ROLE-SESSION-UPGRADE-034]
describe("First legacy upgrade continues with the same role", () => {
  it("retains independent LocalStorage after Cookie failure and never repeats a completed upgrade", async () => {
    await ensureEnglishUi(); await acceptLegalAndSkipFirstRun();
    const probe = await electronDesktopE2eProbe();
    const rolesBefore = await rendererCall("listRoles");
    const role = rolesBefore.find(item => item.name === "Chromium Retained v22 Role");
    if (!role) throw new Error("Missing retained role");
    const before = await electronDesktopE2eRoleSessionMigration(role.id);
    expect(before.journal?.phase).toBe("failed");
    const first = process.env.RION_STUDIO_E2E_PHASE === "chromium-role-session-upgrade-seed";
    const inspection = first ? null : await rendererCall("sessionMigrationRecovery", { type: "inspect", roleId: role.id });
    if (inspection) expect(inspection.phase).toBe("freshReady");
    await $(".app-main-sidebar").$("button*=Roles").click(); await waitForRoute("/roles");
    const card = await $(`[data-selection-id='${role.id}']`); await card.waitForDisplayed(); await card.moveTo();
    const cursor = await fixtureCursor();
    const open = await card.$("button[aria-label='Open']"); await open.waitForClickable(); await open.click();
    const session = await waitFixtureEvent({ afterSequence: cursor, kind: "session", roleId: "chromium-explicit-reset" });
    await browser.waitUntil(async () => (await rendererCall("listRoleStatuses")).some(item => item.roleId === role.id && item.state === "running"), { timeout: 45_000, timeoutMsg: "The same role did not become usable after its first upgrade" });
    expect(await $("dialog[open]").isExisting()).toBe(false);
    const result = await rendererCall("sessionMigrationRecovery", { type: "inspect", roleId: role.id });
    expect(result.phase).toBe("freshReady");
    expect(result.roleId).toBe(role.id);
    expect(result.upgradeResult?.localStorage).toBe("transferred");
    expect(result.upgradeResult?.cookies).toBe("failed");
    expect(result.upgradeResult?.localStorageOriginCount).toBe(2);
    expect(result.upgradeResult?.localStorageEntryCount).toBe(2);
    expect(session.session?.before).toEqual({ cookie: null, localStorage: "retained-upgrade" });
    expect(await electronDesktopE2eRoleSessionMigration(role.id)).toEqual(before);
    expect((await rendererCall("listRoles")).map(item => item.id)).toEqual(rolesBefore.map(item => item.id));
    const runtime = await electronDesktopE2eRoleSessionRuntime(role.id);
    expect(runtime.latestSessionEnsure.chromiumUserDataDir).toContain(role.id);
    expect(runtime.latestSessionEnsure.chromiumUserDataDir).toContain(result.attemptId);
    expect(runtime.currentRuntime?.hostKind).toBe(probe.platform === "macos" ? "appkit-chromium" : "bundled-chromium");
    if (inspection) expect(result).toEqual(inspection);
    await card.moveTo();
    const action = await card.$("button[aria-label='Click for actions or drag to reorder'], button[aria-label='Role actions']"); await action.waitForClickable(); await action.click();
    await $("[role='menu']").$(".//*[@role='menuitem' and normalize-space(.)='Preserve sign-in data']").click();
    const dialog = await $("dialog[open]"); await dialog.waitForDisplayed();
    await expect(dialog).toHaveText(expect.stringContaining("This role is ready to use"));
    await expect(dialog).toHaveText(expect.stringContaining("localStorage"));
    await clickDialogButton("Close");
  });
});
