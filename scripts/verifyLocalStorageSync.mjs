import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["darwin", "win32"]);
const timeoutMs = 3 * 60 * 1000;

async function main() {
  if (!supported.has(process.platform)) {
    console.log("Skipping native localStorage synchronization parity on this platform.");
    return;
  }
  const cargo = await resolveCargoExecutable();
  await run(cargo, ["test", "-p", "rion-core", "local_storage_sync"]);
  await run(cargo, ["test", "-p", "rion-platform", "local_storage_sync"]);
  await run(cargo, ["test", "-p", "rion-tauri", "local_storage_sync"]);

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
    throw new Error("The localStorage sync attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);

  const directory = await mkdtemp(join(tmpdir(), "rion-local-storage-sync-"));
  const output = join(directory, "report.json");
  const server = await startFixtureServer();
  try {
    const result = await run(executable, [], {
      ...process.env,
      RION_STUDIO_LOCAL_STORAGE_SYNC_ATTESTATION_FIXTURE_URL: server.url,
      RION_STUDIO_LOCAL_STORAGE_SYNC_ATTESTATION_OUTPUT: output,
      RION_STUDIO_USER_DATA_DIR: join(directory, "user-data")
    }, timeoutMs);
    const document = JSON.parse(await readFile(output, "utf8"));
    validateReport(document);
    if (result.code !== 0) {
      throw new Error(`localStorage sync attestation exited with code ${result.code}.`);
    }
  } finally {
    await server.close();
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  }
  console.log(
    "Verified document-start alignment, active fan-out, deletion mirroring, stopped-source bootstrap, cross-origin rejection, and isolated stores in a real System WebView."
  );
}

function validateReport(value) {
  if (value?.schemaVersion !== 1 || value?.ok !== true) {
    const code = value?.error?.code ?? "SYSTEM_LOCAL_STORAGE_SYNC_ATTESTATION_FAILED";
    const message = value?.error?.message ?? "The localStorage sync report is invalid.";
    throw new Error(`${code}: ${message}`);
  }
  const report = value.report;
  for (const field of [
    "crossOriginRejected",
    "deletionMirrored",
    "documentStartAligned",
    "isolatedStorePreserved",
    "liveUpdateMirrored",
    "stoppedSourceBootstrap"
  ]) {
    if (report?.[field] !== true) {
      throw new Error(`The localStorage sync report is missing ${field}.`);
    }
  }
}

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    const body = `<!doctype html><meta charset=utf-8><title>Rion localStorage sync</title><script>globalThis.__rionLocalStorageInitial = localStorage.getItem("game_client_settings");</script>ready`;
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
    throw new Error("The localStorage sync fixture server has no TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/play`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    })
  };
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
      if (timedOut) reject(new Error(`localStorage sync attestation timed out after ${timeout}ms.`));
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
