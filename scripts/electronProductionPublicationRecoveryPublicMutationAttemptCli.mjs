import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  readElectronProductionPublicationRecoveryLeaseReleaseAuthorization
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE,
  createElectronProductionPublicationRecoveryPublicMutationAttempt,
  createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  readElectronProductionPublicationRecoveryPublicMutationAttempt,
  readElectronProductionPublicationRecoveryPublicMutationAttemptHistory,
  writeElectronProductionPublicationRecoveryPublicMutationAttempt,
  writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  writeElectronProductionPublicationRecoveryPublicMutationAttemptHistory
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  proveElectronProductionPublicationRecoveryPublicMutationAttemptHistory
} from "./electronProductionPublicationRecoveryPublicMutationAttemptRemote.mjs";
import {
  createElectronProductionRecoveryStoreRemoteReadRequest,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  readElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  assertExactKeys,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_CLI_SUMMARY_KIND =
  "rion-electron-production-publication-recovery-public-mutation-attempt-cli-summary";

const COMMAND_OPTIONS = Object.freeze({
  "materialize-attempt": new Set([
    "authorization",
    "authorization-sha256",
    "operation",
    "output",
    "public-observation",
    "public-observation-sha256",
    "reserved-at",
    "source-snapshot",
    "source-snapshot-sha256",
    "target-snapshot",
    "target-snapshot-sha256"
  ]),
  "prove-existing-attempt-history": new Set([
    "attempt",
    "attempt-read-operation",
    "attempt-read-operation-sha256",
    "attempt-sha256",
    "observed-at",
    "output"
  ]),
  "authorize-attempt": new Set([
    "attempt",
    "attempt-history-proof",
    "attempt-history-proof-sha256",
    "attempt-read-operation",
    "attempt-read-operation-sha256",
    "attempt-sha256",
    "create-operation",
    "create-operation-sha256",
    "output",
    "post-marker-authorization",
    "post-marker-authorization-sha256",
    "pre-marker-authorization",
    "pre-marker-authorization-sha256",
    "verified-at"
  ])
});

export async function runElectronProductionPublicationRecoveryPublicMutationAttemptCli(
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
      "Usage: electronProductionPublicationRecoveryPublicMutationAttemptCli.mjs " +
      "<materialize-attempt|prove-existing-attempt-history|authorize-attempt> " +
      "[options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(command, options);
  const result = command === "materialize-attempt"
    ? await materializeAttempt(options)
    : command === "prove-existing-attempt-history"
      ? await proveExistingAttemptHistory(options, dependencies)
      : await authorizeAttempt(options);
  const summary = Object.freeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_CLI_SUMMARY_KIND,
    command,
    status: "created",
    transactionId: result.transactionId,
    operation: result.operation,
    artifact: result.artifact
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function materializeAttempt(options) {
  const [authorizationFile, observationFile, sourceFile, targetFile] =
    await Promise.all([
      readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        receiptPath: requiredOption(options, "authorization"),
        expectedSha256: requiredOption(options, "authorization-sha256")
      }),
      readElectronProductionPublicLatestRecoveryObservation({
        receiptPath: requiredOption(options, "public-observation"),
        expectedSha256: requiredOption(options, "public-observation-sha256")
      }),
      readElectronProductionPublicLatestSnapshot({
        snapshotPath: requiredOption(options, "source-snapshot"),
        expectedFileSha256: requiredOption(options, "source-snapshot-sha256")
      }),
      readElectronProductionPublicLatestSnapshot({
        snapshotPath: requiredOption(options, "target-snapshot"),
        expectedFileSha256: requiredOption(options, "target-snapshot-sha256")
      })
    ]);
  const operation = requiredOperation(options);
  const attempt =
    createElectronProductionPublicationRecoveryPublicMutationAttempt({
      authorization: authorizationFile.value,
      authorizationSha256: authorizationFile.valueIdentity.sha256,
      operation,
      publicObservation: observationFile.receipt,
      publicObservationSha256: observationFile.receiptIdentity.sha256,
      reservedAt: requiredOption(options, "reserved-at"),
      sourceSnapshot: sourceFile.snapshot,
      targetSnapshot: targetFile.snapshot
    });
  const written =
    await writeElectronProductionPublicationRecoveryPublicMutationAttempt({
      outputPath: requiredOption(options, "output"),
      value: attempt
    });
  return {
    transactionId: attempt.transactionId,
    operation,
    artifact: written.valueIdentity
  };
}

async function proveExistingAttemptHistory(options, dependencies) {
  const outputPath = requiredOption(options, "output");
  await resolveCreateNewFile(
    outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE,
    "publication recovery public-mutation history output"
  );
  const [attemptFile, readFile] = await Promise.all([
    readElectronProductionPublicationRecoveryPublicMutationAttempt({
      receiptPath: requiredOption(options, "attempt"),
      expectedSha256: requiredOption(options, "attempt-sha256")
    }),
    readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: requiredOption(options, "attempt-read-operation"),
      expectedSha256: requiredOption(
        options,
        "attempt-read-operation-sha256"
      )
    })
  ]);
  const attempt = attemptFile.value;
  const target = remoteTarget(attempt.privateStore.target, attempt.privateStore.path);
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
    receipt: readFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: {
        byteLength: attemptFile.valueIdentity.bytes,
        sha256: attemptFile.valueIdentity.sha256
      },
      target
    })
  });
  if (readFile.receipt.terminal.classification !== "present" ||
      readFile.receipt.observed === null) {
    throw new Error("The durable public-mutation marker is not present.");
  }
  const observed = readFile.receipt.observed;
  const history =
    await proveElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
      fetchImpl: dependencies.fetchImpl,
      token: requiredToken(dependencies.readToken()),
      target,
      initialHeadCommitSha: attempt.privateStore.expectedHeadCommitSha,
      attemptBlobSha: observed.blobSha,
      currentObservation: {
        headCommitSha: observed.headCommitSha,
        treeSha: observed.treeSha,
        parentCommitShas: observed.parentCommitShas
      },
      observedAt: requiredOption(options, "observed-at")
    });
  const written =
    await writeElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
      outputPath,
      value: history
    });
  return {
    transactionId: attempt.transactionId,
    operation: attempt.operation,
    artifact: written.valueIdentity
  };
}

