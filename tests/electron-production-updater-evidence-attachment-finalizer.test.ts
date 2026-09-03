import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  finalizeElectronProductionUpdaterEvidenceAttachments
} from "../scripts/electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";
import {
  runElectronProductionUpdaterEvidenceAttachmentFinalizerCli
} from "../scripts/electronProductionUpdaterEvidenceAttachmentFinalizerCli.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND
} from "../scripts/electronProductionUpdaterEvidenceEndpointObservation.mjs";
import {
  createElectronProductionUpdaterEvidenceAttemptPlan,
  type ElectronProductionUpdaterEvidenceAttemptPlanBindings,
  type ElectronProductionUpdaterEvidenceCandidateIdentity
} from "../scripts/electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  assembleElectronProductionUpdaterEvidenceBundle,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW,
  type ElectronProductionUpdaterEvidenceAttachmentName,
  type ElectronProductionUpdaterEvidencePlatform,
  type ElectronProductionUpdaterEvidenceTransition
} from "../scripts/electronProductionUpdaterEvidenceBundle.mjs";

const roots: string[] = [];
const TARGET_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const TAURI_SHA = "c".repeat(40);
const TARGET_VERSION = "8.6.0";
const PRIOR_VERSION = "8.5.0";
const TAURI_VERSION = "8.4.2";
const TARGET_ENDPOINT = "https://updates.example.test/rion/target/latest.json";
const PRIOR_ENDPOINT = "https://updates.example.test/rion/prior/latest.json";
const TAURI_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const ISSUE_TIME = "2026-09-01T00:00:00.000Z";
const CHALLENGE_NONCE = Buffer.alloc(32, 0x2a);
const UUIDS = [
  "90000000-0000-4000-8000-000000000009",
  "10000000-0000-4000-8000-000000000011",
  "10000000-0000-4000-8000-000000000012",
  "10000000-0000-4000-8000-000000000013",
  "10000000-0000-4000-8000-000000000014"
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

describe("production updater evidence attachment finalizer", () => {
  it.each([
    ["tauri-v22-to-electron-v23", "darwin-aarch64"],
    ["tauri-v22-to-electron-v23", "windows-x86_64"],
    ["electron-v23-to-electron-v23", "darwin-aarch64"],
    ["electron-v23-to-electron-v23", "windows-x86_64"]
  ] as const)("derives bundle-valid %s attachments for %s", async (
    transitionKind,
    platform
  ) => {
    const fixture = await createFixture(transitionKind, platform);

    const finalized = await finalizeElectronProductionUpdaterEvidenceAttachments(
      fixture.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    );
    const bundle = await assembleElectronProductionUpdaterEvidenceBundle({
      attachments: Object.fromEntries(
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
          name,
          join(finalized.outputRoot, name)
        ])
      ) as Record<ElectronProductionUpdaterEvidenceAttachmentName, string>,
      outputRoot: fixture.bundleRoot,
      ...fixture.bindings
    });

    expect(bundle.receipt).toMatchObject({
      cutoverEligible: true,
      platform,
      transitionKind,
      transaction: {
        evidenceAttemptId: fixture.cell.evidenceAttemptId,
        sourceInstallAttemptId: fixture.sourceInstallAttemptId,
        sourceUpdaterInvoked: true,
        terminalOutcome: "applied"
      }
    });
    const prebinding = JSON.parse(await readFile(
      fixture.finalizerInput.capturedAttachments.endpointObservation,
      "utf8"
    ));
    expect(prebinding).not.toHaveProperty("sourceInstallAttemptId");
    expect(prebinding).toMatchObject({
      attemptPlanSha256: fixture.finalizerInput.expectedAttemptPlanSha256,
      evidenceAttemptId: fixture.cell.evidenceAttemptId,
      observedAt: "2026-09-01T00:03:00.000Z"
    });
    const finalizedEndpoint = JSON.parse(await readFile(
      join(finalized.outputRoot, "endpoint-observation.json"),
      "utf8"
    ));
    expect(finalizedEndpoint).toMatchObject({
      evidenceAttemptId: fixture.cell.evidenceAttemptId,
      kind: "rion-production-updater-endpoint-observation",
      observedAt: "2026-09-01T00:03:00.000Z",
      sourceInstallAttemptId: fixture.sourceInstallAttemptId
    });
    expect(finalizedEndpoint).not.toHaveProperty("attemptPlanSha256");
    expect(finalized.attachments["source-event-stream.jsonl"].bytes).toBeGreaterThan(0);
    expect((await readFile(join(finalized.outputRoot, "source-event-stream.jsonl"), "utf8"))
      .trim().split("\n")).toHaveLength(9);
  });

  it("rejects a native-host image that differs from the sealed target binding", async () => {
    const fixture = await createFixture(
      "electron-v23-to-electron-v23",
      "darwin-aarch64"
    );
    const nativePath = fixture.finalizerInput.capturedAttachments.nativeHostObservation;
    const native = JSON.parse(await readFile(nativePath, "utf8"));
    native.targetRunningImageSha256 = sha256("different-running-image");
    await writeFile(nativePath, serializeCanonicalJson(native));

    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      fixture.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("native host target running image SHA-256 does not match");
  });

  it("rejects a final journal that was not the observed handoff object", async () => {
    const fixture = await createFixture(
      "electron-v23-to-electron-v23",
      "windows-x86_64"
    );
    const journalPath = fixture.finalizerInput.capturedAttachments.sourceInstallJournal;
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.attempt.updatedAt = "2026-09-01T00:09:01.000Z";
    await writeFile(journalPath, JSON.stringify(journal));

    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      fixture.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("source journal trace final SHA-256 does not match");
  });

  it("rejects endpoint prebindings outside the exact plan cell and provenance", async () => {
    const wrongPlan = await createFixture(
      "electron-v23-to-electron-v23",
      "darwin-aarch64"
    );
    await rewriteEndpointPrebinding(wrongPlan, (value) => {
      value.attemptPlanSha256 = sha256("foreign-attempt-plan");
    });
    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      wrongPlan.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("attempt-plan SHA-256 does not match");

    const wrongCell = await createFixture(
      "electron-v23-to-electron-v23",
      "windows-x86_64"
    );
    await rewriteEndpointPrebinding(wrongCell, (value) => {
      value.evidenceAttemptId = UUIDS[1];
    });
    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      wrongCell.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("endpoint observation context does not match");

    const wrongEndpoint = await createFixture(
      "electron-v23-to-electron-v23",
      "darwin-aarch64"
    );
    await rewriteEndpointPrebinding(wrongEndpoint, (value) => {
      const endpoint = value.endpoint as Record<string, unknown>;
      endpoint.requestEndpoint = "https://foreign.example.test/latest.json";
    });
    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      wrongEndpoint.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("endpoint observation requestEndpoint does not match");
  });

  it("rejects a prebinding that self-reports an attempt ID or follows accepted", async () => {
    const selfReported = await createFixture(
      "tauri-v22-to-electron-v23",
      "darwin-aarch64"
    );
    await rewriteEndpointPrebinding(selfReported, (value) => {
      value.sourceInstallAttemptId = selfReported.sourceInstallAttemptId;
    });
    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      selfReported.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("unexpected schema");

    const late = await createFixture(
      "tauri-v22-to-electron-v23",
      "windows-x86_64"
    );
    await rewriteEndpointPrebinding(late, (value) => {
      value.observedAt = "2026-09-01T00:05:00.001Z";
    });
    await expect(finalizeElectronProductionUpdaterEvidenceAttachments(
      late.finalizerInput,
      { now: () => new Date("2026-09-01T00:01:00.000Z") }
    )).rejects.toThrow("outside the visible check/install window");
  });

  it("exposes a closed file-based finalization CLI with canonical stdout", async () => {
    const fixture = await createFixture(
      "electron-v23-to-electron-v23",
      "darwin-aarch64"
    );
    let stdout = Buffer.alloc(0);
    const argumentsList = finalizerCliArguments(fixture.finalizerInput);

    const summary = await runElectronProductionUpdaterEvidenceAttachmentFinalizerCli(
      argumentsList,
      {
        now: () => new Date("2026-09-01T00:01:00.000Z"),
        writeStdout: (source) => { stdout = Buffer.from(source); }
      }
    );

    expect(JSON.parse(stdout.toString("utf8"))).toEqual(summary);
    expect(summary).toMatchObject({
      cell: fixture.cell
    });
    expect(summary.outputRoot).toBe(await realpath(fixture.finalizerInput.outputRoot));
    await expect(runElectronProductionUpdaterEvidenceAttachmentFinalizerCli([
      ...argumentsList,
      "--fallback", "older-attempt"
    ])).rejects.toThrow("Unknown updater evidence finalizer option --fallback");
  });
});

