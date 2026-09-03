import { $, $$, browser, expect } from "@wdio/globals";

import {
  electronDesktopE2eDiagnosticsExportJournal,
  electronDesktopE2eProbe
} from "../support/electron-driver";
import { cancelVisibleNativeDiagnosticsSaveDialog } from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013]
// [journey:CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013]
// [journey:CHROMIUM-MACOS-APPKIT-DIAGNOSTICS-EXPORT-029]
// [journey:CHROMIUM-WINDOWS-DIAGNOSTICS-EXPORT-029]

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium settings journey`);
  return value;
}

async function openSettingsThroughVisibleUi(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$("button*=Settings").click();
  await waitForRoute("/settings");
}

async function openSettingsSection(
  label: string,
  section: string
): Promise<void> {
  const sidebar = await $(".settings-mode-sidebar");
  await sidebar.waitForDisplayed({ timeout: 10_000 });
  const button = await sidebar.$(`button=${label}`);
  await button.scrollIntoView({ block: "center" });
  await button.click();
  await waitForRoute(`/settings?section=${section}`);
}

async function waitForHighRefreshMode(
  label: "Auto" | "Disabled",
  value: "auto" | "disabled"
): Promise<void> {
  await browser.waitUntil(async () => {
    const control = await $(
      "button[role='combobox'][aria-label='Experimental high refresh rate']"
    );
    const settings = await rendererCall("getGameBrowserSettings");
    return settings.performance.macosHighRefreshMode === value
      && (await control.getText()).includes(label)
      && await control.isEnabled();
  }, {
    timeout: 15_000,
    timeoutMsg: `Chromium settings did not persist high-refresh mode ${value}`
  });
}

async function verifyPreferences(
  platform: "macos" | "windows"
): Promise<void> {
  const rendererPlatform = await browser.execute(() =>
    document.documentElement.dataset.platform
  );
  expect(rendererPlatform).toBe(platform === "macos" ? "mac" : "windows");

  const highRefresh = await $(
    "button[role='combobox'][aria-label='Experimental high refresh rate']"
  );
  if (platform === "windows") {
    expect(await highRefresh.isExisting()).toBe(false);
    return;
  }

  await highRefresh.waitForDisplayed({ timeout: 10_000 });
  await waitForHighRefreshMode("Disabled", "disabled");
  await highRefresh.click();
  const automatic = await $("[role='option']=Auto");
  await automatic.waitForDisplayed({ timeout: 10_000 });
  await automatic.click();
  await waitForHighRefreshMode("Auto", "auto");

  await highRefresh.click();
  const disabled = await $("[role='option']=Disabled");
  await disabled.waitForDisplayed({ timeout: 10_000 });
  await disabled.click();
  await waitForHighRefreshMode("Disabled", "disabled");
}

async function verifyInterface(): Promise<void> {
  await openSettingsSection("Interface", "interface");
  await $("button[aria-label='Font smoothing']").waitForDisplayed({ timeout: 10_000 });
  await $("button=Customize fonts").click();

  const preset = await $("button*=Fresh humanist");
  await preset.waitForDisplayed({ timeout: 10_000 });
  const presetSample = await preset.$(
    ".browser-font-preset-sample .browser-font-sample"
  );
  expect(await presetSample.getAttribute("class")).toContain("text-base");

  const selectedFontValue = await $("button[aria-label='English & Latin'] > span");
  await selectedFontValue.waitForDisplayed({ timeout: 10_000 });
  expect(await selectedFontValue.getAttribute("class")).not.toContain("text-base");

  const onlinePreviewSamples = await $(".browser-font-preview-samples");
  await onlinePreviewSamples.waitForDisplayed({ timeout: 10_000 });
  expect(await onlinePreviewSamples.getAttribute("class")).toContain("text-lg");
  expect(await browser.execute(() => {
    const previewTitle = [...document.querySelectorAll<HTMLElement>("p")].find(
      (element) => element.textContent === "Online font preview"
    );
    const warning = [...document.querySelectorAll<HTMLElement>("span")].find(
      (element) => element.textContent?.startsWith("Font overrides take priority")
    );
    return previewTitle?.closest(".settings-row") === warning?.closest(".settings-row");
  })).toBe(true);
}

async function verifyDataCancelBoundary(): Promise<void> {
  await openSettingsSection("Data", "data");
  await $("button=Export JSON").click();
  const exportDialog = await $("[role='dialog']");
  await exportDialog.waitForDisplayed({ timeout: 10_000 });
  await exportDialog.$("button=Cancel").click();
  await exportDialog.waitForExist({ reverse: true, timeout: 10_000 });
  await $("button=Import JSON").waitForDisplayed({ timeout: 10_000 });
}

async function verifyUpdateBoundary(): Promise<void> {
  await openSettingsSection("Updates", "updates");
  await expect($("button*=Check updates")).toBeDisabled();
}

async function verifyEventBoundDiagnosticsCancel(): Promise<void> {
  await openSettingsSection("Diagnostics", "diagnostics");
  const measure = await $("button=Measure presentation FPS");
  await measure.waitForDisplayed({ timeout: 10_000 });
  await measure.click();

  const cancel = await $("button=Cancel measurement");
  await cancel.waitForDisplayed({ timeout: 10_000 });
  await cancel.click();
  await measure.waitForDisplayed({ timeout: 10_000 });
}

async function verifyNativeDiagnosticsExportCancel(input: Readonly<{
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  const journalBefore = await electronDesktopE2eDiagnosticsExportJournal();
  const priorSequence = journalBefore.observations.at(-1)?.sequence ?? 0;
  const exportButton = await $("button=Export diagnostics");
  await exportButton.waitForClickable({ timeout: 10_000 });
  const nativeCancellation = cancelVisibleNativeDiagnosticsSaveDialog(input);
  await exportButton.click();
  await nativeCancellation;
  await browser.waitUntil(async () => exportButton.isClickable(), {
    timeout: 10_000,
    timeoutMsg: "Diagnostics export did not return from native cancellation"
  });
  expect(await $("[role='alert']").isExisting()).toBe(false);
  const journalAfter = await electronDesktopE2eDiagnosticsExportJournal();
  const newObservations = journalAfter.observations.filter(
    (observation) => observation.sequence > priorSequence
  );
  expect(newObservations).toHaveLength(1);
  expect(newObservations[0]).toEqual({
    coreDiagnosticsExportInvocationCount: 0,
    outcome: "cancelled",
    sequence: priorSequence + 1,
    typedOutcome: null
  });
}

async function verifyLegalCancelBoundary(): Promise<void> {
  await openSettingsSection("About & Legal", "about-legal");
  const openButtons = await $$("button=Open");
  expect(await openButtons.length).toBeGreaterThan(0);
  await openButtons[0].click();

  const legalDialog = await $("[role='dialog']");
  await legalDialog.waitForDisplayed({ timeout: 10_000 });
  const close = await legalDialog.$("button[title='Close']");
  await close.waitForClickable({ timeout: 10_000 });
  await close.click();
  await legalDialog.waitForExist({ reverse: true, timeout: 10_000 });
}

describe("Chromium system settings boundaries", () => {
  it("uses visible UI for platform settings and non-destructive cancellation", async () => {
    expect(required("RION_STUDIO_E2E_PHASE")).toBe("chromium-system-settings");
    const runtimeTarget = required("RION_STUDIO_E2E_RUNTIME_TARGET");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(runtimeTarget);
    expect(probe.driver).toBe("electron");
    expect(probe.packaged).toBe(false);

    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    await openSettingsThroughVisibleUi();
    await verifyPreferences(probe.platform);
    await verifyInterface();
    await verifyDataCancelBoundary();
    await verifyUpdateBoundary();
    await verifyEventBoundDiagnosticsCancel();
    await verifyNativeDiagnosticsExportCancel(probe);
    await verifyLegalCancelBoundary();
  });
});
