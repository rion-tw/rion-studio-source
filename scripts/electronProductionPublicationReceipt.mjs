import { createHash } from "node:crypto";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertSemanticVersionIsNewer,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_KIND =
  "rion-electron-production-publication-transaction";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY =
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES = Object.freeze({
  intent: "electron-production-publication-intent-receipt.json",
  provisional: "electron-production-publication-provisional-receipt.json",
  "recovery-required": "electron-production-publication-recovery-required-receipt.json",
  terminal: "electron-production-publication-recovery-receipt.json"
});

const MAX_RECEIPT_BYTES = 1024 * 1024;
const PHASES = new Set(["intent", "provisional", "recovery-required", "terminal"]);
const TERMINAL_OUTCOMES = new Set(["aborted", "rolled-back", "indeterminate"]);
const PUBLICATION_ACKNOWLEDGEMENTS = new Set([
  "not-submitted",
  "confirmed",
  "rejected",
  "unknown"
]);
const ROLLBACK_ACKNOWLEDGEMENTS = new Set(["confirmed", "rejected", "unknown"]);
const OBSERVED_STATES = new Set(["baseline", "target", "foreign", "unknown"]);
const LEASE_STATUSES = new Set(["held", "lost", "foreign"]);
const INDETERMINATE_REASONS = new Set([
  "foreign-lease-observed",
  "foreign-state-observed",
  "lease-lost",
  "publication-acknowledgement-unknown",
  "publication-readback-mismatch",
  "published-state-unknown",
  "rollback-acknowledgement-unknown",
  "rollback-not-attempted",
  "rollback-readback-mismatch",
  "rollback-rejected"
]);

export function createElectronProductionPublicationIntent(input) {
  assertExactKeys(input, [
    "baseline",
    "lease",
    "recordedAt",
    "target",
    "transactionId"
  ], "publication intent input");
  const transactionId = requiredUuid(input.transactionId, "publication transaction ID");
  const baseline = assertBaseline(input.baseline);
  const target = assertTarget(input.target, baseline.version);
  const lease = assertInitialLease(input.lease);
  const recordedAt = requiredRfc3339(input.recordedAt, "publication intent time");
  return assertElectronProductionPublicationReceipt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_KIND,
    transactionId,
    revision: 1,
    previousEventSha256: null,
    phase: "intent",
    terminal: false,
    outcome: null,
    channel: canonicalChannel(),
    baseline,
    target,
    lease: {
      id: lease.id,
      generation: lease.generation,
      status: "held",
      foreignLeaseId: null,
      foreignLeaseGeneration: null
    },
    publication: {
      acknowledgement: null,
      observedState: "baseline",
      observedStateSha256: baseline.stateSha256
    },
    recovery: emptyRecovery(false),
    recordedAt
  });
}

export function transitionElectronProductionPublication(previousValue, transition) {
  const previous = assertElectronProductionPublicationReceipt(previousValue);
  if (previous.terminal) {
    throw new Error("A terminal publication transaction cannot transition again.");
  }
  assertTransitionTime(transition?.recordedAt, previous.recordedAt);
  if (previous.phase === "intent") {
    return transitionIntent(previous, transition);
  }
  if (previous.phase === "provisional" || previous.phase === "recovery-required") {
    return transitionRecoverable(previous, transition);
  }
  throw new Error("The publication transaction phase cannot transition.");
}

export function electronProductionPublicationEventSha256(receipt) {
  const validated = assertElectronProductionPublicationReceipt(receipt);
  return createHash("sha256").update(serializeCanonicalJson(validated)).digest("hex");
}

