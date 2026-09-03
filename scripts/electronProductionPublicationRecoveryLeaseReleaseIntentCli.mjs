import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE,
  createElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  createElectronProductionPublicationRecoveryLeaseReleaseIntent,
  readElectronProductionPublicationRecoveryLeaseReleaseIntent,
  readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory,
  writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  writeElectronProductionPublicationRecoveryLeaseReleaseIntent,
  writeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
} from "./electronProductionPublicationRecoveryLeaseReleaseIntentRemote.mjs";
import {
  readElectronProductionPublicationRecoveryOutcomeChainProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  readElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionRecoveryStoreRemoteReadRequest,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  readElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  runElectronProductionRecoveryStoreReadbackFoundationCli
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";
import {
  assertExactKeys,
  requiredPositiveInteger,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_CLI_SUMMARY_KIND =
  "rion-electron-production-publication-recovery-lease-release-intent-cli-summary";

const COMMON_FOUNDATION_OPTIONS = [
  "capsule",
  "capsule-read-operation",
  "capsule-read-operation-sha256",
  "owner",
  "ref",
  "repo",
  "seal-read-operation",
  "seal-read-operation-sha256",
  "store-seal"
];
const COMMAND_OPTIONS = Object.freeze({
  "materialize-intent": new Set([
    "authorized-at",
    "chain-proof",
    "chain-proof-sha256",
    "control-sha",
    "held-lease",
    "held-lease-sha256",
    "output",
    "run-attempt",
    "run-id",
    "run-repository",
    "run-started-at",
    "run-workflow",
    "store-seal",
    "store-seal-sha256"
  ]),
  "prove-existing-intent-history": new Set([
    "intent",
    "intent-read-operation",
    "intent-read-operation-sha256",
    "intent-sha256",
    "observed-at",
    "output"
  ]),
  "authorize": new Set([
    ...COMMON_FOUNDATION_OPTIONS,
    "current-control-sha",
    "current-run-attempt",
    "current-run-id",
    "current-run-repository",
    "current-run-started-at",
    "current-run-workflow",
    "create-operation",
    "create-operation-sha256",
    "fresh-chain-proof",
    "fresh-chain-proof-sha256",
    "intent",
    "intent-history-proof",
    "intent-history-proof-sha256",
    "intent-read-operation",
    "intent-read-operation-sha256",
    "intent-sha256",
    "output",
    "verified-at"
  ])
});

export async function runElectronProductionPublicationRecoveryLeaseReleaseIntentCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs " +
      "<materialize-intent|prove-existing-intent-history|authorize> [options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const result = command === "materialize-intent"
    ? await materializeIntent(options)
    : command === "prove-existing-intent-history"
      ? await proveExistingIntentHistory(options, dependencies)
      : await authorize(options, dependencies);
  const summary = Object.freeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_CLI_SUMMARY_KIND,
    command,
    status: "created",
    transactionId: result.transactionId,
    artifact: result.artifact
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function materializeIntent(options) {
  const [heldFile, sealFile, chainFile] = await Promise.all([
    readElectronProductionPublicLatestLease({
      leasePath: requiredOption(options, "held-lease"),
      expectedSha256: requiredOption(options, "held-lease-sha256")
    }),
    readElectronProductionPublicationRecoveryStoreSeal({
      receiptPath: requiredOption(options, "store-seal"),
      expectedSha256: requiredOption(options, "store-seal-sha256")
    }),
    readElectronProductionPublicationRecoveryOutcomeChainProof({
      receiptPath: requiredOption(options, "chain-proof"),
      expectedSha256: requiredOption(options, "chain-proof-sha256")
    })
  ]);
  const intent = createElectronProductionPublicationRecoveryLeaseReleaseIntent({
    heldLease: heldFile.lease,
    heldLeaseSha256: heldFile.leaseIdentity.sha256,
    storeSeal: sealFile.receipt,
    storeSealSha256: sealFile.receiptIdentity.sha256,
    chainProof: chainFile.value,
    chainProofSha256: chainFile.valueIdentity.sha256,
    recoveryRun: {
      repository: requiredOption(options, "run-repository"),
      workflow: requiredOption(options, "run-workflow"),
      runId: requiredOption(options, "run-id"),
      runAttempt: parsePositiveInteger(options, "run-attempt"),
      controlSha: requiredOption(options, "control-sha"),
      startedAt: requiredOption(options, "run-started-at")
    },
    authorizedAt: requiredOption(options, "authorized-at")
  });
  const written =
    await writeElectronProductionPublicationRecoveryLeaseReleaseIntent({
      outputPath: requiredOption(options, "output"),
      value: intent
    });
  return {
    transactionId: intent.transactionId,
    artifact: written.valueIdentity
  };
}

async function proveExistingIntentHistory(options, dependencies) {
  const outputPath = requiredOption(options, "output");
  await resolveCreateNewFile(
    outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE,
    "publication recovery intent-history output"
  );
  const [intentFile, readFile] = await Promise.all([
    readElectronProductionPublicationRecoveryLeaseReleaseIntent({
      receiptPath: requiredOption(options, "intent"),
      expectedSha256: requiredOption(options, "intent-sha256")
    }),
    readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: requiredOption(options, "intent-read-operation"),
      expectedSha256: requiredOption(
        options,
        "intent-read-operation-sha256"
      )
    })
  ]);
  const intent = intentFile.value;
  const target = remoteTarget(intent.privateStore.target, intent.privateStore.path);
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
    receipt: readFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: {
        byteLength: intentFile.valueIdentity.bytes,
        sha256: intentFile.valueIdentity.sha256
      },
      target
    })
  });
  if (readFile.receipt.terminal.classification !== "present" ||
      readFile.receipt.observed === null) {
    throw new Error("The fixed durable intent is not present at the reader head.");
  }
  const observed = readFile.receipt.observed;
  const history =
    await proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
      fetchImpl: dependencies.fetchImpl,
      token: requiredToken(dependencies.readToken()),
      target,
      initialHeadCommitSha: intent.privateStore.expectedHeadCommitSha,
      intentBlobSha: observed.blobSha,
      currentObservation: {
        headCommitSha: observed.headCommitSha,
        treeSha: observed.treeSha,
        parentCommitShas: observed.parentCommitShas
      },
      observedAt: requiredOption(options, "observed-at")
    });
  const written =
    await writeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
      outputPath,
      value: history
    });
  return {
    transactionId: intent.transactionId,
    artifact: written.valueIdentity
  };
}

