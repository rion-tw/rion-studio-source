import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["darwin", "win32"]);
const timeoutMs = 5 * 60 * 1000;

async function main() {
  if (!supported.has(process.platform)) {
    console.log("Skipping System WebView trusted-input attestation on this platform.");
    return;
  }

  const requestedExecutable = optionValue("--executable");
  const requireCompiledAttestation = process.argv.includes("--require-compiled-attestation");
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

  const directory = await mkdtemp(join(tmpdir(), "rion-system-input-"));
  const output = join(directory, "attestation.json");
  const userData = join(directory, "user-data");
  try {
    const result = await run(executable, [], {
      ...process.env,
      RION_STUDIO_INPUT_ATTESTATION_OUTPUT: output,
      RION_STUDIO_USER_DATA_DIR: userData
    }, timeoutMs);
    const report = JSON.parse(await readFile(output, "utf8"));
    validateReport(report, requireCompiledAttestation);
    if (result.code !== 0) {
      throw new Error(
        `System WebView trusted-input attestation exited with code ${result.code}.`
      );
    }
    console.log(
      `Attested ${report.engine} trusted background input with ` +
      `${report.report.cycles} press/release cycles, 1/3/6/9 pixel layouts, ` +
      `popup/upload/download/recovery parity, a stable two-tab display host, and ` +
      `${report.report.roleParity.createDestroyCycles} create/destroy cycles using ` +
      `${basename(executable)}.`
    );
  } finally {
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
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

function validateReport(value, requireCompiledAttestation) {
  const expectedPlatform = process.platform === "win32" ? "windows" : "macos";
  const expectedEngine = process.platform === "win32" ? "webview2" : "wkwebview";
  if (!value || typeof value !== "object") {
    throw new Error("System WebView trusted-input attestation returned no report.");
  }
  if (value.ok !== true) {
    const code = value.error?.code ?? "SYSTEM_INPUT_ATTESTATION_FAILED";
    const message = value.error?.message ?? "The native input fixture failed.";
    throw new Error(`${code}: ${message}`);
  }
  if (
    value.schemaVersion !== 1 ||
    value.platform !== expectedPlatform ||
    value.engine !== expectedEngine
  ) {
    throw new Error("System WebView trusted-input attestation identity is invalid.");
  }
  const behavior = value.report?.behavior;
  const registration = value.report?.registration;
  const roleParity = value.report?.roleParity;
  const popupDownload = roleParity?.popupDownload;
  const recovery = roleParity?.recovery;
  const sharedDisplayHost = roleParity?.sharedDisplayHost;
  const stress = value.report?.stress;
  if (
    value.report?.cycles !== 1000 ||
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
    stress?.allTrusted !== true ||
    stress?.backgroundOnly !== true ||
    stress?.documentFocused !== false ||
    stress?.heldCount !== 0 ||
    stress?.keyDown !== 1000 ||
    stress?.keyUp !== 1000 ||
    JSON.stringify(roleParity?.counts) !== JSON.stringify([1, 3, 6, 9]) ||
    roleParity?.createDestroyCycles !== 100 ||
    roleParity?.totalRoles !== 19 ||
    roleParity?.layouts?.length !== 4 ||
    roleParity.layouts.some((layout) =>
      layout?.loaded !== true || layout?.pixelParity !== true || layout?.released !== true
    ) ||
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
    requireCompiledAttestation &&
    (
      !registration?.adapterVersion?.includes("+trusted-input-attested") ||
      registration?.capabilitySnapshot?.trustedInput !== "supported" ||
      registration?.capabilitySnapshot?.backgroundInput !== "supported"
    )
  ) {
    throw new Error("The packaged System WebView binary lacks compiled input attestation.");
  }
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
