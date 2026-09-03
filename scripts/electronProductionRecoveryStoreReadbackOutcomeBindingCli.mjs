import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
  assertElectronProductionPublicationRecoveryOutcomeChainProof,
  serializeElectronProductionPublicationRecoveryOutcomeChainProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  runElectronProductionRecoveryStoreReadbackFoundationCli
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";
import {
  assertEqual,
  readCanonicalJsonFile,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_OUTCOME_BINDING_KIND =
  "rion-electron-production-recovery-store-readback-outcome-binding";

const READBACK_OPTIONS = [
  "capsule",
  "capsule-read-operation",
  "capsule-read-operation-sha256",
  "owner",
  "ref",
  "repo",
  "seal-read-operation",
  "seal-read-operation-sha256",
  "store-seal",
  "transaction-id"
];
const OPTIONS = new Set([
  ...READBACK_OPTIONS,
  "outcome-chain-proof",
  "outcome-chain-proof-sha256"
]);

export async function runElectronProductionRecoveryStoreReadbackOutcomeBindingCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify-readback-outcome-binding") {
    throw new Error(
      "Usage: electronProductionRecoveryStoreReadbackOutcomeBindingCli.mjs " +
      "verify-readback-outcome-binding [strict local evidence options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(options);
  const [readback, chainProof] = await Promise.all([
    dependencies.verifyReadback(readbackArguments(options), {
      writeStdout: () => undefined
    }),
    dependencies.readChainProof({
      expectedSha256: requiredOption(options, "outcome-chain-proof-sha256"),
      proofPath: requiredOption(options, "outcome-chain-proof")
    })
  ]);
  for (const [actual, expected, label] of [
    [chainProof.value.transactionId, readback.transactionId, "transaction ID"],
    [chainProof.value.target, readback.target, "private target"],
    [chainProof.value.currentObservation, readback.currentObservation,
      "head/tree observation"],
    [chainProof.value.foundation.storeSealSha256,
      readback.storeSeal.file.sha256, "store-seal foundation"]
  ]) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`The recovery outcome ${label} does not match readback.`);
    }
  }
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_OUTCOME_BINDING_KIND,
    status: "verified-same-head-outcome-chain",
    transactionId: readback.transactionId,
    target: readback.target,
    currentObservation: readback.currentObservation,
    readback: {
      capsule: {
        file: readback.capsule.file,
        blobSha: readback.capsule.blobSha,
        readReceiptSha256: readback.capsule.readReceiptSha256
      },
      storeSeal: {
        file: readback.storeSeal.file,
        blobSha: readback.storeSeal.blobSha,
        readReceiptSha256: readback.storeSeal.readReceiptSha256
      }
    },
    outcomeChain: {
      proofSha256: chainProof.sha256,
      status: chainProof.value.status,
      outcomeDirectory: chainProof.value.outcomeDirectory,
      latestOutcome: chainProof.value.latestOutcome,
      terminal: chainProof.value.terminal
    }
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function readbackArguments(options) {
  return [
    "verify-readback-foundation",
    ...READBACK_OPTIONS.flatMap((name) => [
      `--${name}`,
      requiredOption(options, name)
    ])
  ];
}

async function readChainProof(input) {
  const file = await readCanonicalJsonFile(
    input.proofPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome chain proof"
  );
  const expectedSha256 = requiredDigest(
    input.expectedSha256,
    "publication recovery outcome chain proof SHA-256"
  );
  assertEqual(file.sha256, expectedSha256,
    "publication recovery outcome chain proof SHA-256");
  const value = assertElectronProductionPublicationRecoveryOutcomeChainProof(
    file.value
  );
  if (!file.source.equals(
    serializeElectronProductionPublicationRecoveryOutcomeChainProof(value)
  )) {
    throw new Error("The publication recovery outcome chain proof is not canonical.");
  }
  return deepFreeze({ value, sha256: file.sha256 });
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every readback-outcome binding option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid readback-outcome binding option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate readback-outcome binding option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertOptions(options) {
  for (const name of options.keys()) {
    if (!OPTIONS.has(name)) {
      throw new Error(`Unknown readback-outcome binding option --${name}.`);
    }
  }
  for (const name of OPTIONS) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Readback-outcome binding dependencies are invalid.");
  }
  const allowed = new Set(["readChainProof", "verifyReadback", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown readback-outcome binding dependency ${name}.`);
    }
  }
  const dependencies = {
    readChainProof: overrides.readChainProof ?? readChainProof,
    verifyReadback: overrides.verifyReadback ??
      runElectronProductionRecoveryStoreReadbackFoundationCli,
    writeStdout: overrides.writeStdout ?? ((source) => {
      process.stdout.write(source);
    })
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    throw new Error("Readback-outcome binding dependencies are invalid.");
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
  runElectronProductionRecoveryStoreReadbackOutcomeBindingCli().catch(() => {
    process.stderr.write("Recovery-store readback/outcome binding failed closed.\n");
    process.exitCode = 1;
  });
}
