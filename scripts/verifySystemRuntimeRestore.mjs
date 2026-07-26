import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
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
    console.log("Skipping System WebView runtime-restore attestation on this platform.");
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
    throw new Error("The runtime-restore attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);

  const directory = await mkdtemp(join(tmpdir(), "rion-system-restore-"));
  const userData = join(directory, "user-data");
  const server = await startFixtureServer();
  try {
    const reports = {};
    for (const stage of ["seed", "restore", "clean-check"]) {
      console.log(`Runtime restore attestation: starting ${stage} stage.`);
      const output = join(directory, `${stage}.json`);
      const result = await run(executable, [], {
        ...process.env,
        RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_FIXTURE_URL: server.url,
        RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT: output,
        RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_STAGE: stage,
        RION_STUDIO_USER_DATA_DIR: userData
      }, timeoutMs);
      reports[stage] = JSON.parse(await readFile(output, "utf8"));
      validateStage(reports[stage], stage);
      if (result.code !== 0) {
        throw new Error(`Runtime-restore ${stage} stage exited with code ${result.code}.`);
      }
      console.log(`Runtime restore attestation: completed ${stage} stage.`);
    }
    console.log(
      "Attested live display-removal migration, unclean recovery, removed-display fallback, " +
      "persistent role storage, normal-exit persistence, and clean auto-restore eligibility " +
      "across three Tauri processes."
    );
  } finally {
    await server.close();
    await makeTreeWritable(directory);
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  }
}

async function makeTreeWritable(path) {
  try {
    await chmod(path, 0o700);
  } catch {
    return;
  }
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    await chmod(path, 0o600).catch(() => {});
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

function validateStage(value, stage) {
  if (value?.schemaVersion !== 1 || value?.ok !== true || value?.stage !== stage) {
    const code = value?.error?.code ?? "SYSTEM_RUNTIME_RESTORE_ATTESTATION_FAILED";
    const message = value?.error?.message ?? `The ${stage} report is invalid.`;
    throw new Error(`${code}: ${message}`);
  }
  const report = value.report;
  if (stage === "seed" && (
    report?.cleanExit !== false ||
    report?.hotplugDisplayRemovalApplied !== true ||
    report?.liveTabCount !== 1 ||
    report?.roleStoreSeeded !== true ||
    report?.savedTargetDisplayUnavailable !== true ||
    report?.savedTargetDisplayId === report?.availableDisplayId ||
    report?.savedWindowCount < 1
  )) {
    throw new Error("The unclean runtime-restore seed report is incomplete.");
  }
  if (stage === "restore" && (
    report?.recoveryDetected !== true ||
    report?.recoveryCleared !== true ||
    report?.dormantWindowCountAfter !== 0 ||
    report?.displayFallbackApplied !== true ||
    report?.persistedWindowCountAfter !== 1 ||
    report?.restoredTabCount !== 1 ||
    report?.roleStorePreserved !== true
  )) {
    throw new Error("The unclean runtime-restore recovery report is incomplete.");
  }
  if (stage === "clean-check" && (
    report?.autoRestoreEligible !== true ||
    report?.dormantWindowCount < 1 ||
    report?.recoveryRequired !== false
  )) {
    throw new Error("The clean runtime-restore report is incomplete.");
  }
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    console.log(`Runtime restore attestation: fixture request ${request.method} ${request.url}.`);
    const body = "<!doctype html><meta charset=utf-8><title>Rion restore parity</title>restore ready";
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      "content-type": "text/html; charset=utf-8"
    });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The runtime-restore fixture server has no TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/restore`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    })
  };
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
        reject(new Error(`Runtime-restore attestation timed out after ${timeout}ms.`));
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
