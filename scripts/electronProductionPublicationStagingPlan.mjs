import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { verifyElectronProductionCandidateBundle } from
  "./electronProductionCandidateVerifier.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  readElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY
} from "./electronProductionPublicationReceipt.mjs";
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
import {
  assertTauriV22PublicLineagePair,
  readTauriV22PublicLineageReceipt,
  TAURI_V22_COMPATIBILITY_WORKFLOW,
  TAURI_V22_PUBLIC_LINEAGE_KIND,
  TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME
} from "./tauriV22PublicLineage.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_KIND =
  "rion-electron-production-publication-staging-plan";
export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT =
  "electron-production-publication-staging-plan-receipt.json";
export const ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL =
  "STAGE ELECTRON PRODUCTION PUBLICATION";
export const ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW =
  ".github/workflows/electron-production-candidate.yml";

const SOURCE_REPOSITORY = "rion-tw/rion-studio-source";
const CANDIDATE_RECEIPT_NAME = "electron-production-candidate-receipt.json";
const RELEASE_ENVIRONMENT = "electron-production-release";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);

export async function assembleElectronProductionPublicationStagingPlan(input) {
  assertExactKeys(input, [
    "createdAt",
    "lease",
    "lineage",
    "outputPath",
    "ownerApproval",
    "provenance",
    "sourceSnapshot",
    "targetCandidate",
    "transaction"
  ], "publication staging-plan input");
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT,
    "publication staging-plan receipt"
  );
  assertEqual(
    input.ownerApproval,
    ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL,
    "publication staging-plan owner approval"
  );
  const transaction = assertTransaction(input.transaction);
  const lease = assertLease(input.lease);
  const createdAt = requiredRfc3339(input.createdAt, "publication staging-plan time");
  const lineageInput = assertLineageInput(input.lineage);
  const sourceInput = assertSourceSnapshotInput(input.sourceSnapshot);
  const [sourceFile, macos, windows, candidate] = await Promise.all([
    readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: sourceInput.sha256,
      snapshotPath: sourceInput.path
    }),
    readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: lineageInput["darwin-aarch64"].sha256,
      receiptPath: lineageInput["darwin-aarch64"].path
    }),
    readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: lineageInput["windows-x86_64"].sha256,
      receiptPath: lineageInput["windows-x86_64"].path
    }),
    resolveTargetCandidate(input.targetCandidate)
  ]);
  const source = assertSourceSnapshot(sourceFile.snapshot);
  const lineage = assertTauriV22PublicLineagePair({ macos, windows });
  const provenance = assertProvenance(input.provenance, candidate.sourceSha);
  assertLineageBindings({ candidate, lineage, provenance, source });

  const plan = assertElectronProductionPublicationStagingPlan({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_KIND,
    status: "verified-pre-publication-staging-plan",
    terminal: false,
    publicationMutationAllowed: false,
    ownerGate: {
      approval: ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL,
      environment: RELEASE_ENVIRONMENT
    },
    transaction,
    lease,
    source: summarizeSource(sourceFile, lineage, lineageInput, sourceInput),
    target: summarizeTarget(candidate),
    provenance: summarizeProvenance(provenance, lineage, candidate),
    createdAt
  });
  await writeExclusive(outputPath, serializeCanonicalJson(plan));
  const reread = await readCanonicalJsonFile(
    outputPath,
    MAX_RECEIPT_BYTES,
    "publication staging-plan receipt"
  );
  const verifiedPlan = assertElectronProductionPublicationStagingPlan(reread.value);
  return deepFreeze({
    plan: verifiedPlan,
    receiptIdentity: publicIdentity(outputPath, reread),
    receiptPath: outputPath
  });
}

