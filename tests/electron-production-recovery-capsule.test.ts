import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  acquireElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  createElectronProductionPublicationIntent
} from "../scripts/electronProductionPublicationReceipt.mjs";
import {
  createElectronProductionPublicationRecoveryStoreSeal,
  writeElectronProductionPublicationRecoveryStoreSeal
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  materializeElectronProductionRecoveredCapsule,
  verifyElectronProductionRecoveredCapsule
} from "../scripts/electronProductionRecoveredCapsule.mjs";
import {
  createElectronProductionRecoveryCapsule,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
  materializeElectronProductionRecoveryCapsule,
  readElectronProductionRecoveryCapsule,
  readElectronProductionRecoveryCapsuleDirectory
} from "../scripts/electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
} from "../scripts/electronProductionRecoveryStoreRemote.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "../scripts/electronProductionRecoveryStoreTransactionPaths.mjs";
import type {
  ElectronProductionRecoveryCapsuleBinding,
  ElectronProductionRecoveryCapsulePayloadPath
} from "../scripts/electronProductionRecoveryCapsule.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const TAURI_SOURCE_SHA = "1".repeat(40);
const TARGET_SOURCE_SHA = "2".repeat(40);
const TARGET_CONTROL_SHA = "3".repeat(40);
const PRIOR_SOURCE_SHA = "4".repeat(40);
const PRIOR_CONTROL_SHA = "5".repeat(40);
const PUBLISHER_CONTROL_SHA = "6".repeat(40);
const PUBLIC_KEY_SHA256 = "7".repeat(64);
const SOURCE_VERSION = "8.4.2";
const PRIOR_VERSION = "8.5.0";
const TARGET_VERSION = "8.6.0";
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const PUBLISHED_AT = "2026-09-01T00:00:00Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery capsule", () => {
  it("exports and deterministically packs the exact current 16-file recovery inventory", async () => {
    expect(ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS).toHaveLength(16);
    expect(ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS).toEqual({
      maximumJsonDepth: 64,
      maximumJsonNodes: 100_000,
      maximumManifestBytes: 512 * 1024,
      maximumPackageBytes: 8 * 1024 * 1024,
      maximumPayloadFileBytes: 1024 * 1024,
      maximumTotalPayloadBytes: 4 * 1024 * 1024,
      packedFileCount: 17,
      payloadFileCount: 16
    });
    expect(ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumPackageBytes).toBe(
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
    );
    expect(ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS).toEqual([
      "electron-production-candidate-receipt.json",
      "electron-production-prior-candidate-receipt.json",
      "electron-production-prior-candidate-trusted-control-receipt.json",
      "electron-production-prior-candidate-verification.json",
      "electron-production-public-latest-held-lease-evidence.json",
      "electron-production-public-latest-lease-acquire-operation.json",
      "electron-production-public-latest-lease.json",
      "electron-production-publication-intent-receipt.json",
      "electron-production-publication-staging-plan-receipt.json",
      "electron-production-target-candidate-trusted-control-receipt.json",
      "electron-production-target-candidate-verification.json",
      "source-public-latest-snapshot.json",
      "staged-target-public-release-snapshot.json",
      "target-public-latest-projection.json",
      "tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json",
      "tauri-lineage/windows-x86_64/tauri-v22-public-lineage-receipt.json"
    ]);
    const first = await createFixture();
    const second = await createFixture();

    const firstResult = await createElectronProductionRecoveryCapsule(first.input);
    const secondResult = await createElectronProductionRecoveryCapsule(second.input);
    const [firstSource, secondSource] = await Promise.all([
      readFile(first.input.capsulePath),
      readFile(second.input.capsulePath)
    ]);

    expect(secondSource).toEqual(firstSource);
    expect(firstResult.capsuleIdentity).toEqual(secondResult.capsuleIdentity);
    expect(firstResult.manifest).toEqual(secondResult.manifest);
    expect(firstResult.capsule.fileCount).toBe(17);
    expect(path.basename(firstResult.manifestPath)).toBe(
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
    );
    expect(firstResult.manifest).toMatchObject({
      transaction: { id: TRANSACTION_ID },
      lease: { id: LEASE_ID, generation: 1, status: "held" },
      control: { headSha: PUBLISHER_CONTROL_SHA },
      candidate: {
        sourceSha: TARGET_SOURCE_SHA,
        controlSha: TARGET_CONTROL_SHA,
        version: TARGET_VERSION
      },
      priorCandidate: {
        sourceSha: PRIOR_SOURCE_SHA,
        controlSha: PRIOR_CONTROL_SHA,
        version: PRIOR_VERSION
      },
      payloadCount: 16
    });
    expect(Object.keys(firstResult.manifest.files).sort()).toEqual(
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS
    );
    expect(firstResult.manifest.intentSha256).toBe(
      firstResult.manifest.files[
        "electron-production-publication-intent-receipt.json"
      ].sha256
    );

    await expect(readElectronProductionRecoveryCapsule({
      binding: first.binding,
      capsulePath: first.input.capsulePath,
      expectedCapsuleSha256: firstResult.capsuleIdentity.sha256
    })).resolves.toMatchObject({ manifest: firstResult.manifest });
    await expect(readElectronProductionRecoveryCapsuleDirectory({
      binding: first.binding,
      expectedManifestSha256: firstResult.manifestIdentity.sha256,
      sourceRoot: first.input.sourceRoot
    })).resolves.toMatchObject({ manifest: firstResult.manifest });
    await expect(createElectronProductionRecoveryCapsule(first.input))
      .rejects.toThrow("create-new");
  });

  it("rejects extra entries, symlinks, hardlinks, and oversized payloads", async () => {
    const extra = await createFixture();
    await writeFile(path.join(extra.input.sourceRoot, "unexpected.json"), "{}\n");
    await expect(createElectronProductionRecoveryCapsule(extra.input))
      .rejects.toThrow("is not exact");

    const symbolic = await createFixture();
    const symbolicTarget = path.join(symbolic.root, "symbolic-target.json");
    await writeFile(symbolicTarget, "{}\n");
    const symbolicPayload = payloadPath(
      symbolic.input.sourceRoot,
      "electron-production-public-latest-held-lease-evidence.json"
    );
    await unlink(symbolicPayload);
    await symlink(symbolicTarget, symbolicPayload);
    await expect(createElectronProductionRecoveryCapsule(symbolic.input))
      .rejects.toThrow("not a regular file");

    const hard = await createFixture();
    const hardSource = payloadPath(
      hard.input.sourceRoot,
      "electron-production-public-latest-held-lease-evidence.json"
    );
    const hardTarget = payloadPath(
      hard.input.sourceRoot,
      "electron-production-public-latest-lease-acquire-operation.json"
    );
    await unlink(hardTarget);
    await link(hardSource, hardTarget);
    await expect(createElectronProductionRecoveryCapsule(hard.input))
      .rejects.toThrow("single-link regular file");

    const oversized = await createFixture();
    await writeFile(
      payloadPath(
        oversized.input.sourceRoot,
        "electron-production-public-latest-held-lease-evidence.json"
      ),
      Buffer.alloc(
        ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumPayloadFileBytes + 1,
        0x61
      )
    );
    await expect(createElectronProductionRecoveryCapsule(oversized.input))
      .rejects.toThrow("bounded nonempty single-link regular file");

    const overTotal = await createFixture();
    const largeCanonicalPayload = serializeCanonicalJson({
      padding: "a".repeat(900 * 1024)
    });
    for (const relativePath of
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.slice(0, 5)) {
      await writeFile(payloadPath(overTotal.input.sourceRoot, relativePath),
        largeCanonicalPayload);
    }
    await expect(createElectronProductionRecoveryCapsule(overTotal.input))
      .rejects.toThrow("total byte limit");
    await expect(readFile(path.join(
      overTotal.input.sourceRoot,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const tooDeep = await createFixture();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 65; depth += 1) nested = { nested };
    await writeFile(payloadPath(
      tooDeep.input.sourceRoot,
      "electron-production-public-latest-held-lease-evidence.json"
    ), serializeCanonicalJson(nested));
    await expect(createElectronProductionRecoveryCapsule(tooDeep.input))
      .rejects.toThrow("JSON depth limit");
  });

  it("materializes the verified package into one exact create-new inert directory", async () => {
    const fixture = await createFixture();
    const created = await createElectronProductionRecoveryCapsule(fixture.input);
    const outputRoot = path.join(fixture.root, "materialized-capsule");
    const materialized = await materializeElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: created.capsuleIdentity.sha256,
      expectedManifestSha256: created.manifestIdentity.sha256,
      outputRoot
    });

    expect(materialized.materializedRoot).toBe(await realpath(outputRoot));
    expect(materialized.files).toEqual(created.files);
    for (const relativePath of [
      ...ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
    ]) {
      await expect(readFile(payloadPath(outputRoot, relativePath))).resolves
        .toEqual(await readFile(payloadPath(fixture.input.sourceRoot, relativePath)));
    }
    await expect(readElectronProductionRecoveryCapsuleDirectory({
      binding: fixture.binding,
      expectedManifestSha256: created.manifestIdentity.sha256,
      sourceRoot: outputRoot
    })).resolves.toMatchObject({ files: created.files });
    await expect(materializeElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: created.capsuleIdentity.sha256,
      expectedManifestSha256: created.manifestIdentity.sha256,
      outputRoot
    })).rejects.toThrow("create-new");

    const realParent = path.join(fixture.root, "real-materialization-parent");
    const linkedParent = path.join(fixture.root, "linked-materialization-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await expect(materializeElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: created.capsuleIdentity.sha256,
      expectedManifestSha256: created.manifestIdentity.sha256,
      outputRoot: path.join(linkedParent, "capsule")
    })).rejects.toThrow("output parent must be a real directory");

  });

  it("cleans only its identity-fenced partial materialization root", async () => {
    const partial = await createFixture();
    const partialCapsule = await createElectronProductionRecoveryCapsule(
      partial.input
    );
    const partialRoot = path.join(partial.root, "partial-materialization");
    let writes = 0;
    await expect(materializeElectronProductionRecoveryCapsule({
      binding: partial.binding,
      capsulePath: partial.input.capsulePath,
      expectedCapsuleSha256: partialCapsule.capsuleIdentity.sha256,
      expectedManifestSha256: partialCapsule.manifestIdentity.sha256,
      outputRoot: partialRoot
    }, {
      writeFile: async (filePath, source) => {
        writes += 1;
        if (writes === 2) throw new Error("injected materialization write failure");
        await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
      }
    })).rejects.toThrow("injected materialization write failure");
    await expect(lstat(partialRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const reread = await createFixture();
    const rereadCapsule = await createElectronProductionRecoveryCapsule(
      reread.input
    );
    const rereadRoot = path.join(reread.root, "reread-materialization");
    await expect(materializeElectronProductionRecoveryCapsule({
      binding: reread.binding,
      capsulePath: reread.input.capsulePath,
      expectedCapsuleSha256: rereadCapsule.capsuleIdentity.sha256,
      expectedManifestSha256: rereadCapsule.manifestIdentity.sha256,
      outputRoot: rereadRoot
    }, {
      readDirectory: async () => {
        throw new Error("injected final reread failure");
      }
    })).rejects.toThrow("injected final reread failure");
    await expect(lstat(rereadRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const replaced = await createFixture();
    const replacedCapsule = await createElectronProductionRecoveryCapsule(
      replaced.input
    );
    const replacedRoot = path.join(replaced.root, "replaced-materialization");
    const replacementMarker = path.join(replacedRoot, "foreign-owner.txt");
    writes = 0;
    await expect(materializeElectronProductionRecoveryCapsule({
      binding: replaced.binding,
      capsulePath: replaced.input.capsulePath,
      expectedCapsuleSha256: replacedCapsule.capsuleIdentity.sha256,
      expectedManifestSha256: replacedCapsule.manifestIdentity.sha256,
      outputRoot: replacedRoot
    }, {
      writeFile: async (filePath, source) => {
        writes += 1;
        if (writes === 2) {
          await rm(replacedRoot, { recursive: true });
          await mkdir(replacedRoot, { mode: 0o700 });
          await writeFile(replacementMarker, "foreign\n", { mode: 0o600 });
          throw new Error("injected root replacement");
        }
        await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
      }
    })).rejects.toThrow("injected root replacement");
    await expect(readFile(replacementMarker, "utf8")).resolves.toBe("foreign\n");
  });

  it("derives an attested-store binding and cross-binds the seal before materializing", async () => {
    const fixture = await createFixture();
    const capsule = await createElectronProductionRecoveryCapsule(fixture.input);
    const seal = await createStoreSealFixture(fixture, capsule);

    const verified = await verifyElectronProductionRecoveredCapsule({
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: capsule.capsuleIdentity.sha256,
      expectedStoreSealSha256: seal.sha256,
      storeSealPath: seal.path,
      transactionId: TRANSACTION_ID
    });

    expect(verified).toMatchObject({
      status: "verified-store-foundation",
      transactionId: TRANSACTION_ID,
      publisher: {
        repository: "rion-tw/rion-studio-source",
        workflow: ".github/workflows/electron-production-provisional-publish.yml",
        runId: "300",
        runAttempt: 2,
        controlSha: PUBLISHER_CONTROL_SHA
      },
      capsule: capsule.capsuleIdentity,
      manifest: capsule.manifestIdentity,
      storeSeal: { sha256: seal.sha256 }
    });
    expect(verified.foundation.heldLease.sha256).toBe(
      capsule.files["electron-production-public-latest-lease.json"].sha256
    );
    const outputRoot = path.join(fixture.root, "recovered-materialized");
    const materialized = await materializeElectronProductionRecoveredCapsule({
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: capsule.capsuleIdentity.sha256,
      expectedStoreSealSha256: seal.sha256,
      outputRoot,
      storeSealPath: seal.path,
      transactionId: TRANSACTION_ID
    });
    expect(materialized.verification).toEqual(verified);
    expect(materialized.materializedRoot).toBe(await realpath(outputRoot));
    await expect(readFile(payloadPath(
      outputRoot,
      "electron-production-public-latest-lease.json"
    ))).resolves.toEqual(await readFile(payloadPath(
      fixture.input.sourceRoot,
      "electron-production-public-latest-lease.json"
    )));
  });

  it.each([
    ["publisher run", (seal: MutableStoreSealFixture) => {
      seal.publisher.runId = "301";
    }],
    ["publisher repository", (seal: MutableStoreSealFixture) => {
      seal.publisher.repository = "attacker/example";
    }],
    ["publisher workflow", (seal: MutableStoreSealFixture) => {
      seal.publisher.workflow = ".github/workflows/untrusted.yml";
    }],
    ["source", (seal: MutableStoreSealFixture) => {
      seal.source.stateSha256 = "f".repeat(64);
    }],
    ["transaction", (seal: MutableStoreSealFixture) => {
      seal.transactionId = "a8fd8207-382d-4d47-8ab8-6b7835906674";
    }]
  ] as const)("rejects recovered %s rebinding without creating output", async (
    _label,
    mutate
  ) => {
      const fixture = await createFixture();
      const capsule = await createElectronProductionRecoveryCapsule(fixture.input);
      const seal = await createStoreSealFixture(fixture, capsule);
      const value = JSON.parse(
        await readFile(seal.path, "utf8")
      ) as MutableStoreSealFixture;
      mutate(value);
      await writeFile(seal.path, serializeCanonicalJson(value));
      const outputRoot = path.join(fixture.root, "must-not-materialize");
      await expect(materializeElectronProductionRecoveredCapsule({
        capsulePath: fixture.input.capsulePath,
        expectedCapsuleSha256: capsule.capsuleIdentity.sha256,
        expectedStoreSealSha256: sha256(await readFile(seal.path)),
        outputRoot,
        storeSealPath: seal.path,
        transactionId: TRANSACTION_ID
      })).rejects.toThrow(/publisher|source|transaction/u);
      await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects byte, digest, manifest, identity, and canonical-base64 rebinding", async () => {
    const fixture = await createFixture();
    const created = await createElectronProductionRecoveryCapsule(fixture.input);
    const capsule = JSON.parse(await readFile(fixture.input.capsulePath, "utf8"));
    const entry = capsule.files["electron-production-public-latest-held-lease-evidence.json"];
    entry.contentBase64 = Buffer.from("different\n").toString("base64");
    await rewriteCapsule(fixture.input.capsulePath, capsule);
    const changedDigest = sha256(await readFile(fixture.input.capsulePath));
    await expect(readElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: changedDigest
    })).rejects.toThrow("decoded byte length");

    const identity = await createFixture();
    const identityCreated = await createElectronProductionRecoveryCapsule(identity.input);
    const wrongBinding = {
      ...identity.binding,
      control: { ...identity.binding.control, headSha: "f".repeat(40) }
    };
    await expect(readElectronProductionRecoveryCapsule({
      binding: wrongBinding,
      capsulePath: identity.input.capsulePath,
      expectedCapsuleSha256: identityCreated.capsuleIdentity.sha256
    })).rejects.toThrow("held-lease holder head SHA");

    const intent = await createFixture();
    await createElectronProductionRecoveryCapsule(intent.input);
    const intentCapsule = JSON.parse(await readFile(intent.input.capsulePath, "utf8"));
    intentCapsule.intent.sha256 = "f".repeat(64);
    await rewriteCapsule(intent.input.capsulePath, intentCapsule);
    await expect(readElectronProductionRecoveryCapsule({
      binding: intent.binding,
      capsulePath: intent.input.capsulePath,
      expectedCapsuleSha256: sha256(await readFile(intent.input.capsulePath))
    })).rejects.toThrow("intent digest");

    const base64 = await createFixture();
    await createElectronProductionRecoveryCapsule(base64.input);
    const base64Capsule = JSON.parse(await readFile(base64.input.capsulePath, "utf8"));
    const base64Entry = base64Capsule.files[
      "electron-production-public-latest-held-lease-evidence.json"
    ];
    base64Entry.bytes = 1;
    base64Entry.sha256 = sha256("f");
    base64Entry.contentBase64 = "Zh==";
    await rewriteCapsule(base64.input.capsulePath, base64Capsule);
    await expect(readElectronProductionRecoveryCapsule({
      binding: base64.binding,
      capsulePath: base64.input.capsulePath,
      expectedCapsuleSha256: sha256(await readFile(base64.input.capsulePath))
    })).rejects.toThrow("noncanonical base64");

    expect(created.capsuleIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("treats packed paths and payload text only as inert data", async () => {
    const fixture = await createFixture();
    const marker = path.join(fixture.root, "must-not-exist");
    await writeFile(
      payloadPath(
        fixture.input.sourceRoot,
        "electron-production-public-latest-held-lease-evidence.json"
      ),
      serializeCanonicalJson({
        command: `touch ${marker}`,
        import: `file://${marker}`,
        script: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`
      })
    );
    const result = await createElectronProductionRecoveryCapsule(fixture.input);
    await expect(readElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: result.capsuleIdentity.sha256
    })).resolves.toMatchObject({ capsule: { encoding: "base64" } });
    await materializeElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: result.capsuleIdentity.sha256,
      expectedManifestSha256: result.manifestIdentity.sha256,
      outputRoot: path.join(fixture.root, "inert-materialization")
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const traversal = JSON.parse(await readFile(fixture.input.capsulePath, "utf8"));
    traversal.files["../escape.json"] = traversal.files[
      "electron-production-public-latest-held-lease-evidence.json"
    ];
    await rewriteCapsule(fixture.input.capsulePath, traversal);
    await expect(readElectronProductionRecoveryCapsule({
      binding: fixture.binding,
      capsulePath: fixture.input.capsulePath,
      expectedCapsuleSha256: sha256(await readFile(fixture.input.capsulePath))
    })).rejects.toThrow("file inventory");

    const duplicate = await createFixture();
    await createElectronProductionRecoveryCapsule(duplicate.input);
    const duplicateSource = await readFile(duplicate.input.capsulePath, "utf8");
    const duplicateValue = JSON.parse(duplicateSource);
    const duplicatePath = ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS[0];
    const pathPrefix = `    ${JSON.stringify(duplicatePath)}: {`;
    const injected = duplicateSource.replace(
      pathPrefix,
      `    ${JSON.stringify(duplicatePath)}: ` +
        `${JSON.stringify(duplicateValue.files[duplicatePath])},\n${pathPrefix}`
    );
    expect(injected).not.toBe(duplicateSource);
    await writeFile(duplicate.input.capsulePath, injected);
    await expect(readElectronProductionRecoveryCapsule({
      binding: duplicate.binding,
      capsulePath: duplicate.input.capsulePath,
      expectedCapsuleSha256: sha256(injected)
    })).rejects.toThrow("not canonical JSON");
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-recovery-capsule-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "payload");
  const outputRoot = path.join(root, "output");
  await mkdir(path.join(sourceRoot, "tauri-lineage", "darwin-aarch64"), {
    recursive: true
  });
  await mkdir(path.join(sourceRoot, "tauri-lineage", "windows-x86_64"), {
    recursive: true
  });
  await mkdir(outputRoot);

  const targetCandidate = candidateReceipt(TARGET_SOURCE_SHA, TARGET_VERSION);
  const priorCandidate = candidateReceipt(PRIOR_SOURCE_SHA, PRIOR_VERSION);
  const targetCandidateSource = serializeCanonicalJson(targetCandidate);
  const priorCandidateSource = serializeCanonicalJson(priorCandidate);
  const targetCandidateSha256 = sha256(targetCandidateSource);
  const priorCandidateSha256 = sha256(priorCandidateSource);
  const sourceSnapshot = snapshot({
    candidateReceipt: null,
    isLatest: true,
    releaseId: "100",
    sourceSha: TAURI_SOURCE_SHA,
    version: SOURCE_VERSION
  });
  const stagedSnapshot = snapshot({
    candidateReceipt: {
      bytes: targetCandidateSource.length,
      sha256: targetCandidateSha256,
      sourceSha: TARGET_SOURCE_SHA
    },
    isLatest: false,
    releaseId: "200",
    sourceSha: "8".repeat(40),
    version: TARGET_VERSION
  });
  const targetProjection = deriveElectronProductionExpectedLatestState(stagedSnapshot);
  const intent = createElectronProductionPublicationIntent({
    baseline: {
      manifestSha256: sourceSnapshot.latestJson.sha256,
      releaseTag: sourceSnapshot.release.tag,
      runtime: "tauri-v22",
      sourceSha: sourceSnapshot.release.targetCommitish,
      stateSha256: sourceSnapshot.stateSha256,
      version: sourceSnapshot.latestJson.version
    },
    lease: { id: LEASE_ID, generation: 1 },
    recordedAt: PUBLISHED_AT,
    target: {
      candidateReceiptSha256: targetCandidateSha256,
      manifestSha256: targetProjection.latestJson.sha256,
      releaseTag: targetProjection.release.tag,
      runtime: "electron-v23",
      sourceSha: TARGET_SOURCE_SHA,
      stateSha256: targetProjection.stateSha256,
      version: TARGET_VERSION
    },
    transactionId: TRANSACTION_ID
  });
  const control = {
    repository: "rion-tw/rion-studio-source" as const,
    workflow: ".github/workflows/electron-production-provisional-publish.yml" as const,
    event: "workflow_dispatch" as const,
    runId: "300",
    runAttempt: 2,
    headSha: PUBLISHER_CONTROL_SHA
  };
  const heldLease = acquireElectronProductionPublicLatestLease({
    holder: {
      repository: control.repository,
      workflow: control.workflow,
      runId: control.runId,
      runAttempt: control.runAttempt,
      headSha: control.headSha
    },
    leaseId: LEASE_ID,
    previous: null,
    purpose: "electron-v23-provisional-publication",
    recordedAt: PUBLISHED_AT,
    source: {
      runtime: "tauri-v22",
      version: SOURCE_VERSION,
      stateSha256: sourceSnapshot.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: TARGET_VERSION,
      stateSha256: targetProjection.stateSha256
    },
    transactionId: TRANSACTION_ID,
    vacantGeneration: 0
  });
  const targetBinding = {
    sourceSha: TARGET_SOURCE_SHA,
    version: TARGET_VERSION,
    controlSha: TARGET_CONTROL_SHA,
    runId: "201",
    runAttempt: 3
  };
  const priorBinding = {
    sourceSha: PRIOR_SOURCE_SHA,
    version: PRIOR_VERSION,
    controlSha: PRIOR_CONTROL_SHA,
    runId: "101",
    runAttempt: 2
  };
  const binding: ElectronProductionRecoveryCapsuleBinding = {
    transaction: { id: TRANSACTION_ID },
    lease: {
      id: LEASE_ID,
      generation: 1,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease)
    },
    control,
    candidate: targetBinding,
    priorCandidate: priorBinding
  };

  const targetControl = candidateControlReceipt(targetBinding);
  const priorControl = candidateControlReceipt(priorBinding);
  const targetControlSource = serializeCanonicalJson(targetControl);
  const priorControlSource = serializeCanonicalJson(priorControl);
  const payloads: Record<ElectronProductionRecoveryCapsulePayloadPath, unknown> = {
    "electron-production-candidate-receipt.json": targetCandidate,
    "electron-production-prior-candidate-receipt.json": priorCandidate,
    "electron-production-prior-candidate-trusted-control-receipt.json": priorControl,
    "electron-production-prior-candidate-verification.json": candidateVerification({
      binding: priorBinding,
      candidateReceiptSha256: priorCandidateSha256,
      controlReceiptSha256: sha256(priorControlSource),
      prior: true
    }),
    "electron-production-public-latest-held-lease-evidence.json": {
      kind: "held-lease-evidence",
      leaseEventSha256: binding.lease.eventSha256
    },
    "electron-production-public-latest-lease-acquire-operation.json": {
      command: "acquire",
      outcome: "applied",
      leaseEventSha256: binding.lease.eventSha256
    },
    "electron-production-public-latest-lease.json": heldLease,
    "electron-production-publication-intent-receipt.json": intent,
    "electron-production-publication-staging-plan-receipt.json": stagingPlan({
      binding,
      sourceSnapshot,
      targetCandidateSha256
    }),
    "electron-production-target-candidate-trusted-control-receipt.json": targetControl,
    "electron-production-target-candidate-verification.json": candidateVerification({
      binding: targetBinding,
      candidateReceiptSha256: targetCandidateSha256,
      controlReceiptSha256: sha256(targetControlSource),
      prior: false
    }),
    "source-public-latest-snapshot.json": sourceSnapshot,
    "staged-target-public-release-snapshot.json": stagedSnapshot,
    "target-public-latest-projection.json": targetProjection,
    "tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json": {
      kind: "rion-tauri-v22-public-source-lineage",
      platform: "darwin-aarch64"
    },
    "tauri-lineage/windows-x86_64/tauri-v22-public-lineage-receipt.json": {
      kind: "rion-tauri-v22-public-source-lineage",
      platform: "windows-x86_64"
    }
  };
  for (const relativePath of ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS) {
    await writeCanonicalPayload(sourceRoot, relativePath, payloads[relativePath]);
  }
  return {
    binding,
    input: {
      binding,
      capsulePath: path.join(outputRoot, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME),
      sourceRoot
    },
    root
  };
}

interface MutableStoreSealFixture {
  publisher: {
    repository: string;
    runId: string;
    workflow: string;
  };
  source: { stateSha256: string };
  transactionId: string;
}

async function createStoreSealFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  capsule: Awaited<ReturnType<typeof createElectronProductionRecoveryCapsule>>
) {
  const readPayload = async (relativePath: string) => JSON.parse(await readFile(
    payloadPath(fixture.input.sourceRoot, relativePath),
    "utf8"
  ));
  const heldLease = await readPayload(
    "electron-production-public-latest-lease.json"
  );
  const publicationIntent = await readPayload(
    "electron-production-publication-intent-receipt.json"
  );
  const sourceSnapshot = await readPayload("source-public-latest-snapshot.json");
  const targetSnapshot = await readPayload("target-public-latest-projection.json");
  const transactionPaths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: TRANSACTION_ID
  });
  const receipt = createElectronProductionPublicationRecoveryStoreSeal({
    capsuleBytes: capsule.capsuleIdentity.bytes,
    capsuleManifestBytes: capsule.manifestIdentity.bytes,
    capsuleManifestSha256: capsule.manifestIdentity.sha256,
    capsuleSha256: capsule.capsuleIdentity.sha256,
    durableStore: {
      repository: "alternate-owner/private-recovery",
      ref: "recovery-main",
      path: transactionPaths.capsulePath,
      repositoryPolicy: {
        defaultBranch: "recovery-main",
        visibility: "private"
      },
      byteLength: capsule.capsuleIdentity.bytes,
      blobSha: "8".repeat(40),
      treeSha: "9".repeat(40),
      parentCommitSha: "a".repeat(40),
      commitSha: "b".repeat(40),
      remoteReceiptSha256: "c".repeat(64),
      committedAt: PUBLISHED_AT
    },
    heldLease,
    publicationIntent,
    sealedAt: PUBLISHED_AT,
    sourceSnapshot,
    targetSnapshot,
    writer: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "300",
      runAttempt: 2,
      controlSha: PUBLISHER_CONTROL_SHA
    }
  });
  const directory = path.join(fixture.root, "store-seal");
  await mkdir(directory);
  const written = await writeElectronProductionPublicationRecoveryStoreSeal({
    outputPath: path.join(
      directory,
      "electron-production-publication-recovery-store-seal.json"
    ),
    receipt
  });
  return {
    path: written.receiptPath,
    sha256: written.receiptIdentity.sha256
  };
}

function snapshot(input: Readonly<{
  candidateReceipt: null | Readonly<{
    bytes: number;
    sha256: string;
    sourceSha: string;
  }>;
  isLatest: boolean;
  releaseId: string;
  sourceSha: string;
  version: string;
}>) {
  const digests = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      sha256(`${input.version}:${name}`)
    ])
  );
  const tag = `v${input.version}`;
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: 100 + index,
    contentType: contentType(name),
    digest: `sha256:${digests[name]}`,
    id: String(Number(input.releaseId) * 10 + index),
    name,
    url: `https://github.com/rion-tw/rion-studio/releases/download/${tag}/` +
      encodeURIComponent(name)
  }));
  const state = {
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-snapshot",
    repository: "rion-tw/rion-studio",
    release: {
      draft: false,
      id: input.releaseId,
      isLatest: input.isLatest,
      prerelease: false,
      tag,
      targetCommitish: input.sourceSha
    },
    assets,
    latestJson: {
      bytes: assets.find((asset) => asset.name === "latest.json")!.bytes,
      platforms: {
        "darwin-aarch64": {
          artifactName: "Rion.Studio-mac.app.tar.gz",
          artifactSha256: digests["Rion.Studio-mac.app.tar.gz"],
          signatureFileName: "Rion.Studio-mac.app.tar.gz.sig",
          signatureFileSha256: digests["Rion.Studio-mac.app.tar.gz.sig"],
          url: `${PUBLIC_BASE}Rion.Studio-mac.app.tar.gz`
        },
        "windows-x86_64": {
          artifactName: "Rion.Studio-win.exe",
          artifactSha256: digests["Rion.Studio-win.exe"],
          signatureFileName: "Rion.Studio-win.exe.sig",
          signatureFileSha256: digests["Rion.Studio-win.exe.sig"],
          url: `${PUBLIC_BASE}Rion.Studio-win.exe`
        }
      },
      publishedAt: PUBLISHED_AT,
      sha256: digests["latest.json"],
      version: input.version
    },
    candidateReceipt: input.candidateReceipt === null
      ? null
      : {
          assets: digests,
          bytes: input.candidateReceipt.bytes,
          fileName: "electron-production-candidate-receipt.json",
          publicKeySha256: PUBLIC_KEY_SHA256,
          sha256: input.candidateReceipt.sha256,
          sourceSha: input.candidateReceipt.sourceSha,
          updaterBaseUrl: PUBLIC_BASE,
          updaterEndpoint: `${PUBLIC_BASE}latest.json`,
          version: input.version
        }
  };
  const stateSha256 = sha256(serializeCanonicalJson(state));
  const body = {
    ...state,
    observationKind: "observed-release",
    stateSha256
  };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function candidateReceipt(sourceSha: string, version: string) {
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-candidate",
    status: "verified-not-published",
    publication: { allowedByThisWorkflow: false, status: "candidate-only" },
    sourceSha,
    version
  };
}

function candidateControlReceipt(binding: Readonly<{
  controlSha: string;
  runAttempt: number;
  runId: string;
  sourceSha: string;
  version: string;
}>) {
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-candidate-trusted-control",
    candidate: {
      publishedAt: PUBLISHED_AT,
      sourceSha: binding.sourceSha,
      updaterBaseUrl: PUBLIC_BASE,
      updaterEndpoint: `${PUBLIC_BASE}latest.json`,
      version: binding.version
    },
    controlPlane: {
      ref: "refs/heads/main",
      repository: "rion-tw/rion-studio-source",
      sha: binding.controlSha,
      workflow: ".github/workflows/electron-production-candidate.yml"
    },
    ownerApproval: "BUILD ELECTRON PRODUCTION CANDIDATE",
    producer: {
      event: "workflow_dispatch",
      runAttempt: binding.runAttempt,
      runId: binding.runId
    },
    updaterTrust: {
      publicKey: "RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      publicKeySha256: PUBLIC_KEY_SHA256
    }
  };
}

function candidateVerification(input: Readonly<{
  binding: Readonly<{
    controlSha: string;
    runAttempt: number;
    runId: string;
    sourceSha: string;
    version: string;
  }>;
  candidateReceiptSha256: string;
  controlReceiptSha256: string;
  prior: boolean;
}>) {
  return {
    schemaVersion: 1,
    kind: `rion-electron-production-${input.prior ? "prior" : "target"}-candidate-verification`,
    candidate: {
      assets: {},
      receiptSha256: input.candidateReceiptSha256,
      sourceSha: input.binding.sourceSha,
      version: input.binding.version
    },
    controlPlane: {
      ref: "refs/heads/main",
      repository: "rion-tw/rion-studio-source",
      sha: input.binding.controlSha,
      workflow: ".github/workflows/electron-production-candidate.yml"
    },
    producer: {
      runAttempt: input.binding.runAttempt,
      runId: input.binding.runId
    },
    trustedControlReceiptSha256: input.controlReceiptSha256
  };
}

function stagingPlan(input: Readonly<{
  binding: ElectronProductionRecoveryCapsuleBinding;
  sourceSnapshot: ReturnType<typeof snapshot>;
  targetCandidateSha256: string;
}>) {
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-publication-staging-plan",
    status: "verified-pre-publication-staging-plan",
    terminal: false,
    publicationMutationAllowed: false,
    transaction: { id: input.binding.transaction.id },
    lease: {
      id: input.binding.lease.id,
      generation: input.binding.lease.generation
    },
    source: {
      runtime: "tauri-v22",
      version: SOURCE_VERSION,
      snapshot: { fileSha256: sha256(serializeCanonicalJson(input.sourceSnapshot)) },
      lineage: {
        receipts: {
          "darwin-aarch64": {
            sha256: sha256(serializeCanonicalJson({
              kind: "rion-tauri-v22-public-source-lineage",
              platform: "darwin-aarch64"
            }))
          },
          "windows-x86_64": {
            sha256: sha256(serializeCanonicalJson({
              kind: "rion-tauri-v22-public-source-lineage",
              platform: "windows-x86_64"
            }))
          }
        }
      }
    },
    target: {
      runtime: "electron-v23",
      sourceSha: input.binding.candidate.sourceSha,
      version: input.binding.candidate.version,
      candidateReceipt: { sha256: input.targetCandidateSha256 }
    },
    provenance: {
      candidate: {
        runId: input.binding.candidate.runId,
        runAttempt: input.binding.candidate.runAttempt
      }
    }
  };
}

async function writeCanonicalPayload(
  sourceRoot: string,
  relativePath: ElectronProductionRecoveryCapsulePayloadPath,
  value: unknown
) {
  const absolutePath = payloadPath(sourceRoot, relativePath);
  await writeFile(absolutePath, serializeCanonicalJson(value), {
    flag: "wx",
    mode: 0o600
  });
}

async function rewriteCapsule(capsulePath: string, value: unknown) {
  await writeFile(capsulePath, serializeCanonicalJson(value));
}

function payloadPath(sourceRoot: string, relativePath: string) {
  return path.join(sourceRoot, ...relativePath.split("/"));
}

function contentType(name: string) {
  if (name.endsWith(".sig") || name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/vnd.microsoft.portable-executable";
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
