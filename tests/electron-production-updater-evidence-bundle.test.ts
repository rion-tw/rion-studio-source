import { createHash } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  readElectronProductionUpdaterEvidenceAggregate
} from "../scripts/electronProductionUpdaterEvidenceAggregate.mjs";
import {
  runElectronProductionUpdaterEvidenceAggregateCli
} from "../scripts/electronProductionUpdaterEvidenceAggregateCli.mjs";
import {
  createElectronProductionUpdaterEvidenceAttemptPlan
} from "../scripts/electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  assembleElectronProductionUpdaterEvidenceBundle,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW,
  readElectronProductionUpdaterEvidenceBundle,
  type ElectronProductionUpdaterEvidenceAttachmentName,
  type ElectronProductionUpdaterEvidencePlatform,
  type ElectronProductionUpdaterEvidenceProvenance,
  type ElectronProductionUpdaterEvidenceTransition,
  type ElectronProductionUpdaterSourceBinding,
  type ElectronProductionUpdaterTargetBinding
} from "../scripts/electronProductionUpdaterEvidenceBundle.mjs";

const SOURCE_SHA = "b".repeat(40);
const TAURI_SOURCE_SHA = "c".repeat(40);
const TARGET_SHA = "a".repeat(40);
const SOURCE_VERSION = "8.5.0";
const TAURI_VERSION = "8.4.2";
const TARGET_VERSION = "8.6.0";
const SOURCE_ENDPOINT = "https://updates.example.test/rion/v23/source/latest.json";
const TARGET_ENDPOINT = "https://updates.example.test/rion/v23/target/latest.json";
const TAURI_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAURI_FINAL_ENDPOINT =
  "https://release-assets.githubusercontent.com/release/123/latest.json?token=redacted";
const EVIDENCE_ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const ELECTRON_SOURCE_ATTEMPT_ID =
  "update-install-10000000-0000-4000-8000-000000000002";
