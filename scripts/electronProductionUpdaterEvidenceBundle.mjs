import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_KIND =
  "rion-production-updater-terminal-transaction";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME =
  "terminal-receipt.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW =
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES = Object.freeze([
  "data-preservation-observation.json",
  "endpoint-observation.json",
  "native-host-observation.json",
  "product-terminal-receipt.json",
  "source-event-stream.jsonl",
  "source-install-journal.json",
  "source-release-snapshot.json",
  "target-terminal-record.json"
]);

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_EVENT_STREAM_BYTES = 8 * 1024 * 1024;
const READ_ONLY_NO_FOLLOW = fileConstants.O_RDONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const TAURI_UPDATER_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAURI_ASSET_HOST = "release-assets.githubusercontent.com";
const RECEIPT_KEYS = Object.freeze([
  "attachments", "challenge", "completedAt", "cutoverEligible",
  "evidenceKind", "nativeRuntime", "platform", "preservation", "producer",
  "schemaVersion", "source", "target", "transaction", "transitionKind", "trust"
]);
const CONTEXT_KEYS = Object.freeze([
  "challenge", "evidenceAttemptId", "kind", "platform", "schemaVersion",
  "sourceInstallAttemptId", "transitionKind"
]);
const SOURCE_EVENTS = Object.freeze([
  Object.freeze(["source-updater-invoked", "checking"]),
  Object.freeze(["target-manifest-observed", "checking"]),
  Object.freeze(["target-artifact-verified", "downloaded"]),
  Object.freeze(["source-install-accepted", "accepted"]),
  Object.freeze(["source-install-prepared", "installing"]),
  Object.freeze(["source-drain-started", "draining"]),
  Object.freeze(["source-handoff", null]),
  Object.freeze(["target-first-boot", null]),
  Object.freeze(["target-terminal", "applied"])
]);
const PLATFORM_TARGETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    nativeHostKind: "appkit-chromium",
    retainedAppKitHost: true,
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    nativeHostKind: "bundled-chromium",
    retainedAppKitHost: false,
    signatureName: "Rion.Studio-win.exe.sig"
  })
});

export async function assembleElectronProductionUpdaterEvidenceBundle(input) {
  const outputRoot = await resolveCreateNewDirectory(input?.outputRoot);
  const attachmentPaths = assertAttachmentPathMap(input?.attachments);
  const captured = await captureAttachments(attachmentPaths);
  const receipt = deriveReceipt(captured, {
    provenance: input?.provenance,
    sourceBinding: input?.sourceBinding,
    targetBinding: input?.targetBinding
  });
  const receiptSource = serializeCanonicalJson(receipt);
  const receiptSha256 = sha256(receiptSource);

  await mkdir(outputRoot, { mode: 0o700 });
  for (const name of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES) {
    await writeFile(join(outputRoot, name), captured[name].source, {
      flag: "wx",
      mode: 0o600
    });
  }
  await writeFile(
    join(outputRoot, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME),
    receiptSource,
    { flag: "wx", mode: 0o600 }
  );

  return readElectronProductionUpdaterEvidenceBundle({
    expectedReceiptSha256: receiptSha256,
    outputRoot
  });
}

export async function readElectronProductionUpdaterEvidenceBundle(input) {
  const outputRoot = await requiredStableDirectory(input?.outputRoot, "evidence bundle root");
  const expectedNames = [
    ...ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME
  ].sort(compareStrings);
  const names = (await readdir(outputRoot.path)).sort(compareStrings);
  assertStringArrayEqual(names, expectedNames, "evidence bundle inventory");

  const receiptFile = await captureStableRegularFile(
    join(outputRoot.path, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_RECEIPT_NAME),
    MAX_DOCUMENT_BYTES,
    "terminal evidence receipt"
  );
  const expectedReceiptSha256 = input?.expectedReceiptSha256 === undefined
    ? undefined
    : requiredDigest(input.expectedReceiptSha256, "terminal evidence receipt SHA-256");
  if (expectedReceiptSha256 !== undefined) {
    assertEqual(receiptFile.sha256, expectedReceiptSha256,
      "terminal evidence receipt SHA-256");
  }
  const receipt = parseJsonObject(receiptFile.source, "terminal evidence receipt");
  assertExactKeys(receipt, RECEIPT_KEYS, "terminal evidence receipt");
  if (!receiptFile.source.equals(serializeCanonicalJson(receipt))) {
    throw new Error("The terminal evidence receipt must use canonical JSON.");
  }

  const attachmentPaths = Object.fromEntries(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
      name,
      join(outputRoot.path, name)
    ])
  );
  const captured = await captureAttachments(attachmentPaths);
  const finalNames = (await readdir(outputRoot.path)).sort(compareStrings);
  assertStringArrayEqual(finalNames, expectedNames, "evidence bundle inventory");
  await assertStableDirectoryUnchanged(outputRoot);
  const { releaseSnapshotSha256, ...sourceBinding } = receipt.source ?? {};
  const targetBinding = {
    ...(receipt.target ?? {}),
    targetRunningImageSha256: receipt.transaction?.targetRunningImageSha256,
    updaterPublicKeySha256: receipt.trust?.updaterPublicKeySha256
  };
  const derived = deriveReceipt(captured, {
    provenance: receipt.producer,
    sourceBinding,
    targetBinding
  });
  if (!isDeepStrictEqual(receipt, derived)) {
    throw new Error("The terminal evidence receipt does not match its observed attachments.");
  }
  assertEqual(
    releaseSnapshotSha256,
    captured["source-release-snapshot.json"].sha256,
    "source release snapshot receipt binding"
  );
  return deepFreeze({
    attachments: Object.fromEntries(
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
        name,
        { bytes: captured[name].bytes, sha256: captured[name].sha256 }
      ])
    ),
    outputRoot: outputRoot.path,
    receipt,
    receiptSha256: receiptFile.sha256
  });
}

