import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND
} from "../scripts/electronProductionUpdaterDataPreservationObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES
} from "../scripts/electronProductionUpdaterEvidenceBundle.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND
} from "../scripts/electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND
} from "../scripts/electronProductionUpdaterTerminalReceiptObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CONTEXT_FILE,
  coordinateElectronProductionUpdaterPostInstallCell,
  type ElectronProductionUpdaterPostInstallCellCoordinatorDependencies
} from "../scripts/electronProductionUpdaterPostInstallCellCoordinator.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CELL_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterPostInstallCellCoordinatorCli
} from "../scripts/electronProductionUpdaterPostInstallCellCoordinatorCli.mjs";

const PLAN_SHA = sha256("attempt-plan");
const TRACE_SHA = sha256("journal-trace");
const BEFORE_SHA = sha256("preservation-before");
const BUNDLE_SHA = sha256("terminal-bundle");
const SOURCE_ATTEMPT_ID = "update-install-10000000-0000-4000-8000-000000000002";
const EVIDENCE_ATTEMPT_ID = "10000000-0000-4000-8000-000000000003";
const TARGET_SHA = "a".repeat(40);
const TARGET_VERSION = "8.6.0";
const PLATFORM = "darwin-aarch64";
const TRANSITION = "electron-v23-to-electron-v23";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater post-install cell coordinator", () => {
  it("observes first boot, seals preservation, finalizes eight attachments, and verifies the bundle", async () => {
    const fixture = await createFixture();
    const calls: string[] = [];
    const result = await coordinateElectronProductionUpdaterPostInstallCell(
      fixture.input,
      asCoordinatorDependencies(dependencies(fixture, calls))
    );

    expect(result).toMatchObject({
      outputRoot: fixture.input.bundleOutputRoot,
      receiptSha256: BUNDLE_SHA
    });
    expect(calls).toEqual([
      "read-plan",
      "read-trace",
      "observe-terminal",
      "observe-target",
      "finalize-preservation",
      "finalize-attachments",
      "assemble-bundle",
      "read-bundle"
    ]);
    const context = JSON.parse(await readFile(
      fixture.input.dataPreservationContextOutputPath,
      "utf8"
    ));
    expect(context).toEqual({
      challenge: fixture.plan.challenge,
      evidenceAttemptId: EVIDENCE_ATTEMPT_ID,
      platform: PLATFORM,
      sourceInstallAttemptId: SOURCE_ATTEMPT_ID,
      target: expectedPreservationTarget(fixture.bindings.targetBinding),
      transitionKind: TRANSITION
    });
    expect(await readFile(fixture.input.dataPreservationContextOutputPath)).toEqual(
      serializeCanonicalJson(context)
    );
  });

  it("rejects a target binding that diverges from the sealed attempt plan before observing first boot", async () => {
    const fixture = await createFixture();
    const forged = structuredClone(fixture.bindings);
    forged.targetBinding.version = "8.6.1";
    await writeFile(fixture.input.bindingsPath, serializeCanonicalJson(forged));
    const calls: string[] = [];
    await expect(coordinateElectronProductionUpdaterPostInstallCell(
      fixture.input,
      asCoordinatorDependencies(dependencies(fixture, calls))
    )).rejects.toThrow("target binding version does not match");
    expect(calls).toEqual(["read-plan", "read-trace"]);
  });

  it("exposes one exact signal-bound CLI invocation", async () => {
    const fixture = await createFixture();
    const stdout: Buffer[] = [];
    let observedSignal: AbortSignal | undefined;
    const summary = await runElectronProductionUpdaterPostInstallCellCoordinatorCli(
      cliArguments(fixture.input),
      {
        coordinate: (async (input: { signal: AbortSignal }) => {
          observedSignal = input.signal;
          return {
            outputRoot: fixture.input.bundleOutputRoot,
            receiptSha256: BUNDLE_SHA
          };
        }) as never,
        signal: fixture.input.signal,
        writeStdout: (source) => { stdout.push(source); }
      }
    );
    expect(observedSignal).toBe(fixture.input.signal);
    expect(summary).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CELL_CLI_SUMMARY_KIND,
      status: "bundled",
      artifact: { fileName: "terminal-receipt.json", sha256: BUNDLE_SHA },
      outputRoot: fixture.input.bundleOutputRoot
    });
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(summary);

    await expect(runElectronProductionUpdaterPostInstallCellCoordinatorCli([
      ...cliArguments(fixture.input),
      "--platform", PLATFORM
    ], { signal: fixture.input.signal })).rejects.toThrow(
      "Duplicate post-install cell option --platform"
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-post-install-"));
  temporaryDirectories.push(root);
  const attachments = join(root, "attachments");
  const bundle = join(root, "bundle");
  await Promise.all([mkdir(attachments), mkdir(bundle)]);
  const bindings = createBindings();
  const bindingsPath = join(root, "bindings.json");
  await writeFile(bindingsPath, serializeCanonicalJson(bindings));
  const plan = createPlan(bindings);
  const input = {
    attachmentOutputRoot: attachments,
    attemptPlanPath: join(root, "attempt-plan.json"),
    bindingsPath,
    bundleOutputRoot: bundle,
    checkActionPath: join(root, "check-action.json"),
    dataPreservationBeforePath: join(root, "data-preservation-before.json"),
    dataPreservationContextOutputPath: join(
      root,
      ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CONTEXT_FILE
    ),
    dataPreservationObservationOutputPath: join(
      root,
      "data-preservation-observation.json"
    ),
    endpointObservationPath: join(root, "endpoint-observation.json"),
    expectedAttemptPlanSha256: PLAN_SHA,
    expectedDataPreservationBeforeSha256: BEFORE_SHA,
    expectedJournalTraceSha256: TRACE_SHA,
    installActionPath: join(root, "install-action.json"),
    journalTracePath: join(root, "source-event-stream.jsonl"),
    nativeHostObservationPath: join(root, "native-host-observation.json"),
    platform: PLATFORM,
    productTerminalReceiptOutputPath: join(root, "product-terminal-receipt.json"),
    signal: new AbortController().signal,
    sourceInstallJournalPath: join(root, "source-install-journal.json"),
    targetExecutablePath: join(
      root,
      "runtime",
      "Rion Studio.app",
      "Contents",
      "MacOS",
      "Rion Studio"
    ),
    targetLaunchArgumentsOutputPath: join(
      root,
      "native-host-launch-arguments.json"
    ),
    targetProcess: {
      inventoryExecutablePath: join(root, "packaged-process-inventory"),
      inventoryExecutableSha256: sha256("packaged-process-inventory")
    },
    targetUserDataDirectory: join(root, "user-data"),
    transitionKind: TRANSITION
  } as const;
  return { bindings, input, plan, root };
}

