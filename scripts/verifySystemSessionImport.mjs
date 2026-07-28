import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";
import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["darwin", "win32"]);
const timeoutMs = 3 * 60 * 1000;

async function main() {
  if (!supported.has(process.platform)) {
    console.log("Skipping native session-import parity outside macOS and Windows.");
    return;
  }
  const cargo = await resolveCargoExecutable();
  await run(cargo, ["test", "-p", "rion-core", "session_import::tests"]);
  await run(cargo, ["test", "-p", "rion-core", "chrome_profile_import::tests"]);
  await run(cargo, ["test", "-p", "rion-platform", "chrome_profile::tests"]);
  await run(cargo, ["test", "-p", "rion-tauri", "session_transfer_"]);

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
    await run(cargo, ["build", "-p", "rion-tauri"]);
  }
  if (!isAbsolute(executable)) {
    throw new Error("The session-import attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);

  const directory = await mkdtemp(join(tmpdir(), "rion-session-import-"));
  const source = join(directory, "chrome-user-data");
  const userData = join(directory, "rion-user-data");
  const server = await startFixtureServer();
  try {
    for (const stage of ["import", "readback"]) {
      const output = join(directory, `${stage}.json`);
      const result = await run(executable, [], {
        ...process.env,
        RION_STUDIO_SESSION_IMPORT_ATTESTATION_FIXTURE_URL: server.url,
        RION_STUDIO_SESSION_IMPORT_ATTESTATION_OUTPUT: output,
        RION_STUDIO_SESSION_IMPORT_ATTESTATION_SOURCE: source,
        RION_STUDIO_SESSION_IMPORT_ATTESTATION_STAGE: stage,
        RION_STUDIO_USER_DATA_DIR: userData
      }, timeoutMs);
      const report = JSON.parse(await readFile(output, "utf8"));
      validateStage(report, stage);
      if (result.code !== 0) {
        throw new Error(`Session-import ${stage} stage exited with code ${result.code}.`);
      }
    }
  } finally {
    await server.close();
    await makeTreeWritable(directory);
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  }

  if (!process.argv.includes("--skip-system-input")) {
    const args = ["scripts/verifySystemTrustedInput.mjs"];
    if (requestedExecutable) args.push("--executable", requestedExecutable);
    await run(process.execPath, args);
  }
  console.log(
    "Verified the public Chrome preview/apply commands, bounded in-memory snapshots, encrypted staging cleanup, replacement, process restart, and Cookie/LocalStorage readback in a real System WebView."
  );
}

function validateStage(value, stage) {
  if (value?.schemaVersion !== 1 || value?.ok !== true || value?.stage !== stage) {
    const code = value?.error?.code ?? "SYSTEM_SESSION_IMPORT_ATTESTATION_FAILED";
    const message = value?.error?.message ?? `The ${stage} report is invalid.`;
    throw new Error(`${code}: ${message}`);
  }
  const report = value.report;
  if (stage === "import" && (
    report?.cookieCount !== 1 ||
    report?.createdRole !== true ||
    report?.encryptedStagingCleaned !== true ||
    report?.localStorageCount !== 1 ||
    report?.publicCommandApplied !== true ||
    report?.rawStagingAbsent !== true ||
    report?.roleIdPresent !== true ||
    report?.sourceFingerprintStable !== true
  )) {
    throw new Error("The formal session-import report is incomplete.");
  }
  if (stage === "readback" && (
    report?.cookieReadback !== true ||
    report?.localStorageReadback !== true ||
    report?.replacementApplied !== true ||
    report?.roleResolvedExactlyOnce !== true ||
    report?.systemWebViewReadback !== true
  )) {
    throw new Error("The restarted System WebView session readback is incomplete.");
  }
}

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    const body = "<!doctype html><meta charset=utf-8><title>Rion session import</title>ready";
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
    throw new Error("The session-import fixture server has no TCP address.");
  }
  return {
    url: `http://localhost:${address.port}/play`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    })
  };
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
    if (entry.isDirectory()) await makeTreeWritable(child);
    else await chmod(child, 0o600).catch(() => {});
  }));
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env = process.env, timeout = 0) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawnPlatformCommand(executable, args, {
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
      if (timedOut) reject(new Error(`Session-import attestation timed out after ${timeout}ms.`));
      else if (signal) reject(new Error(`${executable} was terminated by ${signal}.`));
      else if (timeout > 0) resolvePromise({ code: code ?? 1 });
      else if (code === 0) resolvePromise({ code });
      else reject(new Error(`${executable} exited with code ${code ?? "unknown"}.`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
