import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import {
  ADMITTED_EXTENSION, admittedManifestIdentity, assertDiagnosticTree, containedDiagnosticPath,
  findAdmittedMacExtensionInput, instrumentDiagnosticPreload, isGeneratedRulesetCachePath,
  redactDiagnosticJson, redactDiagnosticText, strictDiagnosticResultPassed
} from "./electronExtensionBootstrapDiagnosticSupport.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function saveJson(path, value) {
  const text = JSON.stringify(redactDiagnosticJson(value), null, 2);
  JSON.parse(text);
  await writeFile(path, `${text}\n`);
}

async function clonePackage(input, destination) {
  await cp(input.sourceDirectory, destination, {
    recursive: true, force: false, errorOnExist: true,
    filter: async source => {
      containedDiagnosticPath(input.sourceDirectory, source, true);
      if (isGeneratedRulesetCachePath(input.sourceDirectory, source)) return false;
      if ((await lstat(source)).isSymbolicLink()) throw new Error("DIAGNOSTIC_PACKAGE_SYMLINK_FORBIDDEN");
      return true;
    }
  });
  const manifestBytes = await readFile(join(destination, "manifest.json"));
  admittedManifestIdentity(JSON.parse(manifestBytes.toString("utf8")));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== input.manifestSha256) {
    throw new Error("DIAGNOSTIC_PACKAGE_COPY_CHANGED");
  }
  const tree = await assertDiagnosticTree(destination);
  if (tree.files !== input.copyTree.files || tree.bytes !== input.copyTree.bytes) {
    throw new Error("DIAGNOSTIC_PACKAGE_COPY_CHANGED");
  }
  return tree;
}

async function runCase({ directory, executable, mode, probePath, preloadPath, input }) {
  await mkdir(directory, { recursive: true });
  const packagePath = join(directory, "package");
  const sessionRoot = join(directory, "session");
  const outputPath = join(directory, "native-result.json");
  const result = { mode, startedAt: new Date().toISOString(), exitCode: null, signal: null,
    status: "failed", strictReady: false, errors: [] };
  let stdout = "";
  let stderr = "";
  try {
    result.packageCopy = await clonePackage(input, packagePath);
    await mkdir(sessionRoot);
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (/(?:token|secret|password|credential|private.?key)/iu.test(key)) delete environment[key];
    }
    const child = spawn(executable, [probePath], {
      env: {
        ...environment,
        RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_MODE: mode,
        RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_ROOT: sessionRoot,
        RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_PACKAGE: packagePath,
        RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_PRELOAD: preloadPath,
        RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_OUTPUT: outputPath
      }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise((complete, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { result.exitCode = code; result.signal = signal; complete(); });
    });
    let nativeResult;
    try {
      nativeResult = redactDiagnosticJson(JSON.parse(await readFile(outputPath, "utf8")));
      await saveJson(outputPath, nativeResult);
    }
    catch { throw new Error("DIAGNOSTIC_CHILD_RESULT_UNREADABLE"); }
    if (nativeResult.probe !== "electron-extension-bootstrap-diagnostic" || nativeResult.mode !== mode ||
        nativeResult.extensionId !== ADMITTED_EXTENSION.id || nativeResult.electronVersion !== "44.4.3") {
      throw new Error("DIAGNOSTIC_CHILD_RESULT_OWNER_MISMATCH");
    }
    result.native = nativeResult;
    result.strictReady = strictDiagnosticResultPassed(result.exitCode, nativeResult);
    result.status = result.exitCode === 0 && nativeResult.status === "passed" &&
      (mode === "native-only" || result.strictReady) ? "passed" : "failed";
    // Replace the child JSON with the redacted representation before upload.
    await saveJson(outputPath, nativeResult);
  } catch (error) {
    result.errors.push(redactDiagnosticText(error instanceof Error ? error.message : String(error)));
  } finally {
    result.finishedAt = new Date().toISOString();
    await Promise.all([
      writeFile(join(directory, "stdout.log"), redactDiagnosticText(stdout)),
      writeFile(join(directory, "stderr.log"), redactDiagnosticText(stderr)),
      saveJson(join(directory, "case-result.json"), result)
    ]);
  }
  return result;
}

export async function diagnoseElectronExtensionBootstrap(artifactBase) {
  const base = await realpath(resolve(artifactBase));
  const outputBase = containedDiagnosticPath(base, join(base, "extension-bootstrap-diagnostics"));
  await mkdir(outputBase, { recursive: true });
  containedDiagnosticPath(base, await realpath(outputBase));
  const output = await mkdtemp(join(outputBase, `${new Date().toISOString().replaceAll(":", "-")}-`));
  const reportPath = join(output, "report.json");
  const report = { probe: "electron-extension-bootstrap-diagnostic-runner", startedAt: new Date().toISOString(),
    status: "failed", strictReady: false, cases: [], errors: [] };
  try {
    if (process.platform !== "darwin") throw new Error("DIAGNOSTIC_MACOS_HOST_REQUIRED");
    const input = await findAdmittedMacExtensionInput(base);
    report.input = { report: input.report, metadata: ADMITTED_EXTENSION,
      manifest: input.manifest, manifestSha256: input.manifestSha256, sourceTree: input.tree,
      expectedCopyTree: input.copyTree, generatedRulesetCache: input.generatedRulesetCache };
    const require = createRequire(import.meta.url);
    const executable = await realpath(require("electron"));
    if (!(await lstat(executable)).isFile()) throw new Error("DIAGNOSTIC_ELECTRON_EXECUTABLE_INVALID");
    const probePath = join(output, "diagnostic-probe.cjs");
    const preloadPath = join(output, "diagnostic-preload.cjs");
    const preloadSourcePath = join(repositoryRoot, "third_party/electron-chrome-extensions/src/rion-preload.ts");
    const preloadSource = instrumentDiagnosticPreload(await readFile(preloadSourcePath, "utf8"));
    await build({ bundle: true, external: ["electron"], format: "cjs", logLevel: "silent",
      entryPoints: [join(repositoryRoot, "scripts/electronExtensionBootstrapDiagnosticProbe.ts")],
      outfile: probePath, platform: "node", target: "node24" });
    await build({ bundle: true, external: ["electron"], format: "cjs", logLevel: "silent",
      stdin: { contents: preloadSource, loader: "ts", sourcefile: "diagnostic-rion-preload.ts",
        resolveDir: dirname(preloadSourcePath) },
      outfile: preloadPath, platform: "node", target: "node24" });
    for (const mode of ["native-only", "strict-compat"]) {
      const result = await runCase({ directory: join(output, "cases", mode), executable, mode,
        probePath, preloadPath, input });
      report.cases.push(result);
      await saveJson(reportPath, report);
    }
    report.strictReady = report.cases.find(result => result.mode === "strict-compat")?.strictReady === true;
    report.status = report.strictReady ? "passed" : "failed";
  } catch (error) {
    report.errors.push(redactDiagnosticText(error instanceof Error ? error.message : String(error)));
  } finally {
    report.finishedAt = new Date().toISOString();
    await saveJson(reportPath, report);
    console.log(`RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_REPORT=${reportPath}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error("Usage: diagnoseElectronExtensionBootstrap.mjs <artifact-base>");
  const report = await diagnoseElectronExtensionBootstrap(process.argv[2]);
  process.exitCode = report.strictReady ? 0 : 1;
}
