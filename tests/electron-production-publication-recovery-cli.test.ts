import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  acquireElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
  createElectronProductionPublicLatestLeaseReleaseOperation,
  writeElectronProductionPublicLatestLeaseReleaseOperation
} from "../scripts/electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND
} from "../scripts/electronProductionPublicLatestLeaseRemoteCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  assertElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  writeElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
  readElectronProductionPublicationRecoveryOutcome,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  readElectronProductionPublicationRecoveryStoreSeal,
  writeElectronProductionPublicationRecoveryOutcomeAttempt
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
  createElectronProductionPublicLatestRecoveryObservation,
  createElectronProductionPublicLatestRecoveryRollback,
  electronProductionPublicLatestRecoveryObservationSha256,
  writeElectronProductionPublicLatestRecoveryObservation,
  writeElectronProductionPublicLatestRecoveryRollback,
  type ElectronProductionPublicLatestRecoveryObservation
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_CLI_SUMMARY_KIND,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_INPUT_KIND,
  runElectronProductionPublicationRecoveryCli,
  type ElectronProductionPublicationRecoveryCliSummary,
  type ElectronProductionPublicationRecoveryOutcomeMaterializationInput,
  type ElectronProductionPublicationRecoveryStoreSealMaterializationInput
} from "../scripts/electronProductionPublicationRecoveryCli.mjs";
import {
  createElectronProductionPublicationIntent,
  writeElectronProductionPublicationReceipt
} from "../scripts/electronProductionPublicationReceipt.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "../scripts/electronProductionRecoveryCapsule.mjs";
import {
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteRequest,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const SOURCE_SHA = "1".repeat(40);
const CONTROL_SHA = "2".repeat(40);
const RECOVERY_CONTROL_SHA = "3".repeat(40);
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const CLI_PATH = path.resolve(
  "scripts/electronProductionPublicationRecoveryCli.mjs"
);
const temporaryDirectories: string[] = [];
let operationSequence = 0;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production publication recovery CLI", () => {
  it("materializes and verifies a canonical create-new store seal without exposing inputs", async () => {
    const fixture = await recoveryFixture();
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
    );
    const stdout: Buffer[] = [];
    const summary = await runElectronProductionPublicationRecoveryCli(
      materializeStoreArgs(fixture, output),
      { writeStdout: (source) => stdout.push(source) }
    );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_CLI_SUMMARY_KIND,
      command: "materialize-store-seal",
      status: "materialized",
      output: {
        fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
      },
      outcome: null
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    const publicOutput = stdout[0]!.toString("utf8");
    expect(publicOutput).not.toContain("alternate-owner/recovery-vault");
    expect(publicOutput).not.toContain("fixture-private-capsule-material");
    expect(publicOutput).not.toContain(TRANSACTION_ID);

    const seal = await readElectronProductionPublicationRecoveryStoreSeal({
      expectedSha256: summary.output.sha256,
      receiptPath: output
    });
    expect(seal.receipt.durableStore.repository).toBe(
      "alternate-owner/recovery-vault"
    );
    expect(seal.receipt.capsuleSha256).toBe(fixture.capsule.sha256);

    const verified = await runCaptured(
      verifyStoreArgs(fixture, output, summary.output.sha256)
    );
    expect(verified).toMatchObject({
      command: "verify-store-seal",
      status: "verified",
      output: summary.output,
      outcome: null
    });
    await expect(runElectronProductionPublicationRecoveryCli(
      materializeStoreArgs(fixture, output),
      { writeStdout: () => undefined }
    )).rejects.toThrow("must be create-new");
  });

  it("materializes and verifies only the contract-derived source no-op release decision", async () => {
    const fixture = await recoveryFixture();
    const seal = await materializeSeal(fixture);
    const outcomeInput = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-input.json"),
      outcomeMaterializationInput()
    );
    const operation = await writeObservationOperation(fixture, "source");
    const leaseReleaseOperation = await writeLeaseReleaseOperation(
      fixture,
      operation,
      "confirmed"
    );
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    const summary = await runCaptured(materializeOutcomeArgs({
      fixture,
      input: outcomeInput,
      leaseReleaseOperation,
      operation,
      output,
      seal
    }));

    expect(summary).toMatchObject({
      command: "materialize-outcome",
      status: "materialized",
      outcome: {
        classification: "source-observed-noop",
        terminal: true,
        safeToReleaseLease: true
      }
    });
    const receipt = await readElectronProductionPublicationRecoveryOutcome({
      expectedSha256: summary.output.sha256,
      receiptPath: output
    });
    expect(receipt.receipt.outcome.safeToReleaseLease).toBe(true);

    const verified = await runCaptured(
      verifyOutcomeArgs(
        fixture,
        seal,
        leaseReleaseOperation,
        operation,
        output,
        summary.output.sha256
      )
    );
    expect(verified.outcome).toEqual({
      classification: "source-observed-noop",
      terminal: true,
      safeToReleaseLease: true
    });
    const reboundOperation = await writeObservationOperation(fixture, "target");
    await expect(runElectronProductionPublicationRecoveryCli(
      verifyOutcomeArgs(
        fixture,
        seal,
        leaseReleaseOperation,
        reboundOperation,
        output,
        summary.output.sha256
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("recovery-operation binding");
  });

  it("rejects unmarked rollback PATCH evidence in materialize and verify", async () => {
    const fixture = await recoveryFixture();
    const seal = await materializeSeal(fixture);
    const outcomeInput = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-input.json"),
      outcomeMaterializationInput()
    );
    const operation = await writeRollbackOperation(fixture, "unknown", "unknown");
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    await expect(runCaptured(materializeOutcomeArgs({
      fixture,
      input: outcomeInput,
      operation,
      output,
      seal
    }))).rejects.toThrow("unmarked rollback PATCH");

    const observation = await writeObservationOperation(fixture, "source");
    const reconcile = await writeLeaseReleaseOperation(
      fixture,
      observation,
      "confirmed"
    );
    const safe = await runCaptured(materializeOutcomeArgs({
      fixture,
      input: outcomeInput,
      leaseReleaseOperation: reconcile,
      operation: observation,
      output,
      seal
    }));
    await expect(runCaptured(verifyOutcomeArgs(
      fixture,
      seal,
      undefined,
      operation,
      output,
      safe.output.sha256
    ))).rejects.toThrow("unmarked rollback PATCH");
  });

  it("rejects unmarked release PUT evidence in materialize and verify", async () => {
    const fixture = await recoveryFixture();
    const seal = await materializeSeal(fixture);
    const input = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-input.json"),
      outcomeMaterializationInput()
    );
    const operation = await writeObservationOperation(fixture, "source");
    const releasePut = await writeLeaseReleaseOperation(
      fixture,
      operation,
      "confirmed",
      "2026-09-01T00:08:00Z",
      "release"
    );
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    await expect(runCaptured(materializeOutcomeArgs({
      fixture,
      input,
      leaseReleaseOperation: releasePut,
      operation,
      output,
      seal
    }))).rejects.toThrow("unmarked release PUT");

    const reconcile = await writeLeaseReleaseOperation(
      fixture,
      operation,
      "confirmed"
    );
    const safe = await runCaptured(materializeOutcomeArgs({
      fixture,
      input,
      leaseReleaseOperation: reconcile,
      operation,
      output,
      seal
    }));
    await expect(runCaptured(verifyOutcomeArgs(
      fixture,
      seal,
      releasePut,
      operation,
      output,
      safe.output.sha256
    ))).rejects.toThrow("unmarked release PUT");
  });

  it("allows a crashed-attempt gap while rejecting non-increasing successors", async () => {
    const fixture = await recoveryFixture();
    const seal = await materializeSeal(fixture);
    const operation = await writeObservationOperation(fixture, "source");
    const unknownRelease = await writeLeaseReleaseOperation(
      fixture,
      operation,
      "unknown"
    );
    const firstInputValue = outcomeMaterializationInput();
    const firstInput = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-attempt-3-input.json"),
      firstInputValue
    );
    const terminalPath = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    const first = await runCaptured(materializeOutcomeArgs({
      fixture,
      input: firstInput,
      leaseReleaseOperation: unknownRelease,
      operation,
      output: terminalPath,
      seal
    }));
    expect(first.outcome).toMatchObject({ terminal: false });
    expect(first.terminalOutput).toBeNull();
    await expect(readFile(terminalPath)).rejects.toMatchObject({ code: "ENOENT" });
    const firstPath = path.join(fixture.root, first.output.fileName);

    const confirmedRelease = await writeLeaseReleaseOperation(
      fixture,
      operation,
      "confirmed",
      "2026-09-01T00:11:00Z"
    );
    for (const runAttempt of [3, 2]) {
      const invalidInputValue = outcomeMaterializationInput({
        determinedAt: "2026-09-01T00:12:00Z",
        runAttempt,
        startedAt: "2026-09-01T00:10:00Z"
      });
      const invalidRoot = path.join(
        fixture.root,
        `non-increasing-attempt-${runAttempt}`
      );
      await mkdir(invalidRoot);
      const invalidInput = await writeCanonical(
        path.join(invalidRoot, "input.json"),
        invalidInputValue
      );
      const invalidArgs = materializeOutcomeArgs({
        fixture,
        input: invalidInput,
        leaseReleaseOperation: confirmedRelease,
        operation,
        output: path.join(invalidRoot, path.basename(terminalPath)),
        seal
      });
      replaceOption(
        invalidArgs,
        "attempt-output",
        path.join(
          invalidRoot,
          electronProductionPublicationRecoveryOutcomeAttemptFileName(
            invalidInputValue.recoveryRun
          )
        )
      );
      invalidArgs.push(
        "--previous-outcome", firstPath,
        "--previous-outcome-sha256", first.output.sha256
      );
      await expect(runCaptured(invalidArgs)).rejects.toThrow(
        "must use a greater run attempt"
      );
    }
    const secondInputValue = outcomeMaterializationInput({
      determinedAt: "2026-09-01T00:12:00Z",
      runAttempt: 5,
      startedAt: "2026-09-01T00:10:00Z"
    });
    const secondInput = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-attempt-5-input.json"),
      secondInputValue
    );
    const secondArgs = materializeOutcomeArgs({
      fixture,
      input: secondInput,
      leaseReleaseOperation: confirmedRelease,
      operation,
      output: terminalPath,
      seal
    });
    replaceOption(
      secondArgs,
      "attempt-output",
      path.join(
        fixture.root,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          secondInputValue.recoveryRun
        )
      )
    );
    secondArgs.push(
      "--previous-outcome", firstPath,
      "--previous-outcome-sha256", first.output.sha256
    );
    const second = await runCaptured(secondArgs);

    expect(second.outcome).toMatchObject({
      classification: "source-observed-noop",
      terminal: true
    });
    expect(second.terminalOutput).toMatchObject({
      fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
      sha256: second.output.sha256
    });
    const terminal = await readElectronProductionPublicationRecoveryOutcome({
      expectedSha256: second.output.sha256,
      receiptPath: terminalPath
    });
    expect(terminal.receipt.previousOutcomeSha256).toBe(first.output.sha256);

    const verifyArgs = verifyOutcomeArgs(
      fixture,
      seal,
      confirmedRelease,
      operation,
      terminalPath,
      second.output.sha256
    );
    verifyArgs.push(
      "--previous-outcome", firstPath,
      "--previous-outcome-sha256", first.output.sha256
    );
    await expect(runElectronProductionPublicationRecoveryCli(
      verifyArgs,
      { writeStdout: () => undefined }
    )).resolves.toMatchObject({ status: "verified" });

    const invalidVerifyRoot = path.join(fixture.root, "invalid-verify-attempt");
    await mkdir(invalidVerifyRoot);
    const invalidReceipt = {
      ...terminal.receipt,
      recoveryRun: {
        ...terminal.receipt.recoveryRun,
        runAttempt: firstInputValue.recoveryRun.runAttempt
      }
    };
    const invalidOutcome =
      await writeElectronProductionPublicationRecoveryOutcomeAttempt({
        outputPath: path.join(
          invalidVerifyRoot,
          electronProductionPublicationRecoveryOutcomeAttemptFileName(
            invalidReceipt.recoveryRun
          )
        ),
        receipt: invalidReceipt
      });
    const invalidVerifyArgs = verifyOutcomeArgs(
      fixture,
      seal,
      confirmedRelease,
      operation,
      invalidOutcome.receiptPath,
      invalidOutcome.receiptIdentity.sha256
    );
    invalidVerifyArgs.push(
      "--previous-outcome", firstPath,
      "--previous-outcome-sha256", first.output.sha256
    );
    await expect(runElectronProductionPublicationRecoveryCli(
      invalidVerifyArgs,
      { writeStdout: () => undefined }
    )).rejects.toThrow("must use a greater run attempt");
  });

  it("rejects digest mismatch, symlink inputs, and a rebound operation before output", async () => {
    const fixture = await recoveryFixture();
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
    );
    const stdout: Buffer[] = [];
    const badDigestArgs = materializeStoreArgs(fixture, output);
    replaceOption(badDigestArgs, "input-sha256", "f".repeat(64));
    await expect(runElectronProductionPublicationRecoveryCli(badDigestArgs, {
      writeStdout: (source) => stdout.push(source)
    })).rejects.toThrow("SHA-256 does not match");
    expect(stdout).toEqual([]);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkPath = path.join(fixture.root, "linked-store-input.json");
    await symlink(fixture.storeInput.path, symlinkPath);
    const symlinkArgs = materializeStoreArgs(fixture, output);
    replaceOption(symlinkArgs, "input", symlinkPath);
    await expect(runElectronProductionPublicationRecoveryCli(symlinkArgs, {
      writeStdout: () => undefined
    })).rejects.toThrow("regular file");
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });

    const seal = await materializeSeal(fixture);
    const outcomeInput = await writeCanonical(
      path.join(fixture.root, "recovery-outcome-input.json"),
      outcomeMaterializationInput()
    );
    const operation = await writeObservationOperation(fixture, "source");
    const outcomeOutput = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    const rebound = materializeOutcomeArgs({
      fixture,
      input: outcomeInput,
      operation,
      output: outcomeOutput,
      seal
    });
    replaceOption(rebound, "operation-sha256", "f".repeat(64));
    await expect(runElectronProductionPublicationRecoveryCli(rebound, {
      writeStdout: () => undefined
    })).rejects.toThrow("SHA-256 does not match");
    await expect(readFile(outcomeOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a detached manifest, a non-applied store result, and a rebound remote proof", async () => {
    const fixture = await recoveryFixture();
    const output = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
    );
    const detachedRoot = path.join(fixture.root, "detached-manifest");
    await mkdir(detachedRoot);
    const detachedManifest = await writeCanonical(
      path.join(detachedRoot, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME),
      { kind: "unrelated-manifest", schemaVersion: 1 }
    );
    const detachedArgs = materializeStoreArgs(fixture, output);
    replaceOption(detachedArgs, "capsule-manifest", detachedManifest.path);
    replaceOption(
      detachedArgs,
      "capsule-manifest-sha256",
      detachedManifest.sha256
    );
    await expect(runElectronProductionPublicationRecoveryCli(detachedArgs, {
      writeStdout: () => undefined
    })).rejects.toThrow("packed recovery capsule manifest byte length");
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });

    const rejectedRoot = path.join(fixture.root, "rejected-operation");
    await mkdir(rejectedRoot);
    const rejectedReceipt =
      createElectronProductionRecoveryStoreRemoteOperationReceipt({
        request: fixture.remoteRequest,
        result: { outcome: "rejected", reason: "conflict", status: 409 }
      });
    const rejectedFile =
      await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
        outputPath: path.join(
          rejectedRoot,
          "electron-production-recovery-store-remote-operation.json"
        ),
        receipt: rejectedReceipt
      });
    const rejectedArgs = materializeStoreArgs(fixture, output);
    replaceOption(
      rejectedArgs,
      "remote-operation",
      path.join(
        rejectedRoot,
        "electron-production-recovery-store-remote-operation.json"
      )
    );
    replaceOption(
      rejectedArgs,
      "remote-operation-sha256",
      rejectedFile.receiptIdentity.sha256
    );
    await expect(runElectronProductionPublicationRecoveryCli(rejectedArgs, {
      writeStdout: () => undefined
    })).rejects.toThrow("requires an applied remote operation receipt");
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });

    const seal = await materializeSeal(fixture);
    const reboundRoot = path.join(fixture.root, "rebound-operation");
    await mkdir(reboundRoot);
    const reboundReceipt =
      createElectronProductionRecoveryStoreRemoteOperationReceipt({
        request: fixture.remoteRequest,
        result: {
          outcome: "applied",
          blobSha: "9".repeat(40),
          treeSha: "a".repeat(40),
          parentSha: "7".repeat(40),
          commitSha: "8".repeat(40),
          byteLength: fixture.capsule.bytes
        }
      });
    const reboundFile =
      await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
        outputPath: path.join(
          reboundRoot,
          "electron-production-recovery-store-remote-operation.json"
        ),
        receipt: reboundReceipt
      });
    const reboundArgs = verifyStoreArgs(fixture, seal.path, seal.sha256);
    replaceOption(
      reboundArgs,
      "remote-operation",
      path.join(
        reboundRoot,
        "electron-production-recovery-store-remote-operation.json"
      )
    );
    replaceOption(
      reboundArgs,
      "remote-operation-sha256",
      reboundFile.receiptIdentity.sha256
    );
    await expect(runElectronProductionPublicationRecoveryCli(reboundArgs, {
      writeStdout: () => undefined
    })).rejects.toThrow("durable-store blobSha");
  });

  it("exits nonzero with a stable redacted failure and no stdout", async () => {
    const result = await executeCli(["materialize-store-seal"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Electron production recovery CLI failed closed.\n"
    );
  });
});

