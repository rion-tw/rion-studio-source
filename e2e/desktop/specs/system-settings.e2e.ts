import { $, $$, browser, expect } from "@wdio/globals";

import { probe, shutdown } from "../support/control";
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
}

describe("system settings boundaries", () => {
  it("exposes external workflows without crossing their destructive confirmation boundary", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    await navigate("/settings?section=interface");
    await $("button[aria-label='Font smoothing']").waitForExist({ timeout: 10_000 });
    await $("button=Customize fonts").click();
    await $("button*=Fresh humanist").waitForExist({ timeout: 10_000 });

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
    const measure = await $("button=Measure presentation FPS");
    await measure.click();
    const cancelMeasurement = await $("button=Cancel measurement");
    await cancelMeasurement.waitForExist({ timeout: 10_000 });
    await cancelMeasurement.click();
    await measure.waitForExist({ timeout: 10_000 });

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
