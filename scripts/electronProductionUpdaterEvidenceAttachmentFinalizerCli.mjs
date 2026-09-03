import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  finalizeElectronProductionUpdaterEvidenceAttachments
} from "./electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";

const ALLOWED_OPTIONS = new Set([
  "attempt-plan",
  "bindings",
  "check-action",
  "data-preservation",
  "endpoint-observation",
  "expected-attempt-plan-sha256",
  "expected-journal-trace-sha256",
  "install-action",
  "journal-trace",
  "native-host-observation",
  "output-root",
  "platform",
  "product-terminal-receipt",
  "source-install-journal",
  "transition-kind"
]);

export async function runElectronProductionUpdaterEvidenceAttachmentFinalizerCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const normalized = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "finalize") {
    throw new Error(
      "Usage: electronProductionUpdaterEvidenceAttachmentFinalizerCli.mjs " +
      "finalize <strict file-based options>"
    );
  }
  const options = parseArguments(optionArguments);
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = await dependencies.finalize({
    attemptPlanPath: requiredOption(options, "attempt-plan"),
    bindingsPath: requiredOption(options, "bindings"),
    capturedAttachments: {
      dataPreservation: requiredOption(options, "data-preservation"),
      endpointObservation: requiredOption(options, "endpoint-observation"),
      nativeHostObservation: requiredOption(options, "native-host-observation"),
      productTerminalReceipt: requiredOption(options, "product-terminal-receipt"),
      sourceInstallJournal: requiredOption(options, "source-install-journal")
    },
    checkActionPath: requiredOption(options, "check-action"),
    expectedAttemptPlanSha256: requiredOption(
      options,
      "expected-attempt-plan-sha256"
    ),
    expectedJournalTraceSha256: requiredOption(
      options,
      "expected-journal-trace-sha256"
    ),
    installActionPath: requiredOption(options, "install-action"),
    journalTracePath: requiredOption(options, "journal-trace"),
    outputRoot: requiredOption(options, "output-root"),
    platform: requiredOption(options, "platform"),
    transitionKind: requiredOption(options, "transition-kind")
  }, dependencyOverrides);
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: result.kind,
    attemptPlanSha256: result.attemptPlanSha256,
    attachments: result.attachments,
    cell: result.cell,
    journalTraceSha256: result.journalTraceSha256,
    outputRoot: result.outputRoot
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every updater evidence finalizer option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid updater evidence finalizer option near ${rawName ?? "<end>"}.`);
    }
    const name = rawName.slice(2);
    if (!ALLOWED_OPTIONS.has(name)) {
      throw new Error(`Unknown updater evidence finalizer option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate updater evidence finalizer option --${name}.`);
    }
    options.set(name, value);
  }
  for (const name of ALLOWED_OPTIONS) requiredOption(options, name);
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater evidence finalizer CLI dependencies must be an object.");
  }
  const allowed = new Set(["finalize", "now", "writeStdout"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown updater evidence finalizer CLI dependency ${key}.`);
    }
  }
  const dependencies = {
    finalize: value.finalize ?? finalizeElectronProductionUpdaterEvidenceAttachments,
    writeStdout: value.writeStdout ?? ((source) => process.stdout.write(source))
  };
  if (typeof dependencies.finalize !== "function" ||
      typeof dependencies.writeStdout !== "function") {
    throw new Error("Updater evidence finalizer CLI dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runElectronProductionUpdaterEvidenceAttachmentFinalizerCli().catch(() => {
    process.stderr.write("Electron updater evidence attachment finalization failed closed.\n");
    process.exitCode = 1;
  });
}