const CHALLENGE_NONCE = Buffer.alloc(32, 0x5a);
const CHALLENGE_SHA256 = sha256(CHALLENGE_NONCE);
const CHALLENGE_ID = "90000000-0000-4000-8000-000000000009";
const PLAN_NOW = "2026-09-01T00:00:00.000Z";
const SOURCE_EVENT_TIMES = [
  "2026-09-01T00:10:00Z",
  "2026-09-01T00:12:00Z",
  "2026-09-01T00:15:00Z",
  "2026-09-01T00:18:00Z",
  "2026-09-01T00:19:00Z",
  "2026-09-01T00:20:00Z",
  "2026-09-01T00:22:00Z",
  "2026-09-01T00:25:00Z",
  "2026-09-01T00:30:00Z"
] as const;
const SOURCE_EVENTS = [
  ["source-updater-invoked", "checking"],
  ["target-manifest-observed", "checking"],
  ["target-artifact-verified", "downloaded"],
  ["source-install-accepted", "accepted"],
  ["source-install-prepared", "installing"],
  ["source-drain-started", "draining"],
  ["source-handoff", null],
  ["target-first-boot", null],
  ["target-terminal", "applied"]
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("Electron production updater evidence bundle", () => {
  it.each([
    ["electron-v23-to-electron-v23", "darwin-aarch64"],
    ["electron-v23-to-electron-v23", "windows-x86_64"],
    ["tauri-v22-to-electron-v23", "darwin-aarch64"],
    ["tauri-v22-to-electron-v23", "windows-x86_64"]
  ] as const)("assembles and re-verifies %s on %s", async (transition, platform) => {
    const fixture = await createFixture(platform, transition);
    const before = await readAttachmentSources(fixture.attachments);

    const bundle = await assembleElectronProductionUpdaterEvidenceBundle(fixture.input);

    expect((await readdir(fixture.outputRoot)).sort()).toEqual([
      ...ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME
    ].sort());
    expect(bundle.receipt).toMatchObject({
      cutoverEligible: true,
      platform,
      transitionKind: transition,
      transaction: {
        deadlineUsedAsSuccess: false,
        sourceUpdaterInvoked: true,
        terminalAuthority: "target-first-boot-journal-reconciliation",
        terminalOutcome: "applied"
      }
    });
    expect(Object.keys(fixture.input).sort()).toEqual([
      "attachments",
      "outputRoot",
      "provenance",
      "sourceBinding",
      "targetBinding"
    ]);
    expect(await readFile(
      join(fixture.outputRoot, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME)
    )).toEqual(serializeCanonicalJson(bundle.receipt));
    expect(await readAttachmentSources(fixture.attachments)).toEqual(before);
    for (const name of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES) {
      expect(await readFile(join(fixture.outputRoot, name))).toEqual(before[name]);
    }

    const reread = await readElectronProductionUpdaterEvidenceBundle({
      expectedReceiptSha256: bundle.receiptSha256,
      outputRoot: fixture.outputRoot
    });
    expect(reread).toEqual(bundle);
  });

  it("rejects attachment tampering when re-reading the closed bundle", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await assembleElectronProductionUpdaterEvidenceBundle(fixture.input);
    const endpointPath = join(fixture.outputRoot, "endpoint-observation.json");
    await writeFile(endpointPath, `${await readFile(endpointPath, "utf8")} `);

    await expect(
      readElectronProductionUpdaterEvidenceBundle({ outputRoot: fixture.outputRoot })
    ).rejects.toThrow("does not match its observed attachments");
  });

  it("rejects unknown attachment schema before creating an output root", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await rewriteJson(fixture.attachments["endpoint-observation.json"], (value) => {
      value.producerApplied = true;
    });

    await expect(
      assembleElectronProductionUpdaterEvidenceBundle(fixture.input)
    ).rejects.toThrow("endpoint observation schema is not exact");
    await expect(readdir(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed raw source journal not bound by the product receipt", async () => {
    const fixture = await createFixture("windows-x86_64");
    await rewriteJson(fixture.attachments["source-install-journal.json"], (value) => {
      const attempt = value.attempt as Record<string, unknown>;
      attempt.updatedAt = "2026-09-01T00:23:00Z";
    });

    await expect(
      assembleElectronProductionUpdaterEvidenceBundle(fixture.input)
    ).rejects.toThrow("product terminal raw source journal SHA-256 does not match");
  });

  it("binds the external target record to the actual product terminal receipt", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await rewriteJson(fixture.attachments["target-terminal-record.json"], (value) => {
      value.productTerminalReceiptSha256 = sha256("forged-product-terminal-receipt");
    });

    await expect(
      assembleElectronProductionUpdaterEvidenceBundle(fixture.input)
    ).rejects.toThrow("target terminal product receipt SHA-256 does not match");
  });

  it("rejects an unknown canonical receipt field and a non-exact inventory", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await assembleElectronProductionUpdaterEvidenceBundle(fixture.input);
    const receiptPath = join(
      fixture.outputRoot,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.producerApplied = true;
    await writeFile(receiptPath, serializeCanonicalJson(receipt));

    await expect(
      readElectronProductionUpdaterEvidenceBundle({ outputRoot: fixture.outputRoot })
    ).rejects.toThrow("terminal evidence receipt schema is not exact");

    delete receipt.producerApplied;
    await writeFile(receiptPath, serializeCanonicalJson(receipt));
    await writeFile(join(fixture.outputRoot, "unexpected.json"), "{}\n");
    await expect(
      readElectronProductionUpdaterEvidenceBundle({ outputRoot: fixture.outputRoot })
    ).rejects.toThrow("evidence bundle inventory is not exact");
  });

  it("requires a create-new output root", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await mkdir(fixture.outputRoot);

    await expect(
      assembleElectronProductionUpdaterEvidenceBundle(fixture.input)
    ).rejects.toThrow("output root must be create-new");
  });

  it("rejects a multiply linked observer attachment", async () => {
    const fixture = await createFixture("darwin-aarch64");
    const sourcePath = fixture.attachments["source-install-journal.json"];
    await link(sourcePath, `${sourcePath}.hardlink`);

    await expect(
      assembleElectronProductionUpdaterEvidenceBundle(fixture.input)
    ).rejects.toThrow("bounded, nonempty, single-link regular file");
  });
});

