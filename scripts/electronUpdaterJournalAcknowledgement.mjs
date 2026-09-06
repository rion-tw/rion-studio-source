import { watch } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** Subscribe before readback so journal removal cannot fall between them. */
export function waitForUpdaterJournalRemoval(path, timeoutMilliseconds, operations = { access, watch }) {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    return Promise.reject(new Error("Updater acknowledgement requires a positive deadline."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let deadline;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    const inspect = async () => {
      try {
        await operations.access(path);
      } catch (error) {
        // Permission and I/O failures are unknown outcomes, never removal ACKs.
        if (error?.code === "ENOENT") finish();
        else finish(error);
      }
    };
    try {
      watcher = operations.watch(dirname(path), (_event, filename) => {
        if (filename && String(filename) !== basename(path)) return;
        void inspect();
      });
      watcher.on("error", finish);
      watcher.on("close", () => {
        if (!settled) finish(new Error("Updater acknowledgement event stream closed."));
      });
      // DeadlineBound: native updater relaunch has an external acknowledgement
      // boundary. Elapsed time fails; only exact journal absence acknowledges.
      deadline = setTimeout(() => finish(new Error(
        `Timed out waiting for updater acknowledgement: ${path}`
      )), timeoutMilliseconds);
      void inspect();
    } catch (error) {
      finish(error);
    }
  });
}