async function recoveryFixture() {
  const root = await temporaryDirectory();
  const source = makeObservedSnapshot({
    candidate: null,
    idBase: 100,
    isLatest: true,
    version: "8.4.2"
  });
  const staged = makeObservedSnapshot({
    candidate: candidateSummary("8.6.0"),
    idBase: 200,
    isLatest: false,
    version: "8.6.0"
  });
  const target = deriveElectronProductionExpectedLatestState(staged);
  const observedTarget = observedFromProjection(target);
  const intent = createElectronProductionPublicationIntent({
    transactionId: TRANSACTION_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    lease: { id: LEASE_ID, generation: 1 },
    baseline: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      releaseTag: source.release.tag,
      sourceSha: SOURCE_SHA,
      manifestSha256: source.latestJson.sha256,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      releaseTag: target.release.tag,
      sourceSha: target.candidateReceipt!.sourceSha,
      candidateReceiptSha256: target.candidateReceipt!.sha256,
      manifestSha256: target.latestJson.sha256,
      stateSha256: target.stateSha256
    }
  });
  const heldLease = acquireElectronProductionPublicLatestLease({
    holder: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "7001",
      runAttempt: 2,
      headSha: CONTROL_SHA
    },
    leaseId: LEASE_ID,
    previous: null,
    purpose: "electron-v23-provisional-publication",
    recordedAt: "2026-09-01T00:00:00Z",
    source: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      stateSha256: target.stateSha256
    },
    transactionId: TRANSACTION_ID,
    vacantGeneration: 0
  });
  const heldLeaseFile = await writeElectronProductionPublicLatestLease({
    lease: heldLease,
    outputPath: path.join(root, "electron-production-public-latest-lease.json")
  });
  const intentFile = await writeElectronProductionPublicationReceipt({
    outputPath: path.join(
      root,
      "electron-production-publication-intent-receipt.json"
    ),
    receipt: intent
  });
  const sourceFile = await writeSnapshot(root, "source-snapshot.json", source);
  const targetFile = await writeSnapshot(root, "target-snapshot.json", target);
  const observedTargetFile = await writeSnapshot(
    root,
    "observed-target-snapshot.json",
    observedTarget
  );
  const capsuleManifest = await writeCanonical(
    path.join(root, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME),
    {
      kind: "fixture-capsule-manifest",
      privateMaterial: "fixture-private-capsule-material",
      schemaVersion: 1
    }
  );
  const manifestSource = await readFile(capsuleManifest.path);
  const capsule = await writeCanonical(
    path.join(root, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME),
    {
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
      encoding: "base64",
      fileCount: 1,
      totalFileBytes: capsuleManifest.bytes,
      manifest: {
        path: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
        bytes: capsuleManifest.bytes,
        sha256: capsuleManifest.sha256
      },
      intent: {
        path: "electron-production-publication-intent-receipt.json",
        bytes: 1,
        sha256: digest("fixture intent")
      },
      files: {
        [ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME]: {
          bytes: capsuleManifest.bytes,
          contentBase64: manifestSource.toString("base64"),
          sha256: capsuleManifest.sha256
        }
      }
    }
  );
  const remoteRequest = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: "7".repeat(40),
    packageIdentity: {
      fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      byteLength: capsule.bytes,
      sha256: capsule.sha256
    },
    target: {
      owner: "alternate-owner",
      repo: "recovery-vault",
      ref: "recovery-capsules",
      path: `transactions/${TRANSACTION_ID}/${ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME}`,
      repositoryPolicy: {
        defaultBranch: "recovery-capsules",
        visibility: "private"
      }
    }
  });
  const remoteReceipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request: remoteRequest,
    result: {
      outcome: "applied",
      blobSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      parentSha: "7".repeat(40),
      commitSha: "4".repeat(40),
      byteLength: capsule.bytes
    }
  });
  const remoteOperationFile = await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
    outputPath: path.join(
      root,
      "electron-production-recovery-store-remote-operation.json"
    ),
    receipt: remoteReceipt
  });
  const storeInput = await writeCanonical(
    path.join(root, "recovery-store-seal-input.json"),
    storeMaterializationInput()
  );
  return {
    capsule,
    capsuleManifest,
    heldLease,
    heldLeaseFile: {
      path: heldLeaseFile.leasePath,
      sha256: heldLeaseFile.leaseIdentity.sha256
    },
    intentFile: {
      path: intentFile.receiptPath,
      sha256: intentFile.receiptIdentity.sha256
    },
    observedTargetFile,
    observedTarget,
    remoteRequest,
    remoteOperationFile: {
      path: path.join(
        root,
        "electron-production-recovery-store-remote-operation.json"
      ),
      sha256: remoteOperationFile.receiptIdentity.sha256
    },
    root,
    source,
    sourceFile,
    storeInput,
    target,
    targetFile
  };
}