async function authorizeAttempt(options) {
  const outputPath = requiredOption(options, "output");
  await resolveCreateNewFile(
    outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE,
    "publication recovery public-mutation authorization output"
  );
  const [attemptFile, attemptReadFile, postAuthorizationFile] =
    await Promise.all([
      readElectronProductionPublicationRecoveryPublicMutationAttempt({
        receiptPath: requiredOption(options, "attempt"),
        expectedSha256: requiredOption(options, "attempt-sha256")
      }),
      readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
        receiptPath: requiredOption(options, "attempt-read-operation"),
        expectedSha256: requiredOption(
          options,
          "attempt-read-operation-sha256"
        )
      }),
      readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        receiptPath: requiredOption(options, "post-marker-authorization"),
        expectedSha256: requiredOption(
          options,
          "post-marker-authorization-sha256"
        )
      })
    ]);
  const createPair = optionalPair(
    options,
    "create-operation",
    "create-operation-sha256"
  );
  const historyPair = optionalPair(
    options,
    "attempt-history-proof",
    "attempt-history-proof-sha256"
  );
  const preAuthorizationPair = optionalPair(
    options,
    "pre-marker-authorization",
    "pre-marker-authorization-sha256"
  );
  if ((createPair === null) === (historyPair === null)) {
    throw new Error(
      "Authorize-attempt requires exactly one create operation or history proof."
    );
  }
  if ((createPair === null) !== (preAuthorizationPair === null)) {
    throw new Error(
      "Only a newly-created marker requires its pre-marker authorization."
    );
  }
  const [createFile, historyFile, preAuthorizationFile] = await Promise.all([
    createPair === null
      ? null
      : readElectronProductionRecoveryStoreRemoteOperationReceipt({
          receiptPath: createPair.path,
          expectedSha256: createPair.sha256
        }),
    historyPair === null
      ? null
      : readElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
          receiptPath: historyPair.path,
          expectedSha256: historyPair.sha256
        }),
    preAuthorizationPair === null
      ? null
      : readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
          receiptPath: preAuthorizationPair.path,
          expectedSha256: preAuthorizationPair.sha256
        })
  ]);
  const authorization =
    createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      attempt: attemptFile.value,
      attemptSha256: attemptFile.valueIdentity.sha256,
      preMarkerAuthorization: preAuthorizationFile?.value ?? null,
      preMarkerAuthorizationSha256:
        preAuthorizationFile?.valueIdentity.sha256 ?? null,
      createOperation: createFile?.receipt ?? null,
      createOperationSha256: createFile?.receiptIdentity.sha256 ?? null,
      attemptHistoryProof: historyFile?.value ?? null,
      attemptHistoryProofSha256: historyFile?.valueIdentity.sha256 ?? null,
      attemptReadOperation: attemptReadFile.receipt,
      attemptReadOperationSha256: attemptReadFile.receiptIdentity.sha256,
      postMarkerAuthorization: postAuthorizationFile.value,
      postMarkerAuthorizationSha256:
        postAuthorizationFile.valueIdentity.sha256,
      verifiedAt: requiredOption(options, "verified-at")
    });
  const written =
    await writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      outputPath,
      value: authorization
    });
  return {
    transactionId: authorization.transactionId,
    operation: authorization.operation,
    artifact: written.valueIdentity
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every public-mutation marker option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid public-mutation marker option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty public-mutation marker option --${key}.`);
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

function requiredOperation(options) {
  const value = requiredOption(options, "operation");
  if (value !== "rollback-public-latest" && value !== "release-held-lease") {
    throw new Error("--operation must select rollback-public-latest or release-held-lease.");
  }
  return value;
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
    throw new Error("A bounded GH_TOKEN is required for marker history proof.");
  }
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Public-mutation marker CLI dependencies are invalid.");
  }
  const allowed = ["fetchImpl", "readToken", "writeStdout"];
  assertExactKeys(overrides,
    allowed.filter((name) => Object.hasOwn(overrides, name)),
    "public-mutation marker CLI dependencies");
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const readToken = overrides.readToken ?? (() => process.env.GH_TOKEN ?? "");
  if (typeof writeStdout !== "function" || typeof fetchImpl !== "function" ||
      typeof readToken !== "function") {
    throw new Error("Public-mutation marker CLI dependencies are invalid.");
  }
  return Object.freeze({ writeStdout, fetchImpl, readToken });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionPublicationRecoveryPublicMutationAttemptCli().catch(
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