async function createFixture(
  transitionKind: ElectronProductionUpdaterEvidenceTransition,
  platform: ElectronProductionUpdaterEvidencePlatform
) {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-attachment-finalizer-"));
  roots.push(root);
  const controlRoot = join(root, "control");
  const capturedRoot = join(root, "captured");
  await mkdir(controlRoot);
  await mkdir(capturedRoot);
  const platformTarget = platform === "darwin-aarch64" ? {
    artifactName: "Rion.Studio-mac.app.tar.gz",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig",
    targetRunningImageSha256: sha256("mac-target-running-image"),
    nativeHostKind: "appkit-chromium",
    retainedAppKitHost: true
  } : {
    artifactName: "Rion.Studio-win.exe",
    signatureName: "Rion.Studio-win.exe.sig",
    targetRunningImageSha256: sha256("windows-target-running-image"),
    nativeHostKind: "bundled-chromium",
    retainedAppKitHost: false
  };
  const targetBinding = {
    artifactName: platformTarget.artifactName,
    artifactSha256: sha256(`${platform}:target-artifact`),
    candidateReceiptSha256: sha256("target-candidate-receipt"),
    embeddedUpdaterEndpoint: TARGET_ENDPOINT,
    manifestName: "latest.json" as const,
    runtime: "electron-v23" as const,
    servedManifestSha256: sha256("served-target-manifest"),
    signatureName: platformTarget.signatureName,
    signatureSha256: sha256(`${platform}:target-signature`),
    sourceSha: TARGET_SHA,
    targetRunningImageSha256: platformTarget.targetRunningImageSha256,
    updaterPublicKeySha256: sha256("production-updater-key"),
    version: TARGET_VERSION
  };
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  const sourceBinding = isTauri ? {
    artifactName: platformTarget.artifactName,
    artifactSha256: sha256(`${platform}:tauri-artifact`),
    defaultUpdaterEndpoint: TAURI_ENDPOINT,
    lineageKind: "published-release" as const,
    manifestName: "latest.json" as const,
    manifestSha256: sha256("tauri-manifest"),
    releaseTag: `v${TAURI_VERSION}`,
    runningImageSha256: sha256(`${platform}:tauri-running-image`),
    runtime: "tauri-v22" as const,
    sourceSha: TAURI_SHA,
    version: TAURI_VERSION
  } : {
    artifactName: platformTarget.artifactName,
    artifactSha256: sha256(`${platform}:prior-artifact`),
    candidateReceiptSha256: sha256("prior-candidate-receipt"),
    embeddedUpdaterEndpoint: PRIOR_ENDPOINT,
    lineageKind: "production-candidate" as const,
    manifestName: "latest.json" as const,
    manifestSha256: sha256("prior-manifest"),
    runningImageSha256: sha256(`${platform}:prior-running-image`),
    runtime: "electron-v23" as const,
    sourceSha: PRIOR_SHA,
    version: PRIOR_VERSION
  };
  const provenance = {
    artifactName:
      `electron-production-updater-terminal-evidence-${TARGET_VERSION}-` +
      `${TARGET_SHA}-attempt-1`,
    repository: "rion-tw/rion-studio-source" as const,
    runAttempt: 1,
    runId: "202",
    sourceSha: TARGET_SHA,
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW
  };
  const bindings = { provenance, sourceBinding, targetBinding };
  const bindingsPath = join(controlRoot, "bindings.json");
  await writeFile(bindingsPath, serializeCanonicalJson(bindings));
  const uuidQueue = [...UUIDS];
  const planRead = await createElectronProductionUpdaterEvidenceAttemptPlan({
    bindings: attemptPlanBindings(provenance.artifactName),
    challengeNonce: CHALLENGE_NONCE,
    outputPath: join(controlRoot,
      "electron-production-updater-evidence-attempt-plan.json")
  }, {
    now: () => new Date(ISSUE_TIME),
    randomUuid: () => uuidQueue.shift()!
  });
  const cell = planRead.plan.cells.find((candidate) =>
    candidate.platform === platform && candidate.transitionKind === transitionKind
  )!;
  const sourceInstallAttemptId = isTauri
    ? "update-install-42"
    : "update-install-20000000-0000-4000-8000-000000000004";
  const context = {
    challenge: planRead.plan.challenge,
    evidenceAttemptId: cell.evidenceAttemptId,
    platform,
    schemaVersion: 1,
    sourceInstallAttemptId,
    transitionKind
  };
  const target = withoutTargetOnlyBindings(targetBinding);
  const startedAt = "2026-09-01T00:05:00.000Z";
  const finalPhase = platform === "darwin-aarch64"
    ? "restartPending"
    : "installerHandoff";
  const phases = ["accepted", "preparing", "installing", "draining", finalPhase];
  const finalJournal = Buffer.from(JSON.stringify({
    attempt: {
      attemptId: sourceInstallAttemptId,
      phase: finalPhase,
      startedAt,
      targetVersion: TARGET_VERSION,
      updatedAt: "2026-09-01T00:09:00.000Z"
    },
    schemaVersion: 1
  }));
  const journalPath = join(capturedRoot, "source-install-journal.json");
  await writeFile(journalPath, finalJournal);
  const observations = phases.map((phase, index) => {
    const updatedAt = `2026-09-01T00:0${index + 5}:00.000Z`;
    const source = index === phases.length - 1
      ? finalJournal
      : Buffer.from(`${phase}-journal`);
    return {
      journal: { bytes: source.byteLength, sha256: sha256(source) },
      observedAt: `2026-09-01T00:0${index + 5}:30.000Z`,
      phase,
      sequence: index + 1,
      sourceInstallAttemptId,
      startedAt,
      updatedAt
    };
  });
  const trace = {
    kind: "rion-production-updater-source-journal-trace",
    observations,
    platform,
    schemaVersion: 1,
    sourceInstallAttemptId,
    targetVersion: TARGET_VERSION,
    transitionKind,
    visibleInstallInvokedAt: "2026-09-01T00:04:00.000Z"
  };
  const tracePath = join(controlRoot, "source-journal-trace.json");
  await writeFile(tracePath, serializeCanonicalJson(trace));
  const traceSha256 = sha256(await readFile(tracePath));
  const productTerminal = {
    attempt: {
      attemptId: sourceInstallAttemptId,
      phase: "applied",
      startedAt,
      targetVersion: TARGET_VERSION,
      updatedAt: "2026-09-01T00:11:00.000Z"
    },
    authority: "target-first-boot-journal-reconciliation",
    kind: "rion-updater-install-terminal",
    reconciledAt: "2026-09-01T00:11:00.000Z",
    runningVersion: TARGET_VERSION,
    schemaVersion: 1,
    sourceJournalBytes: finalJournal.byteLength,
    sourceJournalSha256: sha256(finalJournal),
    sourcePhase: finalPhase,
    terminalOutcome: "applied"
  };
  const productPath = join(capturedRoot, "product-terminal-receipt.json");
  await writeFile(productPath, JSON.stringify(productTerminal));
  const endpointPath = join(capturedRoot, "endpoint-observation.json");
  await writeFile(endpointPath, serializeCanonicalJson(endpointObservation({
    attemptPlanSha256: planRead.planIdentity.sha256,
    context: {
      challenge: planRead.plan.challenge,
      evidenceAttemptId: cell.evidenceAttemptId,
      platform,
      transitionKind
    },
    isTauri,
    sourceBinding,
    target,
    targetBinding
  })));
  const preservationPath = join(capturedRoot, "data-preservation-observation.json");
  await writeFile(preservationPath, serializeCanonicalJson({
    ...context,
    kind: "rion-production-updater-data-preservation-observation",
    observedAt: "2026-09-01T00:11:00.000Z",
    preservation: {
      afterChallengeSha256: planRead.plan.challenge.nonceSha256,
      beforeChallengeSha256: planRead.plan.challenge.nonceSha256,
      preserved: true,
      userDataIdentitySha256: sha256(`${platform}:user-data`)
    },
    target
  }));
  const nativePath = join(capturedRoot, "native-host-observation.json");
  await writeFile(nativePath, serializeCanonicalJson({
    ...context,
    kind: "rion-production-updater-native-host-observation",
    capturedAt: "2026-09-01T00:12:00.000Z",
    observedAt: "2026-09-01T00:10:00.000Z",
    runtime: {
      nativeHostKind: platformTarget.nativeHostKind,
      remoteDebugging: false,
      retainedAppKitHost: platformTarget.retainedAppKitHost,
      targetVersionObserved: TARGET_VERSION
    },
    target,
    targetRunningImageSha256: targetBinding.targetRunningImageSha256
  }));
  const checkActionPath = join(controlRoot, "check-action.json");
  const installActionPath = join(controlRoot, "install-action.json");
  await writeFile(checkActionPath, serializeCanonicalJson(visibleAction(
    "check", platform, "2026-09-01T00:01:00.000Z", "2026-09-01T00:02:00.000Z"
  )));
  await writeFile(installActionPath, serializeCanonicalJson(visibleAction(
    "install", platform, "2026-09-01T00:04:00.000Z", "2026-09-01T00:06:00.000Z"
  )));
  return {
    bindings,
    bundleRoot: join(root, "bundle"),
    cell,
    finalizerInput: {
      attemptPlanPath: planRead.planPath,
      bindingsPath,
      capturedAttachments: {
        dataPreservation: preservationPath,
        endpointObservation: endpointPath,
        nativeHostObservation: nativePath,
        productTerminalReceipt: productPath,
        sourceInstallJournal: journalPath
      },
      checkActionPath,
      expectedAttemptPlanSha256: planRead.planIdentity.sha256,
      expectedJournalTraceSha256: traceSha256,
      installActionPath,
      journalTracePath: tracePath,
      outputRoot: join(root, "finalized-attachments"),
      platform,
      transitionKind
    },
    sourceInstallAttemptId
  };
}

