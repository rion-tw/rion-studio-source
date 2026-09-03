import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertTauriV22PublicLineagePair,
  createTauriV22PublicLineage,
  readTauriV22PublicLineageReceipt,
  TAURI_V22_COMPATIBILITY_WORKFLOW,
  TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME,
  verifyTauriV22PublicLineage
} from "../scripts/tauriV22PublicLineage.mjs";
import type {
  TauriV22PublicLineageBuildInput,
  TauriV22PublicLineagePlatform,
  TauriV22PublicLineageReceipt,
  TauriV22VerifiedInputReceipt
} from "../scripts/tauriV22PublicLineage.mjs";

const VERSION = "22.9.0";
const RELEASE_TAG = `v${VERSION}`;
const SOURCE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const TAG_OBJECT_SHA = "c".repeat(40);
const UPDATER_KEY_SHA256 = "d".repeat(64);
const PUBLISHED_AT = "2026-08-31T10:00:00Z";
const OBSERVED_AT = "2026-08-31T10:30:00Z";
const SOURCE_OBSERVED_AT = "2026-08-31T10:29:00Z";
const PRODUCED_AT = "2026-08-31T10:35:00Z";
const RELEASE_ID = "9001";
const RUN_ID = "71001";
const RUN_ATTEMPT = 2;

const PLATFORM_FILES = {
  "darwin-aarch64": {
    artifact: Buffer.from("published macOS Tauri v22 archive", "utf8"),
    artifactId: "101",
    artifactName: "Rion.Studio-mac.app.tar.gz",
    derivation: "macos-exact-archive-member" as const,
    executableName: "rion-tauri",
    executableRelativePath: "Rion Studio.app/Contents/MacOS/rion-tauri",
    runningImage: Buffer.from("macOS stable running image", "utf8"),
    signature: Buffer.from("macOS-v22-minisign-signature\n", "utf8"),
    signatureId: "102",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  },
  "windows-x86_64": {
    artifact: Buffer.from("published Windows Tauri v22 NSIS installer", "utf8"),
    artifactId: "103",
    artifactName: "Rion.Studio-win.exe",
    derivation: "windows-isolated-current-user-nsis-install" as const,
    executableName: "rion-tauri.exe",
    executableRelativePath: "rion-tauri.exe",
    runningImage: Buffer.from("Windows stable running image", "utf8"),
    signature: Buffer.from("Windows-v22-minisign-signature\n", "utf8"),
    signatureId: "104",
    signatureName: "Rion.Studio-win.exe.sig"
  }
};

interface Fixture {
  assetDirectory: string;
  input: TauriV22PublicLineageBuildInput;
  inputReceiptPath: string;
  outputPath: string;
  platform: TauriV22PublicLineagePlatform;
  runningExecutablePath: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Tauri v22 public source lineage", () => {
  it.each<TauriV22PublicLineagePlatform>(["darwin-aarch64", "windows-x86_64"])(
    "creates and re-verifies the exact %s public lineage receipt",
    async (platform) => {
      const fixture = await createFixture(platform);
      const receipt = await createTauriV22PublicLineage(fixture.input);
      expect(await readFile(fixture.outputPath)).toEqual(
        serializeCanonicalJson(receipt)
      );

      expect(receipt).toMatchObject({
        cutoverEligible: false,
        kind: "rion-tauri-v22-public-source-lineage",
        platform,
        producer: {
          artifactName: `tauri-v22-public-lineage-${platform}-${RUN_ID}-${RUN_ATTEMPT}`,
          headSha: TARGET_SHA
        },
        release: {
          id: RELEASE_ID,
          tag: RELEASE_TAG,
          version: VERSION
        },
        runningExecutable: {
          derivation: PLATFORM_FILES[platform].derivation,
          derivedFromArtifactSha256: sha256(PLATFORM_FILES[platform].artifact),
          fileName: PLATFORM_FILES[platform].executableName,
          relativePath: PLATFORM_FILES[platform].executableRelativePath,
          sha256: sha256(PLATFORM_FILES[platform].runningImage)
        },
        sourceTag: { peeledCommitSha: SOURCE_SHA },
        targetSourceSha: TARGET_SHA,
        trust: { updaterPublicKeySha256: UPDATER_KEY_SHA256 }
      });
      const expectedReceiptSha256 = sha256(await readFile(fixture.outputPath));
      await expect(verifyTauriV22PublicLineage({
        ...withoutOutput(fixture.input),
        expectedReceiptSha256,
        receiptPath: fixture.outputPath
      })).resolves.toEqual(receipt);
      await expect(readTauriV22PublicLineageReceipt({
        expectedReceiptSha256,
        receiptPath: fixture.outputPath
      })).resolves.toEqual(receipt);
    }
  );