export function assertElectronProductionPublicationReceipt(value) {
  assertExactKeys(value, [
    "baseline",
    "channel",
    "kind",
    "lease",
    "outcome",
    "phase",
    "previousEventSha256",
    "publication",
    "recordedAt",
    "recovery",
    "revision",
    "schemaVersion",
    "target",
    "terminal",
    "transactionId"
  ], "publication transaction receipt");
  assertEqual(value.schemaVersion, 1, "publication receipt schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLICATION_KIND, "publication receipt kind");
  requiredUuid(value.transactionId, "publication transaction ID");
  requiredPositiveInteger(value.revision, "publication revision");
  requiredRfc3339(value.recordedAt, "publication event time");
  if (!PHASES.has(value.phase)) throw new Error("The publication phase is invalid.");
  assertChannel(value.channel);
  const baseline = assertBaseline(value.baseline);
  const target = assertTarget(value.target, baseline.version);
  if (
    target.sourceSha === baseline.sourceSha ||
    target.manifestSha256 === baseline.manifestSha256 ||
    target.stateSha256 === baseline.stateSha256
  ) {
    throw new Error("The publication baseline and target snapshot identities must differ.");
  }
  const lease = assertLease(value.lease);
  const publication = assertPublication(value.publication, baseline, target);
  const recovery = assertRecovery(value.recovery, baseline, target);
  assertRevisionChainShape(value);
  assertPhaseSemantics(value, lease, publication, recovery, baseline, target);
  return deepFreeze({
    ...value,
    channel: { ...value.channel },
    baseline: { ...baseline },
    target: { ...target },
    lease: { ...lease },
    publication: { ...publication },
    recovery: { ...recovery }
  });
}

export async function writeElectronProductionPublicationReceipt(input) {
  assertExactKeys(input, ["outputPath", "receipt"], "publication receipt write input");
  const receipt = assertElectronProductionPublicationReceipt(input.receipt);
  const expectedName = ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES[receipt.phase];
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    expectedName,
    "publication transaction receipt"
  );
  await writeExclusive(outputPath, serializeCanonicalJson(receipt));
  const file = await readCanonicalJsonFile(
    outputPath,
    MAX_RECEIPT_BYTES,
    "publication transaction receipt"
  );
  const reread = assertElectronProductionPublicationReceipt(file.value);
  return deepFreeze({
    receipt: reread,
    receiptIdentity: publicIdentity(outputPath, file),
    receiptPath: outputPath
  });
}

export async function readElectronProductionPublicationReceipt(input) {
  assertExactKeys(
    input,
    ["expectedSha256", "receiptPath"],
    "publication receipt read input"
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "publication transaction receipt"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "publication transaction receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, "publication receipt SHA-256"),
    "publication receipt SHA-256"
  );
  const receipt = assertElectronProductionPublicationReceipt(file.value);
  assertEqual(
    path.basename(receiptPath),
    ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES[receipt.phase],
    "publication receipt filename"
  );
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(receiptPath, file),
    receiptPath
  });
}

function transitionIntent(previous, input) {
  assertExactKeys(input, [
    "acknowledgement",
    "kind",
    "lease",
    "observedState",
    "observedStateSha256",
    "recordedAt"
  ], "publication result transition");
  assertEqual(input.kind, "publication-result", "publication result transition kind");
  const lease = nextLease(previous.lease, input.lease);
  const acknowledgement = requiredEnum(
    input.acknowledgement,
    PUBLICATION_ACKNOWLEDGEMENTS,
    "publication acknowledgement"
  );
  const observation = assertObservation(
    input.observedState,
    input.observedStateSha256,
    previous.baseline,
    previous.target,
    "publication readback"
  );
  const common = nextEvent(previous, input.recordedAt, lease);
  const publication = {
    acknowledgement,
    observedState: observation.state,
    observedStateSha256: observation.sha256
  };

  if (
    acknowledgement === "confirmed" &&
    lease.status === "held" &&
    observation.state === "target"
  ) {
    return assertElectronProductionPublicationReceipt({
      ...common,
      phase: "provisional",
      terminal: false,
      outcome: null,
      publication,
      recovery: emptyRecovery(true)
    });
  }
  if (
    (acknowledgement === "not-submitted" || acknowledgement === "rejected") &&
    lease.status === "held" &&
    observation.state === "baseline"
  ) {
    return terminalEvent(common, publication, {
      rollbackAllowed: false,
      rollbackAttempted: false,
      acknowledgement: null,
      observedStateBeforeRollback: null,
      observedStateBeforeRollbackSha256: null,
      finalState: "baseline",
      finalStateSha256: previous.baseline.stateSha256,
      reason: acknowledgement === "not-submitted"
        ? "publication-not-submitted"
        : "publication-rejected"
    }, "aborted");
  }
  if (
    acknowledgement === "unknown" &&
    lease.status === "held" &&
    observation.state === "target"
  ) {
    return assertElectronProductionPublicationReceipt({
      ...common,
      phase: "recovery-required",
      terminal: false,
      outcome: null,
      publication,
      recovery: emptyRecovery(true)
    });
  }
  const reason = publicationIndeterminateReason(acknowledgement, lease, observation.state);
  return terminalEvent(common, publication, {
    rollbackAllowed: false,
    rollbackAttempted: false,
    acknowledgement: null,
    observedStateBeforeRollback: null,
    observedStateBeforeRollbackSha256: null,
    finalState: observation.state,
    finalStateSha256: observation.sha256,
    reason
  }, "indeterminate");
}

