import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["darwin", "win32"]);
const timeoutMs = 3 * 60 * 1000;

async function main() {
  if (!supported.has(process.platform)) {
    console.log("Skipping System WebView file-operations attestation on this platform.");
    return;
  }
  const requestedExecutable = optionValue("--executable");
  const executable = requestedExecutable
    ? resolve(repositoryRoot, requestedExecutable)
    : join(
        repositoryRoot,
        "target",
        "debug",
        process.platform === "win32" ? "rion-tauri.exe" : "rion-tauri"
      );
  if (!requestedExecutable) {
    await run(command("pnpm"), ["run", "build:renderer"]);
    await run(command("cargo"), ["build", "-p", "rion-tauri"]);
  }
  if (!isAbsolute(executable)) {
    throw new Error("The file-operations attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);

  const directory = await mkdtemp(join(tmpdir(), "rion-system-files-"));
  const output = join(directory, "attestation.json");
  const userData = join(directory, "user-data");
  try {
    const result = await run(executable, [], {
      ...process.env,
      RION_STUDIO_FILE_OPERATIONS_ATTESTATION_OUTPUT: output,
      RION_STUDIO_USER_DATA_DIR: userData
    }, timeoutMs);
    const report = JSON.parse(await readFile(output, "utf8"));
    validateReport(report);
    if (result.code !== 0) {
      throw new Error(`File-operations attestation exited with code ${result.code}.`);
    }
    console.log(
      "Attested packaged portable export/preview and diagnostics export, including " +
      "corrupt-import rejection, atomic failure cleanup, and domain-state preservation."
    );
  } finally {
    await makeTreeWritable(directory);
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  }
}

function validateReport(value) {
  if (value?.schemaVersion !== 1 || value?.ok !== true) {
    const code = value?.error?.code ?? "SYSTEM_FILE_OPERATIONS_ATTESTATION_FAILED";
    const message = value?.error?.message ?? "The file-operations report is invalid.";
    throw new Error(`${code}: ${message}`);
  }
  const report = value.report;
  if (
    report?.corruptImportRejected !== true ||
    report?.diagnosticsAtomicFailurePreserved !== true ||
    report?.diagnosticsExportVerified !== true ||
    report?.domainStatePreserved !== true ||
    report?.portableAtomicFailurePreserved !== true ||
    report?.portableExportVerified !== true ||
    report?.portablePreviewVerified !== true ||
    report?.temporaryFilesReleased !== true
  ) {
    throw new Error("The packaged file-operations attestation report is incomplete.");
  }
}

async function makeTreeWritable(path) {
  await chmod(path, 0o700).catch(() => {});
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (entry.isSymbolicLink()) return;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeTreeWritable(child);
    } else {
      await chmod(child, 0o600).catch(() => {});
    }
  }));
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env = process.env, timeout = 0) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    let timedOut = false;
    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeout)
      : undefined;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`File-operations attestation timed out after ${timeout}ms.`));
      } else if (signal) {
        reject(new Error(`${executable} was terminated by ${signal}.`));
      } else if (timeout > 0) {
        resolvePromise({ code: code ?? 1 });
      } else if (code === 0) {
        resolvePromise({ code });
      } else {
        reject(new Error(`${executable} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
