import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { compile, executeRaw } = vi.hoisted(() => ({ compile: vi.fn(), executeRaw: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(executeRaw, { [promisify.custom]: compile }) };
});

type Completion = (error: Error | null, stdout: string, stderr: string) => void;
const args = ["123", "Game", "window-id", "roleKey", "F6"] as const;
const turn = () => new Promise<void>(resolveTurn => setImmediate(resolveTurn));

function nativeChild() {
  let complete!: Completion;
  let markStarted!: () => void;
  const started = new Promise<void>(resolveStarted => { markStarted = resolveStarted; });
  let input = "";
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
  child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString(); });
  executeRaw.mockImplementationOnce((_file, _args, _options, callback: Completion) => {
    complete = callback;
    markStarted();
    return child;
  });
  return { child, started, input: () => input,
    callback: (error: Error | null = null, stdout = "", stderr = "") => complete(error, stdout, stderr),
    closed: (code: number | null = 0, signal: NodeJS.Signals | null = null) => child.emit("close", code, signal),
    close: (error: Error | null = null, stdout = "", stderr = "") => {
      complete(error, stdout, stderr);
      child.emit("close", error ? 1 : 0, null);
    } };
}

async function begin<Value>(receive: () => Promise<Value>) {
  const helper = await import("../e2e/desktop/support/compiled-macos-native-focus");
  await helper.prepareMacosNativeFocus();
  const native = nativeChild();
  const pending = helper.withMacosNativeFocusReceipt(args, receive);
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await native.started;
  const argv = executeRaw.mock.calls.at(-1)![1] as string[];
  const nonce = argv.at(-1)!;
  return { ...native, pending, outcome, nonce, argv };
}

beforeEach(() => {
  vi.resetModules();
  compile.mockReset().mockResolvedValue({ stdout: "" });
  executeRaw.mockReset();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", resolve("receipt-phase"));
});
afterEach(() => vi.unstubAllEnvs());