function transitionRecoverable(previous, input) {
  assertExactKeys(input, [
    "finalState",
    "finalStateSha256",
    "kind",
    "lease",
    "observedState",
    "observedStateSha256",
    "recordedAt",
    "rollbackAcknowledgement",
    "rollbackAttempted"
  ], "publication recovery transition");
  assertEqual(input.kind, "recovery-result", "publication recovery transition kind");
  const lease = nextLease(previous.lease, input.lease);
  const observed = assertObservation(
    input.observedState,
    input.observedStateSha256,
    previous.baseline,
    previous.target,
    "pre-rollback readback"
  );
  const final = assertObservation(
    input.finalState,
    input.finalStateSha256,
    previous.baseline,
    previous.target,
    "recovery final readback"
  );
  if (typeof input.rollbackAttempted !== "boolean") {
    throw new Error("The rollback-attempted field must be boolean.");
  }
  const rollbackAllowed = lease.status === "held" && observed.state === "target";
  if (!rollbackAllowed && input.rollbackAttempted) {
    throw new Error("Rollback is forbidden after lease loss or a non-target readback.");
  }
  const acknowledgement = input.rollbackAcknowledgement === null
    ? null
    : requiredEnum(
        input.rollbackAcknowledgement,
        ROLLBACK_ACKNOWLEDGEMENTS,
        "rollback acknowledgement"
      );
  if (input.rollbackAttempted !== (acknowledgement !== null)) {
    throw new Error("Rollback acknowledgement presence must match rollback submission.");
  }
  if (!input.rollbackAttempted && (
    final.state !== observed.state || final.sha256 !== observed.sha256
  )) {
    throw new Error("A recovery that did not attempt rollback cannot claim a changed final state.");
  }
  const common = nextEvent(previous, input.recordedAt, lease);
  const recovery = {
    rollbackAllowed,
    rollbackAttempted: input.rollbackAttempted,
    acknowledgement,
    observedStateBeforeRollback: observed.state,
    observedStateBeforeRollbackSha256: observed.sha256,
    finalState: final.state,
    finalStateSha256: final.sha256,
    reason: null
  };
  if (
    rollbackAllowed && input.rollbackAttempted && acknowledgement === "confirmed" &&
    final.state === "baseline"
  ) {
    return terminalEvent(common, previous.publication, {
      ...recovery,
      reason: "source-snapshot-restored"
    }, "rolled-back");
  }
  return terminalEvent(common, previous.publication, {
    ...recovery,
    reason: recoveryIndeterminateReason(lease, observed.state, recovery)
  }, "indeterminate");
}

function terminalEvent(common, publication, recovery, outcome) {
  return assertElectronProductionPublicationReceipt({
    ...common,
    phase: "terminal",
    terminal: true,
    outcome,
    publication,
    recovery
  });
}

function nextEvent(previous, recordedAt, lease) {
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_KIND,
    transactionId: previous.transactionId,
    revision: previous.revision + 1,
    previousEventSha256: electronProductionPublicationEventSha256(previous),
    channel: { ...previous.channel },
    baseline: { ...previous.baseline },
    target: { ...previous.target },
    lease,
    recordedAt
  };
}

function emptyRecovery(rollbackAllowed) {
  return {
    rollbackAllowed,
    rollbackAttempted: false,
    acknowledgement: null,
    observedStateBeforeRollback: null,
    observedStateBeforeRollbackSha256: null,
    finalState: null,
    finalStateSha256: null,
    reason: null
  };
}

function publicationIndeterminateReason(acknowledgement, lease, observedState) {
  if (lease.status === "lost") return "lease-lost";
  if (lease.status === "foreign") return "foreign-lease-observed";
  if (observedState === "foreign") return "foreign-state-observed";
  if (observedState === "unknown") return "published-state-unknown";
  if (acknowledgement === "unknown") return "publication-acknowledgement-unknown";
  return "publication-readback-mismatch";
}