function createBindings() {
  const targetBinding = {
    artifactName: "Rion.Studio-mac.app.tar.gz",
    artifactSha256: sha256("target-artifact"),
    candidateReceiptSha256: sha256("target-candidate"),
    embeddedUpdaterEndpoint: "https://updates.example.test/rion/v23/latest.json",
    manifestName: "latest.json",
    runtime: "electron-v23",
    servedManifestSha256: sha256("served-manifest"),
    signatureName: "Rion.Studio-mac.app.tar.gz.sig",
    signatureSha256: sha256("target-signature"),
    sourceSha: TARGET_SHA,
    targetRunningImageSha256: sha256("target-running-image"),
    updaterPublicKeySha256: sha256("production-public-key"),
    version: TARGET_VERSION
  };
  return {
    provenance: {
      artifactName:
        `electron-production-updater-terminal-evidence-${TARGET_VERSION}-` +
        `${TARGET_SHA}-attempt-4`,
      repository: "rion-tw/rion-studio-source",
      runAttempt: 4,
      runId: "104",
      sourceSha: TARGET_SHA,
      workflow: ".github/workflows/electron-production-updater-evidence.yml"
    },
    sourceBinding: {
      artifactName: "Rion.Studio-mac.app.tar.gz",
      artifactSha256: sha256("source-artifact"),
      candidateReceiptSha256: sha256("prior-candidate"),
      embeddedUpdaterEndpoint: "https://updates.example.test/rion/v22/latest.json",
      lineageKind: "production-candidate",
      manifestName: "latest.json",
      manifestSha256: sha256("source-manifest"),
      runningImageSha256: sha256("source-running-image"),
      runtime: "electron-v23",
      sourceSha: "b".repeat(40),
      version: "8.5.0"
    },
    targetBinding
  };
}