  it("keeps the output create-new and outside the downloaded asset directory", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await createTauriV22PublicLineage(fixture.input);
    await expect(createTauriV22PublicLineage(fixture.input)).rejects.toThrow(
      "must not already exist"
    );

    const nestedOutput = join(fixture.assetDirectory, TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME);
    await expect(createTauriV22PublicLineage({
      ...fixture.input,
      outputPath: nestedOutput
    })).rejects.toThrow("must stay outside");
  });

  it("rejects non-canonical verified-input and public-lineage receipts", async () => {
    const inputFixture = await createFixture("darwin-aarch64");
    const inputReceipt = JSON.parse(
      await readFile(inputFixture.inputReceiptPath, "utf8")
    );
    await writeFile(inputFixture.inputReceiptPath, JSON.stringify(inputReceipt));
    await expect(createTauriV22PublicLineage(inputFixture.input)).rejects.toThrow(
      "verified input receipt is not canonical JSON"
    );

    const lineageFixture = await createFixture("windows-x86_64");
    const receipt = await createTauriV22PublicLineage(lineageFixture.input);
    await writeFile(lineageFixture.outputPath, JSON.stringify(receipt));
    await expect(readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: sha256(await readFile(lineageFixture.outputPath)),
      receiptPath: lineageFixture.outputPath
    })).rejects.toThrow("public-lineage receipt is not canonical JSON");
  });

  it.each([
    { fileName: "Rion.Studio-mac.app.tar.gz", label: "artifact", platform: "darwin-aarch64" },
    { fileName: "Rion.Studio-win.exe.sig", label: "signature", platform: "windows-x86_64" },
    { fileName: "latest.json", label: "manifest", platform: "darwin-aarch64" },
    { fileName: "SHA256SUMS.txt", label: "checksums", platform: "windows-x86_64" }
  ] as const)("rejects downloaded $label tampering during raw-input verification", async ({
    fileName,
    label,
    platform
  }) => {
    const fixture = await createFixture(platform);
    await createTauriV22PublicLineage(fixture.input);
    const receiptSha = sha256(await readFile(fixture.outputPath));
    await overwriteFirstByte(join(fixture.assetDirectory, fileName));
    await expect(verifyTauriV22PublicLineage({
      ...withoutOutput(fixture.input),
      expectedReceiptSha256: receiptSha,
      receiptPath: fixture.outputPath
    })).rejects.toThrow(`${label} verified-input SHA-256`);
  });

  it("rejects running-image tampering during raw-input verification", async () => {
    const executableFixture = await createFixture("windows-x86_64");
    await createTauriV22PublicLineage(executableFixture.input);
    const executableReceiptSha = sha256(await readFile(executableFixture.outputPath));
    await overwriteFirstByte(executableFixture.runningExecutablePath);
    await expect(verifyTauriV22PublicLineage({
      ...withoutOutput(executableFixture.input),
      expectedReceiptSha256: executableReceiptSha,
      receiptPath: executableFixture.outputPath
    })).rejects.toThrow("runningExecutable.sha256");
  });

  it("rejects unknown fields in raw metadata and in the attested receipt", async () => {
    const rawFixture = await createFixture("darwin-aarch64");
    await rewriteJson(rawFixture.inputReceiptPath, (value) => {
      value.unexpected = true;
    });
    await expect(createTauriV22PublicLineage(rawFixture.input)).rejects.toThrow(
      "verified input receipt has an unexpected schema"
    );

    const metadataFixture = await createFixture("windows-x86_64");
    Object.assign(metadataFixture.input.publicRelease, { unexpected: true });
    await expect(createTauriV22PublicLineage(metadataFixture.input)).rejects.toThrow(
      "public release metadata has an unexpected schema"
    );

    const receiptFixture = await createFixture("darwin-aarch64");
    await createTauriV22PublicLineage(receiptFixture.input);
    await rewriteJson(receiptFixture.outputPath, (value) => {
      value.unexpected = true;
    });
    await expect(readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: sha256(await readFile(receiptFixture.outputPath)),
      receiptPath: receiptFixture.outputPath
    })).rejects.toThrow("public-lineage receipt has an unexpected schema");
  });

  it("rejects any unaccounted file in the exact downloaded asset directory", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await writeFile(join(fixture.assetDirectory, "unaccounted-release-asset"), "unexpected");
    await expect(createTauriV22PublicLineage(fixture.input)).rejects.toThrow(
      "asset directory inventory must be exactly"
    );
  });

  it("validates every attested receipt field without replaying platform extraction", async () => {
    const fixture = await createFixture("windows-x86_64");
    await createTauriV22PublicLineage(fixture.input);
    await rewriteJson(fixture.outputPath, (value) => {
      const producer = value.producer as Record<string, unknown>;
      producer.artifactName = `tauri-v22-published-input-windows-x86_64-${RUN_ID}-${RUN_ATTEMPT}`;
    });
    await expect(readTauriV22PublicLineageReceipt({
      expectedReceiptSha256: sha256(await readFile(fixture.outputPath)),
      receiptPath: fixture.outputPath
    })).rejects.toThrow("producer artifact name");
  });

  it("rejects source, target, release, and updater-input cross-binding failures", async () => {
    const sourceFixture = await createFixture("darwin-aarch64");
    sourceFixture.input.sourceTag.peeledCommitSha = "e".repeat(40);
    await expect(createTauriV22PublicLineage(sourceFixture.input)).rejects.toThrow(
      "source tag peeled commit SHA"
    );

    const targetFixture = await createFixture("windows-x86_64");
    targetFixture.input.producer.headSha = "e".repeat(40);
    await expect(createTauriV22PublicLineage(targetFixture.input)).rejects.toThrow(
      "producer head SHA"
    );

    const releaseFixture = await createFixture("darwin-aarch64");
    releaseFixture.input.publicRelease.tagName = "v22.9.1";
    await expect(createTauriV22PublicLineage(releaseFixture.input)).rejects.toThrow(
      "public release tag"
    );

    const sizeFixture = await createFixture("windows-x86_64");
    sizeFixture.input.publicRelease.assets.artifact.bytes += 1;
    await expect(createTauriV22PublicLineage(sizeFixture.input)).rejects.toThrow(
      "artifact public asset bytes"
    );

    const idFixture = await createFixture("darwin-aarch64");
    idFixture.input.publicRelease.assets.signature.id =
      idFixture.input.publicRelease.assets.artifact.id;
    await expect(createTauriV22PublicLineage(idFixture.input)).rejects.toThrow(
      "asset IDs must be distinct"
    );
  });

  it("accepts only strict SemVer and possible RFC 3339 observations", async () => {
    const versionFixture = await createFixture("darwin-aarch64");
    await rewriteJson(versionFixture.inputReceiptPath, (value) => {
      value.releaseVersion = "22.09.0";
    });
    await expect(createTauriV22PublicLineage(versionFixture.input)).rejects.toThrow(
      "strict SemVer"
    );

    const timeFixture = await createFixture("windows-x86_64");
    timeFixture.input.publicRelease.observedAt = "2026-02-29T10:30:00Z";
    await expect(createTauriV22PublicLineage(timeFixture.input)).rejects.toThrow(
      "valid RFC 3339"
    );
  });

  it("rejects the other platform derivation and a symlinked running executable", async () => {
    const derivationFixture = await createFixture("darwin-aarch64");
    derivationFixture.input.runningExecutable.derivation =
      "windows-isolated-current-user-nsis-install";
    await expect(createTauriV22PublicLineage(derivationFixture.input)).rejects.toThrow(
      "running executable derivation"
    );

    const symlinkFixture = await createFixture("windows-x86_64");
    const realExecutable = join(dirname(symlinkFixture.runningExecutablePath), "real-rion-tauri.exe");
    await writeFile(realExecutable, PLATFORM_FILES["windows-x86_64"].runningImage);
    await rm(symlinkFixture.runningExecutablePath);
    await symlink(realExecutable, symlinkFixture.runningExecutablePath);
    await expect(createTauriV22PublicLineage(symlinkFixture.input)).rejects.toThrow(
      "regular file, not a symlink"
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked verified-input receipt before canonical inventory checks",
    async () => {
      const fixture = await createFixture("darwin-aarch64");
      const externalReceipt = join(dirname(fixture.assetDirectory), "external-input-receipt.json");
      await writeFile(externalReceipt, await readFile(fixture.inputReceiptPath));
      await rm(fixture.inputReceiptPath);
      await symlink(externalReceipt, fixture.inputReceiptPath);

      await expect(createTauriV22PublicLineage(fixture.input)).rejects.toThrow(
        "verified input receipt must be a regular file, not a symlink"
      );
    }
  );

  it("pairs independent platform observations while rejecting shared-fact drift", async () => {
    const macFixture = await createFixture("darwin-aarch64", {
      producedAt: "2026-08-31T10:31:02Z",
      releaseObservedAt: "2026-08-31T10:31:00Z",
      sourceObservedAt: "2026-08-31T10:31:01Z"
    });
    const windowsFixture = await createFixture("windows-x86_64", {
      producedAt: "2026-08-31T10:32:02Z",
      releaseObservedAt: "2026-08-31T10:32:00Z",
      sourceObservedAt: "2026-08-31T10:32:01Z"
    });
    const macos = await createTauriV22PublicLineage(macFixture.input);
    const windows = await createTauriV22PublicLineage(windowsFixture.input);

    expect(() => assertTauriV22PublicLineagePair({ macos, windows })).not.toThrow();
    expect(macos.verifiedAt).not.toBe(windows.verifiedAt);
    expect(macos.sourceTag.observedAt).not.toBe(windows.sourceTag.observedAt);

    const targetDrift = structuredClone(windows) as TauriV22PublicLineageReceipt;
    targetDrift.targetSourceSha = "e".repeat(40);
    targetDrift.producer.headSha = targetDrift.targetSourceSha;
    expect(() => assertTauriV22PublicLineagePair({ macos, windows: targetDrift })).toThrow(
      "cross-platform target source SHA"
    );

    const releaseDrift = structuredClone(windows) as TauriV22PublicLineageReceipt;
    releaseDrift.release.id = "9002";
    expect(() => assertTauriV22PublicLineagePair({ macos, windows: releaseDrift })).toThrow(
      "cross-platform release.id"
    );

    const trustDrift = structuredClone(windows) as TauriV22PublicLineageReceipt;
    trustDrift.trust.updaterPublicKeySha256 = "e".repeat(64);
    expect(() => assertTauriV22PublicLineagePair({ macos, windows: trustDrift })).toThrow(
      "cross-platform updater trust.updaterPublicKeySha256"
    );
  });
});

