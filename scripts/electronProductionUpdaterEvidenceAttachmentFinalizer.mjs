import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES
} from "./electronProductionUpdaterEvidenceBundle.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_KIND,
  assertElectronProductionUpdaterEvidenceEndpointObservation
} from "./electronProductionUpdaterEvidenceEndpointObservation.mjs";
import {
  readElectronProductionUpdaterEvidenceAttemptPlan
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  readElectronProductionUpdaterJournalTrace
} from "./electronProductionUpdaterJournalTraceObserver.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRealDirectory,
  requiredRfc3339,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND =
  "rion-production-updater-evidence-attachment-finalization";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;
const CAPTURED_ATTACHMENT_PATH_KEYS = Object.freeze([
  "dataPreservation",
  "endpointObservation",
  "nativeHostObservation",
  "productTerminalReceipt",
  "sourceInstallJournal"
]);
const CONTEXT_KEYS = Object.freeze([
  "challenge",
  "evidenceAttemptId",
  "platform",
  "schemaVersion",
  "sourceInstallAttemptId",
  "transitionKind"
]);
export async function finalizeElectronProductionUpdaterEvidenceAttachments(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "attemptPlanPath",
    "bindingsPath",
    "capturedAttachments",
    "checkActionPath",
    "expectedAttemptPlanSha256",
    "expectedJournalTraceSha256",
    "installActionPath",
    "journalTracePath",
    "outputRoot",
    "platform",
    "transitionKind"
  ], "updater evidence attachment finalization input");
  const platform = requiredPlatform(input.platform);
  const transitionKind = requiredTransition(input.transitionKind);
  const now = dependencyOverrides.now ?? (() => new Date());
  const planRead = await readElectronProductionUpdaterEvidenceAttemptPlan({
    expectedSha256: requiredDigest(
      input.expectedAttemptPlanSha256,
      "updater evidence attempt-plan SHA-256"
    ),
    planPath: requiredAbsolutePath(input.attemptPlanPath,
      "updater evidence attempt plan")
  }, { now });
  const cell = planRead.plan.cells.find((candidate) =>
    candidate.platform === platform && candidate.transitionKind === transitionKind
  );
  if (!cell) throw new Error("The updater evidence attempt plan does not contain the cell.");
  const traceRead = await readElectronProductionUpdaterJournalTrace({
    expectedSha256: requiredDigest(
      input.expectedJournalTraceSha256,
      "source journal trace SHA-256"
    ),
    tracePath: requiredAbsolutePath(input.journalTracePath, "source journal trace")
  });
  const trace = traceRead.trace;
  assertEqual(trace.platform, platform, "source journal trace platform");
  assertEqual(trace.transitionKind, transitionKind, "source journal trace transition");
  assertEqual(trace.targetVersion, planRead.plan.upstream.target.version,
    "source journal trace target version");

  const bindingsFile = await readCanonicalJsonFile(
    input.bindingsPath,
    MAX_DOCUMENT_BYTES,
    "updater evidence bundle bindings"
  );
  const bindings = assertBindings(bindingsFile.value, planRead.plan, transitionKind);
  const context = deepFreeze({
    challenge: planRead.plan.challenge,
    evidenceAttemptId: cell.evidenceAttemptId,
    platform,
    schemaVersion: 1,
    sourceInstallAttemptId: trace.sourceInstallAttemptId,
    transitionKind
  });
  const capturedPaths = assertCapturedAttachmentPaths(input.capturedAttachments);
  assertDistinctPaths([
    requiredAbsolutePath(input.bindingsPath, "updater evidence bundle bindings"),
    traceRead.tracePath,
    ...Object.values(capturedPaths),
    requiredAbsolutePath(input.checkActionPath, "visible updater check action"),
    requiredAbsolutePath(input.installActionPath, "visible updater install action")
  ]);

  const [checkFile, installFile, endpointFile, preservationFile, nativeFile,
    sourceJournalFile, productTerminalFile] = await Promise.all([
    readCanonicalJsonFile(input.checkActionPath, MAX_DOCUMENT_BYTES,
      "visible updater check action"),
    readCanonicalJsonFile(input.installActionPath, MAX_DOCUMENT_BYTES,
      "visible updater install action"),
    readCanonicalJsonFile(capturedPaths.endpointObservation, MAX_DOCUMENT_BYTES,
      "endpoint observation"),
    readCanonicalJsonFile(capturedPaths.dataPreservation, MAX_DOCUMENT_BYTES,
      "data preservation observation"),
    readCanonicalJsonFile(capturedPaths.nativeHostObservation, MAX_DOCUMENT_BYTES,
      "native host observation"),
    readStableFile(capturedPaths.sourceInstallJournal, MAX_DOCUMENT_BYTES,
      "source install journal"),
    readStableFile(capturedPaths.productTerminalReceipt, MAX_DOCUMENT_BYTES,
      "product terminal receipt")
  ]);
  const checkAction = assertVisibleAction(checkFile.value, "check", platform);
  const installAction = assertVisibleAction(installFile.value, "install", platform);
  assertEqual(installAction.processId, checkAction.processId,
    "visible updater source process ID");
  if (Date.parse(installAction.invokedAt) < Date.parse(checkAction.completedAt)) {
    throw new Error("The visible install action precedes the completed update check action.");
  }

  const sourceJournal = assertSourceJournal(
    sourceJournalFile,
    trace,
    bindings.targetBinding.version,
    platform
  );
  const productTerminal = assertProductTerminal(
    productTerminalFile,
    sourceJournalFile,
    sourceJournal,
    trace,
    bindings.targetBinding.version
  );
  const endpointPrebinding =
    assertElectronProductionUpdaterEvidenceEndpointObservation(
      endpointFile.value,
      endpointObservationPrebindingBindings({
        attemptPlanSha256: planRead.planIdentity.sha256,
        bindings,
        cell,
        challenge: planRead.plan.challenge,
        transitionKind
      })
    );
  const endpoint = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_KIND,
    challenge: endpointPrebinding.challenge,
    evidenceAttemptId: endpointPrebinding.evidenceAttemptId,
    platform: endpointPrebinding.platform,
    sourceInstallAttemptId: trace.sourceInstallAttemptId,
    transitionKind: endpointPrebinding.transitionKind,
    endpoint: endpointPrebinding.endpoint,
    observedAt: endpointPrebinding.observedAt
  });
  const preservation = assertContextualAttachment(
    preservationFile.value,
    context,
    "rion-production-updater-data-preservation-observation",
    "data preservation observation"
  );
  const nativeHost = assertContextualAttachment(
    nativeFile.value,
    context,
    "rion-production-updater-native-host-observation",
    "native host observation"
  );
  assertDeepEqual(preservation.target, bindings.target,
    "data preservation target");
  assertDeepEqual(nativeHost.target, bindings.target, "native host target");
  assertEqual(nativeHost.targetRunningImageSha256,
    bindings.targetBinding.targetRunningImageSha256,
    "native host target running image SHA-256");

  const accepted = trace.observations[0];
  const installing = trace.observations[2];
  const draining = trace.observations[3];
  const handoff = trace.observations[4];
  if (Date.parse(endpoint.observedAt) < Date.parse(checkAction.completedAt) ||
      Date.parse(endpoint.observedAt) > Date.parse(accepted.updatedAt)) {
    throw new Error("The endpoint observation is outside the visible check/install window.");
  }
  if (Date.parse(installAction.invokedAt) > Date.parse(accepted.updatedAt)) {
    throw new Error("The source accepted install before the visible install action began.");
  }
  if (Date.parse(nativeHost.observedAt) > Date.parse(productTerminal.reconciledAt)) {
    throw new Error("The target native-host observation follows terminal reconciliation.");
  }

  const sourceSnapshot = {
    ...context,
    capturedAt: checkAction.invokedAt,
    kind: "rion-production-updater-source-release-snapshot",
    source: bindings.sourceBinding
  };
  const sourceSnapshotBytes = serializeCanonicalJson(sourceSnapshot);
  const source = {
    ...bindings.sourceBinding,
    releaseSnapshotSha256: sha256(sourceSnapshotBytes)
  };
  const eventDefinitions = [
    ["source-updater-invoked", "checking", checkAction.completedAt],
    ["target-manifest-observed", "checking", endpoint.observedAt],
    ["target-artifact-verified", "downloaded", accepted.updatedAt],
    ["source-install-accepted", "accepted", accepted.updatedAt],
    ["source-install-prepared", "installing", installing.updatedAt],
    ["source-drain-started", "draining", draining.updatedAt],
    ["source-handoff", handoff.phase, handoff.updatedAt],
    ["target-first-boot", handoff.phase, nativeHost.observedAt],
    ["target-terminal", "applied", productTerminal.reconciledAt]
  ];
  assertEventTimes(eventDefinitions, context.challenge);
  const events = eventDefinitions.map(([event, phase, observedAt], index) => ({
    ...context,
    event,
    kind: "rion-production-updater-source-event",
    observedAt,
    phase,
    sequence: index + 1,
    source,
    target: bindings.target
  }));
  const eventStreamBytes = Buffer.concat(events.map(canonicalJsonLine));
  if (eventStreamBytes.byteLength > MAX_EVENT_STREAM_BYTES) {
    throw new Error("The source event stream exceeds its byte limit.");
  }
  const targetTerminal = {
    ...context,
    deadlineUsedAsSuccess: false,
    firstBoot: true,
    journal: {
      attemptId: trace.sourceInstallAttemptId,
      phase: "applied",
      reconciled: true,
      reconciledAt: productTerminal.reconciledAt,
      targetVersion: bindings.target.version
    },
    kind: "rion-production-updater-target-terminal-record",
    productTerminalReceiptSha256: productTerminalFile.sha256,
    recordedAt: productTerminal.reconciledAt,
    target: bindings.target,
    targetRunningImageSha256: bindings.targetBinding.targetRunningImageSha256,
    terminalAuthority: productTerminal.authority,
    terminalOutcome: productTerminal.terminalOutcome
  };

  const outputRoot = await resolveOutputRoot(input.outputRoot);
  await mkdir(outputRoot, { mode: 0o700 });
  const sources = {
    "data-preservation-observation.json": preservationFile.source,
    "endpoint-observation.json": serializeCanonicalJson(endpoint),
    "native-host-observation.json": nativeFile.source,
    "product-terminal-receipt.json": productTerminalFile.source,
    "source-event-stream.jsonl": eventStreamBytes,
    "source-install-journal.json": sourceJournalFile.source,
    "source-release-snapshot.json": sourceSnapshotBytes,
    "target-terminal-record.json": serializeCanonicalJson(targetTerminal)
  };
  for (const name of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES) {
    await writeExclusive(path.join(outputRoot, name), sources[name]);
  }
  const identities = {};
  for (const name of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES) {
    const file = await readStableFile(
      path.join(outputRoot, name),
      name.endsWith(".jsonl") ? MAX_EVENT_STREAM_BYTES : MAX_DOCUMENT_BYTES,
      `finalized ${name}`
    );
    identities[name] = publicIdentity(path.join(outputRoot, name), file);
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_FINALIZATION_KIND,
    attemptPlanSha256: planRead.planIdentity.sha256,
    bindingsSha256: bindingsFile.sha256,
    cell,
    journalTraceSha256: traceRead.traceIdentity.sha256,
    outputRoot,
    attachments: identities
  });
}

