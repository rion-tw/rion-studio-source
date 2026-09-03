import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  writeElectronProductionPublicationRecoveryOutcomeAttempt
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  verifyElectronProductionPublicationRecoveryOutcomeChain,
  writeElectronProductionPublicationRecoveryOutcomeChainProof
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND,
  ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND,
  runElectronProductionRecoveryStoreOutcomeCreateChainCli
} from "../scripts/electronProductionRecoveryStoreOutcomeCreateChainCli.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
  createElectronProductionRecoveryStoreAtomicPairOperationReceipt,
  createElectronProductionRecoveryStoreAtomicPairRequest,
  writeElectronProductionRecoveryStoreAtomicPairOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteRequest,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreOutcomePaths
} from "../scripts/electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  createOutcomeDiscoveryFixture
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";
import {
  RECOVERY_FIXTURE_TRANSACTION_ID
} from "./support/electronProductionPublicLatestRecoveryFixture";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const OWNER = "alternate-owner";
const REPO = "recovery-vault";
const REF = "recovery-capsules";
const EXPECTED_HEAD = "a".repeat(40);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const PROOF_SHA256 = "e".repeat(64);
const SECRET_TOKEN = "ghp_outcome_chain_must_not_appear";
const RECOVERY_RUN = Object.freeze({
  repository: "rion-tw/rion-studio-source",
  workflow: ".github/workflows/electron-production-provisional-recovery.yml",
  runId: "9001",
  runAttempt: 3,
  controlSha: "1".repeat(40),
  startedAt: "2026-09-01T00:03:00Z"
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery-store outcome create-chain CLI", () => {
  it("binds a real canonical outcome to a real parsed empty-chain proof", async () => {
    const fixture = await createRealCanonicalFixture();
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        fixture.arguments,
        { writeStdout: () => undefined }
      );

    expect(summary).toMatchObject({
      transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
      previousOutcomeSha256: null,
      appendFoundation: {
        proofSha256: fixture.proofSha256,
        currentObservation: { headCommitSha: fixture.expectedHeadSha },
        predecessor: null
      },
      operation: {
        mode: "single-attempt-create",
        applied: { parentCommitSha: fixture.expectedHeadSha }
      }
    });
  });

  it("verifies one append-only nonterminal attempt from the expected store head", async () => {
    const fixture = await createFixture({ terminal: false });
    const outputs: Buffer[] = [];
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        argumentsFor(fixture),
        {
          ...fixture.readers,
          writeStdout: (source) => {
            outputs.push(Buffer.from(source));
          }
        }
      );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND,
      status: "verified",
      transactionId: TRANSACTION_ID,
      paths: { attempt: fixture.paths.attemptPath, terminal: null },
      previousOutcomeSha256: null,
      appendFoundation: {
        proofSha256: PROOF_SHA256,
        currentObservation: {
          headCommitSha: EXPECTED_HEAD
        },
        predecessor: null
      },
      attempt: {
        file: {
          fileName: path.basename(fixture.attemptPath),
          byteLength: fixture.source.length,
          sha256: fixture.sha256
        }
      },
      terminal: null,
      operation: {
        mode: "single-attempt-create",
        operationReceiptSha256: fixture.operationSha256,
        applied: {
          parentCommitSha: EXPECTED_HEAD,
          commitSha: COMMIT,
          treeSha: TREE,
          blobSha: gitBlobSha(fixture.source)
        }
      }
    });
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    expect(outputs[0]!.toString("utf8")).not.toContain(fixture.root);
    expect(outputs[0]!.toString("utf8")).not.toContain(
      fixture.source.toString("base64")
    );
  });

  it("preflights an exact append foundation without operation or credentials", async () => {
    const fixture = await createFixture({ terminal: false });
    const outputs: Buffer[] = [];
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        appendArgumentsFor(fixture),
        {
          ...fixture.readers,
          writeStdout: (source) => {
            outputs.push(Buffer.from(source));
          }
        }
      );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND,
      status: "verified",
      transactionId: TRANSACTION_ID,
      paths: { attempt: fixture.paths.attemptPath, terminal: null },
      previousOutcomeSha256: null,
      appendFoundation: {
        proofSha256: PROOF_SHA256,
        currentObservation: { headCommitSha: EXPECTED_HEAD },
        predecessor: null
      },
      attempt: {
        file: {
          fileName: path.basename(fixture.attemptPath),
          byteLength: fixture.source.length,
          sha256: fixture.sha256
        }
      },
      terminal: null
    });
    expect(summary).not.toHaveProperty("operation");
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    expect(outputs[0]!.toString("utf8")).not.toContain(SECRET_TOKEN);
  });

  it("preflights byte-identical terminal pair paths without remote mutation", async () => {
    const fixture = await createFixture({ terminal: true });
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        appendArgumentsFor(fixture),
        { ...fixture.readers, writeStdout: () => undefined }
      );

    expect(summary.kind).toBe(
      ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND
    );
    expect(summary.paths).toEqual({
      attempt: fixture.paths.attemptPath,
      terminal: fixture.paths.terminalPath
    });
    expect(summary.terminal?.file).toEqual({
      fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
      byteLength: fixture.source.length,
      sha256: fixture.sha256
    });
  });

  it("preflight rejects stale, forked, gapped, terminal, and tampered input", async () => {
    const stale = await createFixture({ terminal: false });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      replaceOption(
        appendArgumentsFor(stale),
        "expected-head-sha",
        "f".repeat(40)
      ),
      { ...stale.readers, writeStdout: () => undefined }
    )).rejects.toThrow("append expected head does not match");

    const fork = await createFixture({
      proofLatestSha256: "8".repeat(64),
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      appendArgumentsFor(fork),
      { ...fork.readers, writeStdout: () => undefined }
    )).rejects.toThrow("append predecessor SHA-256 does not match");

    const gap = await createFixture({
      attemptPreviousSha256: "9".repeat(64),
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      appendArgumentsFor(gap),
      { ...gap.readers, writeStdout: () => undefined }
    )).rejects.toThrow("append predecessor SHA-256 does not match");

    const terminal = await createFixture({
      proofTerminal: true,
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      appendArgumentsFor(terminal),
      { ...terminal.readers, writeStdout: () => undefined }
    )).rejects.toThrow("terminal recovery outcome chain cannot be appended");

    const tampered = await createFixture({ terminal: false });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      replaceOption(
        appendArgumentsFor(tampered),
        "attempt-outcome-sha256",
        "f".repeat(64)
      ),
      { ...tampered.readers, writeStdout: () => undefined }
    )).rejects.toThrow("SHA-256 does not match");

    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli([
      ...appendArgumentsFor(stale),
      "--token", SECRET_TOKEN
    ])).rejects.toThrow(
      "Unknown verify-outcome-append-foundation option --token"
    );
  });

  it("verifies terminal attempt and fixed terminal as one atomic pair commit", async () => {
    const fixture = await createFixture({ terminal: true });
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        argumentsFor(fixture),
        { ...fixture.readers, writeStdout: () => undefined }
      );

    expect(summary.paths).toEqual({
      attempt: fixture.paths.attemptPath,
      terminal: fixture.paths.terminalPath
    });
    expect(summary.terminal?.file).toEqual({
      fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
      byteLength: fixture.source.length,
      sha256: fixture.sha256
    });
    if (summary.kind !==
        ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND) {
      throw new Error("Expected a create-chain verification summary.");
    }
    expect(summary.operation).toMatchObject({
      mode: "atomic-terminal-pair-create",
      operationReceiptSha256: fixture.operationSha256,
      applied: {
        parentCommitSha: EXPECTED_HEAD,
        commitSha: COMMIT,
        treeSha: TREE,
        blobSha: gitBlobSha(fixture.source),
        paths: [fixture.paths.attemptPath, fixture.paths.terminalPath]
      }
    });
  });

  it("accepts only the exact durable chain head as a non-null predecessor", async () => {
    const predecessor = "8".repeat(64);
    const fixture = await createFixture({
      attemptPreviousSha256: predecessor,
      proofLatestSha256: predecessor,
      terminal: false
    });
    const summary =
      await runElectronProductionRecoveryStoreOutcomeCreateChainCli(
        argumentsFor(fixture),
        { ...fixture.readers, writeStdout: () => undefined }
      );

    expect(summary.previousOutcomeSha256).toBe(predecessor);
    expect(summary.appendFoundation.predecessor?.sha256).toBe(predecessor);
  });

  it("rejects a stale proof head, path, blob, and partial terminal evidence", async () => {
    const wrongHead = await createFixture({ terminal: false });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      replaceOption(argumentsFor(wrongHead), "expected-head-sha", "f".repeat(40)),
      { ...wrongHead.readers, writeStdout: () => undefined }
    )).rejects.toThrow("append expected head does not match");

    const wrongPath = await createFixture({
      targetPaths: [
        `transactions/${TRANSACTION_ID}/foreign/` +
          path.basename(electronProductionPublicationRecoveryOutcomeAttemptFileName(
            RECOVERY_RUN
          ))
      ],
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(wrongPath),
      { ...wrongPath.readers, writeStdout: () => undefined }
    )).rejects.toThrow("request identity does not match");

    const wrongBlob = await createFixture({
      blobSha: "f".repeat(40),
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(wrongBlob),
      { ...wrongBlob.readers, writeStdout: () => undefined }
    )).rejects.toThrow("applied blob SHA does not match");

    const terminal = await createFixture({ terminal: true });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(terminal).slice(0, -2),
      { ...terminal.readers, writeStdout: () => undefined }
    )).rejects.toThrow("requires complete terminal evidence");
  });

  it("rejects terminal evidence for an open attempt and exposes no token option", async () => {
    const fixture = await createFixture({ terminal: false });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli([
      ...argumentsFor(fixture),
      "--terminal-outcome", fixture.attemptPath,
      "--terminal-outcome-sha256", fixture.sha256
    ], {
      ...fixture.readers,
      writeStdout: () => undefined
    })).rejects.toThrow("nonterminal recovery outcome attempt cannot have terminal");
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli([
      ...argumentsFor(fixture),
      "--token", SECRET_TOKEN
    ])).rejects.toThrow("Unknown verify-outcome-create-chain option --token");
  });

  it("rejects a forked predecessor, foreign foundation, and terminal chain", async () => {
    const fork = await createFixture({
      proofLatestSha256: "8".repeat(64),
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(fork),
      { ...fork.readers, writeStdout: () => undefined }
    )).rejects.toThrow("append predecessor SHA-256 does not match");

    const foreignFoundation = await createFixture({
      proofStoreSealSha256: "9".repeat(64),
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(foreignFoundation),
      { ...foreignFoundation.readers, writeStdout: () => undefined }
    )).rejects.toThrow("foundation storeSealSha256 does not match");

    const terminalChain = await createFixture({
      proofTerminal: true,
      terminal: false
    });
    await expect(runElectronProductionRecoveryStoreOutcomeCreateChainCli(
      argumentsFor(terminalChain),
      { ...terminalChain.readers, writeStdout: () => undefined }
    )).rejects.toThrow("terminal recovery outcome chain cannot be appended");
  });
});

