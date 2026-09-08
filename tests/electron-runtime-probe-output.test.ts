import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runElectronRuntimeProbe } from "../scripts/verifyElectronRuntime.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function probeProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeEach(() => vi.clearAllMocks());

describe.each(["darwin", "win32"])("%s runtime probe output", (platform) => {
  it("waits for the complete pipe observation after process exit", async () => {
    const child = probeProcess();
    const pending = runElectronRuntimeProbe("electron", "probe.cjs", "addon.node", "isolated");
    const payload = { platform, core: "8.5.0" };
    child.emit("exit", 0, null);
    child.stdout.write(`RION_ELECTRON_RUNTIME_PROBE=${JSON.stringify(payload)}\n`);
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual(payload);
  });

  it("retains the payload and last stage without accepting a crashed process", async () => {
    const child = probeProcess();
    const pending = runElectronRuntimeProbe("electron", "probe.cjs", "addon.node", "isolated");
    const failure = pending.catch((error: unknown) => error as Error);
    child.stdout.write(`RION_ELECTRON_RUNTIME_PROBE=${JSON.stringify({ platform })}\n`);
    child.emit("exit", 3221225477, null);
    child.stderr.write("RION_ELECTRON_RUNTIME_STAGE=contract-written\n");
    child.emit("close", 3221225477, null);
    const error = await failure as Error;
    expect(error.message).toContain("exited with code 3221225477");
    expect(error.message).toContain(`RION_ELECTRON_RUNTIME_PROBE=${JSON.stringify({ platform })}`);
    expect(error.message).toContain("RION_ELECTRON_RUNTIME_STAGE=contract-written");
  });

  it("bounds noisy native failure output while retaining its last observation", async () => {
    const child = probeProcess();
    const pending = runElectronRuntimeProbe("electron", "probe.cjs", "addon.node", "isolated");
    const failure = pending.catch((error: unknown) => error as Error);
    child.stdout.write(`old-stdout-${"x".repeat(100_000)}last-stdout`);
    child.stderr.write(`old-stderr-${"y".repeat(100_000)}last-stderr`);
    child.emit("close", 1, null);
    const error = await failure as Error;
    expect(error.message.length).toBeLessThan(33_000);
    expect(error.message).not.toContain("old-stdout");
    expect(error.message).not.toContain("old-stderr");
    expect(error.message).toContain("last-stdout");
    expect(error.message).toContain("last-stderr");
  });
});