function createPlan(bindings: ReturnType<typeof createBindings>) {
  const target = {
    artifactName: "electron-production-candidate-8.6.0-" +
      `${TARGET_SHA}-attempt-3`,
    candidateReceiptSha256: bindings.targetBinding.candidateReceiptSha256,
    controlSha: "1".repeat(40),
    repository: "rion-tw/rion-studio-source",
    runAttempt: 3,
    runId: "101",
    sourceSha: TARGET_SHA,
    trustedControlReceiptSha256: sha256("target-control"),
    version: TARGET_VERSION,
    workflow: ".github/workflows/electron-production-candidate.yml"
  };
  return {
    producer: {
      aggregateArtifactName: bindings.provenance.artifactName,
      controlSha: "d".repeat(40),
      repository: bindings.provenance.repository,
      runAttempt: bindings.provenance.runAttempt,
      runId: bindings.provenance.runId,
      workflow: bindings.provenance.workflow
    },
    upstream: {
      target,
      priorV23: {
        ...target,
        artifactName: "electron-production-candidate-8.5.0-" +
          `${"b".repeat(40)}-attempt-2`,
        candidateReceiptSha256: bindings.sourceBinding.candidateReceiptSha256,
        sourceSha: "b".repeat(40),
        version: "8.5.0"
      }
    },
    challenge: {
      expiresAt: "2026-09-03T00:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000001",
      issuedAt: "2026-09-02T00:00:00.000Z",
      nonceSha256: sha256("challenge")
    },
    cells: [{
      evidenceAttemptId: EVIDENCE_ATTEMPT_ID,
      platform: PLATFORM,
      transitionKind: TRANSITION
    }]
  };
}

function dependencies(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  calls: string[]
) {
  const context = {
    challenge: fixture.plan.challenge,
    evidenceAttemptId: EVIDENCE_ATTEMPT_ID,
    platform: PLATFORM,
    sourceInstallAttemptId: SOURCE_ATTEMPT_ID,
    target: expectedPreservationTarget(fixture.bindings.targetBinding),
    transitionKind: TRANSITION
  };
  const bundleResult = {
    attachments: {},
    outputRoot: fixture.input.bundleOutputRoot,
    receipt: {},
    receiptSha256: BUNDLE_SHA
  };
  return {
    readAttemptPlan: async () => {
      calls.push("read-plan");
      return {
        plan: fixture.plan,
        planIdentity: { sha256: PLAN_SHA }
      };
    },
    readJournalTrace: async () => {
      calls.push("read-trace");
      return {
        trace: {
          platform: PLATFORM,
          sourceInstallAttemptId: SOURCE_ATTEMPT_ID,
          targetVersion: TARGET_VERSION,
          transitionKind: TRANSITION,
          visibleInstallInvokedAt: "2026-09-02T00:04:00.000Z"
        },
        traceIdentity: { sha256: TRACE_SHA }
      };
    },
    observeTerminalReceipt: async () => {
      calls.push("observe-terminal");
      return {
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND,
        authority: "target-first-boot-journal-reconciliation",
        platform: PLATFORM,
        receipt: {
          bytes: 100,
          fileName: "product-terminal-receipt.json",
          sha256: sha256("product-terminal-receipt")
        },
        reconciledAt: "2026-09-02T00:05:00.000Z",
        sourceInstallAttemptId: SOURCE_ATTEMPT_ID,
        terminalOutcome: "applied"
      };
    },
    observeTargetProcess: async (input: Record<string, unknown>) => {
      calls.push("observe-target");
      expect(input).toMatchObject({
        expectedExecutablePath: fixture.input.targetExecutablePath,
        launchedAfterMilliseconds: Date.parse("2026-09-02T00:04:00.000Z"),
        nativeHostObservationOutputPath: fixture.input.nativeHostObservationPath,
        platformProcess: fixture.input.targetProcess,
        signal: fixture.input.signal
      });
      return {
        schemaVersion: 1,
        kind: "rion-electron-production-updater-target-process-observation",
        platform: PLATFORM,
        process: { processId: 42_420 },
        launchArguments: {
          bytes: 100,
          fileName: "native-host-launch-arguments.json",
          sha256: sha256("launch-arguments")
        },
        nativeHostObservation: {
          bytes: 100,
          fileName: "native-host-observation.json",
          sha256: sha256("native-host-observation")
        }
      };
    },
    finalizeDataPreservation: async (input: { observationPath: string }) => {
      calls.push("finalize-preservation");
      return {
        observation: {
          schemaVersion: 1,
          kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND,
          ...context,
          observedAt: "2026-09-02T00:05:01.000Z",
          preservation: {
            afterChallengeSha256: fixture.plan.challenge.nonceSha256,
            beforeChallengeSha256: fixture.plan.challenge.nonceSha256,
            preserved: true,
            userDataIdentitySha256: sha256("user-data")
          }
        },
        observationIdentity: { sha256: sha256("preservation-observation") },
        observationPath: input.observationPath
      };
    },
    finalizeAttachments: async () => {
      calls.push("finalize-attachments");
      return {
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND,
        attemptPlanSha256: PLAN_SHA,
        bindingsSha256: sha256(serializeCanonicalJson(fixture.bindings)),
        journalTraceSha256: TRACE_SHA,
        outputRoot: fixture.input.attachmentOutputRoot,
        cell: fixture.plan.cells[0],
        attachments: Object.fromEntries(
          ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
            name,
            { sha256: sha256(name) }
          ])
        )
      };
    },
    assembleBundle: async () => {
      calls.push("assemble-bundle");
      return bundleResult;
    },
    readBundle: async () => {
      calls.push("read-bundle");
      return bundleResult;
    }
  };
}

