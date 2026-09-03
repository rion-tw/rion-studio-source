import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE,
  assertElectronProductionUpdaterDataPreservationObservation,
  finalizeElectronProductionUpdaterDataPreservation
} from "./electronProductionUpdaterDataPreservationObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
  assembleElectronProductionUpdaterEvidenceBundle,
  readElectronProductionUpdaterEvidenceBundle
} from "./electronProductionUpdaterEvidenceBundle.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND,
  finalizeElectronProductionUpdaterEvidenceAttachments
} from "./electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";
import {
  readElectronProductionUpdaterEvidenceAttemptPlan
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  readElectronProductionUpdaterJournalTrace
} from "./electronProductionUpdaterJournalTraceObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";
import {
  discoverAndObserveElectronProductionUpdaterTargetProcess
} from "./electronProductionUpdaterTargetProcessObservation.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND,
  ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME,
  observeElectronProductionUpdaterTerminalReceipt
} from "./electronProductionUpdaterTerminalReceiptObserver.mjs";
import {
  assertEqual,
  assertExactKeys,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredDigest,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CONTEXT_FILE =
  "data-preservation-context.json";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const TARGET_BINDING_KEYS = Object.freeze([
  "artifactName",
  "artifactSha256",
  "candidateReceiptSha256",
  "embeddedUpdaterEndpoint",
  "manifestName",
  "runtime",
  "servedManifestSha256",
  "signatureName",
  "signatureSha256",
  "sourceSha",
  "targetRunningImageSha256",
  "updaterPublicKeySha256",
  "version"
]);
const PROVENANCE_KEYS = Object.freeze([
  "artifactName",
  "repository",
  "runAttempt",
  "runId",
  "sourceSha",
  "workflow"
]);

export async function coordinateElectronProductionUpdaterPostInstallCell(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "attachmentOutputRoot",
    "attemptPlanPath",
    "bindingsPath",
    "bundleOutputRoot",
    "checkActionPath",
    "dataPreservationBeforePath",
    "dataPreservationContextOutputPath",
    "dataPreservationObservationOutputPath",
    "endpointObservationPath",
    "expectedAttemptPlanSha256",
    "expectedDataPreservationBeforeSha256",
    "expectedJournalTraceSha256",
    "installActionPath",
    "journalTracePath",
    "nativeHostObservationPath",
    "platform",
    "productTerminalReceiptOutputPath",
    "signal",
    "sourceInstallJournalPath",
    "targetExecutablePath",
    "targetLaunchArgumentsOutputPath",
    "targetProcess",
    "targetUserDataDirectory",
    "transitionKind"
  ], "updater post-install cell coordination input");
  const dependencies = resolveDependencies(dependencyOverrides);
  const platform = requiredEnum(input.platform, PLATFORMS,
    "updater post-install platform");
  const transitionKind = requiredEnum(input.transitionKind, TRANSITIONS,
    "updater post-install transition");
  const signal = requiredAbortSignal(input.signal);
  const expectedAttemptPlanSha256 = requiredDigest(
    input.expectedAttemptPlanSha256,
    "updater evidence attempt-plan SHA-256"
  );
  const expectedJournalTraceSha256 = requiredDigest(
    input.expectedJournalTraceSha256,
    "source journal trace SHA-256"
  );
  const expectedBeforeSha256 = requiredDigest(
    input.expectedDataPreservationBeforeSha256,
    "data-preservation before receipt SHA-256"
  );
  const nowDependencies = dependencies.now === undefined
    ? {}
    : { now: dependencies.now };

  const [planRead, traceRead, bindingsFile] = await Promise.all([
    dependencies.readAttemptPlan({
      expectedSha256: expectedAttemptPlanSha256,
      planPath: requiredAbsolutePath(input.attemptPlanPath,
        "updater evidence attempt plan")
    }, nowDependencies),
    dependencies.readJournalTrace({
      expectedSha256: expectedJournalTraceSha256,
      tracePath: requiredAbsolutePath(input.journalTracePath,
        "source journal trace")
    }),
    readCanonicalJsonFile(
      requiredAbsolutePath(input.bindingsPath,
        "updater evidence bundle bindings"),
      MAX_DOCUMENT_BYTES,
      "updater evidence bundle bindings"
    )
  ]);
  assertEqual(planRead.planIdentity.sha256, expectedAttemptPlanSha256,
    "updater evidence attempt-plan SHA-256");
  assertEqual(traceRead.traceIdentity.sha256, expectedJournalTraceSha256,
    "source journal trace SHA-256");
  const cell = selectedCell(planRead.plan, platform, transitionKind);
  const trace = traceRead.trace;
  assertEqual(trace.platform, platform, "source journal trace platform");
  assertEqual(trace.transitionKind, transitionKind,
    "source journal trace transition");
  assertEqual(trace.targetVersion, planRead.plan.upstream.target.version,
    "source journal trace target version");
  const bindings = assertBindings(
    bindingsFile.value,
    planRead.plan,
    transitionKind
  );

  const productTerminalReceiptOutputPath = await resolveCreateNewFile(
    input.productTerminalReceiptOutputPath,
    ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME,
    "post-install product terminal receipt"
  );
  const contextPath = await resolveCreateNewFile(
    input.dataPreservationContextOutputPath,
    ELECTRON_PRODUCTION_UPDATER_POST_INSTALL_CONTEXT_FILE,
    "post-install data-preservation context"
  );
  const preservationObservationPath = await resolveCreateNewFile(
    input.dataPreservationObservationOutputPath,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE,
    "post-install data-preservation observation"
  );
  const attachmentOutputRoot = requiredAbsolutePath(
    input.attachmentOutputRoot,
    "post-install attachment output root"
  );
  const bundleOutputRoot = requiredAbsolutePath(
    input.bundleOutputRoot,
    "post-install bundle output root"
  );
  assertSeparateRoots(attachmentOutputRoot, bundleOutputRoot);

  const sourceInstallJournalPath = requiredAbsolutePath(
    input.sourceInstallJournalPath,
    "sealed source updater install journal"
  );
  const terminalCapture = assertTerminalCapture(
    await dependencies.observeTerminalReceipt({
      outputPath: productTerminalReceiptOutputPath,
      platform,
      signal,
      sourceJournalPath: sourceInstallJournalPath,
      targetUserDataDirectory: requiredAbsolutePath(
        input.targetUserDataDirectory,
        "target updater user-data directory"
      ),
      targetVersion: planRead.plan.upstream.target.version
    }, dependencies.terminalReceiptDependencies),
    platform,
    trace.sourceInstallAttemptId
  );
  const targetLaunchFence = Date.parse(trace.visibleInstallInvokedAt);
  if (!Number.isSafeInteger(targetLaunchFence) || targetLaunchFence <= 0) {
    throw new Error("The source visible-install time cannot fence target launch.");
  }

  const targetObservation = await dependencies.observeTargetProcess({
    bindings: nativeHostBindings({
      bindings,
      cell,
      plan: planRead.plan,
      platform,
      sourceInstallAttemptId: trace.sourceInstallAttemptId,
      transitionKind
    }),
    expectedExecutablePath: requiredAbsolutePath(
      input.targetExecutablePath,
      "post-install target executable"
    ),
    launchArgumentsOutputPath: requiredAbsolutePath(
      input.targetLaunchArgumentsOutputPath,
      "post-install target launch-arguments output"
    ),
    launchedAfterMilliseconds: targetLaunchFence,
    nativeHostObservationOutputPath: requiredAbsolutePath(
      input.nativeHostObservationPath,
      "post-install native-host observation"
    ),
    platformProcess: input.targetProcess,
    signal
  }, dependencies.targetProcessDependencies);
  assertTargetObservation(
    targetObservation,
    platform,
    trace.sourceInstallAttemptId,
    input.nativeHostObservationPath
  );

  const context = deepFreeze({
    challenge: planRead.plan.challenge,
    evidenceAttemptId: cell.evidenceAttemptId,
    platform,
    sourceInstallAttemptId: trace.sourceInstallAttemptId,
    target: bindings.target,
    transitionKind
  });
  const contextSource = serializeCanonicalJson(context);
  await writeExclusive(contextPath, contextSource);
  const writtenContext = await readCanonicalJsonFile(
    contextPath,
    MAX_DOCUMENT_BYTES,
    "post-install data-preservation context"
  );
  if (!isDeepStrictEqual(writtenContext.value, context)) {
    throw new Error("The post-install data-preservation context changed after creation.");
  }

  const preservationResult = await dependencies.finalizeDataPreservation({
    beforeReceiptPath: requiredAbsolutePath(
      input.dataPreservationBeforePath,
      "data-preservation before receipt"
    ),
    contextPath,
    expectedBeforeReceiptSha256: expectedBeforeSha256,
    expectedContextSha256: writtenContext.sha256,
    observationPath: preservationObservationPath,
    userDataDirectory: requiredAbsolutePath(
      input.targetUserDataDirectory,
      "target updater user-data directory"
    )
  }, nowDependencies);
  assertPreservationResult(preservationResult, context, preservationObservationPath);

  const finalization = await dependencies.finalizeAttachments({
    attemptPlanPath: requiredAbsolutePath(input.attemptPlanPath,
      "updater evidence attempt plan"),
    bindingsPath: requiredAbsolutePath(input.bindingsPath,
      "updater evidence bundle bindings"),
    capturedAttachments: {
      dataPreservation: preservationObservationPath,
      endpointObservation: requiredAbsolutePath(input.endpointObservationPath,
        "endpoint observation"),
      nativeHostObservation: requiredAbsolutePath(input.nativeHostObservationPath,
        "native-host observation"),
      productTerminalReceipt: productTerminalReceiptOutputPath,
      sourceInstallJournal: sourceInstallJournalPath
    },
    checkActionPath: requiredAbsolutePath(input.checkActionPath,
      "visible updater check action"),
    expectedAttemptPlanSha256,
    expectedJournalTraceSha256,
    installActionPath: requiredAbsolutePath(input.installActionPath,
      "visible updater install action"),
    journalTracePath: requiredAbsolutePath(input.journalTracePath,
      "source journal trace"),
    outputRoot: attachmentOutputRoot,
    platform,
    transitionKind
  }, nowDependencies);
  assertFinalization(
    finalization,
    {
      attemptPlanSha256: expectedAttemptPlanSha256,
      bindingsSha256: bindingsFile.sha256,
      cell,
      journalTraceSha256: expectedJournalTraceSha256,
      outputRoot: attachmentOutputRoot
    }
  );

  const assembled = await dependencies.assembleBundle({
    attachments: Object.fromEntries(
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
        name,
        path.join(attachmentOutputRoot, name)
      ])
    ),
    outputRoot: bundleOutputRoot,
    provenance: bindings.provenance,
    sourceBinding: bindings.sourceBinding,
    targetBinding: bindings.targetBinding
  });
  assertBundleResult(assembled, bundleOutputRoot);
  const verified = await dependencies.readBundle({
    expectedReceiptSha256: assembled.receiptSha256,
    outputRoot: bundleOutputRoot
  });
  assertBundleResult(verified, bundleOutputRoot);
  assertEqual(verified.receiptSha256, assembled.receiptSha256,
    "post-install terminal receipt SHA-256");
  assertEqual(terminalCapture.receipt.fileName,
    ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_NAME,
    "post-install product terminal receipt filename");
  return verified;
}