export function assertElectronProductionPublicationStagingPlan(value) {
  assertExactKeys(value, [
    "createdAt",
    "kind",
    "lease",
    "ownerGate",
    "provenance",
    "publicationMutationAllowed",
    "schemaVersion",
    "source",
    "status",
    "target",
    "terminal",
    "transaction"
  ], "publication staging-plan receipt");
  assertEqual(value.schemaVersion, 1, "publication staging-plan schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_KIND,
    "publication staging-plan kind");
  assertEqual(value.status, "verified-pre-publication-staging-plan",
    "publication staging-plan status");
  assertEqual(value.terminal, false, "publication staging-plan terminality");
  assertEqual(value.publicationMutationAllowed, false,
    "publication staging-plan mutation permission");
  assertOwnerGate(value.ownerGate);
  const transaction = assertTransaction(value.transaction);
  const lease = assertLease(value.lease);
  const source = assertPlanSource(value.source);
  const target = assertPlanTarget(value.target, source);
  const provenance = assertPlanProvenance(value.provenance, target);
  assertEqual(source.lineage.targetSourceSha, target.sourceSha,
    "publication staging-plan lineage target source SHA");
  assertEqual(source.lineage.updaterPublicKeySha256, target.updater.publicKeySha256,
    "publication staging-plan lineage updater public-key SHA-256");
  assertEqual(provenance.candidate.headSha, target.sourceSha,
    "publication staging-plan candidate provenance head SHA");
  assertEqual(provenance.lineage.headSha, target.sourceSha,
    "publication staging-plan lineage provenance head SHA");
  const createdAt = requiredRfc3339(value.createdAt, "publication staging-plan time");
  return deepFreeze({
    ...value,
    transaction,
    lease,
    source,
    target,
    provenance,
    createdAt
  });
}

export function serializeElectronProductionPublicationStagingPlan(value) {
  return serializeCanonicalJson(assertElectronProductionPublicationStagingPlan(value));
}

export async function readElectronProductionPublicationStagingPlan(input) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "publication staging-plan read input");
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "publication staging-plan receipt"
  );
  assertEqual(path.basename(receiptPath),
    ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT,
    "publication staging-plan receipt filename");
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "publication staging-plan receipt"
  );
  assertEqual(file.sha256,
    requiredDigest(input.expectedSha256, "publication staging-plan receipt SHA-256"),
    "publication staging-plan receipt SHA-256");
  return deepFreeze({
    plan: assertElectronProductionPublicationStagingPlan(file.value),
    receiptIdentity: publicIdentity(receiptPath, file),
    receiptPath
  });
}

async function resolveTargetCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The publication target candidate input must be an object.");
  }
  if (value.kind === "verified-summary") {
    assertExactKeys(value, ["kind", "verification"],
      "verified target candidate input");
    return assertCandidateVerification(value.verification);
  }
  if (value.kind === "bundle") {
    assertExactKeys(value, [
      "candidateDirectory",
      "candidateReceiptPath",
      "candidateReceiptSha256",
      "kind",
      "macDirectory",
      "publicKey",
      "sourceSha",
      "version",
      "windowsDirectory"
    ], "target candidate bundle input");
    const { kind: _kind, ...verificationInput } = value;
    return assertCandidateVerification(
      await verifyElectronProductionCandidateBundle(verificationInput)
    );
  }
  throw new Error("The publication target candidate input kind is invalid.");
}

function assertCandidateVerification(value) {
  assertExactKeys(value, [
    "assets",
    "receipt",
    "receiptSha256",
    "sourceSha",
    "updaterBaseUrl",
    "updaterEndpoint",
    "version"
  ], "verified target candidate summary");
  const sourceSha = requiredCommitSha(value.sourceSha, "target candidate source SHA");
  const version = requiredSemanticVersion(value.version, "target candidate version");
  const receiptSha256 = requiredDigest(
    value.receiptSha256,
    "target candidate receipt SHA-256"
  );
  const assets = assertCandidateAssets(value.assets, "verified target candidate assets", true);
  const receipt = assertCandidateReceiptSummary(value.receipt);
  for (const [actual, expected, label] of [
    [receipt.sourceSha, sourceSha, "source SHA"],
    [receipt.version, version, "version"],
    [receipt.updaterBaseUrl, value.updaterBaseUrl, "updater base URL"],
    [receipt.updaterEndpoint, value.updaterEndpoint, "updater endpoint"]
  ]) assertEqual(actual, expected, `verified target candidate ${label}`);
  assertEqual(value.updaterEndpoint, ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
    "publication target updater endpoint");
  for (const name of ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES) {
    assertEqual(receipt.assets[name], assets[name].sha256,
      `verified target candidate ${name} SHA-256`);
  }
  return deepFreeze({
    assets,
    receipt,
    receiptSha256,
    sourceSha,
    updaterBaseUrl: value.updaterBaseUrl,
    updaterEndpoint: value.updaterEndpoint,
    version
  });
}

