import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  runElectronProductionRecoveryStoreReadbackFoundationCli
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_CONTINUITY_KIND =
  "rion-electron-production-recovery-store-readback-continuity";

const COMMON_OPTIONS = Object.freeze([
  "owner",
  "ref",
  "repo",
  "transaction-id"
]);
const SNAPSHOT_OPTIONS = Object.freeze([
  "capsule",
  "capsule-read-operation",
  "capsule-read-operation-sha256",
  "seal-read-operation",
  "seal-read-operation-sha256",
  "store-seal"
]);
const ALLOWED_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  ...SNAPSHOT_OPTIONS.map((name) => `initial-${name}`),
  ...SNAPSHOT_OPTIONS.map((name) => `fresh-${name}`)
]);

export async function runElectronProductionRecoveryStoreReadbackContinuityCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify-readback-continuity") {
    throw new Error(
      "Usage: electronProductionRecoveryStoreReadbackContinuityCli.mjs " +
      "verify-readback-continuity [strict local options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(options);
  assertDistinctEvidencePaths(options);
  const [initial, fresh] = await Promise.all([
    verifySnapshot("initial", options, dependencies),
    verifySnapshot("fresh", options, dependencies)
  ]);
  const initialContinuity = continuityProjection(initial);
  const freshContinuity = continuityProjection(fresh);
  if (!isDeepStrictEqual(initialContinuity, freshContinuity)) {
    throw new Error(
      "The recovery-store readback observation changed between sealed reads."
    );
  }
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_CONTINUITY_KIND,
    status: "verified-same-observation",
    ...initialContinuity,
    receipts: {
      initial: receiptProjection(initial),
      fresh: receiptProjection(fresh)
    }
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function verifySnapshot(prefix, options, dependencies) {
  return dependencies.verifyReadback([
    "verify-readback-foundation",
    "--transaction-id", requiredOption(options, "transaction-id"),
    "--owner", requiredOption(options, "owner"),
    "--repo", requiredOption(options, "repo"),
    "--ref", requiredOption(options, "ref"),
    "--capsule", requiredOption(options, `${prefix}-capsule`),
    "--capsule-read-operation",
    requiredOption(options, `${prefix}-capsule-read-operation`),
    "--capsule-read-operation-sha256",
    requiredOption(options, `${prefix}-capsule-read-operation-sha256`),
    "--store-seal", requiredOption(options, `${prefix}-store-seal`),
    "--seal-read-operation",
    requiredOption(options, `${prefix}-seal-read-operation`),
    "--seal-read-operation-sha256",
    requiredOption(options, `${prefix}-seal-read-operation-sha256`)
  ], { writeStdout: () => undefined });
}

function continuityProjection(summary) {
  return deepFreeze({
    transactionId: summary.transactionId,
    target: summary.target,
    paths: summary.paths,
    currentObservation: summary.currentObservation,
    capsule: {
      file: summary.capsule.file,
      blobSha: summary.capsule.blobSha
    },
    storeSeal: {
      file: summary.storeSeal.file,
      blobSha: summary.storeSeal.blobSha
    },
    historicalCapsuleCreate: summary.historicalCapsuleCreate
  });
}

function receiptProjection(summary) {
  return deepFreeze({
    capsuleReadReceiptSha256: summary.capsule.readReceiptSha256,
    sealReadReceiptSha256: summary.storeSeal.readReceiptSha256
  });
}

function assertDistinctEvidencePaths(options) {
  const paths = [];
  for (const prefix of ["initial", "fresh"]) {
    for (const name of [
      "capsule",
      "capsule-read-operation",
      "seal-read-operation",
      "store-seal"
    ]) paths.push(path.resolve(requiredOption(options, `${prefix}-${name}`)));
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "Initial and fresh recovery-store evidence paths must all be distinct."
    );
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every readback-continuity option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid readback-continuity option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate readback-continuity option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertOptions(options) {
  for (const name of options.keys()) {
    if (!ALLOWED_OPTIONS.has(name)) {
      throw new Error(`Unknown readback-continuity option --${name}.`);
    }
  }
  for (const name of ALLOWED_OPTIONS) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required readback-continuity option --${name}.`);
  }
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Readback-continuity dependencies must be an object.");
  }
  const allowed = new Set(["verifyReadback", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown readback-continuity dependency ${name}.`);
    }
  }
  const dependencies = {
    verifyReadback: overrides.verifyReadback ??
      runElectronProductionRecoveryStoreReadbackFoundationCli,
    writeStdout: overrides.writeStdout ??
      ((source) => process.stdout.write(source))
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    throw new Error("Readback-continuity dependencies are invalid.");
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
  runElectronProductionRecoveryStoreReadbackContinuityCli().catch(() => {
    process.stderr.write(
      "Electron production recovery-store readback continuity failed closed.\n"
    );
    process.exitCode = 1;
  });
}