describe("Electron production updater evidence aggregate", () => {
  it("requires one exact, shared-challenge bundle for every transition and platform", async () => {
    const fixtures = await createAggregateFixture();

    const aggregate = await readElectronProductionUpdaterEvidenceAggregate({
      ...aggregateReadInput(fixtures)
    });

    expect(aggregate.evidenceAttemptIds).toHaveLength(4);
    expect(Object.keys(aggregate.bundles)).toEqual([
      "electron-v23-to-electron-v23",
      "tauri-v22-to-electron-v23"
    ]);
    expect(aggregate.target).toMatchObject({
      sourceSha: TARGET_SHA,
      version: TARGET_VERSION
    });
  });

  it("rejects an unknown aggregate sibling", async () => {
    const fixtures = await createAggregateFixture();
    await writeFile(join(fixtures.aggregateRoot, "untrusted.json"), "{}\n");

    await expect(readElectronProductionUpdaterEvidenceAggregate({
      ...aggregateReadInput(fixtures)
    })).rejects.toThrow("aggregate root inventory is not exact");
  });

  it("rejects a reused evidence attempt ID that cannot match the sealed plan", async () => {
    const fixtures = await createAggregateFixture({ reuseAttemptId: true });

    await expect(readElectronProductionUpdaterEvidenceAggregate({
      ...aggregateReadInput(fixtures)
    })).rejects.toThrow("planned evidence attempt ID does not match");
  });

  it("cross-binds both source lineages to the sealed attempt plan", async () => {
    const fixtures = await createAggregateFixture();
    const input = aggregateReadInput(fixtures);

    await expect(readElectronProductionUpdaterEvidenceAggregate({
      ...input,
      expectedSources: {
        ...input.expectedSources,
        priorV23: {
          ...input.expectedSources.priorV23,
          sourceSha: "9".repeat(40)
        }
      }
    })).rejects.toThrow("electron-v23-to-electron-v23 source SHA does not match");
  });

  it("cross-binds the target candidate receipt to the sealed attempt plan", async () => {
    const fixtures = await createAggregateFixture();
    const input = aggregateReadInput(fixtures);

    await expect(readElectronProductionUpdaterEvidenceAggregate({
      ...input,
      expectedTarget: {
        ...input.expectedTarget,
        candidateReceiptSha256: sha256("different-target-candidate")
      }
    })).rejects.toThrow("target candidate receipt SHA-256 does not match");
  });

  it("exposes a strict canonical aggregate verification CLI", async () => {
    const fixtures = await createAggregateFixture();
    let stdout = Buffer.alloc(0);

    const summary = await runElectronProductionUpdaterEvidenceAggregateCli([
      "verify",
      "--aggregate-root", fixtures.aggregateRoot,
      "--attempt-plan", fixtures.planPath,
      "--expected-attempt-plan-sha256", fixtures.planSha256
    ], {
      now: () => new Date(PLAN_NOW),
      writeStdout: (source) => {
        stdout = Buffer.from(source);
      }
    });

    expect(JSON.parse(stdout.toString("utf8"))).toEqual(summary);
    expect(summary).toMatchObject({
      status: "verified",
      artifactName: fixtures.expectedProvenance.artifactName,
      attemptPlanSha256: fixtures.planSha256,
      challengeId: fixtures.expectedChallenge.id,
      plannedCells: fixtures.expectedCellMap
    });
    await expect(runElectronProductionUpdaterEvidenceAggregateCli([
      "verify",
      "--aggregate-root", fixtures.aggregateRoot,
      "--attempt-plan", fixtures.planPath,
      "--expected-attempt-plan-sha256", fixtures.planSha256,
      "--fallback", "older-attempt"
    ])).rejects.toThrow("Unknown updater evidence aggregate option --fallback");
  });
});

