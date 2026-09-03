import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
  assembleElectronProductionUpdaterEvidenceBundle,
  readElectronProductionUpdaterEvidenceBundle
} from "./electronProductionUpdaterEvidenceBundle.mjs";
import {
  assertExactKeys,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRealDirectory
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const MAX_BINDINGS_BYTES = 1024 * 1024;
const BINDING_KEYS = Object.freeze([
  "provenance",
  "sourceBinding",
  "targetBinding"
]);
const COMMAND_OPTIONS = Object.freeze({
  assemble: new Set(["attachments", "bindings", "output-root"]),
  verify: new Set(["bundle-root", "expected-receipt-sha256"])
});

export async function runElectronProductionUpdaterEvidenceBundleCli(
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
      "Usage: electronProductionUpdaterEvidenceBundleCli.mjs " +
      "<assemble|verify> [strict local options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);

  const result = command === "assemble"
    ? await assembleBundle(options, dependencies)
    : await verifyBundle(options, dependencies);
  const summary = bundleSummary(result);
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function assembleBundle(options, dependencies) {
  const bindings = await readBindings(requiredOption(options, "bindings"));
  const attachmentRoot = await readExactAttachmentRoot(
    requiredOption(options, "attachments")
  );
  const outputRoot = await resolveCreateNewOutputRoot(
    requiredOption(options, "output-root")
  );
  assertOutputOutsideAttachmentRoot(outputRoot, attachmentRoot);
  return dependencies.assembleBundle({
    attachments: Object.fromEntries(
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
        name,
        path.join(attachmentRoot, name)
      ])
    ),
    outputRoot,
    provenance: bindings.provenance,
    sourceBinding: bindings.sourceBinding,
    targetBinding: bindings.targetBinding
  });
}

async function verifyBundle(options, dependencies) {
  const outputRoot = requiredAbsolutePath(
    requiredOption(options, "bundle-root"),
    "updater evidence bundle root"
  );
  const expectedReceiptSha256Value = optionalOption(
    options,
    "expected-receipt-sha256"
  );
  const expectedReceiptSha256 = expectedReceiptSha256Value === undefined
    ? undefined
    : requiredDigest(
      expectedReceiptSha256Value,
      "expected updater evidence receipt SHA-256"
    );
  return dependencies.readBundle({
    expectedReceiptSha256,
    outputRoot
  });
}

async function readBindings(bindingsPath) {
  const bindings = await readCanonicalJsonFile(
    bindingsPath,
    MAX_BINDINGS_BYTES,
    "updater evidence bundle bindings"
  );
  assertExactKeys(
    bindings.value,
    BINDING_KEYS,
    "updater evidence bundle bindings"
  );
  return bindings.value;
}

async function readExactAttachmentRoot(value) {
  const attachmentRoot = await requiredRealDirectory(
    value,
    "updater evidence attachment directory"
  );
  const expected = [...ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES]
    .sort(compareStrings);
  const observed = (await readdir(attachmentRoot)).sort(compareStrings);
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error("The updater evidence attachment directory inventory is not exact.");
  }
  return attachmentRoot;
}

async function resolveCreateNewOutputRoot(value) {
  const requested = requiredAbsolutePath(
    value,
    "updater evidence bundle output root"
  );
  const parent = await requiredRealDirectory(
    path.dirname(requested),
    "updater evidence bundle output parent"
  );
  const outputRoot = path.join(parent, path.basename(requested));
  try {
    await lstat(outputRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return outputRoot;
    throw error;
  }
  throw new Error("The updater evidence bundle output root must be create-new.");
}

function assertOutputOutsideAttachmentRoot(outputRoot, attachmentRoot) {
  const relation = path.relative(attachmentRoot, outputRoot);
  if (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relation))
  ) {
    throw new Error(
      "The updater evidence bundle output root must stay outside the attachment directory."
    );
  }
}

function bundleSummary(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The updater evidence bundle result is invalid.");
  }
  return deepFreeze({
    outputRoot: requiredAbsolutePath(
      result.outputRoot,
      "verified updater evidence bundle root"
    ),
    receiptSha256: requiredDigest(
      result.receiptSha256,
      "verified updater evidence receipt SHA-256"
    )
  });
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every updater evidence bundle CLI option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      !rawName?.startsWith("--") || rawName.length === 2 ||
      value === undefined || value.startsWith("--")
    ) {
      throw new Error(
        `Invalid updater evidence bundle CLI option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate updater evidence bundle CLI option --${name}.`);
    }
    options.set(name, value);
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
  for (const name of allowed) {
    if (command === "verify" && name === "expected-receipt-sha256") continue;
    requiredOption(options, name);
  }
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function optionalOption(options, name) {
  return options.has(name) ? requiredOption(options, name) : undefined;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Updater evidence bundle CLI dependencies must be an object.");
  }
  const allowed = new Set(["assembleBundle", "readBundle", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown updater evidence bundle CLI dependency ${name}.`);
    }
  }
  const dependencies = {
    assembleBundle: overrides.assembleBundle ??
      assembleElectronProductionUpdaterEvidenceBundle,
    readBundle: overrides.readBundle ?? readElectronProductionUpdaterEvidenceBundle,
    writeStdout: overrides.writeStdout ?? ((source) => process.stdout.write(source))
  };
  if (Object.values(dependencies).some((dependency) =>
    typeof dependency !== "function"
  )) {
    throw new Error("Updater evidence bundle CLI dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
  runElectronProductionUpdaterEvidenceBundleCli().catch(() => {
    process.stderr.write(
      "Electron production updater evidence bundle CLI failed closed.\n"
    );
    process.exitCode = 1;
  });
}
