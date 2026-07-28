import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";
import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["darwin", "win32"]);
const diagnosticsRoot = join(repositoryRoot, "target", "system-webview-attestations");
const scenarioRuns = [
  { name: "layout", scenario: "layout", timeoutMs: 3 * 60 * 1000 },
  { name: "popup-download", scenario: "popup-download", timeoutMs: 2 * 60 * 1000 },
  { name: "recovery", scenario: "recovery", timeoutMs: 2 * 60 * 1000 },
  { name: "shared-host", scenario: "shared-host", timeoutMs: 2 * 60 * 1000 },
  { name: "input", scenario: "input", timeoutMs: 60 * 1000 },
  ...Array.from({ length: 5 }, (_, index) => ({
    cycles: 20,
    name: `soak-${index + 1}`,
    offset: index * 20,
    scenario: "soak",
    timeoutMs: 2 * 60 * 1000
  }))
];

async function main() {
  if (!supported.has(process.platform)) {
    console.log("Skipping System WebView trusted-input attestation on this platform.");
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
    await run(await resolveCargoExecutable(), ["build", "-p", "rion-tauri"]);
  }
  if (!isAbsolute(executable)) {
    throw new Error("The trusted-input attestation executable must be absolute.");
  }
  await access(executable, constants.X_OK);
  const diagnosticsDirectory = join(
    diagnosticsRoot,
    executable.split(/[\\/]/u).includes("release") ? "packaged" : "debug"
  );
  await rm(diagnosticsDirectory, { force: true, recursive: true });
  await mkdir(diagnosticsDirectory, { recursive: true });

  const scenarioReports = [];
  for (const [index, scenario] of scenarioRuns.entries()) {
    scenarioReports.push(await runScenario(executable, scenario, index, diagnosticsDirectory));
  }
  const report = mergeScenarioReports(scenarioReports);
  validateReport(report);
  await writeFile(
    join(diagnosticsDirectory, "combined-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  console.log(
    `Attested ${report.engine} trusted background input with ` +
    `a bounded native key/mouse sequence, ${report.report.simulatedStress.cycles} ` +
    `simulated production input-state cycles, 1/3/6/9 pixel layouts, ` +
    `popup/upload/download/recovery parity, a stable two-tab display host, and ` +
    `${report.report.roleParity.createDestroyCycles} isolated create/destroy cycles using ` +
    `${basename(executable)}.`
  );
}

async function runScenario(executable, scenario, index, diagnosticsDirectory) {
  const directory = await mkdtemp(join(tmpdir(), `rion-system-input-${scenario.name}-`));
  const prefix = `${String(index + 1).padStart(2, "0")}-${scenario.name}`;
  const output = join(diagnosticsDirectory, `${prefix}.json`);
  const stderrPath = join(diagnosticsDirectory, `${prefix}.stderr.log`);
  const statePath = join(diagnosticsDirectory, `${prefix}.state.json`);
  const userData = join(directory, "user-data");
  const startedAt = new Date().toISOString();
  await writeScenarioState(statePath, { scenario: scenario.name, startedAt, state: "running" });
  let report;
  let scenarioError;
  let failureStage;
  try {
    console.log(`System WebView parity: starting isolated ${scenario.name} scenario.`);
    const result = await run(executable, [], {
      ...process.env,
      RION_STUDIO_INPUT_ATTESTATION_OUTPUT: output,
      RION_STUDIO_INPUT_ATTESTATION_SCENARIO: scenario.scenario,
      RION_STUDIO_INPUT_ATTESTATION_SOAK_CYCLES: String(scenario.cycles ?? 0),
      RION_STUDIO_INPUT_ATTESTATION_SOAK_OFFSET: String(scenario.offset ?? 0),
      RION_STUDIO_USER_DATA_DIR: userData,
      RUST_BACKTRACE: "1"
    }, scenario.timeoutMs, stderrPath);
    report = JSON.parse(await readFile(output, "utf8"));
    validateScenarioReport(report, scenario.scenario);
    if (result.code !== 0) {
      throw new Error(
        `System WebView ${scenario.name} attestation exited with code ${result.code}.`
      );
    }
  } catch (error) {
    scenarioError = error;
    failureStage = await readFailureStage(stderrPath);
  }
  let cleanupError;
  try {
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  } catch (error) {
    cleanupError = error;
  }
  await writeScenarioState(statePath, {
    cleanup: {
      completed: !cleanupError,
      error: cleanupError instanceof Error ? cleanupError.message : undefined
    },
    completedAt: new Date().toISOString(),
    elapsedMs: report?.timings?.elapsedMs,
    error: scenarioError instanceof Error
      ? scenarioError.message
      : cleanupError instanceof Error
        ? cleanupError.message
        : undefined,
    scenario: scenario.name,
    stage: report?.stage ?? failureStage ?? scenario.scenario,
    startedAt,
    state: scenarioError || cleanupError ? "failed" : "completed"
  });
  if (scenarioError) throw scenarioError;
  if (cleanupError) throw cleanupError;
  return report;
}

async function writeScenarioState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readFailureStage(stderrPath) {
  try {
    const stderr = await readFile(stderrPath, "utf8");
    const matches = [...stderr.matchAll(/System WebView lifecycle: stage=(\S+) /gu)];
    return matches.at(-1)?.[1];
  } catch {
    return undefined;
  }
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

function validateScenarioReport(value, scenario) {
  const expectedPlatform = process.platform === "win32" ? "windows" : "macos";
  const expectedEngine = process.platform === "win32" ? "webview2" : "wkwebview";
  if (!value || typeof value !== "object") {
    throw new Error(`System WebView ${scenario} attestation returned no report.`);
  }
  if (value.ok !== true) {
    const code = value.error?.code ?? "SYSTEM_INPUT_ATTESTATION_FAILED";
    const message = value.error?.message ?? `The ${scenario} native fixture failed.`;
    throw new Error(`${code}: ${message}`);
  }
  if (
    value.schemaVersion !== 3 ||
    value.platform !== expectedPlatform ||
    value.engine !== expectedEngine ||
    value.scenario !== scenario ||
    value.stage !== "completed" ||
    value.cleanup?.completed !== true ||
    !Array.isArray(value.cleanup?.errors) ||
    typeof value.timings?.elapsedMs !== "number" ||
    !value.timings?.stagesMs ||
    typeof value.timings.stagesMs !== "object" ||
    value.runtime?.healthy !== true ||
    typeof value.runtime?.hostProcessId !== "number" ||
    typeof value.runtime?.lastStage !== "string" ||
    value.runtime.lastStage.length === 0 ||
    !Array.isArray(value.runtime?.browserProcessIds) ||
    (expectedPlatform === "windows" && (
      value.runtime.browserProcessIds.length === 0 ||
      value.runtime.browserProcessIds.some((pid) => !Number.isInteger(pid) || pid <= 0)
    )) ||
    !Object.hasOwn(value.runtime ?? {}, "failureKind") ||
    typeof value.runtime?.webViewVersion !== "string" ||
    value.runtime.webViewVersion.length === 0
  ) {
    throw new Error(`System WebView ${scenario} attestation identity is invalid.`);
  }
}

function mergeScenarioReports(values) {
  const first = values[0];
  const report = {};
  for (const value of values) mergeReportValue(report, value.report, []);
  return {
    engine: first.engine,
    ok: true,
    platform: first.platform,
    report,
    scenario: "combined",
    scenarios: values.map((value) => ({
      cleanup: value.cleanup,
      runtime: value.runtime,
      scenario: value.scenario,
      stage: value.stage,
      timings: value.timings
    })),
    schemaVersion: 3
  };
}

function mergeReportValue(target, source, path) {
  for (const [key, value] of Object.entries(source ?? {})) {
    const nextPath = [...path, key];
    if (nextPath.join(".") === "roleParity.createDestroyCycles") {
      target[key] = (target[key] ?? 0) + value;
    } else if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      mergeReportValue(target[key], value, nextPath);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReport(value) {
  const expectedPlatform = process.platform === "win32" ? "windows" : "macos";
  const expectedEngine = process.platform === "win32" ? "webview2" : "wkwebview";
  if (!value || typeof value !== "object") {
    throw new Error("System WebView trusted-input attestation returned no report.");
  }
  if (
    value.schemaVersion !== 3 ||
    value.platform !== expectedPlatform ||
    value.engine !== expectedEngine
  ) {
    throw new Error("System WebView trusted-input attestation identity is invalid.");
  }
  const behavior = value.report?.behavior;
  const registration = value.report?.registration;
  const roleParity = value.report?.roleParity;
  const popupDownload = roleParity?.popupDownload;
  const compatibility = roleParity?.compatibility;
  const recovery = roleParity?.recovery;
  const sharedDisplayHost = roleParity?.sharedDisplayHost;
  const simulatedStress = value.report?.simulatedStress;
  if (
    value.report?.nativeKeyDown !== 4 ||
    value.report?.nativeKeyUp !== 3 ||
    registration?.available !== true ||
    registration?.capabilitySnapshot?.navigation !== "supported" ||
    registration?.capabilitySnapshot?.persistentSession !== "supported" ||
    registration?.capabilitySnapshot?.audioMute !== "supported" ||
    behavior?.allTrusted !== true ||
    behavior?.backgroundOnly !== true ||
    behavior?.documentFocused !== false ||
    behavior?.heldCount !== 0 ||
    behavior?.modifierObserved !== true ||
    behavior?.repeatCount !== 1 ||
    behavior?.mouseDown !== 1 ||
    behavior?.mouseUp !== 1 ||
    simulatedStress?.cycles !== 1000 ||
    simulatedStress?.heldCount !== 0 ||
    simulatedStress?.keyDown !== 1000 ||
    simulatedStress?.keyUp !== 1000 ||
    simulatedStress?.transport !== "simulated-core-input-state" ||
    JSON.stringify(roleParity?.counts) !== JSON.stringify([1, 3, 6, 9]) ||
    roleParity?.createDestroyCycles !== 100 ||
    roleParity?.totalRoles !== 19 ||
    roleParity?.layouts?.length !== 4 ||
    roleParity.layouts.some((layout) =>
      layout?.loaded !== true || layout?.pixelParity !== true || layout?.released !== true
    ) ||
    compatibility?.cleanupReleased !== true ||
    compatibility?.isolatedStorage !== true ||
    compatibility?.loaded !== true ||
    compatibility?.probeExecuted !== true ||
    compatibility?.recreated !== true ||
    popupDownload?.trustedPopupGesture !== true ||
    popupDownload?.popupSharedStore !== true ||
    popupDownload?.popupClosed !== true ||
    popupDownload?.downloadCompleted !== true ||
    popupDownload?.downloadContentVerified !== true ||
    popupDownload?.uploadCompleted !== true ||
    popupDownload?.uploadContentVerified !== true ||
    (expectedPlatform === "macos" && (
      popupDownload?.nativeChooserCallbackObserved !== true ||
      popupDownload?.uploadSelectionMechanism !== "wk-open-panel-callback"
    )) ||
    (expectedPlatform === "windows" &&
      popupDownload?.uploadSelectionMechanism !== "webview2-dom-set-file-input-files") ||
    recovery?.nativeHandleReplaced !== true ||
    recovery?.oldHandleReleased !== true ||
    recovery?.processTerminationObserved !== true ||
    recovery?.roleStorePreserved !== true ||
    recovery?.inputRestored !== true ||
    sharedDisplayHost?.contentStateStable !== true ||
    sharedDisplayHost?.hostCount !== 1 ||
    sharedDisplayHost?.tabCount !== 2 ||
    sharedDisplayHost?.nativeHandleStable !== true ||
    sharedDisplayHost?.surfaceLabelsStable !== true ||
    sharedDisplayHost?.windowLabelStable !== true
  ) {
    throw new Error("System WebView trusted-input attestation report is incomplete.");
  }
  if (
    registration?.capabilitySnapshot?.trustedInput !== "supported" ||
    registration?.capabilitySnapshot?.backgroundInput !== "supported"
  ) {
    throw new Error("The System WebView runtime does not report macro input support.");
  }
}

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function run(executable, args, env = process.env, timeout = 0, stderrPath) {
  return await new Promise((resolvePromise, reject) => {
    const stderrChunks = [];
    const child = spawnPlatformCommand(executable, args, {
      cwd: repositoryRoot,
      env,
      stdio: stderrPath ? ["inherit", "inherit", "pipe"] : "inherit",
      windowsHide: true
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrChunks.push(Buffer.from(chunk));
    });
    let timedOut = false;
    let terminationPromise = Promise.resolve();
    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          terminationPromise = terminateProcessTree(child);
        }, timeout)
      : undefined;
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      if (timer) clearTimeout(timer);
      if (stderrPath) {
        await writeFile(stderrPath, Buffer.concat(stderrChunks));
      }
      if (timedOut) {
        // Finish tearing down the timed-out process tree before reporting failure so
        // the next isolated scenario never overlaps its native browser processes.
        await terminationPromise;
        reject(new Error(`System WebView trusted-input attestation timed out after ${timeout}ms.`));
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

function terminateProcessTree(child) {
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      if (child.exitCode === null) child.kill();
      resolvePromise();
    };
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    const fallbackTimer = setTimeout(finish, 10_000);
    killer.once("error", finish);
    killer.once("exit", finish);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
