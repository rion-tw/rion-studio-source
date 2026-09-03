import { isDeepStrictEqual } from "node:util";

import {
  assertElectronProductionPublicationRecoveryStoreSealBindings,
  readElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import {
  materializeElectronProductionRecoveryCapsule,
  readElectronProductionRecoveryCapsuleSelfBound
} from "./electronProductionRecoveryCapsule.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertEqual,
  assertExactKeys
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERED_CAPSULE_VERIFICATION_KIND =
  "rion-electron-production-recovered-capsule-verification";

const FOUNDATION_FILES = Object.freeze({
  heldLease: "electron-production-public-latest-lease.json",
  publicationIntent: "electron-production-publication-intent-receipt.json",
  sourceSnapshot: "source-public-latest-snapshot.json",
  targetSnapshot: "target-public-latest-projection.json"
});

export async function verifyElectronProductionRecoveredCapsule(input) {
  const recovered = await recover(input);
  return recovered.verification;
}

export async function materializeElectronProductionRecoveredCapsule(input) {
  assertExactKeys(input, [
    "capsulePath",
    "expectedCapsuleSha256",
    "expectedStoreSealSha256",
    "outputRoot",
    "storeSealPath",
    "transactionId"
  ], "recovered capsule materialization input");
  const recovered = await recover({
    capsulePath: input.capsulePath,
    expectedCapsuleSha256: input.expectedCapsuleSha256,
    expectedStoreSealSha256: input.expectedStoreSealSha256,
    storeSealPath: input.storeSealPath,
    transactionId: input.transactionId
  });
  const materialized = await materializeElectronProductionRecoveryCapsule({
    binding: recovered.binding,
    capsulePath: input.capsulePath,
    expectedCapsuleSha256: recovered.verification.capsule.sha256,
    expectedManifestSha256: recovered.verification.manifest.sha256,
    outputRoot: input.outputRoot
  });
  return deepFreeze({
    verification: recovered.verification,
    materializedRoot: materialized.materializedRoot
  });
}

async function recover(input) {
  assertExactKeys(input, [
    "capsulePath",
    "expectedCapsuleSha256",
    "expectedStoreSealSha256",
    "storeSealPath",
    "transactionId"
  ], "recovered capsule verification input");
  const transactionPaths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: input.transactionId
  });
  const [selfBound, sealFile] = await Promise.all([
    readElectronProductionRecoveryCapsuleSelfBound({
      capsulePath: input.capsulePath,
      expectedCapsuleSha256: input.expectedCapsuleSha256
    }),
    readElectronProductionPublicationRecoveryStoreSeal({
      receiptPath: input.storeSealPath,
      expectedSha256: input.expectedStoreSealSha256
    })
  ]);
  const { binding, capsule } = selfBound;
  const seal = sealFile.receipt;
  assertEqual(binding.transaction.id, transactionPaths.transactionId,
    "recovered capsule transaction ID");
  assertEqual(seal.transactionId, transactionPaths.transactionId,
    "recovered store-seal transaction ID");
  assertEqual(seal.durableStore.path, transactionPaths.capsulePath,
    "recovered store-seal capsule path");
  assertEqual(seal.capsuleSha256, capsule.capsuleIdentity.sha256,
    "recovered store-seal capsule SHA-256");
  assertEqual(seal.capsuleBytes, capsule.capsuleIdentity.bytes,
    "recovered store-seal capsule byte length");
  assertEqual(seal.capsuleManifestSha256, capsule.manifestIdentity.sha256,
    "recovered store-seal manifest SHA-256");
  assertEqual(seal.capsuleManifestBytes, capsule.manifestIdentity.bytes,
    "recovered store-seal manifest byte length");
  const publisher = {
    repository: binding.control.repository,
    workflow: binding.control.workflow,
    runId: binding.control.runId,
    runAttempt: binding.control.runAttempt,
    controlSha: binding.control.headSha
  };
  if (!isDeepStrictEqual(seal.publisher, publisher)) {
    throw new Error("The recovered capsule publisher does not match its store seal.");
  }
  assertElectronProductionPublicationRecoveryStoreSealBindings({
    heldLease: capsule.foundation.lease,
    publicationIntent: capsule.foundation.intent,
    seal,
    sourceSnapshot: capsule.foundation.sourceSnapshot,
    targetSnapshot: capsule.foundation.targetProjection
  });
  const verification = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERED_CAPSULE_VERIFICATION_KIND,
    status: "verified-store-foundation",
    transactionId: transactionPaths.transactionId,
    publisher,
    capsule: capsule.capsuleIdentity,
    manifest: capsule.manifestIdentity,
    storeSeal: sealFile.receiptIdentity,
    foundation: Object.fromEntries(Object.entries(FOUNDATION_FILES).map(
      ([name, fileName]) => [name, { fileName, ...capsule.files[fileName] }]
    ))
  });
  return { binding, verification };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