function recoveryIndeterminateReason(lease, observedState, recovery) {
  if (lease.status === "lost") return "lease-lost";
  if (lease.status === "foreign") return "foreign-lease-observed";
  if (observedState === "foreign") return "foreign-state-observed";
  if (observedState === "unknown") return "published-state-unknown";
  if (!recovery.rollbackAttempted) return "rollback-not-attempted";
  if (recovery.acknowledgement === "unknown") {
    return "rollback-acknowledgement-unknown";
  }
  if (recovery.acknowledgement === "rejected") return "rollback-rejected";
  return "rollback-readback-mismatch";
}

function assertPhaseSemantics(value, lease, publication, recovery, baseline, target) {
  if (value.phase === "intent") {
    assertEqual(value.revision, 1, "intent revision");
    assertEqual(value.terminal, false, "intent terminality");
    assertEqual(value.outcome, null, "intent outcome");
    assertEqual(lease.status, "held", "intent lease status");
    assertEqual(publication.acknowledgement, null, "intent acknowledgement");
    assertEqual(publication.observedState, "baseline", "intent observed state");
    assertEqual(publication.observedStateSha256, baseline.stateSha256, "intent baseline state");
    assertEmptyRecovery(recovery, false, "intent recovery");
    return;
  }
  if (value.phase === "provisional") {
    if (value.revision < 2) throw new Error("A provisional publication must follow an intent.");
    assertEqual(value.terminal, false, "provisional terminality");
    assertEqual(value.outcome, null, "provisional outcome");
    assertEqual(lease.status, "held", "provisional lease status");
    assertEqual(publication.acknowledgement, "confirmed", "provisional acknowledgement");
    assertEqual(publication.observedState, "target", "provisional observed state");
    assertEqual(publication.observedStateSha256, target.stateSha256, "provisional target state");
    assertEmptyRecovery(recovery, true, "provisional recovery");
    return;
  }
  if (value.phase === "recovery-required") {
    if (value.revision < 2) {
      throw new Error("A recovery-required publication must follow an intent.");
    }
    assertEqual(value.terminal, false, "recovery-required terminality");
    assertEqual(value.outcome, null, "recovery-required outcome");
    assertEqual(lease.status, "held", "recovery-required lease status");
    assertEqual(
      publication.acknowledgement,
      "unknown",
      "recovery-required publication acknowledgement"
    );
    assertEqual(publication.observedState, "target", "recovery-required observed state");
    assertEqual(
      publication.observedStateSha256,
      target.stateSha256,
      "recovery-required target state"
    );
    assertEmptyRecovery(recovery, true, "recovery-required recovery");
    return;
  }
  assertEqual(value.terminal, true, "terminal publication terminality");
  if (!TERMINAL_OUTCOMES.has(value.outcome)) {
    throw new Error("The publication recovery outcome is invalid.");
  }
  if (value.outcome === "aborted") {
    if (
      !["not-submitted", "rejected"].includes(publication.acknowledgement) ||
      publication.observedState !== "baseline" ||
      publication.observedStateSha256 !== baseline.stateSha256 ||
      recovery.rollbackAllowed || recovery.rollbackAttempted ||
      recovery.acknowledgement !== null ||
      recovery.observedStateBeforeRollback !== null ||
      recovery.observedStateBeforeRollbackSha256 !== null ||
      recovery.finalState !== "baseline" ||
      recovery.finalStateSha256 !== baseline.stateSha256 ||
      recovery.reason !== (publication.acknowledgement === "not-submitted"
        ? "publication-not-submitted"
        : "publication-rejected")
    ) throw new Error("The aborted publication receipt is inconsistent.");
    return;
  }
  if (value.outcome === "rolled-back") {
    if (
      lease.status !== "held" ||
      !["confirmed", "unknown"].includes(publication.acknowledgement) ||
      publication.observedState !== "target" ||
      publication.observedStateSha256 !== target.stateSha256 ||
      !recovery.rollbackAllowed || !recovery.rollbackAttempted ||
      recovery.acknowledgement !== "confirmed" ||
      recovery.observedStateBeforeRollback !== "target" ||
      recovery.observedStateBeforeRollbackSha256 !== target.stateSha256 ||
      recovery.finalState !== "baseline" ||
      recovery.finalStateSha256 !== baseline.stateSha256 ||
      recovery.reason !== "source-snapshot-restored"
    ) throw new Error("The rolled-back publication receipt is inconsistent.");
    return;
  }
  if (!INDETERMINATE_REASONS.has(recovery.reason)) {
    throw new Error("The indeterminate publication reason is invalid.");
  }
  if (
    (lease.status === "lost" || lease.status === "foreign" ||
      publication.observedState === "foreign") &&
    recovery.rollbackAttempted
  ) {
    throw new Error("An indeterminate foreign or lease-lost receipt cannot claim rollback.");
  }
  if (
    recovery.rollbackAttempted !== (recovery.acknowledgement !== null) ||
    recovery.finalState === null
  ) throw new Error("The indeterminate recovery fields are inconsistent.");
  assertIndeterminateReason(lease, publication, recovery, baseline, target);
}

