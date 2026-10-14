import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const SETUP_READY = "RION_JOB_DIAGNOSTIC_SETUP_READY";
const RUN_NATIVE = "RION_JOB_DIAGNOSTIC_RUN_NATIVE";
const MAXIMUM_OUTPUT = 1024 * 1024;

export async function startWindowsJobDiagnosticFixture() {
  const temporaryParent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryParent, "rion-job-root-")));
  const identity = await lstat(root);
  const child = spawn("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    resolve("tests/fixtures/windows-job-process-diagnostics.ps1"),
    "-FixtureRoot", root
  ], { windowsHide: true, stdio: "pipe" });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveCompletion!: (output: string) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let barrierBuffer = "";
  let stdout = "";
  let stderr = "";
  let ready = false;
  let started = false;
  let failure: Error | undefined;
  let disposal: Promise<void> | undefined;

  // Completion can reject during beforeAll, before the test attaches its await.
  void completion.catch(() => {});
  function fail(error: Error) {
    failure ??= error;
    rejectReady(failure);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (!ready) {
      barrierBuffer += chunk;
      const newline = barrierBuffer.indexOf("\n");
      if (newline !== -1) {
        const barrier = barrierBuffer.slice(0, newline).replace(/\r$/, "");
        if (barrier !== SETUP_READY) {
          fail(new Error("The Windows Job fixture returned an unexpected setup barrier."));
          return;
        }
        stdout = barrierBuffer.slice(newline + 1);
        barrierBuffer = "";
        ready = true;
        resolveReady();
      }
    } else stdout += chunk;
    if (barrierBuffer.length + stdout.length > MAXIMUM_OUTPUT) {
      fail(new Error("The Windows Job fixture exceeded its bounded stdout."));
    }
  });
  child.stderr.on("data", (chunk: string) => {
    // Retain fixed stages in CI even when the native behavior test expires.
    process.stderr.write(chunk);
    stderr += chunk;
    if (stderr.length > MAXIMUM_OUTPUT) {
      fail(new Error("The Windows Job fixture exceeded its bounded stderr."));
    }
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", (code, signal) => {
    if (failure || code !== 0 || !ready || !started) {
      const error = failure ?? new Error(
        `The Windows Job fixture exited before its exact native result (${code ?? signal}): ${stderr.slice(-2048)}`
      );
      rejectReady(error);
      rejectCompletion(error);
    } else resolveCompletion(stdout);
  });

  return {
    ready: readiness,
    root,
    readStages() {
      return stderr.split(/\r?\n/)
        .filter(line => line.startsWith("RION_JOB_DIAGNOSTIC_STAGE="))
        .map(line => (JSON.parse(line.slice("RION_JOB_DIAGNOSTIC_STAGE=".length)) as { stage: string }).stage);
    },
    async run() {
      if (!ready || started || failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The Windows Job fixture is not at its exact unused setup barrier.");
      }
      started = true;
      child.stdin.end(`${RUN_NATIVE}\n`);
      return completion;
    },
    dispose() {
      disposal ??= dispose();
      return disposal;
    }
  };

  async function dispose() {
    // Terminate only the retained fixture process. Its setup/native Jobs close
    // with KILL_ON_JOB_CLOSE, so failure cannot orphan an owned descendant.
    if (!child.stdin.writableEnded) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await completion.catch(() => {});
    let current;
    try { current = await lstat(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const descendant = relative(temporaryParent, root);
    if (!descendant.startsWith("rion-job-root-") || descendant.includes("..") ||
        isAbsolute(descendant) || current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== identity.dev || current.ino !== identity.ino || await realpath(root) !== root) {
      throw new Error("The Windows Job fixture cleanup identity changed.");
    }
    await rm(root, { recursive: true });
  }
}