function deriveReceipt(captured, bindings) {
  const snapshot = parseJsonObject(
    captured["source-release-snapshot.json"].source,
    "source release snapshot"
  );
  const context = readInitialContext(snapshot);
  const sourceBinding = assertSourceBinding(bindings.sourceBinding, context.transitionKind);
  assertExactRecord(snapshot.source, sourceBinding, "source release snapshot source");
  requiredRfc3339(snapshot.capturedAt, "source release snapshot captured-at");
  const source = {
    ...sourceBinding,
    releaseSnapshotSha256: captured["source-release-snapshot.json"].sha256
  };
  const targetBinding = assertTargetBinding(bindings.targetBinding, context.platform);
  const target = targetBinding.target;
  assertVersionIsNewer(target.version, source.version);
  const producer = assertProvenance(bindings.provenance, target);

  const sourceJournal = assertSourceJournal(
    parseJsonObject(captured["source-install-journal.json"].source, "source install journal"),
    captured["source-install-journal.json"], context, target
  );
  const productTerminal = assertProductTerminal(
    parseJsonObject(
      captured["product-terminal-receipt.json"].source,
      "product terminal receipt"
    ),
    captured["source-install-journal.json"], sourceJournal, context, target
  );
  const events = assertSourceEvents(
    parseJsonLines(captured["source-event-stream.jsonl"].source, "source event stream"),
    context, source, target
  );
  const endpoint = assertEndpointObservation(
    parseJsonObject(captured["endpoint-observation.json"].source, "endpoint observation"),
    context, source, target, targetBinding.updaterPublicKeySha256
  );
  const preservation = assertPreservationObservation(
    parseJsonObject(
      captured["data-preservation-observation.json"].source,
      "data preservation observation"
    ),
    context, target
  );
  const nativeRuntime = assertNativeHostObservation(
    parseJsonObject(
      captured["native-host-observation.json"].source,
      "native host observation"
    ),
    context, target, targetBinding.targetRunningImageSha256
  );
  const targetTerminal = assertTargetTerminal(
    parseJsonObject(
      captured["target-terminal-record.json"].source,
      "target terminal record"
    ),
    captured["product-terminal-receipt.json"].sha256,
    context, productTerminal, target, targetBinding.targetRunningImageSha256
  );

  assertSameInstant(endpoint.observedAt, events[1].observedAt,
    "endpoint observation and manifest event");
  assertSameInstant(sourceJournal.attempt.startedAt, events[3].observedAt,
    "source journal start and install acceptance event");
  assertSameInstant(sourceJournal.attempt.updatedAt, events[6].observedAt,
    "source journal handoff and source handoff event");
  assertSameInstant(nativeRuntime.observedAt, events[7].observedAt,
    "native host observation and target first boot");
  assertSameInstant(preservation.observedAt, events[8].observedAt,
    "data preservation and target terminal event");
  assertSameInstant(targetTerminal.recordedAt, events[8].observedAt,
    "target terminal record and source event");
  if (timestamp(snapshot.capturedAt, "source snapshot capture") >
      timestamp(events[0].observedAt, "source updater invocation")) {
    throw new Error("The source snapshot must precede source updater invocation.");
  }
  if (timestamp(productTerminal.reconciledAt, "product reconciliation") >
      timestamp(targetTerminal.recordedAt, "target terminal record")) {
    throw new Error("The product terminal receipt must precede the target terminal record.");
  }
  assertEvidenceWindow(context.challenge, events, targetTerminal.recordedAt);
  assertWithinEvidenceWindow(
    snapshot.capturedAt,
    context.challenge,
    targetTerminal.recordedAt,
    "source snapshot capture"
  );
  assertWithinEvidenceWindow(
    productTerminal.reconciledAt,
    context.challenge,
    targetTerminal.recordedAt,
    "product terminal reconciliation"
  );

  const attachments = Object.fromEntries(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
      name,
      captured[name].sha256
    ])
  );
  return {
    schemaVersion: 1,
    evidenceKind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_KIND,
    cutoverEligible: true,
    platform: context.platform,
    transitionKind: context.transitionKind,
    challenge: context.challenge,
    source,
    target,
    trust: { updaterPublicKeySha256: targetBinding.updaterPublicKeySha256 },
    transaction: {
      dataPreservationObservationSha256:
        captured["data-preservation-observation.json"].sha256,
      deadlineUsedAsSuccess: targetTerminal.deadlineUsedAsSuccess,
      endpointObservationSha256: captured["endpoint-observation.json"].sha256,
      endpointRedirectCount: endpoint.endpoint.redirectCount,
      endpointStatus: endpoint.endpoint.status,
      evidenceAttemptId: context.evidenceAttemptId,
      nativeHostObservationSha256: captured["native-host-observation.json"].sha256,
      preservedChallengeSha256: preservation.preservation.beforeChallengeSha256,
      productTerminalReceiptSha256: captured["product-terminal-receipt.json"].sha256,
      sourceEventStreamSha256: captured["source-event-stream.jsonl"].sha256,
      sourceHandoffJournalPhase: sourceJournal.attempt.phase,
      sourceHandoffStatus: "restart_pending",
      sourceInstallAttemptId: context.sourceInstallAttemptId,
      sourceInstallJournalSha256: captured["source-install-journal.json"].sha256,
      sourceFetchEndpoint: endpoint.endpoint.requestEndpoint,
      sourceFetchFinalUrlSha256: endpoint.endpoint.final.urlSha256,
      sourceFetchMode: "embedded-default",
      sourceUpdaterInvoked: events[0].event === "source-updater-invoked",
      targetRunningImageSha256: targetBinding.targetRunningImageSha256,
      targetTerminalRecordSha256: captured["target-terminal-record.json"].sha256,
      terminalAuthority: productTerminal.authority,
      terminalOutcome: productTerminal.terminalOutcome
    },
    preservation: preservation.preservation,
    nativeRuntime: nativeRuntime.runtime,
    producer,
    attachments,
    completedAt: targetTerminal.recordedAt
  };
}