function assertBindings(value, plan, transitionKind) {
  assertExactKeys(value, ["provenance", "sourceBinding", "targetBinding"],
    "updater evidence bundle bindings");
  const targetBinding = value.targetBinding;
  for (const [field, expected] of Object.entries({
    candidateReceiptSha256: plan.upstream.target.candidateReceiptSha256,
    sourceSha: plan.upstream.target.sourceSha,
    version: plan.upstream.target.version
  })) assertEqual(targetBinding?.[field], expected, `target binding ${field}`);
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
    artifactName: plan.producer.aggregateArtifactName,
    repository: plan.producer.repository,
    runAttempt: plan.producer.runAttempt,
    runId: plan.producer.runId,
    sourceSha: plan.upstream.target.sourceSha,
    workflow: plan.producer.workflow
  })) assertEqual(value.provenance?.[field], expected, `producer binding ${field}`);
  const { targetRunningImageSha256: _image, updaterPublicKeySha256: _trust, ...target } =
    targetBinding;
  return deepFreeze({
    provenance: { ...value.provenance },
    sourceBinding: { ...value.sourceBinding },
    target: { ...target },
    targetBinding: { ...targetBinding }
  });
}

function endpointObservationPrebindingBindings(input) {
  const target = input.bindings.targetBinding;
  const source = input.bindings.sourceBinding;
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
    attemptPlanSha256: input.attemptPlanSha256,
    context: {
      challenge: input.challenge,
      evidenceAttemptId: input.cell.evidenceAttemptId,
      platform: input.cell.platform,
      transitionKind: input.cell.transitionKind
    },
    endpoint: {
      artifactName: target.artifactName,
      artifactSha256: target.artifactSha256,
      manifestName: target.manifestName,
      requestEndpoint: input.transitionKind === "tauri-v22-to-electron-v23"
        ? source.defaultUpdaterEndpoint
        : source.embeddedUpdaterEndpoint,
      servedManifestSha256: target.servedManifestSha256,
      signatureName: target.signatureName,
      signatureSha256: target.signatureSha256,
      targetEmbeddedUpdaterEndpoint: target.embeddedUpdaterEndpoint,
      targetVersion: target.version,
      updaterPublicKeySha256: target.updaterPublicKeySha256
    }
  });
}

