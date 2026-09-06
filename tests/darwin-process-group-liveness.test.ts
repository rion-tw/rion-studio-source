import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { isDarwinProcessGroupAlive } from "../scripts/darwinProcessGroupLiveness.mjs";

const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
const deny = () => { throw denied; };

describe("Darwin exact process-group liveness", () => {
  it.each(["", "12 12 501 Z", "12 12 501 Z\n13 12 501 Z+"])(
    "accepts an absent or independently observed zombie-only group: %j", source => {
      const readGroupSnapshot = vi.fn(() => source);
      expect(isDarwinProcessGroupAlive(12, { kill: deny, readGroupSnapshot })).toBe(false);
      expect(readGroupSnapshot).toHaveBeenCalledWith(12);
    }
  );

  it.each(["12 12 501 S", "12 12 501 Z\n13 12 501 R+"])(
    "preserves permission failure when a live member exists: %j", source => {
      expect(() => isDarwinProcessGroupAlive(12, { kill: deny, readGroupSnapshot: () => source })).toThrow(denied);
    }
  );

  it.each(["12 14 501 Z", "1 12 501 Z", "12 12 501", "12 12 501 ?", "12 12 -1 Z"])(
    "rejects malformed or foreign-group state: %j", source => {
      expect(() => isDarwinProcessGroupAlive(12, { kill: deny, readGroupSnapshot: () => source }))
        .toThrow("malformed process-group state");
    }
  );

  it("preserves read failure and does not inspect a normally live group", () => {
    const readGroupSnapshot = vi.fn(() => { throw new Error("inventory failed"); });
    expect(isDarwinProcessGroupAlive(12, { kill: () => true, readGroupSnapshot })).toBe(true);
    expect(readGroupSnapshot).not.toHaveBeenCalled();
    expect(() => isDarwinProcessGroupAlive(12, { kill: deny, readGroupSnapshot })).toThrow("inventory failed");
  });
});

it.skipIf(process.platform !== "darwin")("recognizes a real macOS zombie-only group without treating EPERM as absence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-zombie-group-"));
  const executable = join(directory, "probe");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const source = join(directory, "probe.c");
    await writeFile(source, `
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 1;
  if (child == 0) { if (setsid() < 0) _exit(2); _exit(0); }
  siginfo_t info = {0};
  if (waitid(P_PID, child, &info, WEXITED | WNOWAIT)) return 3;
  printf("%d\\n", child); fflush(stdout);
  getchar(); waitpid(child, 0, 0); return 0;
}
`);
    await promisify(execFile)("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror", source, "-o", executable]);
    child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve, reject) => {
      child!.once("close", code => code === 0 ? resolve() : reject(new Error(`probe exited ${code}`)));
      child!.once("error", reject);
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child!.stdout!.once("data", buffer => resolve(Number(buffer.toString().trim())));
      child!.once("error", reject);
    });
    try {
      expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "EPERM" }));
      expect(isDarwinProcessGroupAlive(pid)).toBe(false);
    } finally {
      child.stdin!.end("reap\n");
      await closed;
    }
  } finally {
    child?.stdin?.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
