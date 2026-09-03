import {
  assertElectronProductionPublicLatestSnapshot,
  classifyElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
  assertElectronProductionPublicationReceipt,
  createElectronProductionPublicationIntent,
  transitionElectronProductionPublication
} from "./electronProductionPublicationReceipt.mjs";
import {
  assertEqual,
  assertExactKeys
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import { assertTauriV22PublicLineagePair } from "./tauriV22PublicLineage.mjs";

export function createElectronProductionBaselineLineageFromReceipts(input) {
  assertExactKeys(input, [
    "macos",
    "sourceSnapshot",
    "targetSnapshot",
    "windows"
  ], "publication baseline lineage receipt input");
  const pair = assertTauriV22PublicLineagePair({
    macos: input.macos,
    windows: input.windows
  });
  const source = assertSourceSnapshot(input.sourceSnapshot);
  const target = assertTargetSnapshot(input.targetSnapshot);
  const candidate = target.candidateReceipt;
  for (const receipt of [pair.macos, pair.windows]) {
    for (const [actual, expected, label] of [
      [receipt.release.repository, source.repository, "release repository"],
      [receipt.release.id, source.release.id, "release ID"],
      [receipt.release.tag, source.release.tag, "release tag"],
      [receipt.release.version, source.latestJson.version, "release version"],
      [receipt.targetSourceSha, candidate.sourceSha, "target source SHA"],
      [receipt.trust.updaterPublicKeySha256, candidate.publicKeySha256,
        "updater public-key SHA-256"]
    ]) assertEqual(actual, expected, `publication lineage ${label}`);
    assertLineageAssetBinding(receipt.assets.manifest, source, "latest.json");
    assertLineageAssetBinding(receipt.assets.checksums, source, "SHA256SUMS.txt");
    assertLineageAssetBinding(
      receipt.assets.artifact,
      source,
      receipt.platform === "darwin-aarch64"
        ? "Rion.Studio-mac.app.tar.gz"
        : "Rion.Studio-win.exe"
    );
    assertLineageAssetBinding(
      receipt.assets.signature,
      source,
      receipt.platform === "darwin-aarch64"
        ? "Rion.Studio-mac.app.tar.gz.sig"
        : "Rion.Studio-win.exe.sig"
    );
  }
  return Object.freeze({
    runtime: "tauri-v22",
    version: source.latestJson.version,
    releaseTag: source.release.tag,
    sourceSha: pair.macos.sourceTag.peeledCommitSha,
    manifestSha256: source.latestJson.sha256
  });
}

export function createElectronProductionPublicationIntentFromSnapshots(input) {
  assertExactKeys(input, [
    "baselineLineage",
    "lease",
    "recordedAt",
    "sourceSnapshot",
    "targetSnapshot",
    "transactionId"
  ], "publication snapshot intent input");
  const source = assertSourceSnapshot(input.sourceSnapshot);
  const target = assertTargetSnapshot(input.targetSnapshot);
  const lineage = assertBaselineLineage(input.baselineLineage, source);
  const candidate = target.candidateReceipt;
  const receipt = createElectronProductionPublicationIntent({
    transactionId: input.transactionId,
    recordedAt: input.recordedAt,
    lease: input.lease,
    baseline: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      releaseTag: source.release.tag,
      sourceSha: lineage.sourceSha,
      manifestSha256: source.latestJson.sha256,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      releaseTag: target.release.tag,
      sourceSha: candidate.sourceSha,
      candidateReceiptSha256: candidate.sha256,
      manifestSha256: target.latestJson.sha256,
      stateSha256: target.stateSha256
    }
  });
  return assertElectronProductionPublicationSnapshotBindings({
    receipt,
    sourceSnapshot: source,
    targetSnapshot: target
  });
}

export function recordElectronProductionPublicationResult(input) {
  assertExactKeys(input, [
    "acknowledgement",
    "lease",
    "observedSnapshot",
    "previousReceipt",
    "recordedAt",
    "sourceSnapshot",
    "targetSnapshot"
  ], "publication result input");
  const previous = assertElectronProductionPublicationSnapshotBindings({
    receipt: input.previousReceipt,
    sourceSnapshot: input.sourceSnapshot,
    targetSnapshot: input.targetSnapshot
  });
  const observation = classifyObservation(
    input.observedSnapshot,
    input.sourceSnapshot,
    input.targetSnapshot
  );
  const receipt = transitionElectronProductionPublication(previous, {
    kind: "publication-result",
    acknowledgement: input.acknowledgement,
    observedState: observation.state,
    observedStateSha256: observation.sha256,
    lease: input.lease,
    recordedAt: input.recordedAt
  });
  return assertElectronProductionPublicationSnapshotBindings({
    receipt,
    sourceSnapshot: input.sourceSnapshot,
    targetSnapshot: input.targetSnapshot
  });
}