function assertVisibleAction(value, action, platform) {
  assertExactKeys(value, [
    "action", "completedAt", "controlName", "interaction", "invokedAt", "kind",
    "platform", "processId", "remoteDebugging", "schemaVersion"
  ], `visible updater ${action} action`);
  assertEqual(value.schemaVersion, 1, `visible updater ${action} schema version`);
  assertEqual(value.kind, "rion-production-updater-visible-ui-action",
    `visible updater ${action} kind`);
  assertEqual(value.action, action, `visible updater ${action} action`);
  assertEqual(value.controlName, action === "check" ? "Check updates" : "Restart and update",
    `visible updater ${action} control`);
  assertEqual(value.interaction, "visible-os-accessibility-press",
    `visible updater ${action} interaction`);
  assertEqual(value.platform, platform === "darwin-aarch64" ? "darwin" : "win32",
    `visible updater ${action} platform`);
  assertEqual(value.remoteDebugging, false, `visible updater ${action} remote debugging`);
  if (!Number.isSafeInteger(value.processId) || value.processId <= 1) {
    throw new Error(`The visible updater ${action} process ID is invalid.`);
  }
  const invokedAt = requiredRfc3339(value.invokedAt, `visible updater ${action} invocation`);
  const completedAt = requiredRfc3339(value.completedAt,
    `visible updater ${action} completion`);
  if (Date.parse(completedAt) < Date.parse(invokedAt)) {
    throw new Error(`The visible updater ${action} completion precedes invocation.`);
  }
  return Object.freeze({ ...value, invokedAt, completedAt });
}