function assertCandidateReceiptSummary(value) {
  assertExactKeys(value, [
    "assets",
    "compatibility",
    "kind",
    "ownerGate",
    "platforms",
    "publication",
    "publicKeySha256",
    "publishedAt",
    "schemaVersion",
    "sourceSha",
    "status",
    "updaterBaseUrl",
    "updaterEndpoint",
    "updaterEndpointPolicy",
    "version"
  ], "verified target candidate receipt");
  assertEqual(value.schemaVersion, 1, "target candidate receipt schema version");
  assertEqual(value.kind, "rion-electron-production-candidate",
    "target candidate receipt kind");
  assertEqual(value.status, "verified-not-published", "target candidate receipt status");
  assertExactRecord(value.publication, {
    allowedByThisWorkflow: false,
    status: "candidate-only"
  }, "target candidate publication boundary");
  assertExactRecord(value.ownerGate, {
    approval: "BUILD ELECTRON PRODUCTION CANDIDATE",
    environment: RELEASE_ENVIRONMENT
  }, "target candidate owner gate");
  assertExactRecord(value.updaterEndpointPolicy, {
    redirects: "forbidden",
    requiredStatus: 200
  }, "target candidate endpoint policy");
  assertExactRecord(value.compatibility, {
    stableTauriReleasePath: "preserved",
    tauriV22CutoverEvidence: "separate-required-gate"
  }, "target candidate compatibility boundary");
  assertExactKeys(value.platforms, PLATFORMS, "target candidate platforms");
  for (const platform of PLATFORMS) {
    if (!value.platforms[platform] || typeof value.platforms[platform] !== "object" ||
      Array.isArray(value.platforms[platform])) {
      throw new Error(`The target candidate ${platform} summary must be an object.`);
    }
  }
  return deepFreeze({
    ...value,
    assets: assertCandidateAssets(value.assets, "target candidate receipt assets", false),
    publicKeySha256: requiredDigest(value.publicKeySha256,
      "target candidate public-key SHA-256"),
    publishedAt: requiredRfc3339(value.publishedAt, "target candidate published-at"),
    sourceSha: requiredCommitSha(value.sourceSha, "target candidate receipt source SHA"),
    version: requiredSemanticVersion(value.version, "target candidate receipt version")
  });
}

function assertCandidateAssets(value, label, withBytes) {
  assertExactKeys(value, ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES, label);
  const assets = {};
  for (const name of ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES) {
    if (withBytes) {
      assertExactKeys(value[name], ["bytes", "sha256"], `${label} ${name}`);
      assets[name] = {
        bytes: requiredPositiveInteger(value[name].bytes, `${label} ${name} bytes`),
        sha256: requiredDigest(value[name].sha256, `${label} ${name} SHA-256`)
      };
    } else {
      assets[name] = requiredDigest(value[name], `${label} ${name} SHA-256`);
    }
  }
  return deepFreeze(assets);
}

function assertSourceSnapshot(value) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(value);
  assertEqual(snapshot.observationKind, "observed-release",
    "publication source snapshot observation kind");
  assertEqual(snapshot.release.isLatest, true,
    "publication source snapshot latest status");
  assertEqual(snapshot.candidateReceipt, null,
    "publication source snapshot candidate receipt");
  assertEqual(snapshot.release.tag, `v${snapshot.latestJson.version}`,
    "publication source snapshot release tag");
  return snapshot;
}