function assertIndeterminateReason(lease, publication, recovery, baseline, target) {
  const noRollback = !recovery.rollbackAttempted && recovery.acknowledgement === null;
  if (
    lease.status === "held" &&
    ["not-submitted", "rejected"].includes(publication.acknowledgement) &&
    publication.observedState === "target" &&
    recovery.reason !== "publication-readback-mismatch"
  ) {
    throw new Error("A non-applied publication acknowledgement cannot authorize rollback.");
  }
  if (recovery.reason === "lease-lost") {
    if (lease.status !== "lost" || recovery.rollbackAllowed || !noRollback) {
      throw new Error("The lease-lost recovery reason is inconsistent.");
    }
    return;
  }
  if (recovery.reason === "foreign-lease-observed") {
    if (lease.status !== "foreign" || recovery.rollbackAllowed || !noRollback) {
      throw new Error("The foreign-lease recovery reason is inconsistent.");
    }
    return;
  }
  if (recovery.reason === "foreign-state-observed") {
    const foreignObserved = publication.observedState === "foreign" ||
      recovery.observedStateBeforeRollback === "foreign";
    if (
      !foreignObserved || recovery.rollbackAllowed ||
      recovery.finalState !== "foreign" || !noRollback
    ) {
      throw new Error("The foreign-state recovery reason is inconsistent.");
    }
    return;
  }
  if (recovery.reason === "published-state-unknown") {
    const unknownObserved = publication.observedState === "unknown" ||
      recovery.observedStateBeforeRollback === "unknown";
    if (
      !unknownObserved || recovery.rollbackAllowed ||
      recovery.finalState !== "unknown" || !noRollback
    ) {
      throw new Error("The unknown-state recovery reason is inconsistent.");
    }
    return;
  }
  if (recovery.reason === "publication-acknowledgement-unknown") {
    if (
      publication.acknowledgement !== "unknown" ||
      publication.observedState !== "baseline" ||
      recovery.observedStateBeforeRollback !== null ||
      recovery.finalState !== "baseline" ||
      recovery.finalStateSha256 !== baseline.stateSha256 || !noRollback
    ) throw new Error("The unknown publication acknowledgement is inconsistent.");
    return;
  }
  if (recovery.reason === "publication-readback-mismatch") {
    const confirmedBaselineMismatch =
      publication.acknowledgement === "confirmed" &&
      publication.observedState === "baseline" &&
      recovery.finalState === "baseline" &&
      recovery.finalStateSha256 === baseline.stateSha256;
    const nonApplicationTargetMismatch =
      ["not-submitted", "rejected"].includes(publication.acknowledgement) &&
      publication.observedState === "target" &&
      recovery.finalState === "target" &&
      recovery.finalStateSha256 === target.stateSha256;
    if (
      lease.status !== "held" || recovery.rollbackAllowed ||
      recovery.observedStateBeforeRollback !== null ||
      recovery.observedStateBeforeRollbackSha256 !== null ||
      (!confirmedBaselineMismatch && !nonApplicationTargetMismatch) ||
      !noRollback
    ) throw new Error("The publication readback mismatch is inconsistent.");
    return;
  }
  if (recovery.reason === "rollback-not-attempted") {
    if (
      lease.status !== "held" || recovery.observedStateBeforeRollback === null ||
      recovery.finalState !== recovery.observedStateBeforeRollback ||
      recovery.finalStateSha256 !== recovery.observedStateBeforeRollbackSha256 || !noRollback
    ) throw new Error("The rollback-not-attempted reason is inconsistent.");
    return;
  }
  if (
    lease.status !== "held" || !recovery.rollbackAllowed ||
    !recovery.rollbackAttempted ||
    recovery.observedStateBeforeRollback !== "target" ||
    recovery.observedStateBeforeRollbackSha256 !== target.stateSha256
  ) throw new Error("The rollback recovery reason is inconsistent.");
  if (
    recovery.reason === "rollback-acknowledgement-unknown" &&
    recovery.acknowledgement !== "unknown"
  ) throw new Error("The unknown rollback acknowledgement is inconsistent.");
  if (
    recovery.reason === "rollback-rejected" &&
    recovery.acknowledgement !== "rejected"
  ) throw new Error("The rejected rollback acknowledgement is inconsistent.");
  if (
    recovery.reason === "rollback-readback-mismatch" &&
    (recovery.acknowledgement !== "confirmed" || recovery.finalState === "baseline")
  ) throw new Error("The rollback readback mismatch is inconsistent.");
}

