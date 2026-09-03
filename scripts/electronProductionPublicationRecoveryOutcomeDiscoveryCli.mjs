import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES,
  electronProductionPublicationRecoveryLatestOutcomeSource,
  readElectronProductionPublicationRecoveryOutcomeDiscovery,
  verifyElectronProductionPublicationRecoveryOutcomeChain,
  verifyElectronProductionPublicationRecoveryOutcomeContinuity,
  writeElectronProductionPublicationRecoveryOutcomeChainProof,
  writeElectronProductionPublicationRecoveryOutcomeContinuityProof,
  writeElectronProductionPublicationRecoveryOutcomeDiscovery
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  discoverElectronProductionPublicationRecoveryOutcomes
} from "./electronProductionPublicationRecoveryOutcomeDiscoveryRemote.mjs";
import {
  readElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  readElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import {
  publicIdentity,
  readStableFile,
  requiredAbsolutePath,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const CLI_SUMMARY_KIND =
  "rion-electron-production-publication-recovery-outcome-discovery-cli-summary";
const FOUNDATION_OPTIONS = Object.freeze([
  "held-lease",
  "held-lease-sha256",
  "source-snapshot",
  "source-snapshot-sha256",
  "store-seal",
  "store-seal-sha256",
  "target-snapshot",
  "target-snapshot-sha256"
]);
const COMMAND_OPTIONS = Object.freeze({
  discover: new Set([
    "observed-at",
    "output",
    "owner",
    "ref",
    "repo",
    "repository-default-branch",
    "repository-visibility",
    "transaction-id"
  ]),
  "verify-chain": new Set([
    "discovery",
    "discovery-sha256",
    "latest-outcome-output-directory",
    "output",
    ...FOUNDATION_OPTIONS
  ]),
  "verify-continuity": new Set([
    "fresh-discovery",
    "fresh-discovery-sha256",
    "initial-discovery",
    "initial-discovery-sha256",
    "latest-outcome-output-directory",
    "output",
    ...FOUNDATION_OPTIONS
  ])
});

export async function runElectronProductionPublicationRecoveryOutcomeDiscoveryCli(
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
      "Usage: electronProductionPublicationRecoveryOutcomeDiscoveryCli.mjs " +
      "<discover|verify-chain|verify-continuity> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(command, options);
  const summary = command === "discover"
    ? await runDiscover(options, dependencies)
    : command === "verify-chain"
      ? await runVerifyChain(options, dependencies)
      : await runVerifyContinuity(options, dependencies);
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function runDiscover(options, dependencies) {
  await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
    "publication recovery outcome discovery output"
  );
  const receipt = await dependencies.discoverRemote({
    fetchImpl: dependencies.fetchImpl,
    observedAt: requiredOption(options, "observed-at"),
    target: {
      owner: requiredOption(options, "owner"),
      repo: requiredOption(options, "repo"),
      ref: requiredOption(options, "ref"),
      repositoryPolicy: {
        defaultBranch: requiredOption(options, "repository-default-branch"),
        visibility: requiredPrivateVisibility(options)
      }
    },
    token: requiredToken(dependencies.environment),
    transactionId: requiredOption(options, "transaction-id")
  });
  const written = await writeElectronProductionPublicationRecoveryOutcomeDiscovery({
    outputPath: requiredOption(options, "output"),
    value: receipt
  });
  return summaryFor("discover", written.valueIdentity, null, receipt);
}

async function runVerifyChain(options, dependencies) {
  const [discoveryFile, foundation] = await Promise.all([
    readDiscovery(options, "discovery"),
    readFoundation(options)
  ]);
  const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...foundation,
    discovery: discoveryFile.value,
    discoverySha256: discoveryFile.valueIdentity.sha256
  });
  return materializeVerification({
    command: "verify-chain",
    dependencies,
    discovery: discoveryFile.value,
    latestDirectory: requiredOption(options, "latest-outcome-output-directory"),
    outputPath: requiredOption(options, "output"),
    proof,
    proofFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
    writeProof: writeElectronProductionPublicationRecoveryOutcomeChainProof
  });
}