function assertBindings(value, plan, transitionKind) {
  assertExactKeys(value, ["provenance", "sourceBinding", "targetBinding"],
    "updater evidence bundle bindings");
  assertExactKeys(value.provenance, PROVENANCE_KEYS,
    "updater evidence producer binding");
  assertExactKeys(value.targetBinding, TARGET_BINDING_KEYS,
    "updater evidence target binding");
  const expectedSource = transitionKind === "tauri-v22-to-electron-v23"
    ? plan.upstream.tauriV22
    : plan.upstream.priorV23;
  assertEqual(value.sourceBinding?.sourceSha, expectedSource.sourceSha,
    "source binding source SHA");
  assertEqual(value.sourceBinding?.version, expectedSource.version,
    "source binding version");
  if (transitionKind === "electron-v23-to-electron-v23") {
    assertEqual(value.sourceBinding?.candidateReceiptSha256,
      expectedSource.candidateReceiptSha256,
      "source binding candidate receipt SHA-256");
  }
  for (const [field, expected] of Object.entries({
    candidateReceiptSha256: plan.upstream.target.candidateReceiptSha256,
    sourceSha: plan.upstream.target.sourceSha,
    version: plan.upstream.target.version
  })) {
    assertEqual(value.targetBinding[field], expected, `target binding ${field}`);
  }
  for (const [field, expected] of Object.entries({
    artifactName: plan.producer.aggregateArtifactName,
    repository: plan.producer.repository,
    runAttempt: plan.producer.runAttempt,
    runId: plan.producer.runId,
    sourceSha: plan.upstream.target.sourceSha,
    workflow: plan.producer.workflow
  })) {
    assertEqual(value.provenance[field], expected, `producer binding ${field}`);
  }
  const {
    targetRunningImageSha256: _targetRunningImageSha256,
    updaterPublicKeySha256: _updaterPublicKeySha256,
    ...target
  } = value.targetBinding;
  return deepFreeze({
    provenance: { ...value.provenance },
    sourceBinding: { ...value.sourceBinding },
    target,
    targetBinding: { ...value.targetBinding }
  });
}

