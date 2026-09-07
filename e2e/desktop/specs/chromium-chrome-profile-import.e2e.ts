import { $, expect } from "@wdio/globals";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CHROME_IMPORT_MARKER, CHROME_IMPORT_ROLE,
  chromeImportSourceDigest, prepareChromeImportSource } from "../support/chrome-import-fixture";
import { electronDesktopE2eProbe, electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { selectNativeChromeImportDirectory } from "../support/native-directory-selection";
import { rendererCall } from "../support/renderer-bridge";
import { installRendererEventJournal, rendererEventCursor,
  waitForCollectionProjection, waitForRoleProjection } from "../support/renderer-events";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, setEditorName,
  submitEditor, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-CHROME-PROFILE-IMPORT-033]
// [journey:CHROMIUM-WINDOWS-CHROME-PROFILE-IMPORT-033]

const GAME_NAME = "Chromium Import Game";
const FIXTURE_ID = "chromium-chrome-import";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chrome import journey`);
  return value;
}

async function navigate(label: string, route: string): Promise<void> {
  await $(".app-main-sidebar").$(`button*=${label}`).click();
  await waitForRoute(route);
}

function expectNoPendingImport(): void {
  const database = new DatabaseSync(join(required("RION_STUDIO_USER_DATA_DIR"), "rion-studio.sqlite3"), {
    readOnly: true
  });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM operation_journal WHERE kind = 'chrome_profile_import_v2'"
    ).get();
    expect(row?.count).toBe(0);
  } finally {
    database.close();
  }
}

async function seedImport(probe: Awaited<ReturnType<typeof electronDesktopE2eProbe>>): Promise<void> {
  const source = await prepareChromeImportSource(
    required("RION_STUDIO_E2E_ARTIFACT_DIR"), required("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  );
  await navigate("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(
    `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${FIXTURE_ID}?mode=observe`
  );
  await submitEditor("/games");
  await navigate("Settings", "/settings");
  await $(".settings-mode-sidebar").$("button=Data transfer").click();
  await waitForRoute("/settings?section=data");
  const trigger = await $("button=Import from Chrome");
  await trigger.scrollIntoView({ block: "center" });
  await trigger.click();
  let dialog = await $("[role='dialog']");
  await expect(dialog).toHaveText(expect.stringContaining("Allow sensitive session transfer"));
  await expect(dialog.$("button=Choose Chrome folder")).toBeDisabled();
  await dialog.$("button=Cancel").click();
  expect((await rendererCall("listRoles")).filter(role => role.name === CHROME_IMPORT_ROLE)).toHaveLength(0);
  expectNoPendingImport();
  await trigger.click();
  dialog = await $("[role='dialog']");
  await expect(dialog.$("button=Choose Chrome folder")).toBeDisabled();
  await dialog.$("[role='checkbox']").click();
  await expect(dialog.$("button=Choose Chrome folder")).toBeEnabled();
  await dialog.$("button=Choose Chrome folder").click();
  await selectNativeChromeImportDirectory({ path: source.root, processId: probe.processId, platform: probe.platform });
  dialog = await $("[role='dialog']");
  await expect(dialog).toHaveText(expect.stringContaining("Chrome profile import"));
  await expect(dialog.$("button=Apply import")).toBeDisabled();
  await dialog.$("[role='combobox']").click();
  await $(`[role='option']=${GAME_NAME}`).click();
  await dialog.$("[role='checkbox']").click();
  await dialog.$("button=Apply import").click();
  const confirmation = await $("dialog[open]");
  await confirmation.waitForDisplayed();
  await confirmation.$("button=Cancel").click();
  expect((await rendererCall("listRoles")).filter(role => role.name === CHROME_IMPORT_ROLE)).toHaveLength(0);
  expectNoPendingImport();
  await dialog.$("button=Apply import").click();
  const afterSequence = await rendererEventCursor();
  await $("dialog[open]").$("button=Apply import").click();
  await dialog.$("button=Close").waitForDisplayed({ timeout: 45_000 });
  await expect(dialog).toHaveText(expect.stringContaining("Imported"));
  await expect(dialog).toHaveText(expect.stringContaining("1 cookies · 1 LocalStorage entries"));
  await expect(dialog).not.toHaveText(expect.stringContaining("Failed"));
  await waitForCollectionProjection({ afterSequence, collection: "roles", names: [CHROME_IMPORT_ROLE] });
  expectNoPendingImport();
  expect(await chromeImportSourceDigest(source.root)).toBe(source.digest);
  await dialog.$("button=Close").click();
  await $("button=Back to app").click();
  await writeFile(join(required("RION_STUDIO_USER_DATA_DIR"), "chrome-import-source-evidence.json"),
    JSON.stringify(source));
}

async function verifyVisibleLaunch(probe: Awaited<ReturnType<typeof electronDesktopE2eProbe>>): Promise<void> {
  await navigate("Roles", "/roles");
  const roles = (await rendererCall("listRoles")).filter(role => role.name === CHROME_IMPORT_ROLE);
  expect(roles).toHaveLength(1);
  const role = roles[0]!;
  const card = await $(`[data-selection-id='${role.id}']`);
  await card.scrollIntoView({ block: "center" });
  await card.moveTo();
  const afterSequence = await rendererEventCursor();
  const fixtureSequence = await fixtureCursor();
  await card.$("button[aria-label='Open']").click();
  await waitForRoleProjection({ afterSequence, roleId: role.id, state: "running" });
  const observed = await waitFixtureEvent({ afterSequence: fixtureSequence, roleId: FIXTURE_ID, kind: "session" });
  expect(observed.session).toMatchObject({
    before: { cookie: CHROME_IMPORT_MARKER, localStorage: CHROME_IMPORT_MARKER },
    after: { cookie: CHROME_IMPORT_MARKER, localStorage: CHROME_IMPORT_MARKER },
    mode: "observe"
  });
  const runtime = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(runtime.currentRuntime?.hostKind).toBe(probe.platform === "macos" ? "appkit-chromium" : "bundled-chromium");
  expect(runtime.latestSessionEnsure.chromiumUserDataDir).not.toContain("chrome-import-source");
  expectNoPendingImport();
  const source = JSON.parse(await readFile(join(required("RION_STUDIO_USER_DATA_DIR"),
    "chrome-import-source-evidence.json"), "utf8")) as { root: string; digest: string };
  expect(await chromeImportSourceDigest(source.root)).toBe(source.digest);
  await writeFile(join(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chrome-import-ui-evidence.json"), JSON.stringify({
    phase: required("RION_STUDIO_E2E_PHASE"), platform: probe.platform, roleId: role.id,
    runtime, session: observed.session, sourceDigest: source.digest
  }, null, 2));
}

describe("Consented Chromium Chrome Profile import", () => {
  it("requires visible consent and confirmation, imports only launch-origin data, and persists after restart", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    await installRendererEventJournal();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-chrome-profile-import-seed") await seedImport(probe);
    else if (phase !== "chromium-chrome-profile-import-restart") throw new Error(`Unexpected import phase ${phase}`);
    await verifyVisibleLaunch(probe);
  });
});