function attemptPlanBindings(
  aggregateArtifactName: string
): ElectronProductionUpdaterEvidenceAttemptPlanBindings {
  const repository = "rion-tw/rion-studio-source";
  const candidateWorkflow = ".github/workflows/electron-production-candidate.yml";
  return {
    schemaVersion: 1 as const,
    kind: "rion-electron-production-updater-evidence-attempt-plan-bindings" as const,
    producer: {
      aggregateArtifactName,
      controlSha: "d".repeat(40),
      repository,
      runAttempt: 1,
      runId: "202",
      workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW
    },
    upstream: {
      target: candidateIdentity(TARGET_VERSION, TARGET_SHA, "target", 3, "301"),
      priorV23: candidateIdentity(PRIOR_VERSION, PRIOR_SHA, "prior", 2, "302"),
      tauriV22: {
        artifacts: {
          "darwin-aarch64": {
            artifactName: "tauri-v22-public-lineage-darwin-aarch64-303-1",
            receiptSha256: sha256("tauri-lineage-macos")
          },
          "windows-x86_64": {
            artifactName: "tauri-v22-public-lineage-windows-x86_64-303-1",
            receiptSha256: sha256("tauri-lineage-windows")
          }
        },
        controlSha: "1".repeat(40),
        releaseTag: `v${TAURI_VERSION}`,
        repository,
        runAttempt: 1,
        runId: "303",
        sourceSha: TAURI_SHA,
        targetSourceSha: TARGET_SHA,
        version: TAURI_VERSION,
        workflow: ".github/workflows/electron-updater-tauri-v22-compatibility.yml"
      },
      provisionalPublication: {
        artifactName:
          `electron-production-publication-provisional-${TARGET_VERSION}-` +
          `${TARGET_SHA}-attempt-1`,
        controlSha: "2".repeat(40),
        receiptSha256: sha256("provisional-publication"),
        repository,
        revision: 1,
        runAttempt: 1,
        runId: "304",
        transactionId: "70000000-0000-4000-8000-000000000007",
        workflow: ".github/workflows/electron-production-provisional-publish.yml"
      }
    }
  };

  function candidateIdentity(
    version: string,
    sourceSha: string,
    label: "target" | "prior",
    runAttempt: number,
    runId: string
  ): ElectronProductionUpdaterEvidenceCandidateIdentity {
    return {
      artifactName:
        `electron-production-candidate-${version}-${sourceSha}-attempt-${runAttempt}`,
      candidateReceiptSha256: sha256(`${label}-candidate-receipt`),
      controlSha: (label === "target" ? "e" : "f").repeat(40),
      repository,
      runAttempt,
      runId,
      sourceSha,
      trustedControlReceiptSha256: sha256(`${label}-trusted-control`),
      version,
      workflow: candidateWorkflow
    };
  }
}