async function createRealCanonicalFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-real-outcome-chain-cli-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const discovery = fixture.discovery([], {
    status: "outcome-directory-absent"
  });
  const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...fixture.foundation,
    discovery,
    discoverySha256:
      electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
  });
  const proofFile =
    await writeElectronProductionPublicationRecoveryOutcomeChainProof({
      outputPath: path.join(
        root,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      ),
      value: proof
    });
  const outcome = fixture.createOutcome({
    determinedAt: "2026-09-01T00:05:00Z",
    previousOutcomeSha256: null,
    runAttempt: 1,
    runId: "9901",
    startedAt: "2026-09-01T00:04:00Z"
  });
  const attemptFile =
    await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: path.join(
        root,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          outcome.recoveryRun
        )
      ),
      receipt: outcome
    });
  const paths = electronProductionRecoveryStoreOutcomePaths({
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    recoveryRun: outcome.recoveryRun
  });
  const operationDirectory = path.join(root, "operation");
  await mkdir(operationDirectory, { mode: 0o700 });
  const operationPath = path.join(
    operationDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const operation =
    await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath: operationPath,
      receipt: createElectronProductionRecoveryStoreRemoteOperationReceipt({
        request: createElectronProductionRecoveryStoreRemoteRequest({
          expectedHeadSha: proof.currentObservation.headCommitSha,
          packageIdentity: {
            fileName: attemptFile.receiptIdentity.fileName,
            byteLength: attemptFile.receiptIdentity.bytes,
            sha256: attemptFile.receiptIdentity.sha256
          },
          target: {
            owner: "recovery-owner",
            repo: "recovery-vault",
            ref: "recovery-main",
            path: paths.attemptPath,
            repositoryPolicy: {
              defaultBranch: "recovery-main",
              visibility: "private"
            }
          }
        }),
        result: {
          outcome: "applied",
          blobSha: gitBlobSha(await readFile(attemptFile.receiptPath)),
          byteLength: attemptFile.receiptIdentity.bytes,
          commitSha: COMMIT,
          parentSha: proof.currentObservation.headCommitSha,
          treeSha: TREE
        }
      })
    });
  return {
    expectedHeadSha: proof.currentObservation.headCommitSha,
    proofSha256: proofFile.valueIdentity.sha256,
    arguments: [
      "verify-outcome-create-chain",
      "--transaction-id", RECOVERY_FIXTURE_TRANSACTION_ID,
      "--owner", "recovery-owner",
      "--repo", "recovery-vault",
      "--ref", "recovery-main",
      "--expected-head-sha", proof.currentObservation.headCommitSha,
      "--outcome-chain-proof", proofFile.valuePath,
      "--outcome-chain-proof-sha256", proofFile.valueIdentity.sha256,
      "--attempt-outcome", attemptFile.receiptPath,
      "--attempt-outcome-sha256", attemptFile.receiptIdentity.sha256,
      "--operation", operationPath,
      "--operation-sha256", operation.receiptIdentity.sha256
    ]
  };
}