async function createFixture(
  platform: TauriV22PublicLineagePlatform,
  observations: {
    producedAt?: string;
    releaseObservedAt?: string;
    sourceObservedAt?: string;
  } = {}
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rion-tauri-v22-lineage-"));
  temporaryDirectories.push(root);
  const assetDirectory = join(root, "assets");
  const evidenceDirectory = join(root, "evidence");
  await Promise.all([
    mkdir(assetDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true })
  ]);
  const platformFiles = PLATFORM_FILES[platform];
  const manifest = manifestDocument();
  const checksums = checksumDocument(manifest);
  const inputReceiptPath = join(assetDirectory, "verified-input-receipt.json");
  const inputReceipt: TauriV22VerifiedInputReceipt = {
    artifactBytes: platformFiles.artifact.byteLength,
    artifactName: platformFiles.artifactName,
    artifactSha256: sha256(platformFiles.artifact),
    checksumName: "SHA256SUMS.txt",
    checksumSha256: sha256(checksums),
    evidenceKind: "tauri-v22-published-input",
    manifestName: "latest.json",
    manifestSha256: sha256(manifest),
    platform,
    releaseTag: RELEASE_TAG,
    releaseVersion: VERSION,
    repository: "rion-tw/rion-studio",
    runtime: "tauri-v22",
    schemaVersion: 2,
    signatureName: platformFiles.signatureName,
    signatureSha256: sha256(platformFiles.signature),
    sourceSha: SOURCE_SHA,
    targetSha: TARGET_SHA,
    updaterPublicKeySha256: UPDATER_KEY_SHA256
  };
  await Promise.all([
    writeFile(join(assetDirectory, platformFiles.artifactName), platformFiles.artifact),
    writeFile(join(assetDirectory, platformFiles.signatureName), platformFiles.signature),
    writeFile(join(assetDirectory, "latest.json"), manifest),
    writeFile(join(assetDirectory, "SHA256SUMS.txt"), checksums),
    writeFile(inputReceiptPath, serializeCanonicalJson(inputReceipt))
  ]);
  const runningExecutablePath = platform === "darwin-aarch64"
    ? join(root, "installed", "Rion Studio.app", "Contents", "MacOS", "rion-tauri")
    : join(root, "installed", "rion-tauri.exe");
  await mkdir(dirname(runningExecutablePath), { recursive: true });
  await writeFile(runningExecutablePath, platformFiles.runningImage, { mode: 0o700 });
  const outputPath = join(evidenceDirectory, TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME);
  const releaseObservedAt = observations.releaseObservedAt ?? OBSERVED_AT;
  const sourceObservedAt = observations.sourceObservedAt ?? SOURCE_OBSERVED_AT;
  const input: TauriV22PublicLineageBuildInput = {
    assetDirectory,
    outputPath,
    producer: {
      artifactName: `tauri-v22-public-lineage-${platform}-${RUN_ID}-${RUN_ATTEMPT}`,
      event: "workflow_dispatch",
      headSha: TARGET_SHA,
      producedAt: observations.producedAt ?? PRODUCED_AT,
      repository: "rion-tw/rion-studio-source",
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
    },
    publicRelease: {
      assets: {
        artifact: {
          bytes: platformFiles.artifact.byteLength,
          id: platformFiles.artifactId,
          name: platformFiles.artifactName
        },
        checksums: {
          bytes: checksums.byteLength,
          id: "106",
          name: "SHA256SUMS.txt"
        },
        manifest: {
          bytes: manifest.byteLength,
          id: "105",
          name: "latest.json"
        },
        signature: {
          bytes: platformFiles.signature.byteLength,
          id: platformFiles.signatureId,
          name: platformFiles.signatureName
        }
      },
      draft: false,
      id: RELEASE_ID,
      observedAt: releaseObservedAt,
      prerelease: false,
      publishedAt: PUBLISHED_AT,
      repository: "rion-tw/rion-studio",
      tagName: RELEASE_TAG,
      version: VERSION,
      wasLatestAtCapture: true
    },
    runningExecutable: {
      derivation: platformFiles.derivation,
      path: runningExecutablePath
    },
    sourceTag: {
      observedAt: sourceObservedAt,
      peeledCommitSha: SOURCE_SHA,
      refObjectSha: TAG_OBJECT_SHA,
      refObjectType: "tag",
      releaseTag: RELEASE_TAG,
      repository: "rion-tw/rion-studio-source"
    },
    verifiedInputReceiptPath: inputReceiptPath
  };
  return {
    assetDirectory,
    input,
    inputReceiptPath,
    outputPath,
    platform,
    runningExecutablePath
  };
}