describe("macOS native sender lifetime receipt", () => {
  it("retains the sender through exact target assertions and requires its final receipt and pipe close", async () => {
    let receiveTarget!: (value: { exact: true }) => void;
    const receive = vi.fn(() => new Promise<{ exact: true }>(resolveTarget => { receiveTarget = resolveTarget; }));
    const work = await begin(receive);
    let settled = false;
    void work.outcome.then(() => { settled = true; });
    expect(receive).not.toHaveBeenCalled();
    expect(work.argv.slice(0, -2)).toEqual(args);
    expect(work.argv.at(-2)).toBe("receipt");
    expect(work.nonce).toMatch(/^[a-f0-9-]{36}$/u);
    work.child.stdout.write(`submitted:${work.nonce.slice(0, 10)}`);
    await turn();
    expect(receive).not.toHaveBeenCalled();
    work.child.stdout.write(`${work.nonce.slice(10)}\n`);
    await turn();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(work.child.stdin.writableEnded).toBe(false);
    expect(work.input()).toBe("");
    receiveTarget({ exact: true });
    await turn();
    expect(work.input()).toBe(`received:${work.nonce}\n`);
    expect(settled).toBe(false);
    work.child.stdout.write(`completed:${work.nonce}\n`);
    await turn();
    expect(settled).toBe(false);
    work.close();
    await expect(work.pending).resolves.toEqual({ exact: true });
    expect(work.child.kill).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("compiles before native submission and retains a failed compilation without invoking target assertions", async () => {
    const cause = Object.assign(new Error("SDK failed"), { code: 1 });
    compile.mockRejectedValue(cause);
    const helper = await import("../e2e/desktop/support/compiled-macos-native-focus");
    const receive = vi.fn();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(helper.withMacosNativeFocusReceipt(args, receive)).rejects.toMatchObject({ cause });
    }
    expect(compile).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it("accepts an exact completed marker and successful child close before the local stdin callback", async () => {
    const work = await begin(async () => "exact target");
    let result: unknown;
    void work.outcome.then(outcome => { result = outcome; });
    vi.spyOn(work.child.stdin, "end").mockReturnValue(work.child.stdin);
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    work.child.stdout.write(`completed:${work.nonce}\n`);
    work.close();
    await turn();
    expect(result).toEqual({ value: "exact target" });
  });

  it.each([false, true])("rejects an early successful child exit (submitted=%s)", async (submitted) => {
    const receive = vi.fn(() => new Promise<void>(() => undefined));
    const work = await begin(receive);
    if (submitted) work.child.stdout.write(`submitted:${work.nonce}\n`);
    work.close();
    await expect(work.pending).rejects.toThrow("exited before its complete target acknowledgement");
    await turn();
    expect(receive).not.toHaveBeenCalled();
    expect(work.input()).toBe("");
  });

  it("preserves a rejected target assertion, cancels the exact sender, and waits for cleanup", async () => {
    const original = new Error("exact Macro terminal receipt was rejected");
    const work = await begin(async () => { throw original; });
    let settled = false;
    void work.outcome.then(() => { settled = true; });
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    expect(work.input()).toBe(`cancel:${work.nonce}\n`);
    expect(work.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);
    work.close(Object.assign(new Error("killed after cancellation"), { signal: "SIGKILL" }));
    await expect(work.pending).rejects.toBe(original);
  });

  it.each(["foreign-nonce", "wrong-stage", "duplicate", "oversized", "partial"])(
    "rejects %s protocol output without acknowledging the sender", async (kind) => {
      const receive = vi.fn(() => new Promise<void>(() => undefined));
      const work = await begin(receive);
      if (kind === "foreign-nonce") work.child.stdout.write("submitted:not-this-child\n");
      if (kind === "wrong-stage") work.child.stdout.write(`completed:${work.nonce}\n`);
      if (kind === "duplicate") {
        work.child.stdout.write(`submitted:${work.nonce}\n`);
        work.child.stdout.write(`submitted:${work.nonce}\n`);
      }
      if (kind === "oversized") work.child.stdout.write("x".repeat(257));
      if (kind === "partial") {
        work.child.stdout.write(`submitted:${work.nonce}`);
        work.child.stdout.emit("end");
      }
      await turn();
      expect(work.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(work.input()).toBe(`cancel:${work.nonce}\n`);
      work.close(Object.assign(new Error("protocol cancellation"), { signal: "SIGKILL" }));
      await expect(work.pending).rejects.toThrow("receipt failed");
      expect(receive).not.toHaveBeenCalled();
    }
  );

  it("rejects a missing completion marker after successful target assertions", async () => {
    const work = await begin(async () => "target passed");
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    expect(work.input()).toBe(`received:${work.nonce}\n`);
    work.close();
    await expect(work.pending).rejects.toThrow("exited before its complete target acknowledgement");
  });

  it.each(["stdin", "stdout", "stderr"] as const)("rejects a broken %s pipe and does not retry", async (pipe) => {
    const cause = Object.assign(new Error("pipe broke"), { code: "EPIPE" });
    const work = await begin(async () => "unused");
    work.child[pipe].emit("error", cause);
    expect(work.child.kill).toHaveBeenCalledTimes(1);
    work.close(cause);
    await expect(work.pending).rejects.toBe(cause);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("keeps the native deadline and ignores a late target %s after timeout", async (late) => {
    let completeTarget!: () => void;
    const work = await begin(() => new Promise<void>((resolveTarget, rejectTarget) => {
      completeTarget = () => late === "resolve" ? resolveTarget() : rejectTarget(new Error("late target failure"));
    }));
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    expect(executeRaw.mock.calls[0]![2]).toMatchObject({ timeout: 15_000 });
    const cause = Object.assign(new Error("external process deadline"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGTERM"
    });
    work.close(cause, "bounded native tail", "native deadline");
    await expect(work.pending).rejects.toMatchObject({
      cause, message: expect.stringMatching(/ETIMEDOUT.*killed=true.*SIGTERM.*native deadline/u)
    });
    completeTarget();
    await turn();
    expect(work.input()).toBe(`cancel:${work.nonce}\n`);
    expect(work.input()).not.toContain("received:");
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign completion nonce even after target assertions pass", async () => {
    const work = await begin(async () => "exact target");
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    work.child.stdout.write("completed:another-child\n");
    expect(work.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    work.close();
    await expect(work.pending).rejects.toThrow("mismatched nonce");
  });

  it("preserves a pipe failure after target success instead of accepting the later child receipt", async () => {
    const work = await begin(async () => "exact target");
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    const cause = Object.assign(new Error("ACK pipe failed"), { code: "EPIPE" });
    work.child.stdin.emit("error", cause);
    work.child.stdout.write(`completed:${work.nonce}\n`);
    work.close();
    await expect(work.pending).rejects.toBe(cause);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("does not treat a crash after all protocol receipts as successful delivery", async () => {
    const work = await begin(async () => "target passed");
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    work.child.stdout.write(`completed:${work.nonce}\n`);
    const cause = Object.assign(new Error("native crash"), { code: 134, signal: "SIGABRT" });
    work.close(cause);
    await expect(work.pending).rejects.toMatchObject({ cause });
  });

  it.each(["child-error", "exec-callback"])("waits for actual child close after an early %s failure", async (source) => {
    const work = await begin(async () => "unused");
    let result: unknown;
    void work.outcome.then(outcome => { result = outcome; });
    const cause = Object.assign(new Error("native process error"), { code: "EIO" });
    if (source === "child-error") work.child.emit("error", cause);
    work.callback(cause, "native stdout", "native stderr");
    await turn();
    expect(result).toBeUndefined();
    expect(work.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    work.closed(null, "SIGKILL");
    if (source === "child-error") await expect(work.pending).rejects.toBe(cause);
    else await expect(work.pending).rejects.toMatchObject({ cause });
  });

  it.each([[9, null], [null, "SIGTERM"]] as const)(
    "rejects actual close code %s/signal %s even if execFile reported success", async (code, signal) => {
      const work = await begin(async () => "exact target");
      work.child.stdout.write(`submitted:${work.nonce}\n`);
      await turn();
      work.child.stdout.write(`completed:${work.nonce}\n`);
      work.callback();
      work.closed(code, signal);
      await expect(work.pending).rejects.toThrow("the exact child closed with code");
    }
  );

  it("requires the execFile outcome as well as a successful actual close", async () => {
    const work = await begin(async () => "exact target");
    let result: unknown;
    void work.outcome.then(outcome => { result = outcome; });
    work.child.stdout.write(`submitted:${work.nonce}\n`);
    await turn();
    work.child.stdout.write(`completed:${work.nonce}\n`);
    work.closed();
    await turn();
    expect(result).toBeUndefined();
    work.callback();
    await expect(work.pending).resolves.toBe("exact target");
  });
});
