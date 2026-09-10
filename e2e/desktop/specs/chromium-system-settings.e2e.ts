import { prepareChromiumFontRole, verifyChromiumFontApplication } from "./chromium-font-application-support";

import { $, browser, expect } from "@wdio/globals";

import {
  electronDesktopE2eDiagnosticsExportJournal,
  electronDesktopE2eProbe
} from "../support/electron-driver";
import { cancelVisibleNativeDiagnosticsSaveDialog } from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  scrollLayoutControlIntoView,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013]
// [journey:CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013]
// [journey:CHROMIUM-MACOS-APPKIT-FONT-APPLICATION-033]
// [journey:CHROMIUM-WINDOWS-FONT-APPLICATION-033]
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
  await scrollLayoutControlIntoView(button);
  await button.click();
  await waitForRoute(`/settings?section=${section}`);
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
  await expect(highRefresh).not.toExist();
  expect(await rendererCall("getGameBrowserSettings")).not.toHaveProperty("performance");
}

async function verifyInterface(): Promise<void> {
  await openSettingsSection("Interface settings", "interface");
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
  await openSettingsSection("Data transfer", "data");
  await $("button=Export JSON").click();
  const exportDialog = await $("[role='dialog']");
  await exportDialog.waitForDisplayed({ timeout: 10_000 });
  await exportDialog.$("button=Cancel").click();
  await exportDialog.waitForExist({ reverse: true, timeout: 10_000 });
  await $("button=Import JSON").waitForDisplayed({ timeout: 10_000 });
}

async function verifyUpdateBoundary(): Promise<void> {
  await openSettingsSection("App update", "updates");
  await expect($("button*=Check updates")).toBeDisabled();
}

async function verifyDiagnosticsLogs(
  phase: "chromium-system-settings" | "chromium-system-settings-restart"
): Promise<void> {
  await openSettingsSection("Diagnostics & logs", "diagnostics");
  await expect($("button=Export diagnostics")).toBeDisplayed();
  await expect($("button=Measure presentation FPS")).not.toExist();
  await expect($("button=Cancel measurement")).not.toExist();
  await browser.waitUntil(async () => (await rendererCall("getLogStatus")).entryCount > 0, {
    timeout: 10_000,
    timeoutMsg: "A clean Electron startup did not persist structured log entries"
  });
  const sessionReady = await $("summary*=Application session is ready.");
  await sessionReady.waitForDisplayed({ timeout: 10_000 });

  if (phase === "chromium-system-settings") {
    const levelRow = await $(
      "//*[normalize-space(.)='Recording level']/ancestor::div[contains(@class,'settings-row')][1]"
    );
    const level = await levelRow.$("button[role='combobox']");
    await level.waitForClickable({ timeout: 10_000 });
    await level.click();
    const info = await $("[role='option']=Info");
    await info.waitForClickable({ timeout: 10_000 });
    await info.click();
    await $("summary*=Core state changed.").waitForDisplayed({ timeout: 10_000 });
    return;
  }

  const persistedEntries = (await rendererCall("queryLogs", { limit: 100 })).entries;
  const currentSessionId = persistedEntries.find(
    (entry) => entry.event === "electron_ready"
  )?.sessionId;
  expect(currentSessionId).toBeTruthy();
  if (!persistedEntries.some((entry) =>
    entry.event === "core_state_changed" && entry.sessionId !== currentSessionId
  )) {
    throw new Error(`No prior-session Core state log was restored: ${JSON.stringify({
      currentSessionId,
      entries: persistedEntries.map((entry) => ({
        event: entry.event,
        sessionId: entry.sessionId
      }))
    })}`);
  }
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
  const openDocument = await $("button=Open");
  await openDocument.waitForExist({ timeout: 10_000 });
  await scrollLayoutControlIntoView(openDocument);
  await openDocument.waitForClickable({ timeout: 10_000 });
  await openDocument.click();

  const legalDialog = await $("[role='dialog']");
  await legalDialog.waitForDisplayed({ timeout: 10_000 });
  const close = await legalDialog.$("button[title='Close legal document']");
  await close.waitForClickable({ timeout: 10_000 });
  await close.click();
  await legalDialog.waitForExist({ reverse: true, timeout: 10_000 });
}

describe("Chromium system settings boundaries", () => {
  it("uses visible UI for platform settings and non-destructive cancellation", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (
      phase !== "chromium-system-settings"
      && phase !== "chromium-system-settings-restart"
    ) {
      throw new Error(`Unexpected Chromium settings phase ${phase}`);
    }
    const runtimeTarget = required("RION_STUDIO_E2E_RUNTIME_TARGET");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(runtimeTarget);
    expect(probe.driver).toBe("electron");
    expect(probe.packaged).toBe(false);

    if (phase === "chromium-system-settings-restart") {
      await openSettingsThroughVisibleUi();
      await verifyDiagnosticsLogs(phase);
      return;
    }

    const fontRole = await prepareChromiumFontRole();
    await openSettingsThroughVisibleUi();
    await verifyPreferences(probe.platform);
    await verifyDiagnosticsLogs(phase);
    await verifyInterface();
    await verifyChromiumFontApplication(fontRole);
    await verifyDataCancelBoundary();
    await verifyUpdateBoundary();
    await openSettingsSection("Diagnostics & logs", "diagnostics");
    await verifyNativeDiagnosticsExportCancel(probe);
    await verifyLegalCancelBoundary();
  });
});