function storeMaterializationInput():
ElectronProductionPublicationRecoveryStoreSealMaterializationInput {
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_INPUT_KIND,
    committedAt: "2026-09-01T00:01:00Z",
    writer: {
      repository: "rion-tw/release-control",
      workflow: ".github/workflows/store-publication-recovery.yml",
      runId: "8001",
      runAttempt: 1,
      controlSha: CONTROL_SHA
    },
    sealedAt: "2026-09-01T00:02:00Z"
  };
}

function outcomeMaterializationInput(overrides: Readonly<{
  determinedAt?: string;
  runAttempt?: number;
  startedAt?: string;
}> = {}): ElectronProductionPublicationRecoveryOutcomeMaterializationInput {
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
    recoveryRun: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/recover-electron-publication.yml",
      runId: "9001",
      runAttempt: overrides.runAttempt ?? 3,
      controlSha: RECOVERY_CONTROL_SHA,
      startedAt: overrides.startedAt ?? "2026-09-01T00:03:00Z"
    },
    determinedAt: overrides.determinedAt ?? "2026-09-01T00:09:00Z"
  };
}

function materializeStoreArgs(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  output: string
) {
  return [
    "materialize-store-seal",
    "--input", fixture.storeInput.path,
    "--input-sha256", fixture.storeInput.sha256,
    "--held-lease", fixture.heldLeaseFile.path,
    "--held-lease-sha256", fixture.heldLeaseFile.sha256,
    "--publication-intent", fixture.intentFile.path,
    "--publication-intent-sha256", fixture.intentFile.sha256,
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--capsule", fixture.capsule.path,
    "--capsule-sha256", fixture.capsule.sha256,
    "--capsule-manifest", fixture.capsuleManifest.path,
    "--capsule-manifest-sha256", fixture.capsuleManifest.sha256,
    "--remote-operation", fixture.remoteOperationFile.path,
    "--remote-operation-sha256", fixture.remoteOperationFile.sha256,
    "--output", output
  ];
}