function expectedPreservationTarget(
  target: ReturnType<typeof createBindings>["targetBinding"]
) {
  const {
    targetRunningImageSha256: _targetRunningImageSha256,
    updaterPublicKeySha256: _updaterPublicKeySha256,
    ...preservationTarget
  } = target;
  return preservationTarget;
}

function asCoordinatorDependencies(value: unknown) {
  return value as ElectronProductionUpdaterPostInstallCellCoordinatorDependencies;
}

function cliArguments(input: Awaited<ReturnType<typeof createFixture>>["input"]) {
  return [
    "observe",
    "--attachment-output-root", input.attachmentOutputRoot,
    "--attempt-plan", input.attemptPlanPath,
    "--attempt-plan-sha256", input.expectedAttemptPlanSha256,
    "--bindings", input.bindingsPath,
    "--bundle-output-root", input.bundleOutputRoot,
    "--check-action", input.checkActionPath,
    "--data-preservation-before", input.dataPreservationBeforePath,
    "--data-preservation-before-sha256", input.expectedDataPreservationBeforeSha256,
    "--data-preservation-context-output", input.dataPreservationContextOutputPath,
    "--data-preservation-observation-output",
    input.dataPreservationObservationOutputPath,
    "--endpoint-observation", input.endpointObservationPath,
    "--install-action", input.installActionPath,
    "--journal-trace", input.journalTracePath,
    "--journal-trace-sha256", input.expectedJournalTraceSha256,
    "--native-host-observation", input.nativeHostObservationPath,
    "--platform", input.platform,
    "--product-terminal-receipt-output", input.productTerminalReceiptOutputPath,
    "--source-install-journal", input.sourceInstallJournalPath,
    "--target-executable", input.targetExecutablePath,
    "--target-launch-arguments-output", input.targetLaunchArgumentsOutputPath,
    "--target-user-data", input.targetUserDataDirectory,
    "--transition-kind", input.transitionKind,
    "--inventory-executable", input.targetProcess.inventoryExecutablePath,
    "--inventory-executable-sha256",
    input.targetProcess.inventoryExecutableSha256
  ];
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