function readInitialContext(snapshot) {
  assertExactKeys(snapshot, [...CONTEXT_KEYS, "capturedAt", "source"],
    "source release snapshot");
  assertEqual(snapshot.schemaVersion, 1, "source release snapshot schema version");
  assertEqual(snapshot.kind, "rion-production-updater-source-release-snapshot",
    "source release snapshot kind");
  const platform = requiredEnum(
    snapshot.platform,
    Object.keys(PLATFORM_TARGETS),
    "evidence platform"
  );
  const transitionKind = requiredEnum(snapshot.transitionKind, [
    "tauri-v22-to-electron-v23",
    "electron-v23-to-electron-v23"
  ], "evidence transition kind");
  const evidenceAttemptId = requiredUuid(snapshot.evidenceAttemptId, "evidence attempt ID");
  const sourceInstallAttemptId = requiredSourceAttemptId(
    snapshot.sourceInstallAttemptId,
    transitionKind
  );
  const challenge = assertChallenge(snapshot.challenge);
  return { challenge, evidenceAttemptId, platform, sourceInstallAttemptId, transitionKind };
}

function assertAttachmentContext(document, context, kind, additionalKeys, label) {
  assertExactKeys(document, [...CONTEXT_KEYS, ...additionalKeys], label);
  assertEqual(document.schemaVersion, 1, `${label} schema version`);
  assertEqual(document.kind, kind, `${label} kind`);
  assertEqual(document.evidenceAttemptId, context.evidenceAttemptId,
    `${label} evidence attempt ID`);
  assertEqual(document.sourceInstallAttemptId, context.sourceInstallAttemptId,
    `${label} source install attempt ID`);
  assertEqual(document.platform, context.platform, `${label} platform`);
  assertEqual(document.transitionKind, context.transitionKind, `${label} transition kind`);
  assertExactRecord(document.challenge, context.challenge, `${label} challenge`);
}

function assertSourceJournal(document, identity, context, target) {
  assertExactKeys(document, ["attempt", "schemaVersion"], "source install journal");
  assertEqual(document.schemaVersion, 1, "source install journal schema version");
  assertExactKeys(document.attempt,
    ["attemptId", "phase", "startedAt", "targetVersion", "updatedAt"],
    "source install journal attempt");
  assertEqual(document.attempt.attemptId, context.sourceInstallAttemptId,
    "source install journal attempt ID");
  assertEqual(document.attempt.phase, sourceHandoffPhase(context.platform),
    "source install journal handoff phase");
  assertEqual(document.attempt.targetVersion, target.version,
    "source install journal target version");
  requiredRfc3339(document.attempt.startedAt, "source install journal start time");
  requiredRfc3339(document.attempt.updatedAt, "source install journal update time");
  requiredDigest(identity.sha256, "raw source install journal SHA-256");
  return document;
}

