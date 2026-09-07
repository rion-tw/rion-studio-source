import { $, browser, expect } from "@wdio/globals";
import { electronDesktopE2eRetainedV22Precondition, electronDesktopE2eRoleSessionMigration } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import { acceptLegalAndSkipFirstRun, clickDialogButton, ensureEnglishUi, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-ROLE-SESSION-RECOVERY-033]
// [journey:CHROMIUM-WINDOWS-ROLE-SESSION-RECOVERY-033]
describe("Preserve sign-in source recovery", () => {
  it("uses visible recovery and keeps unsupported native sources blocked", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const fixture = await electronDesktopE2eRetainedV22Precondition();
    if (!fixture) throw new Error("Missing native recovery precondition");
    const before = await electronDesktopE2eRoleSessionMigration(fixture.roleId);
    expect(before.journal?.phase).toBe("failed");
    await $(".app-main-sidebar").$("button*=Roles").click();
    await waitForRoute("/roles");
    const card = await $(`[data-selection-id='${fixture.roleId}']`);
    await card.waitForDisplayed(); await card.moveTo();
    const action = await card.$("button[aria-label='Click for actions or drag to reorder'], button[aria-label='Role actions']");
    await action.waitForClickable(); await action.click();
    const menu = await $("[role='menu']");
    await menu.$(".//*[@role='menuitem' and normalize-space(.)='Preserve sign-in data']").click();
    const dialog = await $("dialog[open]"); await dialog.waitForDisplayed();
    const inspected = await rendererCall("sessionMigrationRecovery", { type: "inspect", roleId: fixture.roleId });
    const supported = inspected.candidates.some(candidate => candidate.supported);
    if (!supported) {
      await dialog.$("[role='alert']").waitForDisplayed({ timeout: 20_000 });
      await expect(dialog).toHaveText(expect.stringContaining("NATIVE_PLATFORM_VALIDATION_PENDING"));
      expect(await electronDesktopE2eRoleSessionMigration(fixture.roleId)).toEqual(before);
    } else {
      const recover = await dialog.$("button=Preserve sign-in data");
      await recover.waitForEnabled({ timeout: 20_000 }); await recover.click();
      await browser.waitUntil(async () => {
        const status = await dialog.$("[role='status']").getText();
        return status.includes("did not complete") || status.includes("Migration complete");
      }, {
        timeout: 60_000, timeoutMsg: "The exact isolated and formal helper receipts did not complete"
      });
      expect(await dialog.getText()).toContain("Migration complete");
      const after = await electronDesktopE2eRoleSessionMigration(fixture.roleId);
      expect(after.journal?.phase).toBe("v23Ready");
      expect(after.journal?.outcome).toBe("verified");
      expect(after.journal?.transferId).not.toBe(before.journal?.transferId);
      expect(after.journal?.firstVerifiedLaunchAt).toBeNull();
      expect(after.journal?.cleanFlushReceiptId).toMatch(/^chromium-session-fresh:[0-9a-f]{64}$/u);
    }
    expect(await rendererCall("listRoleStatuses")).toEqual([]);
    await clickDialogButton("Close");
  });
});
