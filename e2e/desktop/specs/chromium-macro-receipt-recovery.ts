import { browser, expect } from "@wdio/globals";
import { compatibleReceiptFault } from "../support/compatible-receipt-fault";
import { rendererCall } from "../support/renderer-bridge";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { activateChromiumRoleVisible, launchChromiumRoleVisible, macroFixtureUrl,
  startChromiumMacroVisible, type ChromiumMacroScenarioContext } from "./chromium-macro-cutover-support";
import type { GameWindow } from "../../../src/shared/types";
import type { LogEntry } from "../../../src/shared/generated";

export async function exerciseCompatibleReceiptRecovery(context: ChromiumMacroScenarioContext, gameId: string, window: GameWindow) {
  const fixtureId = "macro-receipt-recovery";
  const url = macroFixtureUrl(fixtureId);
  const role = await rendererCall("createRole", { gameId, launchUrl: url, name: "Receipt Recovery Role" });
  const macro = await rendererCall("createMacro", { name: "Receipt Recovery Loop", activationMode: "press", enabled: true,
    roleIds: [role.id], repeat: { type: "loop", intervalMs: 250 },
    steps: [{ id: "receipt-key", type: "key", action: "tap", code: "KeyJ" }] });
  const tab = await launchChromiumRoleVisible(role, fixtureId, window);
  await activateChromiumRoleVisible(context, tab);
  const baseline = await electronDesktopE2eRoleSessionRuntime(role.id);
  const cursor = await fixtureCursor();
  await startChromiumMacroVisible(macro, [role.id]);
  await waitFixtureEvent({ afterSequence: cursor, kind: "consumer-keyup", roleId: fixtureId });
  try {
    await compatibleReceiptFault(url, "arm");
    await browser.waitUntil(async () => (await rendererCall("listRoleStatuses"))
      .some(status => status.roleId === role.id && status.automationState === "unavailable"),
    { timeout: 20_000, timeoutMsg: "Rejected down and cleanup receipts did not retain input quarantine" });
    await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
      .some(status => status.macroId === macro.id && status.state === "running"),
    { timeout: 10_000, timeoutMsg: "A receipt failure left the macro running" });
    let incidents: LogEntry[] = [];
    await browser.waitUntil(async () => {
      const { entries } = await rendererCall("queryLogs", { levels: ["error"], limit: 100, search: "trusted_input_incident" });
      incidents = entries.filter(entry => entry.context?.roleId === role.id);
      return incidents.some(entry => entry.context?.compatibleReceiptValidation !== undefined);
    }, { timeout: 10_000, timeoutMsg: "Receipt validation evidence did not reach the persistent log" });
    expect(incidents).toEqual(expect.arrayContaining([expect.objectContaining({ context: expect.objectContaining({
      compatibleReceiptValidation: expect.objectContaining({ reason: "identity", field: "sequence",
        received: "-1", reportedStatus: "applied", reportedEventCount: 1 }),
      gameDeliveryConfirmed: false, observedDomEventCount: 0
    }) })]));
    const current = await electronDesktopE2eRoleSessionRuntime(role.id);
    expect(current.currentRuntime).toEqual(expect.objectContaining({ generation: baseline.currentRuntime?.generation,
      tabId: tab.tabId, windowId: tab.windowId }));
    return { roleId: role.id, incidents, current };
  } finally { await compatibleReceiptFault(url, "clear"); }
}