function assertProductTerminal(document, rawJournal, sourceJournal, context, target) {
  assertExactKeys(document, [
    "attempt", "authority", "kind", "reconciledAt", "runningVersion",
    "schemaVersion", "sourceJournalBytes", "sourceJournalSha256", "sourcePhase",
    "terminalOutcome"
  ], "product terminal receipt");
  assertEqual(document.schemaVersion, 1, "product terminal receipt schema version");
  assertEqual(document.kind, "rion-updater-install-terminal", "product terminal receipt kind");
  assertEqual(document.authority, "target-first-boot-journal-reconciliation",
    "product terminal authority");
  assertEqual(document.sourceJournalBytes, rawJournal.bytes,
    "product terminal raw source journal bytes");
  assertEqual(document.sourceJournalSha256, rawJournal.sha256,
    "product terminal raw source journal SHA-256");
  assertEqual(document.sourcePhase, sourceJournal.attempt.phase,
    "product terminal source phase");
  assertEqual(document.runningVersion, target.version, "product terminal running version");
  assertEqual(document.terminalOutcome, "applied", "product terminal outcome");
  assertExactKeys(document.attempt,
    ["attemptId", "phase", "startedAt", "targetVersion", "updatedAt"],
    "product terminal attempt");
  assertEqual(document.attempt.attemptId, context.sourceInstallAttemptId,
    "product terminal attempt ID");
  assertEqual(document.attempt.phase, "applied", "product terminal attempt phase");
  assertEqual(document.attempt.startedAt, sourceJournal.attempt.startedAt,
    "product terminal attempt start");
  assertEqual(document.attempt.targetVersion, target.version,
    "product terminal attempt target version");
  assertEqual(document.attempt.updatedAt, document.reconciledAt,
    "product terminal attempt update time");
  requiredRfc3339(document.reconciledAt, "product terminal reconciliation time");
  if (timestamp(document.reconciledAt, "product terminal reconciliation") <
      timestamp(sourceJournal.attempt.updatedAt, "source journal handoff")) {
    throw new Error("The product terminal receipt cannot precede source handoff.");
  }
  return document;
}

function assertSourceEvents(events, context, source, target) {
  if (events.length !== SOURCE_EVENTS.length) {
    throw new Error(`The source event stream must contain exactly ${SOURCE_EVENTS.length} events.`);
  }
  let previousTime;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const [expectedEvent, declaredPhase] = SOURCE_EVENTS[index];
    const expectedPhase = declaredPhase ?? sourceHandoffPhase(context.platform);
    const label = `source event ${index + 1}`;
    assertAttachmentContext(event, context, "rion-production-updater-source-event", [
      "event", "observedAt", "phase", "sequence", "source", "target"
    ], label);
    assertEqual(event.sequence, index + 1, `${label} sequence`);
    assertEqual(event.event, expectedEvent, `${label} event`);
    assertEqual(event.phase, expectedPhase, `${label} phase`);
    assertExactRecord(event.source, source, `${label} source`);
    assertExactRecord(event.target, target, `${label} target`);
    const observedAt = timestamp(event.observedAt, `${label} observed-at`);
    if (previousTime !== undefined && observedAt < previousTime) {
      throw new Error("The source event stream timestamps must be monotonically ordered.");
    }
    previousTime = observedAt;
  }
  return events;
}

function assertEndpointObservation(document, context, source, target, publicKeySha256) {
  assertAttachmentContext(document, context,
    "rion-production-updater-endpoint-observation", ["endpoint", "observedAt"],
    "endpoint observation");
  const endpoint = document.endpoint;
  assertExactKeys(endpoint, [
    "artifactName", "artifactSha256", "final", "manifestName", "redirectCount",
    "redirects", "requestEndpoint", "servedManifestSha256", "signatureName",
    "signatureSha256", "status", "targetEmbeddedUpdaterEndpoint",
    "updaterPublicKeySha256"
  ], "endpoint observation result");
  const sourceEndpoint = context.transitionKind === "tauri-v22-to-electron-v23"
    ? source.defaultUpdaterEndpoint
    : source.embeddedUpdaterEndpoint;
  assertEqual(endpoint.requestEndpoint, sourceEndpoint, "source fetch endpoint");
  for (const [field, expected] of Object.entries({
    artifactName: target.artifactName,
    artifactSha256: target.artifactSha256,
    manifestName: target.manifestName,
    servedManifestSha256: target.servedManifestSha256,
    signatureName: target.signatureName,
    signatureSha256: target.signatureSha256,
    status: 200,
    targetEmbeddedUpdaterEndpoint: target.embeddedUpdaterEndpoint,
    updaterPublicKeySha256: publicKeySha256
  })) assertEqual(endpoint[field], expected, `endpoint observation ${field}`);
  assertRedirectChain(endpoint, context.transitionKind, target.version);
  requiredRfc3339(document.observedAt, "endpoint observation time");
  return document;
}