export function recordElectronProductionPublicationRecovery(input) {
  assertExactKeys(input, [
    "finalSnapshot",
    "lease",
    "observedSnapshot",
    "previousReceipt",
    "recordedAt",
    "rollbackAcknowledgement",
    "rollbackAttempted",
    "sourceSnapshot",
    "targetSnapshot"
  ], "publication recovery input");
  const previous = assertElectronProductionPublicationSnapshotBindings({
    receipt: input.previousReceipt,
    sourceSnapshot: input.sourceSnapshot,
    targetSnapshot: input.targetSnapshot
  });
  const observed = classifyObservation(
    input.observedSnapshot,
    input.sourceSnapshot,
    input.targetSnapshot
  );
  const final = classifyObservation(
    input.finalSnapshot,
    input.sourceSnapshot,
    input.targetSnapshot
  );
  const receipt = transitionElectronProductionPublication(previous, {
    kind: "recovery-result",
    observedState: observed.state,
    observedStateSha256: observed.sha256,
    rollbackAttempted: input.rollbackAttempted,
    rollbackAcknowledgement: input.rollbackAcknowledgement,
    finalState: final.state,
    finalStateSha256: final.sha256,
    lease: input.lease,
    recordedAt: input.recordedAt
  });
  return assertElectronProductionPublicationSnapshotBindings({
    receipt,
    sourceSnapshot: input.sourceSnapshot,
    targetSnapshot: input.targetSnapshot
  });
}

export function assertElectronProductionPublicationSnapshotBindings(input) {
  assertExactKeys(input, [
    "receipt",
    "sourceSnapshot",
    "targetSnapshot"
  ], "publication snapshot bindings");
  const receipt = assertElectronProductionPublicationReceipt(input.receipt);
  const source = assertSourceSnapshot(input.sourceSnapshot);
  const target = assertTargetSnapshot(input.targetSnapshot);
  const candidate = target.candidateReceipt;
  for (const [actual, expected, label] of [
    [receipt.baseline.runtime, "tauri-v22", "baseline runtime"],
    [receipt.baseline.version, source.latestJson.version, "baseline version"],
    [receipt.baseline.releaseTag, source.release.tag, "baseline release tag"],
    [receipt.baseline.manifestSha256, source.latestJson.sha256,
      "baseline manifest SHA-256"],
    [receipt.baseline.stateSha256, source.stateSha256, "baseline state SHA-256"],
    [receipt.target.runtime, "electron-v23", "target runtime"],
    [receipt.target.version, target.latestJson.version, "target version"],
    [receipt.target.releaseTag, target.release.tag, "target release tag"],
    [receipt.target.sourceSha, candidate.sourceSha, "target source SHA"],
    [receipt.target.candidateReceiptSha256, candidate.sha256,
      "target candidate receipt SHA-256"],
    [receipt.target.manifestSha256, target.latestJson.sha256,
      "target manifest SHA-256"],
    [receipt.target.stateSha256, target.stateSha256, "target state SHA-256"]
  ]) assertEqual(actual, expected, `publication ${label}`);
  return receipt;
}

function assertSourceSnapshot(value) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(value);
  assertEqual(snapshot.observationKind, "observed-release",
    "publication source observation kind");
  assertEqual(snapshot.release.isLatest, true,
    "publication source latest status");
  assertEqual(snapshot.candidateReceipt, null,
    "publication source candidate receipt");
  return snapshot;
}

function assertTargetSnapshot(value) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(value);
  assertEqual(snapshot.observationKind, "expected-latest-projection",
    "publication target observation kind");
  assertEqual(snapshot.release.isLatest, true,
    "publication target projected latest status");
  if (!snapshot.candidateReceipt) {
    throw new Error("The publication target snapshot must bind the production candidate receipt.");
  }
  assertEqual(
    snapshot.candidateReceipt.updaterEndpoint,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
    "publication target updater endpoint"
  );
  return snapshot;
}

function assertBaselineLineage(value, source) {
  assertExactKeys(value, [
    "manifestSha256",
    "releaseTag",
    "runtime",
    "sourceSha",
    "version"
  ], "publication baseline lineage");
  assertEqual(value.runtime, "tauri-v22", "publication baseline lineage runtime");
  assertEqual(value.version, source.latestJson.version,
    "publication baseline lineage version");
  assertEqual(value.releaseTag, source.release.tag,
    "publication baseline lineage release tag");
  assertEqual(value.manifestSha256, source.latestJson.sha256,
    "publication baseline lineage manifest SHA-256");
  return value;
}

function assertLineageAssetBinding(lineageAsset, source, expectedName) {
  const snapshotAsset = source.assets.find((asset) => asset.name === expectedName);
  if (!snapshotAsset) {
    throw new Error(`The publication source snapshot is missing ${expectedName}.`);
  }
  for (const [actual, expected, label] of [
    [lineageAsset.name, expectedName, "name"],
    [lineageAsset.id, snapshotAsset.id, "ID"],
    [lineageAsset.bytes, snapshotAsset.bytes, "bytes"],
    [lineageAsset.sha256, snapshotAsset.digest.slice("sha256:".length), "SHA-256"]
  ]) assertEqual(actual, expected, `publication lineage ${expectedName} ${label}`);
}

function classifyObservation(value, sourceSnapshot, targetSnapshot) {
  if (value === null) return Object.freeze({ state: "unknown", sha256: null });
  const observed = assertElectronProductionPublicLatestSnapshot(value);
  const state = classifyElectronProductionPublicLatestSnapshot({
    observed,
    source: sourceSnapshot,
    target: targetSnapshot
  });
  return Object.freeze({
    state: state === "source" ? "baseline" : state,
    sha256: observed.stateSha256
  });
}