function verifyStoreArgs(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  sealPath: string,
  sealSha256: string
) {
  return [
    "verify-store-seal",
    "--store-seal", sealPath,
    "--store-seal-sha256", sealSha256,
    "--held-lease", fixture.heldLeaseFile.path,
    "--held-lease-sha256", fixture.heldLeaseFile.sha256,
    "--publication-intent", fixture.intentFile.path,
    "--publication-intent-sha256", fixture.intentFile.sha256,
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--capsule", fixture.capsule.path,
    "--capsule-sha256", fixture.capsule.sha256,
    "--capsule-manifest", fixture.capsuleManifest.path,
    "--capsule-manifest-sha256", fixture.capsuleManifest.sha256,
    "--remote-operation", fixture.remoteOperationFile.path,
    "--remote-operation-sha256", fixture.remoteOperationFile.sha256
  ];
}

function materializeOutcomeArgs(input: Readonly<{
  fixture: Awaited<ReturnType<typeof recoveryFixture>>;
  input: CanonicalFile;
  leaseReleaseOperation?: CanonicalFile;
  operation: CanonicalFile;
  output: string;
  seal: CanonicalFile;
}>) {
  const attemptOutput = path.join(
    path.dirname(input.output),
    electronProductionPublicationRecoveryOutcomeAttemptFileName(
      outcomeMaterializationInput().recoveryRun
    )
  );
  return [
    "materialize-outcome",
    "--input", input.input.path,
    "--input-sha256", input.input.sha256,
    "--operation", input.operation.path,
    "--operation-sha256", input.operation.sha256,
    ...leaseReleaseArgs(input.leaseReleaseOperation),
    "--held-lease", input.fixture.heldLeaseFile.path,
    "--held-lease-sha256", input.fixture.heldLeaseFile.sha256,
    "--store-seal", input.seal.path,
    "--store-seal-sha256", input.seal.sha256,
    "--source-snapshot", input.fixture.sourceFile.path,
    "--source-snapshot-sha256", input.fixture.sourceFile.sha256,
    "--target-snapshot", input.fixture.targetFile.path,
    "--target-snapshot-sha256", input.fixture.targetFile.sha256,
    "--attempt-output", attemptOutput,
    "--terminal-output", input.output
  ];
}