function assertRedirectChain(endpoint, transitionKind, targetVersion) {
  if (!Array.isArray(endpoint.redirects)) {
    throw new Error("The endpoint redirect chain must be an array.");
  }
  assertEqual(endpoint.redirectCount, endpoint.redirects.length, "endpoint redirect count");
  assertExactKeys(endpoint.final, ["host", "scheme", "status", "urlSha256"],
    "endpoint final response");
  assertEqual(endpoint.final.scheme, "https:", "endpoint final response scheme");
  assertEqual(endpoint.final.status, 200, "endpoint final response status");
  requiredDigest(endpoint.final.urlSha256, "endpoint final response URL SHA-256");
  const request = requiredHttpsEndpoint(endpoint.requestEndpoint, "source fetch endpoint");
  let previousHash = sha256(Buffer.from(request.href, "utf8"));
  let previousHost = request.hostname;
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  if ((!isTauri && endpoint.redirects.length !== 0) ||
      (isTauri && (endpoint.redirects.length < 1 || endpoint.redirects.length > 3))) {
    throw new Error("The endpoint redirect count is invalid for the source runtime.");
  }
  const taggedEndpoint =
    `https://github.com/rion-tw/rion-studio/releases/download/v${targetVersion}/latest.json`;
  endpoint.redirects.forEach((redirect, index) => {
    const label = `endpoint redirect ${index + 1}`;
    assertExactKeys(redirect, [
      "fromHost", "fromScheme", "fromUrlSha256", "locationUrlSha256", "sequence",
      "status", "toHost", "toScheme"
    ], label);
    assertEqual(redirect.sequence, index + 1, `${label} sequence`);
    assertEqual(redirect.fromScheme, "https:", `${label} source scheme`);
    assertEqual(redirect.toScheme, "https:", `${label} target scheme`);
    assertEqual(redirect.fromHost, previousHost, `${label} source host`);
    assertEqual(redirect.fromUrlSha256, previousHash, `${label} source URL SHA-256`);
    requiredDigest(redirect.locationUrlSha256, `${label} target URL SHA-256`);
    if (![301, 302, 303, 307, 308].includes(redirect.status)) {
      throw new Error(`The ${label} status is not an HTTP redirect.`);
    }
    if (isTauri && index === 0) {
      assertEqual(redirect.fromHost, "github.com", `${label} source host`);
      assertEqual(redirect.toHost, "github.com", `${label} target host`);
      assertEqual(redirect.locationUrlSha256, sha256(Buffer.from(taggedEndpoint, "utf8")),
        `${label} exact tagged target URL SHA-256`);
    } else if (isTauri) {
      assertEqual(redirect.toHost, TAURI_ASSET_HOST, `${label} target host`);
    }
    previousHash = redirect.locationUrlSha256;
    previousHost = redirect.toHost;
  });
  assertEqual(endpoint.final.urlSha256, previousHash, "endpoint final URL SHA-256");
  assertEqual(endpoint.final.host, previousHost, "endpoint final host");
}

function assertPreservationObservation(document, context, target) {
  assertAttachmentContext(document, context,
    "rion-production-updater-data-preservation-observation",
    ["observedAt", "preservation", "target"], "data preservation observation");
  assertExactRecord(document.target, target, "data preservation target");
  assertExactKeys(document.preservation, [
    "afterChallengeSha256", "beforeChallengeSha256", "preserved",
    "userDataIdentitySha256"
  ], "data preservation result");
  assertEqual(document.preservation.beforeChallengeSha256, context.challenge.nonceSha256,
    "pre-update challenge SHA-256");
  assertEqual(document.preservation.afterChallengeSha256, context.challenge.nonceSha256,
    "post-update challenge SHA-256");
  assertEqual(document.preservation.preserved, true, "data preservation verdict");
  requiredDigest(document.preservation.userDataIdentitySha256, "user-data identity SHA-256");
  requiredRfc3339(document.observedAt, "data preservation observation time");
  return document;
}

function assertNativeHostObservation(document, context, target, runningImageSha256) {
  assertAttachmentContext(document, context,
    "rion-production-updater-native-host-observation",
    ["capturedAt", "observedAt", "runtime", "target", "targetRunningImageSha256"],
    "native host observation");
  assertExactRecord(document.target, target, "native host target");
  assertEqual(document.targetRunningImageSha256, runningImageSha256,
    "native host target running image SHA-256");
  assertExactKeys(document.runtime, [
    "nativeHostKind", "remoteDebugging", "retainedAppKitHost", "targetVersionObserved"
  ], "native runtime observation");
  const expected = PLATFORM_TARGETS[context.platform];
  assertEqual(document.runtime.nativeHostKind, expected.nativeHostKind,
    "native runtime host kind");
  assertEqual(document.runtime.retainedAppKitHost, expected.retainedAppKitHost,
    "native runtime retained AppKit host");
  assertEqual(document.runtime.remoteDebugging, false, "native runtime remote debugging");
  assertEqual(document.runtime.targetVersionObserved, target.version,
    "native runtime target version");
  const observedAt = requiredRfc3339(
    document.observedAt,
    "native host observation time"
  );
  const capturedAt = requiredRfc3339(
    document.capturedAt,
    "native host capture time"
  );
  if (Date.parse(capturedAt) < Date.parse(observedAt)) {
    throw new Error("The native host capture precedes the observed target process.");
  }
  if (Date.parse(capturedAt) > Date.parse(context.challenge.expiresAt)) {
    throw new Error("The native host capture exceeds the evidence challenge lifetime.");
  }
  return document;
}