interface Fixture {
  readonly attemptPath: string;
  readonly operationPath: string;
  readonly operationSha256: string;
  readonly paths: ReturnType<typeof electronProductionRecoveryStoreOutcomePaths>;
  readonly readers: {
    readonly readOutcome: (input: ReadInput) => Promise<never>;
    readonly readOutcomeAttempt: (input: ReadInput) => Promise<never>;
    readonly readAppendProof: () => Promise<never>;
  };
  readonly root: string;
  readonly sha256: string;
  readonly source: Buffer;
  readonly terminalPath: string | null;
}

interface ReadInput {
  readonly receiptPath: string;
  readonly expectedSha256: string;
}

async function createFixture(options: Readonly<{
  attemptPreviousSha256?: string;
  blobSha?: string;
  proofHeadSha?: string;
  proofLatestSha256?: string;
  proofStoreSealSha256?: string;
  proofTerminal?: boolean;
  targetPaths?: readonly string[];
  terminal: boolean;
}>): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "rion-outcome-chain-cli-"));
  temporaryDirectories.push(root);
  const paths = electronProductionRecoveryStoreOutcomePaths({
    transactionId: TRANSACTION_ID,
    recoveryRun: RECOVERY_RUN
  });
  const outcome = {
    transactionId: TRANSACTION_ID,
    recoveryRun: RECOVERY_RUN,
    previousOutcomeSha256: options.attemptPreviousSha256 ?? null,
    lease: {
      leaseId: "lease-id",
      generation: 7,
      eventSha256: "2".repeat(64)
    },
    source: {
      snapshotSha256: "3".repeat(64),
      stateSha256: "4".repeat(64)
    },
    target: {
      snapshotSha256: "5".repeat(64),
      stateSha256: "6".repeat(64)
    },
    durableStore: { sealSha256: "7".repeat(64) },
    outcome: { terminal: options.terminal }
  };
  const proof = {
    status: options.proofTerminal ? "terminal" : "empty",
    transactionId: TRANSACTION_ID,
    target: {
      repository: `${OWNER}/${REPO}`,
      ref: REF,
      repositoryPolicy: { defaultBranch: REF, visibility: "private" }
    },
    currentObservation: {
      headCommitSha: options.proofHeadSha ?? EXPECTED_HEAD,
      treeSha: "8".repeat(40),
      parentCommitShas: ["9".repeat(40)]
    },
    foundation: {
      transactionId: TRANSACTION_ID,
      leaseId: outcome.lease.leaseId,
      generation: outcome.lease.generation,
      heldLeaseEventSha256: outcome.lease.eventSha256,
      heldLeaseSha256: "a".repeat(64),
      storeSealSha256:
        options.proofStoreSealSha256 ?? outcome.durableStore.sealSha256,
      sourceSnapshotSha256: outcome.source.snapshotSha256,
      targetSnapshotSha256: outcome.target.snapshotSha256,
      sourceStateSha256: outcome.source.stateSha256,
      targetStateSha256: outcome.target.stateSha256
    },
    latestOutcome: options.proofLatestSha256 === undefined
      ? null
      : { sha256: options.proofLatestSha256, terminal: false },
    terminal: options.proofTerminal ? { sha256: "b".repeat(64) } : null
  };
  const source = serializeCanonicalJson({
    schemaVersion: 1,
    kind: "test-publication-recovery-outcome",
    ...outcome
  });
  const sourceSha256 = sha256(source);
  const attemptPath = path.join(
    root,
    electronProductionPublicationRecoveryOutcomeAttemptFileName(RECOVERY_RUN)
  );
  await writeFile(attemptPath, source, { flag: "wx", mode: 0o600 });
  const terminalPath = options.terminal
    ? path.join(root, ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE)
    : null;
  if (terminalPath !== null) {
    await writeFile(terminalPath, source, { flag: "wx", mode: 0o600 });
  }
  const target = (storePath: string) => ({
    owner: OWNER,
    repo: REPO,
    ref: REF,
    path: storePath,
    repositoryPolicy: { defaultBranch: REF, visibility: "private" as const }
  });
  const targetPaths = options.targetPaths ?? (options.terminal
    ? [paths.attemptPath, paths.terminalPath]
    : [paths.attemptPath]);
  if (options.terminal && targetPaths.length !== 2) {
    throw new Error("The terminal fixture needs two target paths.");
  }
  const packageIdentity = (fileName: string) => ({
    fileName,
    byteLength: source.length,
    sha256: sourceSha256
  });
  const operationDirectory = path.join(root, "operation");
  await mkdir(operationDirectory, { mode: 0o700 });
  const operationPath = path.join(
    operationDirectory,
    options.terminal
      ? ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE
      : ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const result = {
    outcome: "applied" as const,
    blobSha: options.blobSha ?? gitBlobSha(source),
    byteLength: source.length,
    commitSha: COMMIT,
    parentSha: EXPECTED_HEAD,
    treeSha: TREE
  };
  const operation = options.terminal
    ? await writeElectronProductionRecoveryStoreAtomicPairOperationReceipt({
        outputPath: operationPath,
        receipt: createElectronProductionRecoveryStoreAtomicPairOperationReceipt({
          request: createElectronProductionRecoveryStoreAtomicPairRequest({
            expectedHeadSha: EXPECTED_HEAD,
            packageIdentities: [
              packageIdentity(path.basename(attemptPath)),
              packageIdentity(ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE)
            ],
            targets: [target(targetPaths[0]!), target(targetPaths[1]!)]
          }),
          result: {
            ...result,
            paths: [targetPaths[0]!, targetPaths[1]!]
          }
        })
      })
    : await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
        outputPath: operationPath,
        receipt: createElectronProductionRecoveryStoreRemoteOperationReceipt({
          request: createElectronProductionRecoveryStoreRemoteRequest({
            expectedHeadSha: EXPECTED_HEAD,
            packageIdentity: packageIdentity(path.basename(attemptPath)),
            target: target(targetPaths[0]!)
          }),
          result
        })
      });
  const reader = async (input: ReadInput) => ({
    receipt: outcome,
    receiptIdentity: {
      bytes: source.length,
      fileName: path.basename(input.receiptPath),
      sha256: input.expectedSha256
    },
    receiptPath: input.receiptPath
  } as never);
  const readAppendProof = async () => ({
    proof,
    proofIdentity: {
      bytes: 512,
      fileName: "electron-production-publication-recovery-outcome-chain-proof.json",
      sha256: PROOF_SHA256
    }
  } as never);
  return {
    attemptPath,
    operationPath,
    operationSha256: operation.receiptIdentity.sha256,
    paths,
    readers: { readAppendProof, readOutcome: reader, readOutcomeAttempt: reader },
    root,
    sha256: sourceSha256,
    source,
    terminalPath
  };
}