function endpointObservation(input: {
  attemptPlanSha256: string;
  context: Record<string, unknown>;
  isTauri: boolean;
  sourceBinding: Record<string, unknown>;
  target: Record<string, unknown>;
  targetBinding: Record<string, unknown>;
}) {
  const tagged =
    `https://github.com/rion-tw/rion-studio/releases/download/v${TARGET_VERSION}/latest.json`;
  const asset = "https://release-assets.githubusercontent.com/release/123/latest.json?token=x";
  const requestEndpoint = input.isTauri ? TAURI_ENDPOINT : PRIOR_ENDPOINT;
  const redirects = input.isTauri ? [
    redirect(1, TAURI_ENDPOINT, tagged),
    redirect(2, tagged, asset)
  ] : [];
  const finalUrl = input.isTauri ? asset : requestEndpoint;
  const final = new URL(finalUrl);
  return {
    attemptPlanSha256: input.attemptPlanSha256,
    ...input.context,
    endpoint: {
      artifactName: input.target.artifactName,
      artifactSha256: input.target.artifactSha256,
      final: {
        host: final.hostname,
        scheme: final.protocol,
        status: 200,
        urlSha256: sha256(finalUrl)
      },
      manifestName: "latest.json",
      redirectCount: redirects.length,
      redirects,
      requestEndpoint,
      servedManifestSha256: input.target.servedManifestSha256,
      signatureName: input.target.signatureName,
      signatureSha256: input.target.signatureSha256,
      status: 200,
      targetEmbeddedUpdaterEndpoint: TARGET_ENDPOINT,
      updaterPublicKeySha256: input.targetBinding.updaterPublicKeySha256
    },
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
    schemaVersion: 1,
    observedAt: "2026-09-01T00:03:00.000Z"
  };
}