function assertTargetTerminal(document, productSha256, context, product, target, runningSha256) {
  assertAttachmentContext(document, context,
    "rion-production-updater-target-terminal-record", [
      "deadlineUsedAsSuccess", "firstBoot", "journal", "productTerminalReceiptSha256",
      "recordedAt", "target", "targetRunningImageSha256", "terminalAuthority",
      "terminalOutcome"
    ], "target terminal record");
  assertEqual(document.firstBoot, true, "target terminal first-boot verdict");
  assertEqual(document.deadlineUsedAsSuccess, false, "target terminal deadline policy");
  assertEqual(document.productTerminalReceiptSha256, productSha256,
    "target terminal product receipt SHA-256");
  assertExactRecord(document.target, target, "target terminal target");
  assertEqual(document.targetRunningImageSha256, runningSha256,
    "target terminal running image SHA-256");
  assertEqual(document.terminalAuthority, product.authority, "target terminal authority");
  assertEqual(document.terminalOutcome, product.terminalOutcome, "target terminal outcome");
  assertExactRecord(document.journal, {
    attemptId: context.sourceInstallAttemptId,
    phase: product.terminalOutcome,
    reconciled: true,
    reconciledAt: product.reconciledAt,
    targetVersion: target.version
  }, "target terminal journal");
  requiredRfc3339(document.recordedAt, "target terminal record time");
  return document;
}

function assertSourceBinding(value, transitionKind) {
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  assertExactKeys(value, [
    "artifactName", "artifactSha256", ...(isTauri ? [] : ["candidateReceiptSha256"]),
    ...(isTauri ? ["defaultUpdaterEndpoint"] : ["embeddedUpdaterEndpoint"]),
    "lineageKind", "manifestName", "manifestSha256", ...(isTauri ? ["releaseTag"] : []),
    "runningImageSha256", "runtime", "sourceSha", "version"
  ], "source binding");
  assertEqual(value.runtime, isTauri ? "tauri-v22" : "electron-v23", "source runtime");
  assertEqual(value.lineageKind, isTauri ? "published-release" : "production-candidate",
    "source lineage kind");
  if (isTauri) {
    assertEqual(value.defaultUpdaterEndpoint, TAURI_UPDATER_ENDPOINT,
      "Tauri source updater endpoint");
    assertEqual(value.releaseTag, `v${value.version}`, "Tauri source release tag");
  } else {
    requiredDigest(value.candidateReceiptSha256, "source candidate receipt SHA-256");
    requiredHttpsEndpoint(value.embeddedUpdaterEndpoint, "source embedded updater endpoint");
  }
  requiredNonemptyString(value.artifactName, "source artifact name");
  requiredDigest(value.artifactSha256, "source artifact SHA-256");
  assertEqual(value.manifestName, "latest.json", "source manifest name");
  requiredDigest(value.manifestSha256, "source manifest SHA-256");
  requiredDigest(value.runningImageSha256, "source running image SHA-256");
  requiredCommitSha(value.sourceSha, "source commit SHA");
  requiredSemanticVersion(value.version, "source version");
  return { ...value };
}

function assertTargetBinding(value, platform) {
  const targetKeys = [
    "artifactName", "artifactSha256", "candidateReceiptSha256", "embeddedUpdaterEndpoint",
    "manifestName", "runtime", "servedManifestSha256", "signatureName",
    "signatureSha256", "sourceSha", "version"
  ];
  assertExactKeys(value, [...targetKeys, "targetRunningImageSha256", "updaterPublicKeySha256"],
    "target binding");
  const target = Object.fromEntries(targetKeys.map((key) => [key, value[key]]));
  const expected = PLATFORM_TARGETS[platform];
  assertEqual(target.runtime, "electron-v23", "target runtime");
  assertEqual(target.artifactName, expected.artifactName, "target artifact name");
  assertEqual(target.signatureName, expected.signatureName, "target signature name");
  assertEqual(target.manifestName, "latest.json", "target manifest name");
  requiredDigest(target.artifactSha256, "target artifact SHA-256");
  requiredDigest(target.candidateReceiptSha256, "target candidate receipt SHA-256");
  requiredDigest(target.servedManifestSha256, "target served manifest SHA-256");
  requiredDigest(target.signatureSha256, "target signature SHA-256");
  requiredCommitSha(target.sourceSha, "target source SHA");
  requiredSemanticVersion(target.version, "target version");
  requiredHttpsEndpoint(target.embeddedUpdaterEndpoint, "target embedded updater endpoint");
  return {
    target,
    targetRunningImageSha256: requiredDigest(
      value.targetRunningImageSha256,
      "target running image SHA-256"
    ),
    updaterPublicKeySha256: requiredDigest(
      value.updaterPublicKeySha256,
      "updater public key SHA-256"
    )
  };
}

