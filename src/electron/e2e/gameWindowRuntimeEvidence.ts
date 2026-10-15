import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runtimeOperationEvidence } from "../main/runtimeOperationJournal";

/** Keep failed Show admission evidence in the same uploaded scope as its readback. */
export function writeGameWindowRuntimeEvidence(
  directory: string | undefined,
  observations: readonly unknown[]
): void {
  if (!directory || !isAbsolute(directory)) return;
  writeFileSync(join(directory, "electron-game-window-runtime-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`);
  writeFileSync(join(directory, "electron-runtime-operation-observations.json"),
    `${JSON.stringify(runtimeOperationEvidence(), null, 2)}\n`);
}