async function createFixture(
  platform: ElectronProductionUpdaterEvidencePlatform,
  transition: ElectronProductionUpdaterEvidenceTransition =
    "electron-v23-to-electron-v23",
  evidenceAttemptId = EVIDENCE_ATTEMPT_ID
) {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-evidence-bundle-"));
  temporaryDirectories.push(root);
  const observerRoot = join(root, "observer-output");
  const outputRoot = join(root, "assembled-bundle");
  await mkdir(observerRoot);

  const platformBinding = platform === "darwin-aarch64" ? {
    artifactName: "Rion.Studio-mac.app.tar.gz",
    nativeHostKind: "appkit-chromium",
    retainedAppKitHost: true,
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  } : {
    artifactName: "Rion.Studio-win.exe",
    nativeHostKind: "bundled-chromium",
    retainedAppKitHost: false,
    signatureName: "Rion.Studio-win.exe.sig"
  };
  const isTauri = transition === "tauri-v22-to-electron-v23";
  const sourceBinding: ElectronProductionUpdaterSourceBinding = isTauri ? {
    artifactName: platformBinding.artifactName,
    artifactSha256: sha256(`${platform}:tauri-source-artifact`),
    defaultUpdaterEndpoint: TAURI_ENDPOINT,
    lineageKind: "published-release",
    manifestName: "latest.json",
    manifestSha256: sha256("tauri-source-latest-json"),
    releaseTag: `v${TAURI_VERSION}`,
    runningImageSha256: sha256(`${platform}:tauri-source-running-image`),
    runtime: "tauri-v22",
    sourceSha: TAURI_SOURCE_SHA,
    version: TAURI_VERSION
  } : {
    artifactName: platformBinding.artifactName,
    artifactSha256: sha256(`${platform}:source-artifact`),
    candidateReceiptSha256: sha256("source-candidate-receipt"),
    embeddedUpdaterEndpoint: SOURCE_ENDPOINT,
    lineageKind: "production-candidate",
    manifestName: "latest.json",
    manifestSha256: sha256("source-latest-json"),
    runningImageSha256: sha256(`${platform}:source-running-image`),
    runtime: "electron-v23",
    sourceSha: SOURCE_SHA,
    version: SOURCE_VERSION
  };
  const targetBinding: ElectronProductionUpdaterTargetBinding = {
    artifactName: platformBinding.artifactName,
    artifactSha256: sha256(`${platform}:target-artifact`),
    candidateReceiptSha256: sha256("target-candidate-receipt"),
    embeddedUpdaterEndpoint: TARGET_ENDPOINT,
    manifestName: "latest.json",
    runtime: "electron-v23",
    servedManifestSha256: sha256("target-latest-json"),
    signatureName: platformBinding.signatureName,
    signatureSha256: sha256(`${platform}:target-signature`),
    sourceSha: TARGET_SHA,
    targetRunningImageSha256: sha256(`${platform}:target-running-image`),
    updaterPublicKeySha256: sha256("production-updater-public-key"),
    version: TARGET_VERSION
  };
  const target = withoutTargetOnlyBindings(targetBinding);
  const challenge = {
    expiresAt: "2026-09-02T00:00:00.000Z",
    id: CHALLENGE_ID,
    issuedAt: PLAN_NOW,
    nonceSha256: CHALLENGE_SHA256
  };
  const context = {
    challenge,
    evidenceAttemptId,
    platform,
    schemaVersion: 1,
    sourceInstallAttemptId: isTauri ? "update-install-1" : ELECTRON_SOURCE_ATTEMPT_ID,
    transitionKind: transition
  } as const;
  const sourceSnapshotPath = join(observerRoot, "source-release-snapshot.json");
  await writeJson(sourceSnapshotPath, {
    ...context,
    capturedAt: "2026-09-01T00:05:00Z",
    kind: "rion-production-updater-source-release-snapshot",
    source: sourceBinding
  });
  const source = {
    ...sourceBinding,
    releaseSnapshotSha256: sha256(await readFile(sourceSnapshotPath))
  };
  const sourceHandoffPhase = platform === "darwin-aarch64"
    ? "restartPending"
    : "installerHandoff";
  const sourceInstallAttemptId = context.sourceInstallAttemptId;
  const sourceJournalPath = join(observerRoot, "source-install-journal.json");
  await writeJson(sourceJournalPath, {
    attempt: {
      attemptId: sourceInstallAttemptId,
      phase: sourceHandoffPhase,
      startedAt: SOURCE_EVENT_TIMES[3],
      targetVersion: TARGET_VERSION,
      updatedAt: SOURCE_EVENT_TIMES[6]
    },
    schemaVersion: 1
  });
  const sourceJournal = await readFile(sourceJournalPath);
  const productReceipt = {
    attempt: {
      attemptId: sourceInstallAttemptId,
      phase: "applied",
      startedAt: SOURCE_EVENT_TIMES[3],
      targetVersion: TARGET_VERSION,
      updatedAt: SOURCE_EVENT_TIMES[8]
    },
    authority: "target-first-boot-journal-reconciliation",
    kind: "rion-updater-install-terminal",
    reconciledAt: SOURCE_EVENT_TIMES[8],
    runningVersion: TARGET_VERSION,
    schemaVersion: 1,
    sourceJournalBytes: sourceJournal.length,
    sourceJournalSha256: sha256(sourceJournal),
    sourcePhase: sourceHandoffPhase,
    terminalOutcome: "applied"
  };
  const productReceiptPath = join(observerRoot, "product-terminal-receipt.json");
  await writeJson(productReceiptPath, productReceipt);
  const events = SOURCE_EVENTS.map(([event, phase], index) => ({
    ...context,
    event,
    kind: "rion-production-updater-source-event",
    observedAt: SOURCE_EVENT_TIMES[index],
    phase: phase ?? sourceHandoffPhase,
    sequence: index + 1,
    source,
    target
  }));
  await writeFile(
    join(observerRoot, "source-event-stream.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  const sourceEndpoint = isTauri ? TAURI_ENDPOINT : SOURCE_ENDPOINT;
  const targetTaggedEndpoint =
    `https://github.com/rion-tw/rion-studio/releases/download/v${TARGET_VERSION}/latest.json`;
  const redirectUrls = isTauri ? [
    [TAURI_ENDPOINT, targetTaggedEndpoint],
    [targetTaggedEndpoint, TAURI_FINAL_ENDPOINT]
  ] as const : [];
  const redirects = redirectUrls.map(([fromSource, toSource], index) => {
    const from = new URL(fromSource);
    const to = new URL(toSource);
    return {
      fromHost: from.hostname,
      fromScheme: from.protocol,
      fromUrlSha256: sha256(fromSource),
      locationUrlSha256: sha256(toSource),
      sequence: index + 1,
      status: 302,
      toHost: to.hostname,
      toScheme: to.protocol
    };
  });
  const finalEndpoint = isTauri ? TAURI_FINAL_ENDPOINT : SOURCE_ENDPOINT;
  const endpoint = new URL(finalEndpoint);
  await writeJson(join(observerRoot, "endpoint-observation.json"), {
    ...context,
    endpoint: {
      artifactName: target.artifactName,
      artifactSha256: target.artifactSha256,
      final: {
        host: endpoint.hostname,
        scheme: endpoint.protocol,
        status: 200,
        urlSha256: sha256(finalEndpoint)
      },
      manifestName: target.manifestName,
      redirectCount: redirects.length,
      redirects,
      requestEndpoint: sourceEndpoint,
      servedManifestSha256: target.servedManifestSha256,
      signatureName: target.signatureName,
      signatureSha256: target.signatureSha256,
      status: 200,
      targetEmbeddedUpdaterEndpoint: TARGET_ENDPOINT,
      updaterPublicKeySha256: targetBinding.updaterPublicKeySha256
    },
    kind: "rion-production-updater-endpoint-observation",
    observedAt: SOURCE_EVENT_TIMES[1]
  });
  const preservation = {
    afterChallengeSha256: CHALLENGE_SHA256,
    beforeChallengeSha256: CHALLENGE_SHA256,
    preserved: true,
    userDataIdentitySha256: sha256(`${platform}:user-data`)
  };
  await writeJson(join(observerRoot, "data-preservation-observation.json"), {
    ...context,
    kind: "rion-production-updater-data-preservation-observation",
    observedAt: SOURCE_EVENT_TIMES[8],
    preservation,
    target
  });
  await writeJson(join(observerRoot, "native-host-observation.json"), {
    ...context,
    capturedAt: SOURCE_EVENT_TIMES[8],
    kind: "rion-production-updater-native-host-observation",
    observedAt: SOURCE_EVENT_TIMES[7],
    runtime: {
      nativeHostKind: platformBinding.nativeHostKind,
      remoteDebugging: false,
      retainedAppKitHost: platformBinding.retainedAppKitHost,
      targetVersionObserved: TARGET_VERSION
    },
    target,
    targetRunningImageSha256: targetBinding.targetRunningImageSha256
  });
  await writeJson(join(observerRoot, "target-terminal-record.json"), {
    ...context,
    deadlineUsedAsSuccess: false,
    firstBoot: true,
    journal: {
      attemptId: sourceInstallAttemptId,
      phase: "applied",
      reconciled: true,
      reconciledAt: productReceipt.reconciledAt,
      targetVersion: TARGET_VERSION
    },
    kind: "rion-production-updater-target-terminal-record",
    productTerminalReceiptSha256: sha256(await readFile(productReceiptPath)),
    recordedAt: SOURCE_EVENT_TIMES[8],
    target,
    targetRunningImageSha256: targetBinding.targetRunningImageSha256,
    terminalAuthority: productReceipt.authority,
    terminalOutcome: productReceipt.terminalOutcome
  });

  const attachments = Object.fromEntries(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
      name,
      join(observerRoot, name)
    ])
  ) as Record<ElectronProductionUpdaterEvidenceAttachmentName, string>;
  const provenance: ElectronProductionUpdaterEvidenceProvenance = {
    artifactName:
      `electron-production-updater-terminal-evidence-${TARGET_VERSION}-${TARGET_SHA}-attempt-1`,
    repository: "rion-tw/rion-studio-source",
    runAttempt: 1,
    runId: "202",
    sourceSha: TARGET_SHA,
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW
  };
  return {
    attachments,
    input: { attachments, outputRoot, provenance, sourceBinding, targetBinding },
    outputRoot
  } as const;
}