function assertProvenance(value, target) {
  assertExactKeys(value,
    ["artifactName", "repository", "runAttempt", "runId", "sourceSha", "workflow"],
    "evidence producer provenance");
  assertEqual(value.repository, "rion-tw/rion-studio-source", "evidence producer repository");
  assertEqual(value.workflow, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_WORKFLOW,
    "evidence producer workflow");
  requiredRunId(value.runId, "evidence producer run ID");
  requiredPositiveInteger(value.runAttempt, "evidence producer run attempt");
  assertEqual(value.sourceSha, target.sourceSha, "evidence producer target source SHA");
  assertEqual(
    value.artifactName,
    `electron-production-updater-terminal-evidence-${target.version}-${target.sourceSha}` +
      `-attempt-${value.runAttempt}`,
    "evidence producer artifact name"
  );
  return { ...value };
}

function assertChallenge(value) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "evidence challenge");
  requiredUuid(value.id, "evidence challenge ID");
  requiredDigest(value.nonceSha256, "evidence challenge nonce SHA-256");
  const issuedAt = timestamp(value.issuedAt, "evidence challenge issued-at");
  const expiresAt = timestamp(value.expiresAt, "evidence challenge expires-at");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 24 * 60 * 60 * 1000) {
    throw new Error("The evidence challenge lifetime must be positive and at most 24 hours.");
  }
  return { ...value };
}

function assertEvidenceWindow(challenge, events, completedAt) {
  const issuedAt = timestamp(challenge.issuedAt, "evidence challenge issued-at");
  const expiresAt = timestamp(challenge.expiresAt, "evidence challenge expires-at");
  const completed = timestamp(completedAt, "evidence completion time");
  if (completed < issuedAt || completed > expiresAt) {
    throw new Error("The terminal evidence completed outside its challenge window.");
  }
  for (const [index, event] of events.entries()) {
    const observedAt = timestamp(event.observedAt, `source event ${index + 1} observed-at`);
    if (observedAt < issuedAt || observedAt > completed) {
      throw new Error(`The source event ${index + 1} falls outside the evidence window.`);
    }
  }
}

function assertWithinEvidenceWindow(value, challenge, completedAt, label) {
  const observedAt = timestamp(value, label);
  const issuedAt = timestamp(challenge.issuedAt, "evidence challenge issued-at");
  const completed = timestamp(completedAt, "evidence completion time");
  if (observedAt < issuedAt || observedAt > completed) {
    throw new Error(`The ${label} falls outside the terminal evidence window.`);
  }
}

async function captureAttachments(paths) {
  const captured = {};
  const filesystemObjects = new Set();
  for (const name of ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES) {
    const identity = await captureStableRegularFile(
      paths[name],
      name.endsWith(".jsonl") ? MAX_EVENT_STREAM_BYTES : MAX_DOCUMENT_BYTES,
      name
    );
    const objectId = `${identity.dev}:${identity.ino}`;
    if (filesystemObjects.has(objectId)) {
      throw new Error("Every terminal evidence attachment must be a distinct filesystem object.");
    }
    filesystemObjects.add(objectId);
    captured[name] = identity;
  }
  return captured;
}

function assertAttachmentPathMap(value) {
  assertExactKeys(value, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES,
    "terminal evidence attachment path map");
  return Object.fromEntries(
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTACHMENT_NAMES.map((name) => [
      name,
      requiredAbsolutePath(value[name], `${name} path`)
    ])
  );
}

async function captureStableRegularFile(filePath, maximumBytes, label) {
  const pathBefore = await lstat(filePath, { bigint: true });
  assertBoundedSingleLinkFile(pathBefore, maximumBytes, label);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertSameFile(pathBefore, before, label);
    assertBoundedSingleLinkFile(before, maximumBytes, label);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameFile(before, after, label);
    const pathAfter = await lstat(filePath, { bigint: true });
    assertSameFile(after, pathAfter, label);
    return {
      bytes: Number(after.size),
      dev: after.dev,
      ino: after.ino,
      sha256: sha256(source),
      source
    };
  } finally {
    await handle.close();
  }
}

async function resolveCreateNewDirectory(value) {
  const requested = requiredAbsolutePath(value, "evidence bundle output root");
  const parent = await requiredStableDirectory(dirname(requested),
    "evidence bundle output parent");
  const outputRoot = join(parent.path, basename(requested));
  try {
    await lstat(outputRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return outputRoot;
    throw error;
  }
  throw new Error("The evidence bundle output root must be create-new.");
}

async function requiredStableDirectory(value, label) {
  const requestedPath = requiredAbsolutePath(value, label);
  const requested = await lstat(requestedPath, { bigint: true });
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonicalPath = await realpath(requestedPath);
  const canonical = await lstat(canonicalPath, { bigint: true });
  assertSameDirectory(requested, canonical, label);
  return { label, metadata: canonical, path: canonicalPath };
}

async function assertStableDirectoryUnchanged(directory) {
  const observed = await lstat(directory.path, { bigint: true });
  assertSameDirectory(directory.metadata, observed, directory.label);
}

function assertBoundedSingleLinkFile(metadata, maximumBytes, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size <= 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(`The ${label} must be a bounded, nonempty, single-link regular file.`);
  }
}