function assertSourceJournal(file, trace, targetVersion, platform) {
  const document = parseJson(file.source, "source install journal");
  assertExactKeys(document, ["attempt", "schemaVersion"], "source install journal");
  assertEqual(document.schemaVersion, 1, "source install journal schema version");
  assertExactKeys(document.attempt, [
    "attemptId", "phase", "startedAt", "targetVersion", "updatedAt"
  ], "source install journal attempt");
  const handoff = trace.observations[4];
  assertEqual(file.bytes, handoff.journal.bytes, "source journal trace final bytes");
  assertEqual(file.sha256, handoff.journal.sha256, "source journal trace final SHA-256");
  assertEqual(document.attempt.attemptId, trace.sourceInstallAttemptId,
    "source journal attempt ID");
  assertEqual(document.attempt.phase,
    platform === "darwin-aarch64" ? "restartPending" : "installerHandoff",
    "source journal handoff phase");
  assertEqual(document.attempt.startedAt, trace.observations[0].startedAt,
    "source journal start time");
  assertEqual(document.attempt.updatedAt, handoff.updatedAt,
    "source journal handoff time");
  assertEqual(document.attempt.targetVersion, targetVersion,
    "source journal target version");
  return document;
}

function assertProductTerminal(file, sourceFile, source, trace, targetVersion) {
  const document = parseJson(file.source, "product terminal receipt");
  assertExactKeys(document, [
    "attempt", "authority", "kind", "reconciledAt", "runningVersion",
    "schemaVersion", "sourceJournalBytes", "sourceJournalSha256", "sourcePhase",
    "terminalOutcome"
  ], "product terminal receipt");
  assertEqual(document.schemaVersion, 1, "product terminal receipt schema version");
  assertEqual(document.kind, "rion-updater-install-terminal",
    "product terminal receipt kind");
  assertEqual(document.authority, "target-first-boot-journal-reconciliation",
    "product terminal authority");
  assertEqual(document.terminalOutcome, "applied", "product terminal outcome");
  assertEqual(document.sourceJournalBytes, sourceFile.bytes,
    "product terminal source journal bytes");
  assertEqual(document.sourceJournalSha256, sourceFile.sha256,
    "product terminal source journal SHA-256");
  assertEqual(document.sourcePhase, source.attempt.phase,
    "product terminal source phase");
  assertEqual(document.runningVersion, targetVersion,
    "product terminal running version");
  assertExactKeys(document.attempt, [
    "attemptId", "phase", "startedAt", "targetVersion", "updatedAt"
  ], "product terminal attempt");
  assertEqual(document.attempt.attemptId, trace.sourceInstallAttemptId,
    "product terminal attempt ID");
  assertEqual(document.attempt.phase, "applied", "product terminal attempt phase");
  assertEqual(document.attempt.startedAt, trace.observations[0].startedAt,
    "product terminal attempt start time");
  assertEqual(document.attempt.targetVersion, targetVersion,
    "product terminal target version");
  const reconciledAt = requiredRfc3339(document.reconciledAt,
    "product terminal reconciliation time");
  assertEqual(document.attempt.updatedAt, reconciledAt,
    "product terminal attempt update time");
  if (Date.parse(reconciledAt) < Date.parse(trace.observations[4].updatedAt)) {
    throw new Error("The product terminal receipt predates source handoff.");
  }
  return Object.freeze({ ...document, reconciledAt });
}