function verifyOutcomeArgs(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  seal: CanonicalFile,
  leaseReleaseOperation: CanonicalFile | undefined,
  operation: CanonicalFile,
  outcomePath: string,
  outcomeSha256: string
) {
  return [
    "verify-outcome",
    "--outcome", outcomePath,
    "--outcome-sha256", outcomeSha256,
    "--operation", operation.path,
    "--operation-sha256", operation.sha256,
    ...leaseReleaseArgs(leaseReleaseOperation),
    "--store-seal", seal.path,
    "--store-seal-sha256", seal.sha256,
    "--held-lease", fixture.heldLeaseFile.path,
    "--held-lease-sha256", fixture.heldLeaseFile.sha256,
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256
  ];
}

function leaseReleaseArgs(operation: CanonicalFile | undefined) {
  return operation === undefined
    ? []
    : [
        "--lease-release-operation", operation.path,
        "--lease-release-operation-sha256", operation.sha256
      ];
}

async function materializeSeal(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>
): Promise<CanonicalFile> {
  const output = path.join(
    fixture.root,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
  );
  const summary = await runCaptured(materializeStoreArgs(fixture, output));
  return { bytes: summary.output.bytes, path: output, sha256: summary.output.sha256 };
}

async function writeObservationOperation(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  classification: "source" | "target" | "unknown"
): Promise<CanonicalFile> {
  const receipt = recoveryObservation(fixture, classification, "2026-09-01T00:04:00Z");
  const directory = path.join(fixture.root, `operation-${operationSequence += 1}`);
  await mkdir(directory);
  const written = await writeElectronProductionPublicLatestRecoveryObservation({
    outputPath: path.join(
      directory,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    ),
    receipt
  });
  return {
    bytes: written.receiptIdentity.bytes,
    path: written.receiptPath,
    sha256: written.receiptIdentity.sha256
  };
}

