import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
  createElectronProductionRecoveryCapsule,
  materializeElectronProductionRecoveryCapsule,
  readElectronProductionRecoveryCapsule,
  readElectronProductionRecoveryCapsuleDirectory
} from "./electronProductionRecoveryCapsule.mjs";
import {
  requiredPositiveInteger
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_CLI_OPERATION_KIND =
  "rion-electron-production-recovery-capsule-cli-operation";

const INTENT_FILE_NAME =
  "electron-production-publication-intent-receipt.json";
const SOURCE_REPOSITORY = "rion-tw/rion-studio-source";
const PUBLISHER_WORKFLOW =
  ".github/workflows/electron-production-provisional-publish.yml";
const BINDING_OPTIONS = Object.freeze([
  "candidate-control-sha",
  "candidate-run-attempt",
  "candidate-run-id",
  "candidate-source-sha",
  "candidate-version",
  "control-head-sha",
  "control-run-attempt",
  "control-run-id",
  "lease-event-sha256",
  "lease-generation",
  "lease-id",
  "prior-candidate-control-sha",
  "prior-candidate-run-attempt",
  "prior-candidate-run-id",
  "prior-candidate-source-sha",
  "prior-candidate-version",
  "transaction-id"
]);
const COMMAND_OPTIONS = Object.freeze({
  create: new Set([...BINDING_OPTIONS, "capsule-output", "source-root"]),
  materialize: new Set([
    ...BINDING_OPTIONS,
    "capsule-path",
    "capsule-sha256",
    "manifest-sha256",
    "output-root"
  ]),
  verify: new Set([
    ...BINDING_OPTIONS,
    "capsule-path",
    "capsule-sha256",
    "manifest-sha256",
    "source-root"
  ])
});

export async function runElectronProductionRecoveryCapsuleCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new Error(
      "Usage: electronProductionRecoveryCapsuleCli.mjs " +
      "<create|materialize|verify> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const binding = bindingFromOptions(options);
  let result;
  if (command === "create") {
    result = await dependencies.createCapsule({
      binding,
      capsulePath: requiredOption(options, "capsule-output"),
      sourceRoot: requiredOption(options, "source-root")
    });
  } else if (command === "verify") {
    result = await dependencies.readCapsule({
      binding,
      capsulePath: requiredOption(options, "capsule-path"),
      expectedCapsuleSha256: requiredOption(options, "capsule-sha256")
    });
    const directory = await dependencies.readDirectory({
      binding,
      expectedManifestSha256: requiredOption(options, "manifest-sha256"),
      sourceRoot: requiredOption(options, "source-root")
    });
    assertSameDirectoryCapsule(result, directory);
  } else {
    result = await dependencies.materializeCapsule({
      binding,
      capsulePath: requiredOption(options, "capsule-path"),
      expectedCapsuleSha256: requiredOption(options, "capsule-sha256"),
      expectedManifestSha256: requiredOption(options, "manifest-sha256"),
      outputRoot: requiredOption(options, "output-root")
    });
  }
  const summary = operationSummary(command, result);
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function bindingFromOptions(options) {
  return {
    transaction: { id: requiredOption(options, "transaction-id") },
    lease: {
      id: requiredOption(options, "lease-id"),
      generation: positiveIntegerOption(options, "lease-generation"),
      eventSha256: requiredOption(options, "lease-event-sha256")
    },
    control: {
      repository: SOURCE_REPOSITORY,
      workflow: PUBLISHER_WORKFLOW,
      event: "workflow_dispatch",
      runId: requiredOption(options, "control-run-id"),
      runAttempt: positiveIntegerOption(options, "control-run-attempt"),
      headSha: requiredOption(options, "control-head-sha")
    },
    candidate: candidateBinding(options, "candidate"),
    priorCandidate: candidateBinding(options, "prior-candidate")
  };
}

function candidateBinding(options, prefix) {
  return {
    sourceSha: requiredOption(options, `${prefix}-source-sha`),
    version: requiredOption(options, `${prefix}-version`),
    controlSha: requiredOption(options, `${prefix}-control-sha`),
    runId: requiredOption(options, `${prefix}-run-id`),
    runAttempt: positiveIntegerOption(options, `${prefix}-run-attempt`)
  };
}

function assertSameDirectoryCapsule(capsule, directory) {
  if (!isDeepStrictEqual(capsule.manifestIdentity, directory.manifestIdentity)) {
    throw new Error(
      "The packed recovery capsule manifest identity differs from the directory manifest."
    );
  }
  if (!isDeepStrictEqual(capsule.manifest, directory.manifest)) {
    throw new Error(
      "The packed recovery capsule manifest differs from the directory manifest."
    );
  }
  if (!isDeepStrictEqual(capsule.files, directory.files)) {
    throw new Error(
      "The packed recovery capsule inventory differs from the directory inventory."
    );
  }
}

function operationSummary(command, result) {
  const intent = result.files[INTENT_FILE_NAME];
  if (!intent) {
    throw new Error("The verified recovery capsule intent identity is missing.");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_CLI_OPERATION_KIND,
    command,
    capsule: exactIdentity(
      result.capsuleIdentity,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      "packed recovery capsule"
    ),
    manifest: exactIdentity(
      result.manifestIdentity,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      "recovery capsule manifest"
    ),
    intent: exactIdentity(
      { ...intent, fileName: INTENT_FILE_NAME },
      INTENT_FILE_NAME,
      "publication intent"
    )
  });
}

function exactIdentity(value, expectedFileName, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.fileName !== expectedFileName ||
      !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
      typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error(`The ${label} identity is invalid.`);
  }
  return {
    bytes: value.bytes,
    fileName: value.fileName,
    sha256: value.sha256
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every recovery capsule CLI option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid recovery capsule CLI option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty recovery capsule CLI option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function positiveIntegerOption(options, name) {
  const value = requiredOption(options, name);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return requiredPositiveInteger(Number(value), name);
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery capsule CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "createCapsule",
    "materializeCapsule",
    "readCapsule",
    "readDirectory",
    "writeStdout"
  ]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown recovery capsule CLI dependency ${name}.`);
    }
  }
  const dependencies = {
    createCapsule: overrides.createCapsule ?? createElectronProductionRecoveryCapsule,
    materializeCapsule: overrides.materializeCapsule ??
      materializeElectronProductionRecoveryCapsule,
    readCapsule: overrides.readCapsule ?? readElectronProductionRecoveryCapsule,
    readDirectory: overrides.readDirectory ??
      readElectronProductionRecoveryCapsuleDirectory,
    writeStdout: overrides.writeStdout ?? ((source) => {
      process.stdout.write(source);
    })
  };
  if (Object.values(dependencies).some((dependency) =>
    typeof dependency !== "function"
  )) {
    throw new Error("Recovery capsule CLI dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionRecoveryCapsuleCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
