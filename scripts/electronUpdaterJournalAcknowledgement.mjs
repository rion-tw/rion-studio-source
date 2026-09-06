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
    let fileWatcher;
    let deadline;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      watcher?.close();
      fileWatcher?.close();
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
    const bindFile = () => {
      if (settled) return;
      let next;
      try {
        next = operations.watch(path, () => {
          if (settled || fileWatcher !== next) return;
          observeChange();
        });
      } catch (error) {
        // Watching this exact path reports ENOENT if the journal is already gone.
        if (error?.code === "ENOENT") finish();
        else finish(error);
        return;
      }
      const previous = fileWatcher;
      fileWatcher = next;
      next.on("error", (error) => {
        if (fileWatcher === next && !settled) finish(error);
      });
      next.on("close", () => {
        if (fileWatcher === next && !settled) {
          finish(new Error("Updater journal file event stream closed."));
        }
      });
      previous?.close();
    };
    const observeChange = () => {
      // An exact native event may mean atomic replacement. Bind the current
      // inode before readback; neither the old inode nor a directory event alone
      // establishes removal. This adds no periodic discovery or retry loop.
      bindFile();
      if (!settled) void inspect();
    };
    try {
      watcher = operations.watch(dirname(path), (_event, filename) => {
        if (settled || (filename && String(filename) !== basename(path))) return;
        observeChange();
      });
      watcher.on("error", finish);
      watcher.on("close", () => {
        if (!settled) finish(new Error("Updater acknowledgement event stream closed."));
      });
      bindFile();
      if (settled) return;
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