async function writeRollbackOperation(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  acknowledgement: "confirmed" | "rejected" | "unknown",
  finalClassification: "source" | "target" | "unknown"
): Promise<CanonicalFile> {
  const before = recoveryObservation(fixture, "target", "2026-09-01T00:04:00Z");
  const final = recoveryObservation(
    fixture,
    finalClassification,
    "2026-09-01T00:07:00Z"
  );
  const result = acknowledgement === "confirmed"
    ? { reason: "applied-response" as const, httpStatus: 200 }
    : acknowledgement === "rejected"
      ? { reason: "github-rejected" as const, httpStatus: 409 }
      : { reason: "transport" as const, httpStatus: null };
  const receipt = createElectronProductionPublicLatestRecoveryRollback({
    finalObservation: final,
    finalObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(final),
    heldLease: fixture.heldLease,
    mutation: {
      submitted: true,
      releaseId: fixture.source.release.id,
      makeLatest: true,
      acknowledgement,
      submittedAt: "2026-09-01T00:05:00Z",
      resultRecordedAt: "2026-09-01T00:06:00Z",
      ...result
    },
    preObservation: before,
    preObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(before),
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: fixture.sourceFile.sha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: fixture.targetFile.sha256
  });
  const directory = path.join(fixture.root, `operation-${operationSequence += 1}`);
  await mkdir(directory);
  const written = await writeElectronProductionPublicLatestRecoveryRollback({
    outputPath: path.join(
      directory,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE
    ),
    receipt
  });
  return {
    bytes: written.receiptIdentity.bytes,
    path: written.receiptPath,
    sha256: written.receiptIdentity.sha256
  };
}

