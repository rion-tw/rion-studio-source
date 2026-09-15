import { readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { assertFixtureKeyboardReleased, type FixtureKeyboardEvidence } from
  "../../../src/electron/e2e/fixtureKeyboardEvidence";

async function waitForArtifact<T>(name: string, select: (value: unknown) => T | undefined): Promise<T> {
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR!;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const changes = watch(directory, { signal: controller.signal });
  const next = () => {
    const change = changes.next();
    void change.catch(() => undefined);
    return change;
  };
  // Subscribe before reading; a terminal write between reads must not be lost.
  let pending = next();
  const read = async (): Promise<T | undefined> => {
    try { return select(JSON.parse(await readFile(join(directory, name), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };
  try {
    for (;;) {
      const current = await read();
      if (current !== undefined) return current;
      const change = await pending;
      if (change.done) break;
      pending = next();
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await changes.return?.();
  }
  throw new Error(`Terminal artifact was not observed: ${name}`);
}

export async function expectTerminalConsumerRelease(roleId: string, tabId: string, code: string): Promise<void> {
  const evidence = await waitForArtifact("electron-fixture-keyboard-terminal.json", value =>
    (value as FixtureKeyboardEvidence[]).find(entry => entry.roleId === roleId && entry.tabId === tabId));
  assertFixtureKeyboardReleased(evidence, code);
}

export async function waitForTabDestruction(tabId: string): Promise<void> {
  const terminal = await waitForArtifact("electron-core-flow-observations.json", value =>
    (value as Array<{ boundary: string; type: string; status: string; error?: string;
      details?: { action?: { tabId?: string }; result?: unknown } }>).find(entry =>
      entry.boundary === "effect" && entry.type === "embeddedDestroyTab" &&
      entry.status !== "started" && entry.details?.action?.tabId === tabId));
  if (terminal.status !== "completed" || terminal.details?.result !== true) {
    throw new Error(`Exact tab destruction did not complete: ${terminal.error ?? terminal.status}`);
  }
}

export async function runtimeEffectCursor(): Promise<number> {
  const entries = JSON.parse(await readFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!,
    "electron-core-flow-observations.json"), "utf8")) as Array<{ sequence: number }>;
  return entries.at(-1)?.sequence ?? 0;
}

export async function waitForCreatedWorkspaceTab(sourceId: string, afterSequence: number): Promise<string> {
  return waitForArtifact("electron-core-flow-observations.json", value =>
    (value as Array<{ sequence: number; boundary: string; type: string; status: string;
      details?: { action?: { sourceId?: string; tabId?: string } } }>).find(entry =>
      entry.sequence > afterSequence && entry.boundary === "effect" &&
      entry.type === "embeddedCreateTab" && entry.status === "started" &&
      entry.details?.action?.sourceId === sourceId)?.details?.action?.tabId);
}

/** Pair authoritative close completion with each original WebContents' native event. */
export async function expectRoleSurfacesDestroyed(roleIds: readonly string[]): Promise<void> {
  const events = JSON.parse(await readFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!,
    "electron-role-surface-lifecycle-observations.json"), "utf8")) as Array<{
      roleId?: string; webContentsId: number; sequence: number; stage: string; destroyed: boolean;
    }>;
  for (const roleId of roleIds) {
    const created = events.filter(event => event.roleId === roleId && event.stage === "created");
    if (!created.length || created.some(original => !events.some(event =>
      event.roleId === roleId && event.webContentsId === original.webContentsId &&
      event.sequence > original.sequence && event.stage === "destroyed" && event.destroyed))) {
      throw new Error(`Original native Role surfaces were not all destroyed: ${roleId}`);
    }
  }
}