async function authorize(options, dependencies) {
  const outputPath = requiredOption(options, "output");
  await resolveCreateNewFile(
    outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
    "publication recovery lease-release authorization output"
  );
  const [intentFile, intentReadFile, chainFile] = await Promise.all([
    readElectronProductionPublicationRecoveryLeaseReleaseIntent({
      receiptPath: requiredOption(options, "intent"),
      expectedSha256: requiredOption(options, "intent-sha256")
    }),
    readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: requiredOption(options, "intent-read-operation"),
      expectedSha256: requiredOption(
        options,
        "intent-read-operation-sha256"
      )
    }),
    readElectronProductionPublicationRecoveryOutcomeChainProof({
      receiptPath: requiredOption(options, "fresh-chain-proof"),
      expectedSha256: requiredOption(options, "fresh-chain-proof-sha256")
    })
  ]);
  const createPair = optionalPair(
    options,
    "create-operation",
    "create-operation-sha256"
  );
  const historyPair = optionalPair(
    options,
    "intent-history-proof",
    "intent-history-proof-sha256"
  );
  if ((createPair === null) === (historyPair === null)) {
    throw new Error(
      "Authorize requires exactly one create-operation or intent-history proof."
    );
  }
  const createFile = createPair === null
    ? null
    : await readElectronProductionRecoveryStoreRemoteOperationReceipt({
        receiptPath: createPair.path,
        expectedSha256: createPair.sha256
      });
  const historyFile = historyPair === null
    ? null
    : await readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
        receiptPath: historyPair.path,
        expectedSha256: historyPair.sha256
      });
  const foundationReadback =
    await runElectronProductionRecoveryStoreReadbackFoundationCli([
      "verify-readback-foundation",
      "--transaction-id", intentFile.value.transactionId,
      "--owner", requiredOption(options, "owner"),
      "--repo", requiredOption(options, "repo"),
      "--ref", requiredOption(options, "ref"),
      "--capsule", requiredOption(options, "capsule"),
      "--capsule-read-operation",
      requiredOption(options, "capsule-read-operation"),
      "--capsule-read-operation-sha256",
      requiredOption(options, "capsule-read-operation-sha256"),
      "--store-seal", requiredOption(options, "store-seal"),
      "--seal-read-operation", requiredOption(options, "seal-read-operation"),
      "--seal-read-operation-sha256",
      requiredOption(options, "seal-read-operation-sha256")
    ], { writeStdout: dependencies.ignoreStdout });
  const authorization =
    createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      intent: intentFile.value,
      intentSha256: intentFile.valueIdentity.sha256,
      currentRun: {
        repository: requiredOption(options, "current-run-repository"),
        workflow: requiredOption(options, "current-run-workflow"),
        runId: requiredOption(options, "current-run-id"),
        runAttempt: parsePositiveInteger(options, "current-run-attempt"),
        controlSha: requiredOption(options, "current-control-sha"),
        startedAt: requiredOption(options, "current-run-started-at")
      },
      createOperation: createFile?.receipt ?? null,
      createOperationSha256: createFile?.receiptIdentity.sha256 ?? null,
      intentHistoryProof: historyFile?.value ?? null,
      intentHistoryProofSha256: historyFile?.valueIdentity.sha256 ?? null,
      intentReadOperation: intentReadFile.receipt,
      intentReadOperationSha256: intentReadFile.receiptIdentity.sha256,
      freshChainProof: chainFile.value,
      freshChainProofSha256: chainFile.valueIdentity.sha256,
      foundationReadback,
      verifiedAt: requiredOption(options, "verified-at")
    });
  const written =
    await writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      outputPath,
      value: authorization
    });
  return {
    transactionId: authorization.transactionId,
    artifact: written.valueIdentity
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every lease-release intent option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid lease-release intent option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty lease-release intent option --${key}.`);
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

function parsePositiveInteger(options, name) {
  const source = requiredOption(options, name);
  if (!/^[1-9][0-9]*$/u.test(source)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return requiredPositiveInteger(Number(source), `--${name}`);
}

function optionalPair(options, pathName, digestName) {
  const filePath = options.get(pathName)?.trim() ?? null;
  const sha256 = options.get(digestName)?.trim() ?? null;
  if ((filePath === null) !== (sha256 === null)) {
    throw new Error(`--${pathName} and --${digestName} must be supplied together.`);
  }
  return filePath === null ? null : { path: filePath, sha256 };
}

function remoteTarget(target, filePath) {
  const [owner, repo, extra] = target.repository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error("The private recovery repository slug is invalid.");
  }
  return {
    owner,
    repo,
    ref: target.ref,
    path: filePath,
    repositoryPolicy: target.repositoryPolicy
  };
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      /\s/u.test(value)) {
    throw new Error("A bounded GH_TOKEN is required for intent-history proof.");
  }
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Lease-release intent CLI dependencies are invalid.");
  }
  const allowed = ["fetchImpl", "readToken", "writeStdout"];
  assertExactKeys(overrides,
    allowed.filter((name) => Object.hasOwn(overrides, name)),
    "lease-release intent CLI dependencies");
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const readToken = overrides.readToken ?? (() => process.env.GH_TOKEN ?? "");
  if (typeof writeStdout !== "function" || typeof fetchImpl !== "function" ||
      typeof readToken !== "function") {
    throw new Error("Lease-release intent CLI dependencies are invalid.");
  }
  return Object.freeze({
    writeStdout,
    fetchImpl,
    readToken,
    ignoreStdout: async () => {}
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionPublicationRecoveryLeaseReleaseIntentCli().catch(
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