async function writeLeaseReleaseOperation(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  recoveryOperation: CanonicalFile,
  acknowledgement: "confirmed" | "unknown",
  attemptedAt = "2026-09-01T00:08:00Z",
  command: "observe-release" | "release" = "observe-release"
): Promise<CanonicalFile> {
  const held = fixture.heldLease;
  const released = releaseElectronProductionPublicLatestLease(held, {
    transactionId: held.transactionId,
    leaseId: held.leaseId,
    generation: held.generation,
    sourceStateSha256: held.source.stateSha256,
    targetStateSha256: held.target.stateSha256,
    recordedAt: attemptedAt
  });
  const releasedSource = serializeElectronProductionPublicLatestLease(released);
  const applied = acknowledgement === "confirmed";
  const remoteOperation = {
    schemaVersion: 1 as const,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    command,
    request: {
      attemptedAt,
      held: {
        transactionId: held.transactionId,
        leaseId: held.leaseId,
        generation: held.generation,
        revision: held.revision,
        eventSha256: electronProductionPublicLatestLeaseEventSha256(held),
        sourceStateSha256: held.source.stateSha256,
        targetStateSha256: held.target.stateSha256
      }
    },
    outcome: applied
      ? command === "release" ? "applied" as const : "observed" as const
      : "indeterminate" as const,
    reason: applied ? null : "unknown-acknowledgement" as const,
    httpStatus: null,
    remote: {
      repository: "rion-tw/rion-studio" as const,
      ref: "main" as const,
      path: "releases/electron-production-public-latest-lease.json" as const,
      blobSha: applied ? "9".repeat(40) : null
    },
    lease: applied
      ? {
          transactionId: released.transactionId,
          leaseId: released.leaseId,
          generation: released.generation,
          revision: released.revision,
          status: "released" as const,
          eventSha256: electronProductionPublicLatestLeaseEventSha256(released)
        }
      : null,
    output: applied
      ? {
          bytes: releasedSource.length,
          fileName: "electron-production-public-latest-lease.json" as const,
          sha256: digest(releasedSource)
        }
      : null
  };
  const kind = path.basename(recoveryOperation.path) ===
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    ? ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND
    : ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND;
  const preReleaseObservation = recoveryObservation(
    fixture,
    "source",
    attemptedAt
  );
  const operation = createElectronProductionPublicLatestLeaseReleaseOperation({
    heldLease: held,
    preReleaseObservation,
    recoveryOperation: {
      kind,
      sha256: kind === ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND
        ? electronProductionPublicLatestRecoveryObservationSha256(
          preReleaseObservation
        )
        : recoveryOperation.sha256
    },
    remoteOperation,
    resolvedAt: attemptedAt
  });
  const directory = path.join(fixture.root, `operation-${operationSequence += 1}`);
  await mkdir(directory);
  const written = await writeElectronProductionPublicLatestLeaseReleaseOperation({
    operation,
    outputPath: path.join(
      directory,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    )
  });
  return {
    bytes: written.operationIdentity.bytes,
    path: written.operationPath,
    sha256: written.operationIdentity.sha256
  };
}

function recoveryObservation(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  classification: "source" | "target" | "unknown",
  observedAt: string
): Readonly<ElectronProductionPublicLatestRecoveryObservation> {
  const result = classification === "unknown"
    ? {
        outcome: "indeterminate" as const,
        reason: "transport" as const,
        status: null,
        latest: null
      }
    : {
        outcome: "observed" as const,
        latest: {
          releaseId: classification === "source"
            ? fixture.source.release.id
            : fixture.target.release.id,
          updatedAt: observedAt
        },
        snapshot: classification === "source"
          ? fixture.source
          : fixture.observedTarget
      };
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt,
    result,
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: fixture.sourceFile.sha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: fixture.targetFile.sha256
  });
}