async function createAggregateFixture(options: { reuseAttemptId?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-evidence-aggregate-"));
  temporaryDirectories.push(root);
  const aggregateRoot = join(root, "aggregate");
  await mkdir(aggregateRoot);
  const combinations = [
    ["electron-v23-to-electron-v23", "darwin-aarch64"],
    ["electron-v23-to-electron-v23", "windows-x86_64"],
    ["tauri-v22-to-electron-v23", "darwin-aarch64"],
    ["tauri-v22-to-electron-v23", "windows-x86_64"]
  ] as const;
  const fixtures = [];
  for (const [transition, platform] of combinations) {
    const index = fixtures.length + 1;
    const evidenceAttemptId = options.reuseAttemptId
      ? EVIDENCE_ATTEMPT_ID
      : `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const fixture = await createFixture(platform, transition, evidenceAttemptId);
    await assembleElectronProductionUpdaterEvidenceBundle(fixture.input);
    const destination = join(aggregateRoot, transition, platform);
    await mkdir(join(aggregateRoot, transition), { recursive: true });
    await cp(fixture.outputRoot, destination, { recursive: true });
    fixtures.push(fixture);
  }
  const plannedIds = [
    CHALLENGE_ID,
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002"
  ];
  const planRead = await createElectronProductionUpdaterEvidenceAttemptPlan({
    bindings: attemptPlanBindings(fixtures[0]!.input.provenance),
    challengeNonce: CHALLENGE_NONCE,
    outputPath: join(root, "electron-production-updater-evidence-attempt-plan.json")
  }, {
    now: () => new Date(PLAN_NOW),
    randomUuid: () => plannedIds.shift()!
  });
  const expectedCellMap = {
    "tauri-v22-to-electron-v23": {
      "darwin-aarch64": planRead.plan.cells[0]!.evidenceAttemptId,
      "windows-x86_64": planRead.plan.cells[1]!.evidenceAttemptId
    },
    "electron-v23-to-electron-v23": {
      "darwin-aarch64": planRead.plan.cells[2]!.evidenceAttemptId,
      "windows-x86_64": planRead.plan.cells[3]!.evidenceAttemptId
    }
  };
  return {
    aggregateRoot,
    expectedCellMap,
    expectedCells: planRead.plan.cells,
    expectedChallenge: planRead.plan.challenge,
    expectedProvenance: fixtures[0]!.input.provenance,
    expectedSources: {
      priorV23: {
        candidateReceiptSha256: planRead.plan.upstream.priorV23.candidateReceiptSha256,
        sourceSha: planRead.plan.upstream.priorV23.sourceSha,
        version: planRead.plan.upstream.priorV23.version
      },
      tauriV22: {
        sourceSha: planRead.plan.upstream.tauriV22.sourceSha,
        version: planRead.plan.upstream.tauriV22.version
      }
    },
    expectedTarget: {
      candidateReceiptSha256: planRead.plan.upstream.target.candidateReceiptSha256,
      sourceSha: planRead.plan.upstream.target.sourceSha,
      version: planRead.plan.upstream.target.version
    },
    planPath: planRead.planPath,
    planSha256: planRead.planIdentity.sha256
  };
}

function aggregateReadInput(
  fixtures: Awaited<ReturnType<typeof createAggregateFixture>>
) {
  return {
    aggregateRoot: fixtures.aggregateRoot,
    expectedCells: fixtures.expectedCells,
    expectedChallenge: fixtures.expectedChallenge,
    expectedProvenance: fixtures.expectedProvenance,
    expectedSources: fixtures.expectedSources,
    expectedTarget: fixtures.expectedTarget
  };
}

function attemptPlanBindings(provenance: ElectronProductionUpdaterEvidenceProvenance) {
  const repository = "rion-tw/rion-studio-source";
  const candidateWorkflow = ".github/workflows/electron-production-candidate.yml";
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-updater-evidence-attempt-plan-bindings",
    producer: {
      aggregateArtifactName: provenance.artifactName,
      controlSha: "d".repeat(40),
      repository,
      runAttempt: provenance.runAttempt,
      runId: provenance.runId,
      workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW
    },
    upstream: {
      target: {
        artifactName:
          `electron-production-candidate-${TARGET_VERSION}-${TARGET_SHA}-attempt-3`,
        candidateReceiptSha256: sha256("target-candidate-receipt"),
        controlSha: "e".repeat(40),
        repository,
        runAttempt: 3,
        runId: "301",
        sourceSha: TARGET_SHA,
        trustedControlReceiptSha256: sha256("target-trusted-control"),
        version: TARGET_VERSION,
        workflow: candidateWorkflow
      },
      priorV23: {
        artifactName:
          `electron-production-candidate-${SOURCE_VERSION}-${SOURCE_SHA}-attempt-2`,
        candidateReceiptSha256: sha256("source-candidate-receipt"),
        controlSha: "f".repeat(40),
        repository,
        runAttempt: 2,
        runId: "302",
        sourceSha: SOURCE_SHA,
        trustedControlReceiptSha256: sha256("source-trusted-control"),
        version: SOURCE_VERSION,
        workflow: candidateWorkflow
      },
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
        sourceSha: TAURI_SOURCE_SHA,
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
  } as const;
}

function withoutTargetOnlyBindings(binding: ElectronProductionUpdaterTargetBinding) {
  const {
    targetRunningImageSha256: _targetRunningImageSha256,
    updaterPublicKeySha256: _updaterPublicKeySha256,
    ...target
  } = binding;
  return target;
}

async function readAttachmentSources(
  attachments: Record<ElectronProductionUpdaterEvidenceAttachmentName, string>
) {
  return Object.fromEntries(await Promise.all(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map(async (name) => [
      name,
      await readFile(attachments[name])
    ])
  )) as Record<ElectronProductionUpdaterEvidenceAttachmentName, Buffer>;
}

async function rewriteJson(
  path: string,
  mutate: (value: Record<string, unknown>) => void
) {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeJson(path, value);
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
