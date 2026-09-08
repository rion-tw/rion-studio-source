import type { ChildProcess } from "node:child_process";
export function observeUpdaterRelaunch(
  child: ChildProcess, journalPath: string, deadlineMilliseconds: number
): Promise<void>;
