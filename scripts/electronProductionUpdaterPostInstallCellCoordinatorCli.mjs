import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME } from
  "./electronProductionUpdaterEvidenceBundle.mjs";
import { coordinateElectronProductionUpdaterPostInstallCell } from
  "./electronProductionUpdaterPostInstallCellCoordinator.mjs";

export const ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CELL_CLI_SUMMARY_KIND =
  "rion-electron-production-updater-post-install-cell-cli-summary";

const COMMON_OPTIONS = Object.freeze([
  "attachment-output-root",
  "attempt-plan",
  "attempt-plan-sha256",
  "bindings",
  "bundle-output-root",
  "check-action",
  "data-preservation-before",
  "data-preservation-before-sha256",
  "data-preservation-context-output",
  "data-preservation-observation-output",
  "endpoint-observation",
  "install-action",
  "journal-trace",
  "journal-trace-sha256",
  "native-host-observation",
  "platform",
  "product-terminal-receipt-output",
  "source-install-journal",
  "target-executable",
  "target-launch-arguments-output",
  "target-user-data",
  "transition-kind"
]);
const DARWIN_OPTIONS = Object.freeze([
  ...COMMON_OPTIONS,
  "inventory-executable",
  "inventory-executable-sha256"
]);
const ALL_OPTIONS = new Set(DARWIN_OPTIONS);

export async function runElectronProductionUpdaterPostInstallCellCoordinatorCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "observe") {
    throw new Error(
      "Usage: electronProductionUpdaterPostInstallCellCoordinatorCli.mjs " +
      "observe <exact post-install cell options>"
    );
  }
  const options = parseArguments(optionArguments);
  const isDarwin = requiredOption(options, "platform") === "darwin-aarch64";
  assertExactOptions(options, isDarwin ? DARWIN_OPTIONS : COMMON_OPTIONS);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = await dependencies.coordinate({
    attachmentOutputRoot: requiredOption(options, "attachment-output-root"),
    attemptPlanPath: requiredOption(options, "attempt-plan"),
    bindingsPath: requiredOption(options, "bindings"),
    bundleOutputRoot: requiredOption(options, "bundle-output-root"),
    checkActionPath: requiredOption(options, "check-action"),
    dataPreservationBeforePath: requiredOption(options, "data-preservation-before"),
    dataPreservationContextOutputPath: requiredOption(
      options,
      "data-preservation-context-output"
    ),
    dataPreservationObservationOutputPath: requiredOption(
      options,
      "data-preservation-observation-output"
    ),
    endpointObservationPath: requiredOption(options, "endpoint-observation"),
    expectedAttemptPlanSha256: requiredOption(options, "attempt-plan-sha256"),
    expectedDataPreservationBeforeSha256: requiredOption(
      options,
      "data-preservation-before-sha256"
    ),
    expectedJournalTraceSha256: requiredOption(options, "journal-trace-sha256"),
    installActionPath: requiredOption(options, "install-action"),
    journalTracePath: requiredOption(options, "journal-trace"),
    nativeHostObservationPath: requiredOption(options, "native-host-observation"),
    platform: requiredOption(options, "platform"),
    productTerminalReceiptOutputPath: requiredOption(
      options,
      "product-terminal-receipt-output"
    ),
    signal: dependencies.signal,
    sourceInstallJournalPath: requiredOption(options, "source-install-journal"),
    targetExecutablePath: requiredOption(options, "target-executable"),
    targetLaunchArgumentsOutputPath: requiredOption(
      options,
      "target-launch-arguments-output"
    ),
    targetProcess: isDarwin
      ? {
          inventoryExecutablePath: requiredOption(options, "inventory-executable"),
          inventoryExecutableSha256: requiredOption(
            options,
            "inventory-executable-sha256"
          )
        }
      : {},
    targetUserDataDirectory: requiredOption(options, "target-user-data"),
    transitionKind: requiredOption(options, "transition-kind")
  }, dependencies.coordinatorDependencies);
  const summary = Object.freeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CELL_CLI_SUMMARY_KIND,
    status: "bundled",
    artifact: Object.freeze({
      fileName: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME,
      sha256: result.receiptSha256
    }),
    outputRoot: result.outputRoot
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every post-install cell option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid post-install cell option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!ALL_OPTIONS.has(name)) {
      throw new Error(`Unknown post-install cell option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate post-install cell option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertExactOptions(options, expected) {
  const observedNames = [...options.keys()].sort();
  const expectedNames = [...expected].sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The post-install cell option set is not exact.");
  }
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Post-install cell CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "coordinate",
    "coordinatorDependencies",
    "signal",
    "writeStdout"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown post-install cell CLI dependency ${key}.`);
    }
  }
  const coordinate = value.coordinate ?? coordinateElectronProductionUpdaterPostInstallCell;
  const writeStdout = value.writeStdout ?? ((source) => process.stdout.write(source));
  if (typeof coordinate !== "function" || typeof writeStdout !== "function") {
    throw new Error("Post-install cell CLI dependencies are invalid.");
  }
  return Object.freeze({
    coordinate,
    coordinatorDependencies: value.coordinatorDependencies ?? {},
    signal: requiredSignal(value.signal),
    writeStdout
  });
}

function requiredSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The post-install cell CLI caller must provide an AbortSignal.");
  }
  return value;
}

function processCancellation() {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("process termination requested"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  });
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = processCancellation();
  runElectronProductionUpdaterPostInstallCellCoordinatorCli(
    process.argv.slice(2),
    { signal: cancellation.signal }
  ).catch(() => {
    process.stderr.write("Electron production updater post-install cell failed closed.\n");
    process.exitCode = 1;
  }).finally(() => cancellation.dispose());
}
