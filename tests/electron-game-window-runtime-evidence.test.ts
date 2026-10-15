import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { writeGameWindowRuntimeEvidence } from "../src/electron/e2e/gameWindowRuntimeEvidence";
import { recordRuntimeTransition } from "../src/electron/main/runtimeOperationJournal";

it("retains rejected receipt fences beside the final absent Game Window readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-window-evidence-"));
  if (!resolve(directory).startsWith(resolve(tmpdir())+sep) || !directory.includes("rion-window-evidence-")) {
    throw new Error("Window evidence cleanup escaped its temporary scope");
  }
  try {
    recordRuntimeTransition({ operationId: "show-operation", action: "empty-window-receipt",
      targetKind: "window", targetId: "window-under-test", stage: "rejected",
      errorCode: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
      fences: { coreRevision: 2, nativeRevision: 3, reason: "topology-revision" } });
    const observations = [{ windowId: "window-under-test", currentRuntime: null }];
    writeGameWindowRuntimeEvidence(directory, observations);
    expect(JSON.parse(await readFile(join(directory, "electron-game-window-runtime-observations.json"), "utf8")))
      .toEqual(observations);
    const journal = JSON.parse(await readFile(join(directory, "electron-runtime-operation-observations.json"), "utf8"));
    expect(journal.capacity).toBe(512);
    expect(journal.entries).toContainEqual(expect.objectContaining({
      action: "empty-window-receipt", stage: "rejected", targetId: "window-under-test",
      errorCode: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
      fences: { coreRevision: 2, nativeRevision: 3, reason: "topology-revision" }
    }));
    expect(journal.entries.length).toBeLessThanOrEqual(journal.capacity);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