function assertContextualAttachment(value, context, kind, label) {
  for (const key of CONTEXT_KEYS) {
    const expected = key === "schemaVersion" ? 1 : context[key];
    if (key === "challenge") assertDeepEqual(value?.[key], expected, `${label} challenge`);
    else assertEqual(value?.[key], expected, `${label} ${key}`);
  }
  assertEqual(value?.kind, kind, `${label} kind`);
  requiredRfc3339(value?.observedAt, `${label} observed-at`);
  return value;
}

function assertEventTimes(definitions, challenge) {
  const issuedAt = Date.parse(challenge.issuedAt);
  const expiresAt = Date.parse(challenge.expiresAt);
  let previous = null;
  definitions.forEach(([, , value], index) => {
    const observedAt = requiredRfc3339(value, `source event ${index + 1} observed-at`);
    const timestamp = Date.parse(observedAt);
    if (timestamp < issuedAt || timestamp > expiresAt) {
      throw new Error(`The source event ${index + 1} is outside the challenge window.`);
    }
    if (previous !== null && timestamp < previous) {
      throw new Error("The source event timestamps are not monotonic.");
    }
    previous = timestamp;
  });
}

function assertCapturedAttachmentPaths(value) {
  assertExactKeys(value, CAPTURED_ATTACHMENT_PATH_KEYS,
    "captured updater evidence attachment paths");
  return Object.fromEntries(CAPTURED_ATTACHMENT_PATH_KEYS.map((key) => [
    key,
    requiredAbsolutePath(value[key], `${key} captured attachment`)
  ]));
}

function assertDistinctPaths(paths) {
  const normalized = paths.map((value) => path.resolve(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Every updater evidence finalizer input must use a distinct path.");
  }
}

async function resolveOutputRoot(value) {
  const requested = requiredAbsolutePath(value, "updater evidence attachment output root");
  const parent = await requiredRealDirectory(path.dirname(requested),
    "updater evidence attachment output parent");
  const outputRoot = path.join(parent, path.basename(requested));
  try {
    await lstat(outputRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return outputRoot;
    throw error;
  }
  throw new Error("The updater evidence attachment output root must be create-new.");
}

function requiredPlatform(value) {
  if (value !== "darwin-aarch64" && value !== "windows-x86_64") {
    throw new Error("The updater evidence attachment platform is unsupported.");
  }
  return value;
}

function requiredTransition(value) {
  if (value !== "tauri-v22-to-electron-v23" &&
      value !== "electron-v23-to-electron-v23") {
    throw new Error("The updater evidence attachment transition is unsupported.");
  }
  return value;
}

function canonicalJsonLine(value) {
  return Buffer.from(`${JSON.stringify(JSON.parse(serializeCanonicalJson(value)))}\n`, "utf8");
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