function assertLineageBindings(input) {
  const receipts = [input.lineage.macos, input.lineage.windows];
  for (const receipt of receipts) {
    for (const [actual, expected, label] of [
      [receipt.release.repository, input.source.repository, "release repository"],
      [receipt.release.id, input.source.release.id, "release ID"],
      [receipt.release.tag, input.source.release.tag, "release tag"],
      [receipt.release.version, input.source.latestJson.version, "release version"],
      [receipt.targetSourceSha, input.candidate.sourceSha, "target source SHA"],
      [receipt.trust.updaterPublicKeySha256,
        input.candidate.receipt.publicKeySha256, "updater public-key SHA-256"],
      [receipt.producer.runId, input.provenance.lineage.runId, "producer run ID"],
      [receipt.producer.runAttempt, input.provenance.lineage.runAttempt,
        "producer run attempt"],
      [receipt.producer.workflow, input.provenance.lineage.workflow,
        "producer workflow"],
      [receipt.producer.repository, input.provenance.lineage.repository,
        "producer repository"],
      [receipt.producer.headSha, input.provenance.lineage.headSha,
        "producer head SHA"]
    ]) assertEqual(actual, expected, `publication lineage ${label}`);
    const artifactName = receipt.platform === "darwin-aarch64"
      ? "Rion.Studio-mac.app.tar.gz"
      : "Rion.Studio-win.exe";
    assertLineageAsset(receipt.assets.artifact, input.source, artifactName);
    assertLineageAsset(receipt.assets.signature, input.source, `${artifactName}.sig`);
    assertLineageAsset(receipt.assets.checksums, input.source, "SHA256SUMS.txt");
    assertLineageAsset(receipt.assets.manifest, input.source, "latest.json");
  }
  if (input.lineage.macos.sourceTag.peeledCommitSha === input.candidate.sourceSha) {
    throw new Error("The publication source and target source SHA must differ.");
  }
}

function assertLineageAsset(lineageAsset, source, name) {
  const snapshotAsset = source.assets.find((asset) => asset.name === name);
  if (!snapshotAsset) throw new Error(`The source snapshot is missing ${name}.`);
  for (const [actual, expected, label] of [
    [lineageAsset.name, name, "name"],
    [lineageAsset.id, snapshotAsset.id, "ID"],
    [lineageAsset.bytes, snapshotAsset.bytes, "bytes"],
    [lineageAsset.sha256, snapshotAsset.digest.slice("sha256:".length), "SHA-256"]
  ]) assertEqual(actual, expected, `publication lineage ${name} ${label}`);
}

function summarizeSource(sourceFile, lineage, lineageInput, sourceInput) {
  const source = sourceFile.snapshot;
  return {
    runtime: "tauri-v22",
    repository: source.repository,
    releaseId: source.release.id,
    releaseTag: source.release.tag,
    version: source.latestJson.version,
    sourceSha: lineage.macos.sourceTag.peeledCommitSha,
    manifest: { fileName: "latest.json", sha256: source.latestJson.sha256 },
    snapshot: {
      bytes: sourceFile.file.bytes,
      fileName: path.basename(sourceInput.path),
      fileSha256: sourceFile.file.sha256,
      stateSha256: source.stateSha256,
      snapshotSha256: source.snapshotSha256
    },
    lineage: {
      kind: TAURI_V22_PUBLIC_LINEAGE_KIND,
      targetSourceSha: lineage.macos.targetSourceSha,
      updaterPublicKeySha256: lineage.macos.trust.updaterPublicKeySha256,
      receipts: {
        "darwin-aarch64": {
          fileName: TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME,
          sha256: lineageInput["darwin-aarch64"].sha256
        },
        "windows-x86_64": {
          fileName: TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME,
          sha256: lineageInput["windows-x86_64"].sha256
        }
      }
    }
  };
}

