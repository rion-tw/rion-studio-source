import { $, browser, expect } from "@wdio/globals";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Game, GameWindow, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { clickVisibleRuntimeTab } from "../support/native-runtime-tabs";
import { forceTerminateProcessTree } from "../support/process";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  navigate,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-WINDOW-RECOVERY-UI-022]
// [journey:CHROMIUM-WINDOWS-WINDOW-RECOVERY-UI-022]

const GAME_NAME = "Chromium Window Recovery Game";
const WINDOWS = ["Chromium Window Recovery Left", "Chromium Window Recovery Right"] as const;
const ROLES = [
  { fixture: "chromium-window-recovery-alpha", marker: "chromium-window-alpha", name: "Chromium Recovery Alpha" },
  { fixture: "chromium-window-recovery-beta", marker: "chromium-window-beta", name: "Chromium Recovery Beta" },
  { fixture: "chromium-window-recovery-gamma", marker: "chromium-window-gamma", name: "Chromium Recovery Gamma" }
] as const;

interface WindowRecoveryRoleEvidence {
  chromiumPathSha256: string;
  fixture: string;
  marker: string;
  name: string;
  roleId: string;
  tabId: string;
  windowId: string;
}

interface WindowRecoveryLifecycle {
  contractVersion: 1;
  platform: "macos" | "windows";
  roles: readonly WindowRecoveryRoleEvidence[];
  windows: readonly {
    activeTabId: string;
    name: string;
    tabIds: readonly string[];
    windowId: string;
  }[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by Window recovery`);
  return value;
}

function roleUrl(fixture: string, marker: string): string {
  const url = new URL(`/role/${fixture}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("marker", marker);
  url.searchParams.set("mode", "seed");
  return url.href;
}

function lifecyclePath(): string {
  return resolve(dirname(required("RION_STUDIO_E2E_ARTIFACT_DIR")),
    "chromium-window-recovery-evidence.json");
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findEntity<Value extends { name: string }>(
  name: string,
  read: () => Promise<Value[]>
): Promise<Value> {
  let entity: Value | undefined;
  await browser.waitUntil(async () => {
    entity = (await read()).find((candidate) => candidate.name === name);
    return entity !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Missing persisted entity ${name}` });
  return entity!;
}

async function menuAction(entityId: string, triggerLabel: string, action: string): Promise<void> {
  const row = await $(`[data-selection-id='${entityId}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  await row.moveTo();
  const trigger = await row.$(`button[aria-label='${triggerLabel}']`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const item = await $(`//*[@role='menuitem' and normalize-space(.)='${action}']`);
  await item.waitForClickable({ timeout: 10_000 });
  await item.click();
}

async function createGameAndRoles(): Promise<Readonly<{ game: Game; roles: Role[] }>> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(roleUrl(ROLES[0].fixture, ROLES[0].marker));
  await submitEditor("/games");
  const game = await findEntity(GAME_NAME, () => rendererCall("listGames"));
  const roles: Role[] = [];
  for (const definition of ROLES) {
    await openSection("Games", "/games");
    await menuAction(game.id, "Game actions", "Add role");
    await waitForRoute(`/roles/new?gameId=${game.id}`);
    await setEditorName(definition.name);
    await $("#role-launch-url").setValue(roleUrl(definition.fixture, definition.marker));
    await submitEditor("/roles");
    roles.push(await findEntity(definition.name, () => rendererCall("listRoles")));
  }
  return { game, roles };
}

async function createWindow(name: string): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const prior = new Set((await rendererCall("listGameWindows")).map(({ id }) => id));
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows")).find(({ id }) => !prior.has(id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible Game Window creation did not commit" });
  await menuAction(created!.id, "Game window actions", "Rename");
  await $("#rename-game-window-name").setValue(name);
  await (await $("dialog[open]")).$("button=Save").click();
  return findEntity(name, () => rendererCall("listGameWindows"));
}

async function quickAccessLaunch(role: Role, windowId: string): Promise<void> {
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.$("input[role='combobox']").setValue(role.name);
  await $(`#quick-access-option-role-${role.id}`).waitForDisplayed({ timeout: 10_000 });
  const destinations = await $(`[data-testid='quick-access-destination-role-${role.id}']`);
  await destinations.waitForClickable({ timeout: 10_000 });
  await destinations.click();
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${windowId}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
}

async function waitSession(
  afterSequence: number,
  definition: typeof ROLES[number],
  stored: boolean
): Promise<void> {
  const event = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: definition.fixture
  });
  expect(event.session).toEqual({
    after: { cookie: definition.marker, localStorage: definition.marker },
    before: stored
      ? { cookie: definition.marker, localStorage: definition.marker }
      : { cookie: null, localStorage: null },
    marker: definition.marker,
    mode: "seed"
  });
}

