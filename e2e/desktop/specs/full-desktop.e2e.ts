import { browser, expect } from "@wdio/globals";

import { probe, rendererCall, shutdown } from "../support/control";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickEntityMenuAction,
  ensureEnglishUi,
  navigate
} from "../support/ui";

// [journey:APP-FULL-CRUD-001]

const GAME_NAME = "E2E Smoke Game Edited";
const ROLE_NAME = "E2E Smoke Role";
const WORKSPACE_NAME = "E2E Smoke Workspace";
const MACRO_NAME = "E2E Smoke Macro";

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

async function deleteEntity(
  route: string,
  id: string,
  triggerLabel: string,
  listMethod: "listGames" | "listRoles" | "listLaunchWorkspaces" | "listMacros"
): Promise<void> {
  await navigate(route);
  await clickEntityMenuAction(id, triggerLabel, "Delete");
  await clickConfirmation("Delete");
  await browser.waitUntil(async () => {
    const entities = await rendererCall(listMethod) as Array<{ id: string }>;
    return !entities.some((entity) => entity.id === id);
  }, { timeout: 15_000, timeoutMsg: `${id} remained after destructive UI confirmation` });
}

describe("full desktop mutation journeys", () => {
  it("cancels once, then removes persisted entities in reverse dependency order", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const game = (await rendererCall("listGames")).find((candidate) => candidate.name === GAME_NAME);
    const role = (await rendererCall("listRoles")).find((candidate) => candidate.name === ROLE_NAME);
    const workspace = (await rendererCall("listLaunchWorkspaces")).find((candidate) => candidate.name === WORKSPACE_NAME);
    const macro = (await rendererCall("listMacros")).find((candidate) => candidate.name === MACRO_NAME);
    if (!game || !role || !workspace || !macro) throw new Error("Smoke entities are unavailable for full CRUD cleanup");

    await navigate("/macros");
    await clickEntityMenuAction(macro.id, "Macro actions", "Delete");
    await clickConfirmation("Cancel");
    expect((await rendererCall("listMacros")).some((candidate) => candidate.id === macro.id)).toBe(true);

    await deleteEntity("/macros", macro.id, "Macro actions", "listMacros");
    await deleteEntity("/workspaces", workspace.id, "Workspace actions", "listLaunchWorkspaces");
    await deleteEntity("/roles", role.id, "Role actions", "listRoles");
    await deleteEntity("/games", game.id, "Game actions", "listGames");
    await shutdownAndWaitForFlush();
  });
});