function assertRevisionChainShape(value) {
  if (value.revision === 1) {
    assertEqual(value.previousEventSha256, null, "initial previous-event SHA-256");
  } else {
    requiredDigest(value.previousEventSha256, "previous-event SHA-256");
  }
  if (value.phase !== "intent" && value.revision === 1) {
    throw new Error("A non-intent publication receipt must follow another event.");
  }
}

function assertChannel(value) {
  assertExactKeys(value, ["repository", "updaterEndpoint"], "publication channel");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "publication repository");
  assertEqual(value.updaterEndpoint, ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
    "publication updater endpoint");
  return value;
}

function canonicalChannel() {
  return {
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    updaterEndpoint: ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT
  };
}

function assertBaseline(value) {
  assertExactKeys(value, [
    "manifestSha256",
    "releaseTag",
    "runtime",
    "sourceSha",
    "stateSha256",
    "version"
  ], "publication baseline");
  const version = requiredSemanticVersion(value.version, "publication baseline version");
  assertEqual(value.runtime, "tauri-v22", "publication baseline runtime");
  assertEqual(value.releaseTag, `v${version}`, "publication baseline release tag");
  return {
    manifestSha256: requiredDigest(value.manifestSha256, "publication baseline manifest SHA-256"),
    releaseTag: value.releaseTag,
    runtime: value.runtime,
    sourceSha: requiredCommitSha(value.sourceSha, "publication baseline source SHA"),
    stateSha256: requiredDigest(value.stateSha256, "publication baseline state SHA-256"),
    version
  };
}

function assertTarget(value, baselineVersion) {
  assertExactKeys(value, [
    "candidateReceiptSha256",
    "manifestSha256",
    "releaseTag",
    "runtime",
    "sourceSha",
    "stateSha256",
    "version"
  ], "publication target");
  const version = requiredSemanticVersion(value.version, "publication target version");
  assertSemanticVersionIsNewer(
    version,
    baselineVersion,
    "publication target version"
  );
  assertEqual(value.runtime, "electron-v23", "publication target runtime");
  assertEqual(value.releaseTag, `v${version}`, "publication target release tag");
  const target = {
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      "publication target candidate receipt SHA-256"
    ),
    manifestSha256: requiredDigest(value.manifestSha256, "publication target manifest SHA-256"),
    releaseTag: value.releaseTag,
    runtime: value.runtime,
    sourceSha: requiredCommitSha(value.sourceSha, "publication target source SHA"),
    stateSha256: requiredDigest(value.stateSha256, "publication target state SHA-256"),
    version
  };
  return target;
}

function assertInitialLease(value) {
  assertExactKeys(value, ["generation", "id"], "publication lease input");
  return {
    id: requiredUuid(value.id, "publication lease ID"),
    generation: requiredPositiveInteger(value.generation, "publication lease generation")
  };
}

function assertLease(value) {
  assertExactKeys(value, [
    "foreignLeaseGeneration",
    "foreignLeaseId",
    "generation",
    "id",
    "status"
  ], "publication lease");
  const lease = {
    id: requiredUuid(value.id, "publication lease ID"),
    generation: requiredPositiveInteger(value.generation, "publication lease generation"),
    status: requiredEnum(value.status, LEASE_STATUSES, "publication lease status"),
    foreignLeaseId: value.foreignLeaseId,
    foreignLeaseGeneration: value.foreignLeaseGeneration
  };
  if (lease.status === "foreign") {
    requiredUuid(lease.foreignLeaseId, "foreign publication lease ID");
    requiredPositiveInteger(
      lease.foreignLeaseGeneration,
      "foreign publication lease generation"
    );
    if (
      lease.foreignLeaseId === lease.id &&
      lease.foreignLeaseGeneration === lease.generation
    ) throw new Error("A foreign publication lease must differ from the owned lease fence.");
  } else if (lease.foreignLeaseId !== null || lease.foreignLeaseGeneration !== null) {
    throw new Error("A held or lost publication lease must use explicit null foreign identity.");
  }
  return lease;
}