async function showWindow(windowId: string): Promise<void> {
  await openSection("Windows", "/game-windows");
  const show = await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`);
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
}

async function waitExactWindows(lifecycle: WindowRecoveryLifecycle): Promise<void> {
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    if (runtime.windows.length !== lifecycle.windows.length) return false;
    return lifecycle.windows.every((window) => {
      const live = runtime.windows.find(({ id }) => id === window.windowId);
      const tabIds = runtime.tabs.filter(({ windowId }) => windowId === window.windowId)
        .map(({ id }) => id);
      return live?.visible === true
        && tabIds.join("|") === window.tabIds.join("|");
    });
  }, { timeout: 45_000, timeoutMsg: "Exact multi-window native topology did not become live" });
}

async function activateTab(input: Readonly<{
  evidence: WindowRecoveryRoleEvidence;
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<void> {
  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: input.evidence.tabId,
    tabName: input.evidence.name
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .windows.find(({ id }) => id === input.evidence.windowId)?.activeTabId ===
      input.evidence.tabId, {
    timeout: 30_000,
    timeoutMsg: `Visible native tab ${input.evidence.tabId} did not activate`
  });
}

async function activateWindowRoles(input: Readonly<{
  lifecycle: WindowRecoveryLifecycle;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  windowId: string;
}>): Promise<void> {
  const roles = input.lifecycle.roles.filter(({ windowId }) => windowId === input.windowId);
  for (const role of roles) {
    const cursor = await fixtureCursor();
    await activateTab({ evidence: role, ...input });
    await waitFixtureEvent({ afterSequence: cursor, kind: "visibility", roleId: role.fixture });
  }
}

async function exactNative(lifecycle: WindowRecoveryLifecycle) {
  const [windows, roles] = await Promise.all([
    Promise.all(lifecycle.windows.map(({ windowId }) =>
      electronDesktopE2eGameWindowRuntime(windowId))),
    Promise.all(lifecycle.roles.map(({ roleId }) =>
      electronDesktopE2eRoleSessionRuntime(roleId)))
  ]);
  return { roles, windows };
}

async function writeRuntime(
  lifecycle: WindowRecoveryLifecycle,
  mode: "live" | "discarded" = "live"
): Promise<void> {
  const native = mode === "live" ? await exactNative(lifecycle) : { roles: [], windows: [] };
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-window-recovery-runtime.json"),
    `${JSON.stringify({ lifecycle, mode, native }, null, 2)}\n`
  );
}

async function readLifecycle(platform: "macos" | "windows"): Promise<WindowRecoveryLifecycle> {
  const lifecycle = JSON.parse(await readFile(lifecyclePath(), "utf8")) as
    WindowRecoveryLifecycle;
  expect(lifecycle).toEqual(expect.objectContaining({ contractVersion: 1, platform }));
  return lifecycle;
}

async function forceCurrentProcess(processId: number): Promise<void> {
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "forced-termination.json"),
    `${JSON.stringify({ pid: processId, requestedAt: new Date().toISOString() }, null, 2)}\n`);
  await forceTerminateProcessTree(processId);
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const { roles } = await createGameAndRoles();
  const windows = [await createWindow(WINDOWS[0]), await createWindow(WINDOWS[1])];
  const targets = [windows[0]!, windows[1]!, windows[1]!] as const;
  for (const [index, role] of roles.entries()) {
    const cursor = await fixtureCursor();
    await quickAccessLaunch(role, targets[index]!.id);
    await waitSession(cursor, ROLES[index]!, false);
  }
  const saved = await rendererCall("listGameWindows");
  const roleEvidence = await Promise.all(roles.map(async (role, index) => {
    const window = saved.find(({ id }) => id === targets[index]!.id)!;
    const tab = window.tabs.find(({ sourceId }) => sourceId === role.id)!;
    const native = await electronDesktopE2eRoleSessionRuntime(role.id);
    return {
      chromiumPathSha256: native.latestSessionEnsure.chromiumPathSha256,
      fixture: ROLES[index]!.fixture,
      marker: ROLES[index]!.marker,
      name: role.name,
      roleId: role.id,
      tabId: tab.id,
      windowId: window.id
    };
  }));
  const lifecycle: WindowRecoveryLifecycle = {
    contractVersion: 1,
    platform,
    roles: roleEvidence,
    windows: windows.map((window) => {
      const persisted = saved.find(({ id }) => id === window.id)!;
      return {
        activeTabId: persisted.activeTabId!,
        name: persisted.name,
        tabIds: persisted.tabs.map(({ id }) => id),
        windowId: persisted.id
      };
    })
  };
  await writeFile(lifecyclePath(), `${JSON.stringify(lifecycle, null, 2)}\n`);
  await writeRuntime(lifecycle);
}

async function reopenAndVerify(input: Readonly<{
  lifecycle: WindowRecoveryLifecycle;
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<void> {
  const cursor = await fixtureCursor();
  for (const { windowId } of input.lifecycle.windows) await showWindow(windowId);
  await waitExactWindows(input.lifecycle);
  await Promise.all([
    waitSession(cursor, ROLES[0], true),
    waitSession(cursor, ROLES[1], true),
    waitSession(cursor, ROLES[2], true)
  ]);
  await activateWindowRoles({ ...input, windowId: input.lifecycle.windows[1]!.windowId });
}

async function forcePhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  expect((await rendererCall("getEmbeddedRuntimeState")).windows).toEqual([]);
  await reopenAndVerify({ ...input, lifecycle });
  await writeRuntime(lifecycle);
  await forceCurrentProcess(input.processId);
}

async function restoreAndForcePhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toEqual(expect.objectContaining({
    reason: "unclean-exit",
    tabCount: 3,
    windowCount: 2
  }));
  expect(awaiting.recovery?.interruptedWindowIds).toBeUndefined();
  for (const { windowId } of lifecycle.windows) {
    expect(awaiting.savedWindows?.find(({ id }) => id === windowId)?.state)
      .toBe("awaiting-recovery");
  }
  expect(awaiting.windows).toEqual([]);
  const cursor = await fixtureCursor();
  const restore = await $("button=Restore session");
  await restore.waitForClickable({ timeout: 10_000 });
  await restore.click();
  await waitExactWindows(lifecycle);
  await Promise.all([
    waitSession(cursor, ROLES[0], true),
    waitSession(cursor, ROLES[1], true),
    waitSession(cursor, ROLES[2], true)
  ]);
  await activateWindowRoles({
    lifecycle,
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    windowId: lifecycle.windows[1]!.windowId
  });
  await writeRuntime(lifecycle);
  await forceCurrentProcess(input.processId);
}

async function discardPhase(platform: "macos" | "windows"): Promise<void> {
  const lifecycle = await readLifecycle(platform);
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toEqual(expect.objectContaining({
    reason: "unclean-exit",
    tabCount: 3,
    windowCount: 2
  }));
  expect(awaiting.recovery?.interruptedWindowIds).toBeUndefined();
  for (const { windowId } of lifecycle.windows) {
    expect(awaiting.savedWindows?.find(({ id }) => id === windowId)?.state)
      .toBe("awaiting-recovery");
  }
  const discard = await $("button=Discard");
  await discard.waitForClickable({ timeout: 10_000 });
  await discard.click();
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    return runtime.recovery === undefined && runtime.windows.length === 0
      && lifecycle.windows.every(({ windowId }) =>
        runtime.savedWindows?.find(({ id }) => id === windowId)?.state === "dormant");
  }, { timeout: 45_000, timeoutMsg: "Visible Discard did not terminalize exact cohort" });
  expect(await $("button=Restore session").isExisting()).toBe(false);
  await writeRuntime(lifecycle, "discarded");
}

async function finalShowPhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  await navigate("/dashboard");
  expect(await $("button=Restore session").isExisting()).toBe(false);
  expect(await $("button=Discard").isExisting()).toBe(false);
  await reopenAndVerify({ ...input, lifecycle });
  await writeRuntime(lifecycle);
}

describe("Chromium multi-window recovery UI", () => {
  it("restores, activates, discards, and visibly reopens the exact native cohort", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    const input = { mainWindowHandle, platform: probe.platform, processId: probe.processId };
    if (phase === "chromium-window-recovery-seed") await seedPhase(probe.platform);
    else if (phase === "chromium-window-recovery-force") await forcePhase(input);
    else if (phase === "chromium-window-recovery-restore-force") {
      await restoreAndForcePhase(input);
    } else if (phase === "chromium-window-recovery-discard") {
      await discardPhase(probe.platform);
    } else if (phase === "chromium-window-recovery-final-show") {
      await finalShowPhase(input);
    } else throw new Error(`Unexpected Window recovery phase ${phase}`);
  });
});