function assertSameFile(expected, observed, label) {
  if (!observed.isFile() || expected.dev !== observed.dev || expected.ino !== observed.ino ||
      expected.mode !== observed.mode || expected.nlink !== observed.nlink ||
      expected.size !== observed.size || expected.mtimeNs !== observed.mtimeNs ||
      expected.ctimeNs !== observed.ctimeNs) {
    throw new Error(`The ${label} changed while it was read.`);
  }
}

function assertSameDirectory(expected, observed, label) {
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      expected.dev !== observed.dev || expected.ino !== observed.ino ||
      expected.mode !== observed.mode || expected.nlink !== observed.nlink ||
      expected.size !== observed.size || expected.mtimeNs !== observed.mtimeNs ||
      expected.ctimeNs !== observed.ctimeNs) {
    throw new Error(`The ${label} changed while it was resolved.`);
  }
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must contain one JSON object.`);
  }
  return value;
}

function parseJsonLines(source, label) {
  const text = source.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`The ${label} must end with one newline.`);
  const lines = text.slice(0, -1).split(/\r?\n/u);
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error(`The ${label} must contain nonempty JSON lines without gaps.`);
  }
  return lines.map((line, index) =>
    parseJsonObject(Buffer.from(line, "utf8"), `${label} line ${index + 1}`)
  );
}

function requiredSourceAttemptId(value, transitionKind) {
  const attemptId = requiredNonemptyString(value, "source install attempt ID");
  if (transitionKind === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9]\d*)$/u.exec(attemptId);
    if (!match || BigInt(match[1]) > 18_446_744_073_709_551_615n) {
      throw new Error("The source install attempt ID is not an exact Tauri v22 sequence.");
    }
  } else {
    const prefix = "update-install-";
    if (!attemptId.startsWith(prefix)) {
      throw new Error("The source install attempt ID is not an Electron v23 UUID.");
    }
    requiredUuid(attemptId.slice(prefix.length), "source install attempt ID");
  }
  return attemptId;
}

function requiredHttpsEndpoint(value, label) {
  const endpoint = requiredNonemptyString(value, label);
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`, { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/latest.json") || url.href !== endpoint) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  return url;
}

function assertVersionIsNewer(target, source) {
  const left = parseSemanticVersion(target, "target version");
  const right = parseSemanticVersion(source, "source version");
  if (compareSemanticVersions(left, right) > 0) return;
  throw new Error("The target version must be strictly newer than the source version.");
}

function parseSemanticVersion(value, label) {
  const normalized = requiredSemanticVersion(value, label);
  const separator = normalized.indexOf("-");
  const core = separator === -1 ? normalized : normalized.slice(0, separator);
  const prereleaseSource = separator === -1 ? undefined : normalized.slice(separator + 1);
  return {
    core: core.split("."),
    prerelease: prereleaseSource?.split(".") ?? []
  };
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const result = compareNumericIdentifier(left.core[index], right.core[index]);
    if (result !== 0) return result;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requiredRfc3339(value, label) {
  const normalized = requiredNonemptyString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
    .exec(normalized);
  if (!match) {
    throw new Error(`The ${label} must be RFC 3339.`);
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [match[1], match[2], match[3], match[4], match[5], match[6], match[7] ?? "0",
      match[8] ?? "0"].map(Number);
  const monthLengths = [
    31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31
  ];
  if (month < 1 || month > 12 || day < 1 || day > (monthLengths[month - 1] ?? 0) ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 ||
      Number.isNaN(Date.parse(normalized))) {
    throw new Error(`The ${label} must be RFC 3339.`);
  }
  return normalized;
}

function timestamp(value, label) {
  return Date.parse(requiredRfc3339(value, label));
}

function requiredSemanticVersion(value, label) {
  const normalized = requiredNonemptyString(value, label);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
    .test(normalized)) {
    throw new Error(`The ${label} must be strict semantic versioning.`);
  }
  const separator = normalized.indexOf("-");
  const prerelease = separator === -1 ? [] : normalized.slice(separator + 1).split(".");
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`The ${label} must not contain a zero-padded numeric prerelease.`);
  }
  return normalized;
}

function requiredUuid(value, label) {
  const normalized = requiredNonemptyString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(normalized)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return normalized;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredCommitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal GitHub run ID.`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value;
}

function requiredEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`The ${label} is unsupported.`);
  return value;
}

function requiredNonemptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${label} is required.`);
  return value;
}

function requiredAbsolutePath(value, label) {
  const normalized = requiredNonemptyString(value, label);
  if (!isAbsolute(normalized)) throw new Error(`The ${label} must be absolute.`);
  return resolve(normalized);
}

function sourceHandoffPhase(platform) {
  return platform === "darwin-aarch64" ? "restartPending" : "installerHandoff";
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertExactRecord(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`The ${label} does not match.`);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  assertStringArrayEqual(actual, expected, `${label} schema`);
}

function assertStringArrayEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`The ${label} is not exact.`);
}

function assertSameInstant(left, right, label) {
  if (timestamp(left, label) !== timestamp(right, label)) {
    throw new Error(`The ${label} timestamps do not match.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`The ${label} does not match.`);
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