function summarizeTarget(candidate) {
  return {
    runtime: "electron-v23",
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    releaseTag: `v${candidate.version}`,
    version: candidate.version,
    sourceSha: candidate.sourceSha,
    candidateReceipt: {
      fileName: CANDIDATE_RECEIPT_NAME,
      sha256: candidate.receiptSha256
    },
    assets: Object.fromEntries(ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map(
      (name) => [name, candidate.assets[name].sha256]
    )),
    updater: {
      baseUrl: candidate.updaterBaseUrl,
      endpoint: candidate.updaterEndpoint,
      publicKeySha256: candidate.receipt.publicKeySha256
    }
  };
}

function summarizeProvenance(provenance, lineage, candidate) {
  return {
    candidate: {
      ...provenance.candidate,
      event: "workflow_dispatch",
      artifactName: `electron-production-candidate-${candidate.version}-${candidate.sourceSha}` +
        `-attempt-${provenance.candidate.runAttempt}`
    },
    lineage: {
      ...provenance.lineage,
      event: "workflow_dispatch",
      artifacts: {
        "darwin-aarch64": lineage.macos.producer.artifactName,
        "windows-x86_64": lineage.windows.producer.artifactName
      }
    }
  };
}

function assertSourceSnapshotInput(value) {
  assertExactKeys(value, ["path", "sha256"], "publication source snapshot input");
  return {
    path: requiredAbsolutePath(value.path, "publication source snapshot"),
    sha256: requiredDigest(value.sha256, "publication source snapshot SHA-256")
  };
}

function assertLineageInput(value) {
  assertExactKeys(value, PLATFORMS, "publication lineage input");
  const result = {};
  for (const platform of PLATFORMS) {
    assertExactKeys(value[platform], ["path", "sha256"], `${platform} lineage input`);
    result[platform] = {
      path: requiredAbsolutePath(value[platform].path, `${platform} lineage receipt`),
      sha256: requiredDigest(value[platform].sha256, `${platform} lineage receipt SHA-256`)
    };
  }
  return deepFreeze(result);
}

function assertProvenance(value, targetSourceSha) {
  assertExactKeys(value, ["candidate", "lineage"], "publication staging provenance");
  return deepFreeze({
    candidate: assertRunProvenance(
      value.candidate,
      "candidate",
      ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW,
      targetSourceSha
    ),
    lineage: assertRunProvenance(
      value.lineage,
      "lineage",
      TAURI_V22_COMPATIBILITY_WORKFLOW,
      targetSourceSha
    )
  });
}