function nativeHostBindings(input) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
    context: {
      challenge: input.plan.challenge,
      evidenceAttemptId: input.cell.evidenceAttemptId,
      platform: input.platform,
      sourceInstallAttemptId: input.sourceInstallAttemptId,
      transitionKind: input.transitionKind
    },
    target: input.bindings.target,
    targetRunningImageSha256:
      input.bindings.targetBinding.targetRunningImageSha256
  });
}

function assertTargetObservation(value, platform, sourceInstallAttemptId, outputPath) {
  assertExactKeys(value, [
    "kind", "launchArguments", "nativeHostObservation", "platform", "process",
    "schemaVersion"
  ], "post-install target-process observation");
  assertEqual(value.schemaVersion, 1,
    "post-install target-process observation schema version");
  assertEqual(value.kind,
    "rion-electron-production-updater-target-process-observation",
    "post-install target-process observation kind");
  assertEqual(value.platform, platform,
    "post-install target-process observation platform");
  assertEqual(value.nativeHostObservation.fileName,
    path.basename(requiredAbsolutePath(outputPath, "native-host observation")),
    "post-install native-host observation filename");
  requiredDigest(value.nativeHostObservation.sha256,
    "post-install native-host observation SHA-256");
  if (typeof sourceInstallAttemptId !== "string" || sourceInstallAttemptId.length === 0) {
    throw new Error("The post-install source attempt identity is invalid.");
  }
}