async function runCaptured(
  args: string[]
): Promise<Readonly<ElectronProductionPublicationRecoveryCliSummary>> {
  const stdout: Buffer[] = [];
  const summary = await runElectronProductionPublicationRecoveryCli(args, {
    writeStdout: (source) => stdout.push(source)
  });
  expect(stdout).toEqual([serializeCanonicalJson(summary)]);
  return summary;
}

async function writeSnapshot(
  root: string,
  name: string,
  snapshot: ReturnType<typeof assertElectronProductionPublicLatestSnapshot>
): Promise<CanonicalFile> {
  const snapshotPath = path.join(root, name);
  const written = await writeElectronProductionPublicLatestSnapshot({
    outputPath: snapshotPath,
    snapshot
  });
  return {
    bytes: written.file.bytes,
    path: snapshotPath,
    sha256: written.file.sha256
  };
}

async function writeCanonical(
  filePath: string,
  value: unknown
): Promise<CanonicalFile> {
  const source = serializeCanonicalJson(value);
  await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
  return { bytes: source.length, path: filePath, sha256: digest(source) };
}

function makeObservedSnapshot(input: Readonly<{
  candidate: ReturnType<typeof candidateSummary> | null;
  idBase: number;
  isLatest: boolean;
  version: string;
}>) {
  const tag = `v${input.version}`;
  const digests = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      digest(`${input.version}:${name}`)
    ])
  );
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: 100 + index,
    contentType: contentType(name),
    digest: `sha256:${digests[name]}`,
    id: String(input.idBase + index),
    name,
    url: `https://github.com/rion-tw/rion-studio/releases/download/${tag}/${encodeURIComponent(name)}`
  }));
  const updaterBaseUrl = input.candidate?.updaterBaseUrl ??
    "https://updates.example.test/v22/";
  const state = {
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-snapshot",
    repository: "rion-tw/rion-studio",
    release: {
      draft: false,
      id: String(input.idBase * 10),
      isLatest: input.isLatest,
      prerelease: false,
      tag,
      targetCommitish: input.idBase.toString(16).padStart(40, "0")
    },
    assets,
    latestJson: {
      bytes: assets.find((asset) => asset.name === "latest.json")?.bytes,
      platforms: {
        "darwin-aarch64": {
          artifactName: "Rion.Studio-mac.app.tar.gz",
          artifactSha256: digests["Rion.Studio-mac.app.tar.gz"],
          signatureFileName: "Rion.Studio-mac.app.tar.gz.sig",
          signatureFileSha256: digests["Rion.Studio-mac.app.tar.gz.sig"],
          url: `${updaterBaseUrl}Rion.Studio-mac.app.tar.gz`
        },
        "windows-x86_64": {
          artifactName: "Rion.Studio-win.exe",
          artifactSha256: digests["Rion.Studio-win.exe"],
          signatureFileName: "Rion.Studio-win.exe.sig",
          signatureFileSha256: digests["Rion.Studio-win.exe.sig"],
          url: `${updaterBaseUrl}Rion.Studio-win.exe`
        }
      },
      publishedAt: "2026-09-01T00:00:00Z",
      sha256: digests["latest.json"],
      version: input.version
    },
    candidateReceipt: input.candidate === null ? null : {
      ...input.candidate,
      assets: digests,
      version: input.version
    }
  };
  const stateSha256 = digest(serializeCanonicalJson(state));
  const body = { ...state, observationKind: "observed-release", stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: digest(serializeCanonicalJson(body))
  });
}

function observedFromProjection(target: ReturnType<
  typeof deriveElectronProductionExpectedLatestState
>) {
  const body = {
    schemaVersion: target.schemaVersion,
    kind: target.kind,
    observationKind: "observed-release",
    repository: target.repository,
    release: target.release,
    assets: target.assets,
    latestJson: target.latestJson,
    candidateReceipt: target.candidateReceipt,
    stateSha256: target.stateSha256
  };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: digest(serializeCanonicalJson(body))
  });
}

function candidateSummary(version: string) {
  return {
    assets: {} as Record<string, string>,
    bytes: 512,
    fileName: "electron-production-candidate-receipt.json" as const,
    publicKeySha256: "b".repeat(64),
    sha256: digest(`candidate:${version}`),
    sourceSha: "a".repeat(40),
    updaterBaseUrl: PUBLIC_BASE,
    updaterEndpoint: `${PUBLIC_BASE}latest.json`,
    version
  };
}

function contentType(name: string) {
  if (name.endsWith(".sig") || name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/vnd.microsoft.portable-executable";
}

function replaceOption(args: string[], name: string, value: string) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing test option ${name}.`);
  args[index + 1] = value;
}

async function executeCli(args: string[]) {
  return new Promise<Readonly<{
    code: number | null;
    stderr: string;
    stdout: string;
  }>>((resolve, reject) => {
    execFile(process.execPath, [CLI_PATH, ...args], (error, stdout, stderr) => {
      if (error && !("code" in error)) {
        reject(error);
        return;
      }
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stderr,
        stdout
      });
    });
  });
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-recovery-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

interface CanonicalFile {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}