async function runVerifyContinuity(options, dependencies) {
  const [initial, fresh, foundation] = await Promise.all([
    readDiscovery(options, "initial-discovery"),
    readDiscovery(options, "fresh-discovery"),
    readFoundation(options)
  ]);
  if (initial.valuePath === fresh.valuePath) {
    throw new Error("Initial and fresh recovery discoveries must be distinct files.");
  }
  const proof = verifyElectronProductionPublicationRecoveryOutcomeContinuity({
    ...foundation,
    initialDiscovery: initial.value,
    initialDiscoverySha256: initial.valueIdentity.sha256,
    freshDiscovery: fresh.value,
    freshDiscoverySha256: fresh.valueIdentity.sha256
  });
  return materializeVerification({
    command: "verify-continuity",
    dependencies,
    discovery: fresh.value,
    latestDirectory: requiredOption(options, "latest-outcome-output-directory"),
    outputPath: requiredOption(options, "output"),
    proof,
    proofFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE,
    writeProof: writeElectronProductionPublicationRecoveryOutcomeContinuityProof
  });
}

async function materializeVerification(input) {
  const latestDirectory = await requiredEmptyRealDirectory(input.latestDirectory);
  const proofOutputPath = await resolveCreateNewFile(
    input.outputPath,
    input.proofFileName,
    "publication recovery outcome discovery proof output"
  );
  if (path.dirname(proofOutputPath) === latestDirectory) {
    throw new Error("The recovery proof and latest-outcome roots must be distinct.");
  }
  const latestSource = electronProductionPublicationRecoveryLatestOutcomeSource(
    input.discovery,
    input.proof
  );
  let latest = null;
  try {
    latest = latestSource === null
      ? null
      : await materializeLatestOutcome(
          latestDirectory,
          input.proof.latestOutcome,
          latestSource,
          input.dependencies.rereadLatestFile
        );
    const written = await input.writeProof({
      outputPath: proofOutputPath,
      value: input.proof
    });
    return summaryFor(
      input.command,
      written.valueIdentity,
      latest?.publicIdentity ?? null,
      input.proof
    );
  } catch (error) {
    if (latest !== null) {
      await unlinkIfIdentityMatches(latest.path, latest.identity);
    }
    throw error;
  }
}

async function readFoundation(options) {
  const [heldLease, sourceSnapshot, storeSeal, targetSnapshot] =
    await Promise.all([
      readElectronProductionPublicLatestLease({
        expectedSha256: requiredOption(options, "held-lease-sha256"),
        leasePath: requiredOption(options, "held-lease")
      }),
      readElectronProductionPublicLatestSnapshot({
        expectedFileSha256: requiredOption(options, "source-snapshot-sha256"),
        snapshotPath: requiredOption(options, "source-snapshot")
      }),
      readElectronProductionPublicationRecoveryStoreSeal({
        expectedSha256: requiredOption(options, "store-seal-sha256"),
        receiptPath: requiredOption(options, "store-seal")
      }),
      readElectronProductionPublicLatestSnapshot({
        expectedFileSha256: requiredOption(options, "target-snapshot-sha256"),
        snapshotPath: requiredOption(options, "target-snapshot")
      })
    ]);
  return Object.freeze({
    heldLease: heldLease.lease,
    heldLeaseSha256: heldLease.leaseIdentity.sha256,
    sourceSnapshot: sourceSnapshot.snapshot,
    sourceSnapshotSha256: sourceSnapshot.file.sha256,
    storeSeal: storeSeal.receipt,
    storeSealSha256: storeSeal.receiptIdentity.sha256,
    targetSnapshot: targetSnapshot.snapshot,
    targetSnapshotSha256: targetSnapshot.file.sha256
  });
}

function readDiscovery(options, prefix) {
  return readElectronProductionPublicationRecoveryOutcomeDiscovery({
    expectedSha256: requiredOption(options, `${prefix}-sha256`),
    receiptPath: requiredOption(options, prefix)
  });
}