function argumentsFor(fixture: Fixture): string[] {
  const args = [
    "verify-outcome-create-chain",
    "--transaction-id", TRANSACTION_ID,
    "--owner", OWNER,
    "--repo", REPO,
    "--ref", REF,
    "--expected-head-sha", EXPECTED_HEAD,
    "--outcome-chain-proof", path.join(fixture.root, "outcome-chain-proof.json"),
    "--outcome-chain-proof-sha256", PROOF_SHA256,
    "--attempt-outcome", fixture.attemptPath,
    "--attempt-outcome-sha256", fixture.sha256,
    "--operation", fixture.operationPath,
    "--operation-sha256", fixture.operationSha256
  ];
  if (fixture.terminalPath !== null) args.push(
    "--terminal-outcome", fixture.terminalPath,
    "--terminal-outcome-sha256", fixture.sha256
  );
  return args;
}

function appendArgumentsFor(fixture: Fixture): string[] {
  const args = argumentsFor(fixture);
  args[0] = "verify-outcome-append-foundation";
  for (const option of ["--operation", "--operation-sha256"]) {
    const index = args.indexOf(option);
    if (index < 0) throw new Error(`Missing create-chain option ${option}.`);
    args.splice(index, 2);
  }
  return args;
}

function replaceOption(args: string[], name: string, value: string): string[] {
  const copy = [...args];
  const index = copy.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing option --${name}.`);
  copy[index + 1] = value;
  return copy;
}

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