function assertRunProvenance(value, label, workflow, headSha) {
  assertExactKeys(value, [
    "headSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], `${label} run provenance`);
  assertEqual(value.repository, SOURCE_REPOSITORY, `${label} run repository`);
  assertEqual(value.workflow, workflow, `${label} run workflow`);
  assertEqual(requiredCommitSha(value.headSha, `${label} run head SHA`), headSha,
    `${label} run head SHA`);
  return {
    headSha: value.headSha,
    repository: value.repository,
    runAttempt: requiredPositiveInteger(value.runAttempt, `${label} run attempt`),
    runId: requiredRunId(value.runId, `${label} run ID`),
    workflow: value.workflow
  };
}

function assertTransaction(value) {
  assertExactKeys(value, ["id"], "publication staging transaction");
  return deepFreeze({ id: requiredUuid(value.id, "publication staging transaction ID") });
}

function assertLease(value) {
  assertExactKeys(value, ["generation", "id"], "publication staging lease");
  return deepFreeze({
    generation: requiredPositiveInteger(value.generation, "publication staging lease generation"),
    id: requiredUuid(value.id, "publication staging lease ID")
  });
}

function assertOwnerGate(value) {
  assertExactRecord(value, {
    approval: ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL,
    environment: RELEASE_ENVIRONMENT
  }, "publication staging-plan owner gate");
}

function assertPlanSource(value) {
  assertExactKeys(value, [
    "lineage",
    "manifest",
    "releaseId",
    "releaseTag",
    "repository",
    "runtime",
    "snapshot",
    "sourceSha",
    "version"
  ], "publication staging-plan source");
  assertEqual(value.runtime, "tauri-v22", "publication staging-plan source runtime");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "publication staging-plan source repository");
  const version = requiredSemanticVersion(value.version,
    "publication staging-plan source version");
  assertEqual(value.releaseTag, `v${version}`, "publication staging-plan source tag");
  requiredString(value.releaseId, "publication staging-plan source release ID");
  assertExactRecord(value.manifest, {
    fileName: "latest.json",
    sha256: requiredDigest(value.manifest?.sha256,
      "publication staging-plan source manifest SHA-256")
  }, "publication staging-plan source manifest");
  const snapshot = assertSnapshotIdentity(value.snapshot);
  const lineage = assertPlanLineage(value.lineage);
  return deepFreeze({
    ...value,
    lineage,
    snapshot,
    sourceSha: requiredCommitSha(value.sourceSha,
      "publication staging-plan source SHA"),
    version
  });
}

function assertSnapshotIdentity(value) {
  assertExactKeys(value, [
    "bytes",
    "fileName",
    "fileSha256",
    "snapshotSha256",
    "stateSha256"
  ], "publication staging-plan source snapshot");
  return deepFreeze({
    bytes: requiredPositiveInteger(value.bytes, "publication source snapshot bytes"),
    fileName: requiredFileName(value.fileName, "publication source snapshot filename"),
    fileSha256: requiredDigest(value.fileSha256, "publication source snapshot file SHA-256"),
    snapshotSha256: requiredDigest(value.snapshotSha256,
      "publication source snapshot object SHA-256"),
    stateSha256: requiredDigest(value.stateSha256, "publication source state SHA-256")
  });
}

function assertPlanLineage(value) {
  assertExactKeys(value, [
    "kind",
    "receipts",
    "targetSourceSha",
    "updaterPublicKeySha256"
  ], "publication staging-plan lineage");
  assertEqual(value.kind, TAURI_V22_PUBLIC_LINEAGE_KIND,
    "publication staging-plan lineage kind");
  assertExactKeys(value.receipts, PLATFORMS,
    "publication staging-plan lineage receipts");
  const receipts = {};
  for (const platform of PLATFORMS) {
    assertExactRecord(value.receipts[platform], {
      fileName: TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME,
      sha256: requiredDigest(value.receipts[platform]?.sha256,
        `${platform} staging lineage receipt SHA-256`)
    }, `${platform} staging lineage receipt`);
    receipts[platform] = { ...value.receipts[platform] };
  }
  return deepFreeze({
    ...value,
    receipts,
    targetSourceSha: requiredCommitSha(value.targetSourceSha,
      "publication staging lineage target source SHA"),
    updaterPublicKeySha256: requiredDigest(value.updaterPublicKeySha256,
      "publication staging lineage updater public-key SHA-256")
  });
}

function assertPlanTarget(value, source) {
  assertExactKeys(value, [
    "assets",
    "candidateReceipt",
    "releaseTag",
    "repository",
    "runtime",
    "sourceSha",
    "updater",
    "version"
  ], "publication staging-plan target");
  assertEqual(value.runtime, "electron-v23", "publication staging-plan target runtime");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "publication staging-plan target repository");
  const version = requiredSemanticVersion(value.version,
    "publication staging-plan target version");
  assertSemanticVersionIsNewer(
    version,
    source.version,
    "publication staging-plan target version"
  );
  assertEqual(value.releaseTag, `v${version}`, "publication staging-plan target tag");
  const sourceSha = requiredCommitSha(value.sourceSha,
    "publication staging-plan target source SHA");
  if (sourceSha === source.sourceSha) {
    throw new Error("The publication staging-plan source and target SHA must differ.");
  }
  assertExactRecord(value.candidateReceipt, {
    fileName: CANDIDATE_RECEIPT_NAME,
    sha256: requiredDigest(value.candidateReceipt?.sha256,
      "publication staging-plan candidate receipt SHA-256")
  }, "publication staging-plan candidate receipt");
  const assets = assertCandidateAssets(value.assets,
    "publication staging-plan target assets", false);
  assertExactKeys(value.updater, ["baseUrl", "endpoint", "publicKeySha256"],
    "publication staging-plan target updater");
  assertEqual(value.updater.endpoint, ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT,
    "publication staging-plan target updater endpoint");
  return deepFreeze({
    ...value,
    assets,
    sourceSha,
    updater: {
      baseUrl: requiredHttpsBaseUrl(value.updater.baseUrl),
      endpoint: value.updater.endpoint,
      publicKeySha256: requiredDigest(value.updater.publicKeySha256,
        "publication staging-plan updater public-key SHA-256")
    },
    version
  });
}

