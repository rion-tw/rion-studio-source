import { $, $$, browser, expect } from "@wdio/globals";

import { detachTerminatedApplicationSession, probe, shutdown } from "../support/control";
import { waitForTranscriptEvent } from "../support/transcript";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, navigate } from "../support/ui";

// [journey:SETTINGS-SYSTEM-001]

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete" && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
  detachTerminatedApplicationSession();
}

describe("system settings boundaries", () => {
  it("exposes external workflows without crossing their destructive confirmation boundary", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    await navigate("/settings?section=preferences");
    await expect($("button[role='combobox'][aria-label='Experimental high refresh rate']")).not.toExist();
    await navigate("/settings?section=interface");
    await $("button[aria-label='Font smoothing']").waitForExist({ timeout: 10_000 });
    await $("button=Customize fonts").click();
    await $("button*=Fresh humanist").waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const sample = document.querySelector<HTMLElement>(
            ".browser-font-preset-sample .browser-font-sample"
          );
          return sample?.classList.contains("text-base") ?? false;
        }),
      {
        timeout: 10_000,
        timeoutMsg: "Font preset samples did not use the larger preview size"
      }
    );
    const selectedFontValue = await $("button[aria-label='English & Latin'] > span");
    await selectedFontValue.waitForExist({ timeout: 10_000 });
    expect(await selectedFontValue.getAttribute("class")).not.toContain("text-base");
    const onlinePreviewSamples = await $(".browser-font-preview-samples");
    await onlinePreviewSamples.waitForExist({ timeout: 10_000 });
    expect(await onlinePreviewSamples.getAttribute("class")).toContain("text-lg");
    expect(
      await browser.execute(() => {
        const previewTitle = [...document.querySelectorAll<HTMLElement>("p")].find(
          (element) => element.textContent === "Online font preview"
        );
        const overrideWarning = [...document.querySelectorAll<HTMLElement>("span")].find((element) =>
          element.textContent?.startsWith("Font overrides take priority")
        );
        return previewTitle?.closest(".settings-row") === overrideWarning?.closest(".settings-row");
      })
    ).toBe(true);

    await navigate("/settings?section=data");
    await $("button=Export JSON").click();
    const exportDialog = await $("[role='dialog']");
    await exportDialog.waitForExist({ timeout: 10_000 });
    await exportDialog.$("button=Cancel").click();
    await exportDialog.waitForExist({ reverse: true, timeout: 10_000 });
    await $("button=Import JSON").waitForExist({ timeout: 10_000 });

    await navigate("/settings?section=updates");
    await expect($("button*=Check updates")).toBeDisabled();

    await navigate("/settings?section=diagnostics");
    await expect($("button=Export diagnostics")).toBeDisplayed();
    await expect($("button=Measure presentation FPS")).not.toExist();
    await expect($("button=Cancel measurement")).not.toExist();

    await navigate("/settings?section=about-legal");
    const legalButtons = await $$("button=Open");
    expect(await legalButtons.length).toBeGreaterThan(0);
    await legalButtons[0].click();
    const legalDialog = await $("[role='dialog']");
    await legalDialog.waitForExist({ timeout: 10_000 });
    const close = await legalDialog.$("button[aria-label='Close']");
    if (await close.isExisting()) await close.click();
    else await browser.keys("Escape");
    await legalDialog.waitForExist({ reverse: true, timeout: 10_000 });

    await shutdownAndWaitForFlush();
  });
});