function nextLease(previous, observation) {
  assertExactKeys(observation, [
    "foreignLeaseGeneration",
    "foreignLeaseId",
    "generation",
    "id",
    "status"
  ], "publication lease observation");
  assertEqual(observation.id, previous.id, "publication lease ID fence");
  assertEqual(observation.generation, previous.generation, "publication lease generation fence");
  return assertLease(observation);
}

function assertPublication(value, baseline, target) {
  assertExactKeys(value, [
    "acknowledgement",
    "observedState",
    "observedStateSha256"
  ], "publication result");
  const acknowledgement = value.acknowledgement === null
    ? null
    : requiredEnum(
        value.acknowledgement,
        PUBLICATION_ACKNOWLEDGEMENTS,
        "publication acknowledgement"
      );
  const observation = assertObservation(
    value.observedState,
    value.observedStateSha256,
    baseline,
    target,
    "publication result"
  );
  return {
    acknowledgement,
    observedState: observation.state,
    observedStateSha256: observation.sha256
  };
}

function assertRecovery(value, baseline, target) {
  assertExactKeys(value, [
    "acknowledgement",
    "finalState",
    "finalStateSha256",
    "observedStateBeforeRollback",
    "observedStateBeforeRollbackSha256",
    "reason",
    "rollbackAllowed",
    "rollbackAttempted"
  ], "publication recovery");
  if (typeof value.rollbackAllowed !== "boolean" || typeof value.rollbackAttempted !== "boolean") {
    throw new Error("The publication rollback flags must be boolean.");
  }
  const acknowledgement = value.acknowledgement === null
    ? null
    : requiredEnum(value.acknowledgement, ROLLBACK_ACKNOWLEDGEMENTS,
        "publication rollback acknowledgement");
  if (value.observedStateBeforeRollback === null) {
    assertEqual(
      value.observedStateBeforeRollbackSha256,
      null,
      "null pre-rollback state SHA-256"
    );
  } else {
    assertObservation(
      value.observedStateBeforeRollback,
      value.observedStateBeforeRollbackSha256,
      baseline,
      target,
      "publication pre-rollback state"
    );
  }
  if (value.finalState === null) {
    assertEqual(value.finalStateSha256, null, "null recovery state SHA-256");
  } else {
    assertObservation(value.finalState, value.finalStateSha256, baseline, target,
      "publication recovery final state");
  }
  if (value.reason !== null && typeof value.reason !== "string") {
    throw new Error("The publication recovery reason must be a string or null.");
  }
  return { ...value, acknowledgement };
}

function assertObservation(stateValue, shaValue, baseline, target, label) {
  const state = requiredEnum(stateValue, OBSERVED_STATES, `${label} state`);
  if (state === "unknown") {
    assertEqual(shaValue, null, `${label} unknown-state SHA-256`);
    return { state, sha256: null };
  }
  const sha256 = requiredDigest(shaValue, `${label} SHA-256`);
  if (state === "baseline") assertEqual(sha256, baseline.stateSha256, `${label} baseline state`);
  if (state === "target") assertEqual(sha256, target.stateSha256, `${label} target state`);
  if (
    state === "foreign" &&
    (sha256 === baseline.stateSha256 || sha256 === target.stateSha256)
  ) throw new Error(`The ${label} foreign state must differ from known snapshots.`);
  return { state, sha256 };
}

function assertEmptyRecovery(value, rollbackAllowed, label) {
  if (
    value.rollbackAllowed !== rollbackAllowed || value.rollbackAttempted ||
    value.acknowledgement !== null || value.observedStateBeforeRollback !== null ||
    value.observedStateBeforeRollbackSha256 !== null || value.finalState !== null ||
    value.finalStateSha256 !== null || value.reason !== null
  ) throw new Error(`The ${label} must contain explicit null recovery fields.`);
}

function assertTransitionTime(value, previousValue) {
  const recordedAt = requiredRfc3339(value, "publication transition time");
  if (Date.parse(recordedAt) < Date.parse(previousValue)) {
    throw new Error("A publication transition cannot precede its previous event.");
  }
}

function requiredEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
