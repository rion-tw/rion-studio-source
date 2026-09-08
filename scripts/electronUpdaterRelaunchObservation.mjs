import { lstat } from "node:fs/promises";
import { waitForUpdaterJournalRemoval } from "./electronUpdaterJournalAcknowledgement.mjs";

/** Observe the exact child; process exit is failure, never an updater ACK. */
export async function observeUpdaterRelaunch(child, journalPath, deadlineMilliseconds) {
  const cancellation = new AbortController();
  const output = { stdout: "", stderr: "" };
  const append = (name) => (chunk) => {
    // Keep draining pipes while bounding retained diagnostics, including a crash tail.
    output[name] = (output[name] + chunk.toString()).slice(-8192);
  };
  const stdout = append("stdout");
  const stderr = append("stderr");
  const failed = (error) => cancellation.abort(error);
  const exited = (code, signal) => failed(new Error(
    `Updater relaunch exited before journal acknowledgement: PID ${child.pid}; code ${code}; signal ${signal}`
  ));
  child.stdout?.on("data", stdout);
  child.stderr?.on("data", stderr);
  child.once("error", failed);
  child.once("exit", exited);
  try {
    if (child.exitCode !== null || child.signalCode !== null) {
      exited(child.exitCode, child.signalCode);
    }
    await waitForUpdaterJournalRemoval(journalPath, deadlineMilliseconds, undefined, cancellation.signal);
  } catch (primaryError) {
    let journal;
    try {
      const status = await lstat(journalPath);
      journal = { present: true, bytes: status.size, modifiedAt: status.mtime.toISOString(),
        regularFile: status.isFile(), symbolicLink: status.isSymbolicLink() };
    } catch (error) {
      journal = { present: error?.code === "ENOENT" ? false : "unknown", errorCode: error?.code };
    }
    const diagnostic = Object.assign(new Error(JSON.stringify({
      kind: "updater-relaunch-observation", authoritative: false,
      processId: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, journal
    })), output);
    throw new AggregateError([diagnostic], "Updater relaunch failed; bounded child observations retained.", { cause: primaryError });
  } finally {
    child.removeListener("error", failed);
    child.removeListener("exit", exited);
    child.stdout?.removeListener("data", stdout);
    child.stderr?.removeListener("data", stderr);
    child.stdout?.resume();
    child.stderr?.resume();
  }
}
