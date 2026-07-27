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
    console.log("Skipping native macro/game parity outside macOS and Windows.");
    return;
  }

  const cargo = await resolveCargoExecutable();
  await run(cargo, [
    "test", "-p", "rion-core",
    "embedded_macro_from_one_role_runs_three_iterations_for_all_assigned_roles",
    "--", "--nocapture"
  ]);
  await run(cargo, ["test", "-p", "rion-core", "macro_runtime::tests"]);
  await run(cargo, ["test", "-p", "rion-core", "compatibility_runtime::tests"]);
  await run(command("pnpm"), [
    "exec", "vitest", "run",
    "tests/macro-overlay-injector.test.ts",
    "tests/macro-overlay-interactions.test.ts",
    "tests/macro-overlay-runtime.test.ts",
    "tests/renderer-games-ui.test.tsx"
  ]);

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
    throw new Error("The macro-game attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);

  const directory = await mkdtemp(join(tmpdir(), "rion-macro-game-"));
  const output = join(directory, "report.json");
  const userData = join(directory, "rion-user-data");
  const server = await startFixtureServer();
  try {
    const result = await run(executable, [], {
      ...process.env,
      RION_STUDIO_MACRO_GAME_ATTESTATION_FIXTURE_URL: server.url,
      RION_STUDIO_MACRO_GAME_ATTESTATION_OUTPUT: output,
      RION_STUDIO_USER_DATA_DIR: userData
    }, timeoutMs);
    const report = JSON.parse(await readFile(output, "utf8"));
    validateReport(report);
    if (result.code !== 0) {
      throw new Error(`Macro-game attestation exited with code ${result.code}.`);
    }
  } finally {
    await server.close();
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  }

  if (!process.argv.includes("--skip-system-input")) {
    const args = ["scripts/verifySystemTrustedInput.mjs"];
    if (requestedExecutable) args.push("--executable", requestedExecutable);
    await run(process.execPath, args);
  }
  console.log(
    "Verified public MacroStart scheduling, ordered multi-role dispatch, loop cancellation, held-key cleanup, trusted input, compatibility state, and overlay behavior in real System WebViews."
  );
}

function validateReport(value) {
  if (value?.schemaVersion !== 1 || value?.ok !== true) {
    const code = value?.error?.code ?? "SYSTEM_MACRO_GAME_ATTESTATION_FAILED";
    const message = value?.error?.message ?? "The macro-game report is invalid.";
    throw new Error(`${code}: ${message}`);
  }
  const report = value.report;
  if (
    report?.cancelStoppedDispatch !== true ||
    report?.clickDelivered !== true ||
    report?.heldKeysReleased !== true ||
    report?.multiRoleSequenceMatched !== true ||
    report?.productionMacroStart !== true ||
    report?.roleCount !== 2 ||
    report?.trustedEventsOnly !== true
  ) {
    throw new Error("The formal macro-game report is incomplete.");
  }
}

async function startFixtureServer() {
  const body = `<!doctype html>
<meta charset="utf-8">
<title>Rion macro game</title>
<style>html,body{width:100%;height:100%;margin:0}body{background:#111}</style>
<script>
(() => {
  const events = [];
  const records = [];
  const held = new Set();
  let clicks = 0;
  let keyHDown = 0;
  let untrusted = 0;
  globalThis.__rionMacroGame = {
    snapshot() {
      return { ready: true, events: [...events], records: [...records], heldCount: held.size, clicks, keyHDown, untrusted };
    }
  };
  addEventListener("keydown", (event) => {
    if (!event.isTrusted) untrusted += 1;
    records.push({ type: "down", code: event.code, key: event.key, repeat: event.repeat, timeStamp: event.timeStamp });
    if (event.repeat) return;
    held.add(event.code);
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") events.push("down:" + event.code);
    if (event.code === "KeyH") keyHDown += 1;
  }, true);
  addEventListener("keyup", (event) => {
    if (!event.isTrusted) untrusted += 1;
    records.push({ type: "up", code: event.code, key: event.key, repeat: event.repeat, timeStamp: event.timeStamp });
    held.delete(event.code);
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") events.push("up:" + event.code);
  }, true);
  addEventListener("click", (event) => {
    if (!event.isTrusted) untrusted += 1;
    clicks += 1;
  }, true);
})();
</script>`;
  const server = createServer((_request, response) => {
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
    throw new Error("The macro-game fixture server has no TCP address.");
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
      if (timedOut) reject(new Error(`Macro-game attestation timed out after ${timeout}ms.`));
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
