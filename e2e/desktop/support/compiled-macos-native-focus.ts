import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const nativeFocusScript = fileURLToPath(new URL("./macos-native-focus.swift", import.meta.url));
const executables = new Map<string, Promise<string>>();
type NativeFocusArguments = readonly [
  string, string, string, "focus" | "observe" | "shortcut" | "roleKey", string
];

export function boundedNativeProcessFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown failure";
  const failure = error as Readonly<{
    code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown;
  }>;
  const fields = [
    `code=${String(failure.code ?? "unknown")}`,
    `killed=${String(failure.killed ?? false)}`,
    `signal=${String(failure.signal ?? "none")}`
  ];
  const output = [failure.stderr, failure.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n").trim();
  if (output.length > 0) fields.push(`output=${JSON.stringify(output.slice(-2_000))}`);
  return fields.join(", ");
}

async function execute(stage: string, file: string, args: readonly string[], timeout: number): Promise<void> {
  const started = Date.now();
  try {
    await executeFile(file, args, { encoding: "utf8", timeout });
  } catch (cause) {
    throw new Error(`${stage} failed after ${Date.now() - started}ms ` +
      `(${boundedNativeProcessFailure(cause)})`, { cause });
  }
}

/** Compile before a journey captures its native input eligibility; this submits no input. */
export async function prepareMacosNativeFocus(): Promise<string> {
  const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) {
    throw new Error("The compiled macOS focus helper requires its absolute phase artifact directory");
  }
  const path = resolve(artifactDirectory, "macos-native-focus");
  let executable = executables.get(path);
  if (!executable) {
    executable = (async () => {
      // Match the existing Workspace helper's separate cold SDK compilation bound.
      // A failed promise remains authoritative for this isolated phase; no retry.
      await execute("Compile macos-native-focus", "/usr/bin/xcrun",
        ["swiftc", nativeFocusScript, "-o", path], 120_000);
      return path;
    })();
    executables.set(path, executable);
  }
  return executable;
}

/** Separate cold compilation from each exact, single-invocation native action. */
export async function runMacosNativeFocus(
  args: NativeFocusArguments,
  timeout: 15_000 | 30_000
): Promise<void> {
  await execute(`Run macos-native-focus ${args[3]}`, await prepareMacosNativeFocus(), args, timeout);
}

/** Retain this exact sender until the target assertions acknowledge it. */
export async function withMacosNativeFocusReceipt<Value>(
  args: NativeFocusArguments,
  receive: () => Promise<Value>
): Promise<Value> {
  const executable = await prepareMacosNativeFocus();
  const nonce = randomUUID();
  return new Promise<Value>((resolveReceipt, rejectReceipt) => {
    let output = "";
    let submitted = false;
    let completed = false;
    let received = false;
    let acknowledgementSent = false;
    let processClosed = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let callbackOutcome: Readonly<{ error: Error | null; stdout: string; stderr: string }> | null = null;
    let retirementRequested = false;
    let settled = false;
    let failed = false;
    let failure: unknown;
    let value: Value;

    const protocolError = (message: string): Error =>
      new Error(`macos-native-focus receipt failed: ${message}`);
    const finish = (): void => {
      if (!processClosed || !callbackOutcome || settled) return;
      if (failed) {
        settled = true;
        rejectReceipt(failure);
      } else if (closeCode !== 0 || closeSignal !== null) {
        settled = true;
        rejectReceipt(protocolError(`the exact child closed with code ${String(closeCode)} and signal ${String(closeSignal)} ` +
          `(${boundedNativeProcessFailure({ code: closeCode, signal: closeSignal,
            stdout: callbackOutcome.stdout, stderr: callbackOutcome.stderr })})`));
      } else if (!submitted || !received || !completed || !acknowledgementSent) {
        settled = true;
        rejectReceipt(protocolError("the exact child exited before its complete target acknowledgement"));
      } else {
        settled = true;
        resolveReceipt(value);
      }
    };
    const child = execFile(executable, [...args, "receipt", nonce], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 4_096
    }, (error, stdout, stderr) => {
      callbackOutcome = { error, stdout, stderr };
      if (error) abort(new Error(`Run macos-native-focus receipt failed (${boundedNativeProcessFailure({ ...error, stdout, stderr })})`,
        { cause: error }));
      finish();
    });
    const abort = (error: unknown): void => {
      if (settled) return;
      if (!failed) {
        failed = true;
        failure = error;
      }
      // A failed target receipt never authorizes success. Retire only this child,
      // then require both its actual close event and the execFile outcome.
      if (!processClosed && !retirementRequested) {
        retirementRequested = true;
        try { child.stdin?.end(`cancel:${nonce}\n`); } catch { /* Exact child retirement below remains mandatory. */ }
        try { child.kill("SIGKILL"); } catch { /* The exact close event remains mandatory; a thrown kill is not retirement. */ }
      }
      finish();
    };
    const receiveTarget = (): void => {
      void Promise.resolve().then(() => {
        if (failed || settled || processClosed) throw protocolError("the sender retired before target observation");
        return receive();
      }).then((result) => {
        if (failed || settled || processClosed) return;
        received = true;
        value = result;
        acknowledgementSent = true;
        try {
          // The child's exact completed nonce plus pipe-close exit 0 is the
          // authoritative ACK readback, independent of local write-callback order.
          child.stdin!.end(`received:${nonce}\n`, "utf8");
        } catch (error) { abort(error); }
      }, abort).catch(abort);
    };
    child.on("error", abort);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (processClosed) return;
      processClosed = true;
      closeCode = code;
      closeSignal = signal;
      finish();
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      abort(protocolError("the exact child did not expose its receipt pipes"));
      return;
    }
    child.stdin.on("error", abort);
    child.stdout.on("error", abort);
    child.stderr.on("error", abort);
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (failed || settled) return;
      output += chunk.toString();
      if (output.length > 256) {
        abort(protocolError("the child emitted an oversized receipt"));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (output.length > 0) {
        abort(protocolError("the child emitted an unsolicited receipt"));
        return;
      }
      if (!submitted && line === `submitted:${nonce}`) {
        submitted = true;
        receiveTarget();
      } else if (submitted && received && acknowledgementSent && !completed && line === `completed:${nonce}`) {
        completed = true;
      } else {
        abort(protocolError("the child emitted an out-of-order or mismatched nonce receipt"));
      }
    });
    child.stdout.on("end", () => {
      if (output.length > 0) abort(protocolError("the child closed a partial receipt"));
    });
  });
}