function redirect(sequence: number, fromValue: string, toValue: string) {
  const from = new URL(fromValue);
  const to = new URL(toValue);
  return {
    fromHost: from.hostname,
    fromScheme: from.protocol,
    fromUrlSha256: sha256(fromValue),
    locationUrlSha256: sha256(toValue),
    sequence,
    status: 302,
    toHost: to.hostname,
    toScheme: to.protocol
  };
}

function visibleAction(
  action: "check" | "install",
  platform: ElectronProductionUpdaterEvidencePlatform,
  invokedAt: string,
  completedAt: string
) {
  return {
    action,
    completedAt,
    controlName: action === "check" ? "Check updates" : "Restart and update",
    interaction: "visible-os-accessibility-press",
    invokedAt,
    kind: "rion-production-updater-visible-ui-action",
    platform: platform === "darwin-aarch64" ? "darwin" : "win32",
    processId: 4242,
    remoteDebugging: false,
    schemaVersion: 1
  };
}

function finalizerCliArguments(input: Awaited<ReturnType<typeof createFixture>>[
  "finalizerInput"
]) {
  return [
    "finalize",
    "--attempt-plan", input.attemptPlanPath,
    "--bindings", input.bindingsPath,
    "--check-action", input.checkActionPath,
    "--data-preservation", input.capturedAttachments.dataPreservation,
    "--endpoint-observation", input.capturedAttachments.endpointObservation,
    "--expected-attempt-plan-sha256", input.expectedAttemptPlanSha256,
    "--expected-journal-trace-sha256", input.expectedJournalTraceSha256,
    "--install-action", input.installActionPath,
    "--journal-trace", input.journalTracePath,
    "--native-host-observation", input.capturedAttachments.nativeHostObservation,
    "--output-root", input.outputRoot,
    "--platform", input.platform,
    "--product-terminal-receipt", input.capturedAttachments.productTerminalReceipt,
    "--source-install-journal", input.capturedAttachments.sourceInstallJournal,
    "--transition-kind", input.transitionKind
  ];
}

function withoutTargetOnlyBindings(binding: Record<string, unknown>) {
  const {
    targetRunningImageSha256: _targetRunningImageSha256,
    updaterPublicKeySha256: _updaterPublicKeySha256,
    ...target
  } = binding;
  return target;
}

async function rewriteEndpointPrebinding(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mutate: (value: Record<string, unknown>) => void
) {
  const endpointPath = fixture.finalizerInput.capturedAttachments.endpointObservation;
  const value = JSON.parse(await readFile(endpointPath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(endpointPath, serializeCanonicalJson(value));
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