function selectedCell(plan, platform, transitionKind) {
  const matches = plan.cells.filter((candidate) =>
    candidate.platform === platform && candidate.transitionKind === transitionKind
  );
  if (matches.length !== 1) {
    throw new Error("The updater evidence attempt plan must contain exactly one selected cell.");
  }
  return matches[0];
}

function assertTerminalCapture(value, platform, sourceInstallAttemptId) {
  assertExactKeys(value, [
    "authority",
    "kind",
    "platform",
    "receipt",
    "reconciledAt",
    "schemaVersion",
    "sourceInstallAttemptId",
    "terminalOutcome"
  ], "post-install product terminal receipt capture");
  assertEqual(value.schemaVersion, 1,
    "post-install product terminal receipt capture schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_CAPTURE_KIND,
    "post-install product terminal receipt capture kind");
  assertEqual(value.authority, "target-first-boot-journal-reconciliation",
    "post-install product terminal receipt authority");
  assertEqual(value.platform, platform,
    "post-install product terminal receipt platform");
  assertEqual(value.sourceInstallAttemptId, sourceInstallAttemptId,
    "post-install product terminal receipt source attempt ID");
  assertEqual(value.terminalOutcome, "applied",
    "post-install product terminal receipt outcome");
  assertExactKeys(value.receipt, ["bytes", "fileName", "sha256"],
    "post-install product terminal receipt identity");
  requiredDigest(value.receipt.sha256,
    "post-install product terminal receipt SHA-256");
  return value;
}