function manifestDocument(): Buffer {
  const manifest = {
    platforms: {
      "darwin-aarch64": {
        sha256: sha256(PLATFORM_FILES["darwin-aarch64"].artifact),
        signature: PLATFORM_FILES["darwin-aarch64"].signature.toString("utf8").trim(),
        url: `https://github.com/rion-tw/rion-studio/releases/download/${RELEASE_TAG}/${PLATFORM_FILES["darwin-aarch64"].artifactName}`
      },
      "windows-x86_64": {
        sha256: sha256(PLATFORM_FILES["windows-x86_64"].artifact),
        signature: PLATFORM_FILES["windows-x86_64"].signature.toString("utf8").trim(),
        url: `https://github.com/rion-tw/rion-studio/releases/download/${RELEASE_TAG}/${PLATFORM_FILES["windows-x86_64"].artifactName}`
      }
    },
    pub_date: PUBLISHED_AT,
    version: VERSION
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function checksumDocument(manifest: Buffer): Buffer {
  return Buffer.from([
    `${sha256(PLATFORM_FILES["darwin-aarch64"].artifact)}  ${PLATFORM_FILES["darwin-aarch64"].artifactName}`,
    `${sha256(PLATFORM_FILES["darwin-aarch64"].signature)}  ${PLATFORM_FILES["darwin-aarch64"].signatureName}`,
    `${sha256(PLATFORM_FILES["windows-x86_64"].artifact)}  ${PLATFORM_FILES["windows-x86_64"].artifactName}`,
    `${sha256(PLATFORM_FILES["windows-x86_64"].signature)}  ${PLATFORM_FILES["windows-x86_64"].signatureName}`,
    `${sha256(manifest)}  latest.json`,
    ""
  ].join("\n"), "utf8");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutOutput(input: TauriV22PublicLineageBuildInput) {
  const { outputPath: _outputPath, ...verificationInput } = input;
  return verificationInput;
}

async function overwriteFirstByte(filePath: string): Promise<void> {
  const source = await readFile(filePath);
  source[0] = source[0] ^ 0xff;
  await writeFile(filePath, source);
}

async function rewriteJson(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void
): Promise<void> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(filePath, serializeCanonicalJson(value));
}