async function materializeLatestOutcome(
  directory,
  expected,
  source,
  rereadLatestFile
) {
  if (expected === null) {
    throw new Error("A latest outcome source requires a chain head identity.");
  }
  if (
    source.length !== expected.bytes ||
    sha256(source) !== expected.sha256
  ) throw new Error("The latest recovery outcome source identity does not match.");
  const outputPath = path.join(directory, expected.fileName);
  let handle = null;
  let identity = null;
  try {
    handle = await open(outputPath, "wx", 0o600);
    const opened = await handle.stat({ bigint: true });
    identity = { dev: opened.dev, ino: opened.ino };
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = null;
    const reread = await rereadLatestFile(
      outputPath,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES,
      "latest publication recovery outcome"
    );
    if (reread.bytes !== expected.bytes || reread.sha256 !== expected.sha256) {
      throw new Error("The latest recovery outcome changed after materialization.");
    }
    const current = await lstat(outputPath, { bigint: true });
    if (
      current.dev !== identity.dev || current.ino !== identity.ino ||
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
    ) {
      throw new Error("The latest recovery outcome inode changed after materialization.");
    }
    return Object.freeze({
      path: outputPath,
      identity,
      publicIdentity: publicIdentity(outputPath, reread)
    });
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (identity !== null) await unlinkIfIdentityMatches(outputPath, identity);
    throw error;
  }
}

async function requiredEmptyRealDirectory(value) {
  const requested = requiredAbsolutePath(
    value,
    "latest recovery outcome output directory"
  );
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The latest recovery outcome root must be a real directory.");
  }
  const canonical = await realpath(requested);
  if ((await readdir(canonical)).length !== 0) {
    throw new Error("The latest recovery outcome root must be empty.");
  }
  return canonical;
}

async function unlinkIfIdentityMatches(filePath, identity) {
  try {
    const current = await lstat(filePath, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function summaryFor(command, proofIdentity, latestOutcome, value) {
  return deepFreeze({
    schemaVersion: 1,
    kind: CLI_SUMMARY_KIND,
    command,
    status: command === "discover" ? "materialized" : "verified",
    output: proofIdentity,
    latestOutcome,
    transactionId: value.transactionId,
    target: value.target,
    currentObservation: value.currentObservation,
    outcomeDirectory: value.outcomeDirectory,
    terminal: command === "discover" ? null : value.terminal
  });
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every recovery outcome discovery option requires one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const raw = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!raw?.startsWith("--") || raw.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid recovery outcome discovery option near ${raw ?? "<end>"}.`);
    }
    const name = raw.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate recovery outcome discovery option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown recovery outcome discovery option --${name}.`);
    }
  }
  for (const name of allowed) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredPrivateVisibility(options) {
  const visibility = requiredOption(options, "repository-visibility");
  if (visibility !== "private") {
    throw new Error("Recovery outcome discovery requires a private repository.");
  }
  return "private";
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (
    typeof token !== "string" || token.length === 0 || token.length > 4096 ||
    /\s/u.test(token)
  ) throw new Error("GH_TOKEN is required for recovery outcome discovery.");
  return token;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery outcome discovery CLI dependencies are invalid.");
  }
  const allowed = new Set([
    "discoverRemote",
    "environment",
    "fetchImpl",
    "rereadLatestFile",
    "writeStdout"
  ]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown recovery outcome discovery dependency ${name}.`);
    }
  }
  const dependencies = {
    discoverRemote: overrides.discoverRemote ??
      discoverElectronProductionPublicationRecoveryOutcomes,
    environment: overrides.environment ?? process.env,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    rereadLatestFile: overrides.rereadLatestFile ?? readStableFile,
    writeStdout: overrides.writeStdout ??
      ((source) => process.stdout.write(source))
  };
  if (
    typeof dependencies.discoverRemote !== "function" ||
    !dependencies.environment || typeof dependencies.environment !== "object" ||
    typeof dependencies.fetchImpl !== "function" ||
    typeof dependencies.rereadLatestFile !== "function" ||
    typeof dependencies.writeStdout !== "function"
  ) throw new Error("Recovery outcome discovery CLI dependencies are invalid.");
  return Object.freeze(dependencies);
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
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
  runElectronProductionPublicationRecoveryOutcomeDiscoveryCli().catch(() => {
    process.stderr.write(
      "Electron production recovery outcome discovery failed closed.\n"
    );
    process.exitCode = 1;
  });
}
