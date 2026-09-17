import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { classifyElectronDevOutput } from "./diagnoseElectronDevOutput.mjs";

if (!["darwin", "win32"].includes(process.platform)) throw new Error("Extensions verification requires macOS or Windows");
const require = createRequire(import.meta.url);
const executable = process.env.RION_EXTENSION_PROBE_EXECUTABLE ?? require("electron");
const root = await mkdtemp(join(tmpdir(), "rion-extensions-native-"));
try {
  for (const phase of ["seed", "restart"]) {
    const child = spawn(executable, [fileURLToPath(new URL("./electronExtensionsProbe.cjs", import.meta.url))], {
      env: { ...process.env, RION_EXTENSIONS_PROBE_DIR: root, RION_EXTENSIONS_PROBE_PHASE: phase }, stdio: "inherit"
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Extension ${phase} probe failed: ${code ?? signal}`)));
    });
  }
  const compatibilityMain = join(root, "electron-extension-compatibility-probe.cjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./electronExtensionCompatibilityProbe.ts", import.meta.url))],
    external: ["electron"],
    format: "cjs",
    logLevel: "silent",
    outfile: compatibilityMain,
    platform: "node",
    target: "node24"
  });
  for (const workerType of ["classic", "module"]) {
    const compatibility = spawn(executable, [compatibilityMain], {
      env: {
        ...process.env,
        RION_EXTENSION_COMPAT_WORKER_TYPE: workerType,
        RION_EXTENSION_COMPAT_PRELOAD: fileURLToPath(new URL("../out/preload/extensionCompat.cjs", import.meta.url)),
        RION_EXTENSION_COMPAT_PROBE_DIR: root,
        RION_EXTENSION_COMPAT_SIGNING_KEY: fileURLToPath(new URL(
          "../crates/rion-core/src/extensions/test-signing-key.json",
          import.meta.url
        ))
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let compatibilityOutput = "";
    for (const [stream, target] of [
      [compatibility.stdout, process.stdout],
      [compatibility.stderr, process.stderr]
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        target.write(chunk);
        compatibilityOutput = `${compatibilityOutput}${chunk}`.slice(-1024 * 1024);
      });
    }
    await new Promise((resolve, reject) => {
      compatibility.once("error", reject);
      compatibility.once("exit", (code, signal) => code === 0
        ? resolve()
        : reject(new Error(`Extension compatibility probe failed: ${code ?? signal}`)));
    });
    if (compatibilityOutput.includes("Error occurred in handler for 'crx-msg'")) {
      throw new Error("Handled extension API errors escaped through the native IPC handler.");
    }
    const diagnosis = classifyElectronDevOutput(compatibilityOutput);
    const serviceWorkerFailure = diagnosis.findings.find((finding) =>
      finding.id === "extension-service-worker-registration-failed" ||
      finding.id === "extension-service-worker-runtime-error"
    );
    if (serviceWorkerFailure) {
      throw new Error(`Extension compatibility probe retained ${serviceWorkerFailure.id}.`);
    }
  }
  const bootstrapMain = join(root, "electron-extension-bootstrap-probe.cjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./electronExtensionBootstrapProbe.ts", import.meta.url))],
    external: ["electron"], format: "cjs", logLevel: "silent",
    outfile: bootstrapMain, platform: "node", target: "node24"
  });
  for (const phase of ["seed", "restart"]) {
    const bootstrap = spawn(executable, [bootstrapMain], {
      env: {
        ...process.env, RION_EXTENSION_BOOTSTRAP_PROBE_DIR: root,
        RION_EXTENSION_BOOTSTRAP_PROBE_PHASE: phase,
        RION_EXTENSION_COMPAT_PRELOAD: fileURLToPath(new URL("../out/preload/extensionCompat.cjs", import.meta.url))
      }, stdio: ["ignore", "pipe", "pipe"]
    });
    let bootstrapOutput = "";
    bootstrap.stdout.setEncoding("utf8");
    bootstrap.stdout.on("data", chunk => { bootstrapOutput += chunk; process.stdout.write(chunk); });
    bootstrap.stderr.pipe(process.stderr);
    await new Promise((resolve, reject) => {
      bootstrap.once("error", reject);
      bootstrap.once("exit", (code, signal) => code === 0 ? resolve()
        : reject(new Error(`Extension bootstrap ${phase} probe failed: ${code ?? signal}`)));
    });
    for (const kind of ["failure", "success"]) {
      if (!bootstrapOutput.includes(`"phase":"${phase}","kind":"${kind}"`)) {
        throw new Error(`Bootstrap probe omitted ${phase}/${kind} completion evidence`);
      }
    }
  }

} finally { await rm(root, { recursive: true, force: true }); }

await import("./verifyElectronExtensionFiltering.mjs");