function assertPlanProvenance(value, target) {
  assertExactKeys(value, ["candidate", "lineage"],
    "publication staging-plan provenance");
  const candidate = assertPlanRunProvenance(
    value.candidate,
    "candidate",
    ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW
  );
  const expectedArtifact = `electron-production-candidate-${target.version}-${target.sourceSha}` +
    `-attempt-${candidate.runAttempt}`;
  assertEqual(candidate.artifactName, expectedArtifact,
    "publication staging-plan candidate artifact name");
  const lineage = assertPlanRunProvenance(
    value.lineage,
    "lineage",
    TAURI_V22_COMPATIBILITY_WORKFLOW,
    true
  );
  return deepFreeze({ candidate, lineage });
}

function assertPlanRunProvenance(value, label, workflow, withArtifacts = false) {
  assertExactKeys(value, [
    ...(withArtifacts ? ["artifacts"] : ["artifactName"]),
    "event",
    "headSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], `publication staging-plan ${label} provenance`);
  assertEqual(value.event, "workflow_dispatch", `${label} provenance event`);
  assertEqual(value.repository, SOURCE_REPOSITORY, `${label} provenance repository`);
  assertEqual(value.workflow, workflow, `${label} provenance workflow`);
  const result = {
    ...value,
    headSha: requiredCommitSha(value.headSha, `${label} provenance head SHA`),
    runAttempt: requiredPositiveInteger(value.runAttempt, `${label} provenance run attempt`),
    runId: requiredRunId(value.runId, `${label} provenance run ID`)
  };
  if (withArtifacts) {
    assertExactKeys(value.artifacts, PLATFORMS, `${label} provenance artifacts`);
    result.artifacts = Object.fromEntries(PLATFORMS.map((platform) => [
      platform,
      requiredString(value.artifacts[platform], `${platform} lineage artifact name`)
    ]));
  } else {
    result.artifactName = requiredString(
      value.artifactName,
      `${label} provenance artifact name`
    );
  }
  return deepFreeze(result);
}

function assertExactRecord(value, expected, label) {
  assertExactKeys(value, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    assertEqual(value[key], expectedValue, `${label} ${key}`);
  }
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal GitHub run ID.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${label} must be a nonempty string.`);
  }
  return value;
}

function requiredFileName(value, label) {
  const normalized = requiredString(value, label);
  if (path.basename(normalized) !== normalized || normalized === "." || normalized === "..") {
    throw new Error(`The ${label} must be one filename.`);
  }
  return normalized;
}

function requiredHttpsBaseUrl(value) {
  let url;
  try {
    url = new URL(requiredString(value, "publication staging-plan updater base URL"));
  } catch (error) {
    throw new Error("The publication staging-plan updater base URL is invalid.", {
      cause: error
    });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/") || url.href !== value ||
    new URL("latest.json", url).href !== ELECTRON_PRODUCTION_PUBLIC_LATEST_ENDPOINT) {
    throw new Error("The publication staging-plan updater base URL does not match public latest.");
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}
