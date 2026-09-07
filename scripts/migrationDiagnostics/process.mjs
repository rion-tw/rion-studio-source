import { spawn } from "node:child_process";

// DeadlineBound external process acknowledgement. An expired deadline is failure,
// never a receipt; close (including pipe EOF) is required even after cancellation.
export function runProcess(command, args, { input, env, signal, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, timeout, killSignal: "SIGKILL" });
    const stdout = [];
    let length = 0;
    let stderrBytes = 0;
    let failure;
    const abort = () => { failure = new Error("DIAGNOSTIC_CANCELLED"); child.kill("SIGKILL"); };
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => { failure = new Error("NATIVE_PROCESS_START_FAILED"); });
    child.stdin.on("error", () => { failure ??= new Error("NATIVE_PROCESS_INPUT_FAILED"); });
    child.stdout.on("data", bytes => {
      length += bytes.length;
      if (length > 66 * 1024 * 1024) { failure = new Error("NATIVE_OUTPUT_LIMIT"); child.kill("SIGKILL"); }
      else stdout.push(Buffer.from(bytes));
    });
    child.stderr.on("data", bytes => { stderrBytes += bytes.length; });
    child.once("close", (code, terminationSignal) => {
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || terminationSignal !== null) reject(new Error(`NATIVE_PROCESS_FAILED:${code}:${terminationSignal}:stderrBytes=${stderrBytes}`));
      else resolve({ stdout: Buffer.concat(stdout), pid: child.pid, stderrBytes });
    });
    child.stdin.end(input);
  });
}

export function exactResponse(wire, platform) {
  if (!["darwin", "win32"].includes(platform)) throw new Error("NATIVE_PLATFORM_REQUIRED");
  const prefix = Buffer.from(platform === "win32" ? "\r\n" : "");
  if (!wire.subarray(0, prefix.length).equals(prefix)) throw new Error("NATIVE_PREFIX_INVALID");
  const response = wire.subarray(prefix.length);
  if (response.length < 20 || response.subarray(0, 8).toString("ascii") !== "RCHRES01" ||
      response.subarray(9, 12).some(byte => byte !== 0)) throw new Error("NATIVE_FRAME_INVALID");
  const metaLength = response.readUInt32BE(12);
  const secretLength = response.readUInt32BE(16);
  if (!metaLength || metaLength > 1024 * 1024 || secretLength !== 0 || response.length !== 20 + metaLength) {
    throw new Error("NATIVE_FRAME_LENGTH_INVALID");
  }
  if (![0, 1, 2].includes(response[8])) throw new Error("NATIVE_OUTCOME_INVALID");
  return { outcome: response[8], metadata: JSON.parse(response.subarray(20).toString("utf8")) };
}
