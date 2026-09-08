import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { observeUpdaterRelaunch } from "../scripts/electronUpdaterRelaunchObservation.mjs";

describe("packaged updater child observation", () => {
  it("retains a real child's failure and stderr while the journal remains pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-relaunch-"));
    const journal = join(root, "journal");
    try {
      await writeFile(journal, "pending");
      const child = spawn(process.execPath, ["-e", 'process.stderr.write("exact boot failure", () => process.exit(7))'],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const error = await observeUpdaterRelaunch(child, journal, 5000).catch(error => error as AggregateError);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected failed relaunch");
      expect((error.cause as Error).message).toContain("code 7");
      expect(error.errors[0].stderr).toContain("exact boot failure");
      expect(JSON.parse(error.errors[0].message)).toMatchObject({
        processId: child.pid, exitCode: 7, journal: { present: true, bytes: 7, regularFile: true }
      });
      expect(child.listenerCount("exit")).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bounds noisy child output and preserves the exact spawn error", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-relaunch-"));
    try {
      const journal = join(root, "journal");
      await writeFile(journal, "pending");
      const child = Object.assign(new EventEmitter(), {
        pid: 42, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough()
      }) as unknown as ChildProcess;
      const primary = new Error("spawn denied");
      const pending = observeUpdaterRelaunch(child, journal, 5000).catch(error => error as AggregateError);
      (child.stderr as PassThrough).write("x".repeat(20000) + "tail");
      child.emit("error", primary);
      const error = await pending;
      if (!(error instanceof AggregateError)) throw new Error("Expected failed relaunch");
      expect(error.cause).toBe(primary);
      expect(error.errors[0].stderr).toHaveLength(8192);
      expect(error.errors[0].stderr.endsWith("tail")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
