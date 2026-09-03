import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const MAX_ELECTRON_CANDIDATE_SIGNATURE_BYTES = 64 * 1024;

export async function assertCopiedPlatformAssetsMatchReceipts(
  outputDirectory,
  macReceipt,
  windowsReceipt
) {
  await Promise.all([
    assertCopiedAssetMatchesReceipt(
      outputDirectory,
      macReceipt.artifact,
      "artifact",
      MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
      "darwin-aarch64 copied updater artifact"
    ),
    assertCopiedAssetMatchesReceipt(
      outputDirectory,
      macReceipt.artifact,
      "signature",
      MAX_ELECTRON_CANDIDATE_SIGNATURE_BYTES,
      "darwin-aarch64 copied updater signature"
    ),
    assertCopiedAssetMatchesReceipt(
      outputDirectory,
      macReceipt.distribution,
      "artifact",
      MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
      "darwin-aarch64 copied distribution"
    ),
    assertCopiedAssetMatchesReceipt(
      outputDirectory,
      windowsReceipt.artifact,
      "artifact",
      MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
      "windows-x86_64 copied updater artifact"
    ),
    assertCopiedAssetMatchesReceipt(
      outputDirectory,
      windowsReceipt.artifact,
      "signature",
      MAX_ELECTRON_CANDIDATE_SIGNATURE_BYTES,
      "windows-x86_64 copied updater signature"
    )
  ]);
}

export function assertCandidateAssetDigestsMatchPlatformReceipts(
  assetSha256,
  macReceipt,
  windowsReceipt
) {
  const expected = [
    [macReceipt.artifact.fileName, macReceipt.artifact.sha256],
    [macReceipt.artifact.signatureFileName, macReceipt.artifact.signatureSha256],
    [macReceipt.distribution.fileName, macReceipt.distribution.sha256],
    [windowsReceipt.artifact.fileName, windowsReceipt.artifact.sha256],
    [windowsReceipt.artifact.signatureFileName, windowsReceipt.artifact.signatureSha256]
  ];
  for (const [fileName, receiptSha256] of expected) {
    if (assetSha256[fileName] !== receiptSha256) {
      throw new Error(
        `The assembled candidate asset ${fileName} does not match its verified platform receipt.`
      );
    }
  }
}

export async function captureStableBoundedFileIdentity(filePath, maximumBytes, label) {
  const pathMetadata = await lstat(filePath, { bigint: true });
  assertBoundedRegularFile(pathMetadata, maximumBytes, label);
  const noFollow = typeof fileConstants.O_NOFOLLOW === "number"
    ? fileConstants.O_NOFOLLOW
    : 0;
  const handle = await open(filePath, fileConstants.O_RDONLY | noFollow);
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(pathMetadata, openedMetadata, label);
    assertBoundedRegularFile(openedMetadata, maximumBytes, label);
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    const completedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(openedMetadata, completedMetadata, label);
    const completedPathMetadata = await lstat(filePath, { bigint: true });
    assertSameRegularFile(completedMetadata, completedPathMetadata, label);
    return Object.freeze({
      bytes: Number(completedMetadata.size),
      sha256: digest.digest("hex")
    });
  } finally {
    await handle.close();
  }
}

async function assertCopiedAssetMatchesReceipt(
  outputDirectory,
  identity,
  kind,
  maximumBytes,
  label
) {
  const isSignature = kind === "signature";
  const fileName = isSignature ? identity.signatureFileName : identity.fileName;
  const expectedBytes = isSignature ? identity.signatureBytes : identity.bytes;
  const expectedSha256 = isSignature ? identity.signatureSha256 : identity.sha256;
  const actual = await captureStableBoundedFileIdentity(
    path.join(outputDirectory, fileName),
    maximumBytes,
    label
  );
  if (actual.bytes !== expectedBytes || actual.sha256 !== expectedSha256) {
    throw new Error(`The ${label} does not match its verified platform receipt.`);
  }
}

function assertBoundedRegularFile(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(
      `${label} is not a bounded, nonempty, exclusively linked regular file.`
    );
  }
}

function assertSameRegularFile(expected, observed, label) {
  if (
    !observed.isFile() ||
    expected.dev !== observed.dev ||
    expected.ino !== observed.ino ||
    expected.mode !== observed.mode ||
    expected.nlink !== observed.nlink ||
    expected.size !== observed.size ||
    expected.mtimeNs !== observed.mtimeNs ||
    expected.ctimeNs !== observed.ctimeNs
  ) {
    throw new Error(`${label} identity changed while it was being read.`);
  }
}