function assertPreservationResult(value, context, observationPath) {
  const observation = assertElectronProductionUpdaterDataPreservationObservation(
    value?.observation
  );
  const expected = { ...context };
  const actual = {
    challenge: observation.challenge,
    evidenceAttemptId: observation.evidenceAttemptId,
    platform: observation.platform,
    sourceInstallAttemptId: observation.sourceInstallAttemptId,
    target: observation.target,
    transitionKind: observation.transitionKind
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("The data-preservation observation does not match the selected cell.");
  }
  assertEqual(value.observationPath, observationPath,
    "data-preservation observation path");
  requiredDigest(value.observationIdentity?.sha256,
    "data-preservation observation SHA-256");
}

function assertFinalization(value, expected) {
  assertEqual(value?.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND,
    "post-install attachment finalization kind");
  for (const field of [
    "attemptPlanSha256",
    "bindingsSha256",
    "journalTraceSha256",
    "outputRoot"
  ]) {
    assertEqual(value[field], expected[field],
      `post-install attachment finalization ${field}`);
  }
  if (!isDeepStrictEqual(value.cell, expected.cell)) {
    throw new Error("The post-install attachment finalization cell does not match.");
  }
  assertExactKeys(value.attachments,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
    "post-install finalized attachments");
}

function assertBundleResult(value, outputRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The post-install terminal evidence bundle result is invalid.");
  }
  assertEqual(value.outputRoot, outputRoot,
    "post-install terminal evidence bundle root");
  requiredDigest(value.receiptSha256,
    "post-install terminal evidence receipt SHA-256");
}

function assertSeparateRoots(left, right) {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  if (
    leftToRight === "" ||
    isInside(leftToRight) ||
    isInside(rightToLeft)
  ) {
    throw new Error(
      "The post-install attachment and bundle output roots must be separate."
    );
  }
}

function isInside(relation) {
  return relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation);
}

function requiredEnum(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The post-install cell coordinator requires a caller AbortSignal.");
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Post-install cell coordinator dependencies must be an object.");
  }
  const defaults = {
    assembleBundle: assembleElectronProductionUpdaterEvidenceBundle,
    finalizeAttachments: finalizeElectronProductionUpdaterEvidenceAttachments,
    finalizeDataPreservation: finalizeElectronProductionUpdaterDataPreservation,
    observeTargetProcess:
      discoverAndObserveElectronProductionUpdaterTargetProcess,
    observeTerminalReceipt: observeElectronProductionUpdaterTerminalReceipt,
    readAttemptPlan: readElectronProductionUpdaterEvidenceAttemptPlan,
    readBundle: readElectronProductionUpdaterEvidenceBundle,
    readJournalTrace: readElectronProductionUpdaterJournalTrace
  };
  const allowed = new Set([
    ...Object.keys(defaults),
    "now",
    "targetProcessDependencies",
    "terminalReceiptDependencies"
  ]);
  for (const name of Object.keys(value)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown post-install cell coordinator dependency ${name}.`);
    }
  }
  const dependencies = {
    ...defaults,
    ...Object.fromEntries(Object.keys(defaults).map((name) => [
      name,
      value[name] ?? defaults[name]
    ])),
    now: value.now,
    targetProcessDependencies: value.targetProcessDependencies ?? {},
    terminalReceiptDependencies: value.terminalReceiptDependencies ?? {}
  };
  if (Object.keys(defaults).some((name) =>
    typeof dependencies[name] !== "function"
  ) || (dependencies.now !== undefined && typeof dependencies.now !== "function")) {
    throw new Error("Post-install cell coordinator dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
