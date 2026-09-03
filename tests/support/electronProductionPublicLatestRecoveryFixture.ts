import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  acquireElectronProductionPublicLatestLease
} from "../../scripts/electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  createElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  serializeElectronProductionPublicLatestSnapshot,
  type ElectronProductionPublicLatestSnapshot
} from "../../scripts/electronProductionPublicLatestSnapshot.mjs";

export const RECOVERY_FIXTURE_TOKEN = "github-recovery-token";
export const RECOVERY_FIXTURE_TRANSACTION_ID =
  "018f47a0-2d3e-7abc-8def-1234567890ab";
export const RECOVERY_FIXTURE_LEASE_ID =
  "018f47a0-2d3e-7abc-8def-1234567890ac";
export const RECOVERY_FIXTURE_UPDATED_AT = "2026-09-01T00:04:00Z";

const REPOSITORY = "rion-tw/rion-studio" as const;
const PUBLISHED_AT = "2026-08-30T00:00:00Z";
const UPDATER_BASE_URL =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";

export async function createPublicLatestRecoveryFixture(root: string) {
  const sourceFixture = await createReleaseFixture(root, {
    directory: "source-assets",
    idBase: 100,
    includeCandidateReceipt: false,
    isLatest: true,
    version: "8.4.2"
  });
  const targetFixture = await createReleaseFixture(root, {
    directory: "target-assets",
    idBase: 200,
    includeCandidateReceipt: true,
    isLatest: false,
    version: "8.6.0"
  });
  const source = await createElectronProductionPublicLatestSnapshot({
    assetDirectory: sourceFixture.assetDirectory,
    release: sourceFixture.release
  });
  const stagedTarget = await createElectronProductionPublicLatestSnapshot({
    assetDirectory: targetFixture.assetDirectory,
    candidateReceiptPath: targetFixture.candidateReceiptPath,
    candidateReceiptSha256: targetFixture.candidateReceiptSha256,
    release: targetFixture.release
  });
  const target = deriveElectronProductionExpectedLatestState(stagedTarget);
  const observedTarget = await createElectronProductionPublicLatestSnapshot({
    assetDirectory: targetFixture.assetDirectory,
    candidateReceiptSummary: target.candidateReceipt,
    release: { ...targetFixture.release, isLatest: true }
  });
  const sourceFileSha256 = sha256(
    serializeElectronProductionPublicLatestSnapshot(source)
  );
  const targetFileSha256 = sha256(
    serializeElectronProductionPublicLatestSnapshot(target)
  );
  const heldLease = acquireElectronProductionPublicLatestLease({
    holder: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "7001",
      runAttempt: 2,
      headSha: "2".repeat(40)
    },
    leaseId: RECOVERY_FIXTURE_LEASE_ID,
    previous: null,
    purpose: "electron-v23-provisional-publication",
    recordedAt: "2026-09-01T00:00:00Z",
    source: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      stateSha256: target.stateSha256
    },
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    vacantGeneration: 0
  });
  return {
    heldLease,
    observedTarget,
    source,
    sourceApi: githubRelease(source, sourceFixture.sources),
    sourceFileSha256,
    sourceSources: sourceFixture.sources,
    target,
    targetApi: githubRelease(target, targetFixture.sources),
    targetFileSha256,
    targetSources: targetFixture.sources
  };
}

export function githubRelease(
  snapshot: ElectronProductionPublicLatestSnapshot,
  sources: Readonly<Record<string, Buffer>>
) {
  return {
    id: Number(snapshot.release.id),
    tag_name: snapshot.release.tag,
    draft: false,
    prerelease: false,
    updated_at: RECOVERY_FIXTURE_UPDATED_AT,
    assets: snapshot.assets.map((asset) => ({
      id: Number(asset.id),
      name: asset.name,
      size: sources[asset.name]!.length,
      digest: asset.digest,
      browser_download_url: asset.url,
      content_type: asset.contentType,
      state: "uploaded"
    }))
  };
}

export function githubTagReference(snapshot: ElectronProductionPublicLatestSnapshot) {
  return {
    ref: `refs/tags/${snapshot.release.tag}`,
    object: { type: "commit", sha: snapshot.release.targetCommitish }
  };
}

async function createReleaseFixture(root: string, options: Readonly<{
  directory: string;
  idBase: number;
  includeCandidateReceipt: boolean;
  isLatest: boolean;
  version: string;
}>) {
  const assetDirectory = path.join(root, options.directory);
  await mkdir(assetDirectory);
  const signatures = {
    "Rion.Studio-mac.app.tar.gz.sig": `mac-signature-${options.version}\n`,
    "Rion.Studio-win.exe.sig": `windows-signature-${options.version}\n`
  };
  const manifest = {
    version: options.version,
    pub_date: PUBLISHED_AT,
    platforms: {
      "darwin-aarch64": {
        url: `${UPDATER_BASE_URL}Rion.Studio-mac.app.tar.gz`,
        signature: signatures["Rion.Studio-mac.app.tar.gz.sig"].trim(),
        sha256: sha256(`mac-archive-${options.version}\n`)
      },
      "windows-x86_64": {
        url: `${UPDATER_BASE_URL}Rion.Studio-win.exe`,
        signature: signatures["Rion.Studio-win.exe.sig"].trim(),
        sha256: sha256(`windows-installer-${options.version}\n`)
      }
    }
  };
  const sources: Record<string, Buffer> = {
    "Rion.Studio-mac.app.tar.gz":
      Buffer.from(`mac-archive-${options.version}\n`),
    "Rion.Studio-mac.app.tar.gz.sig": Buffer.from(
      signatures["Rion.Studio-mac.app.tar.gz.sig"]
    ),
    "Rion.Studio-mac.dmg": Buffer.from(`mac-dmg-${options.version}\n`),
    "Rion.Studio-win.exe":
      Buffer.from(`windows-installer-${options.version}\n`),
    "Rion.Studio-win.exe.sig": Buffer.from(
      signatures["Rion.Studio-win.exe.sig"]
    ),
    "latest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  };
  const checksumNames = Object.keys(sources).sort();
  sources["SHA256SUMS.txt"] = Buffer.from(
    `${checksumNames.map((name) => `${sha256(sources[name]!)}  ${name}`)
      .join("\n")}\n`
  );
  await Promise.all(Object.entries(sources).map(([name, source]) =>
    writeFile(path.join(assetDirectory, name), source, { flag: "wx" })
  ));
  const assetSha256 = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      sha256(sources[name]!)
    ])
  );
  const candidateReceiptPath = path.join(
    root,
    `${options.directory}-electron-production-candidate-receipt.json`
  );
  const canonicalCandidatePath = path.join(
    root,
    "electron-production-candidate-receipt.json"
  );
  const candidateReceipt = productionCandidateReceipt(
    options.version,
    sources,
    assetSha256
  );
  if (options.includeCandidateReceipt) {
    await writeFile(
      canonicalCandidatePath,
      `${JSON.stringify(candidateReceipt, null, 2)}\n`,
      { flag: "wx" }
    );
  }
  const candidateReceiptSha256 = options.includeCandidateReceipt
    ? sha256(await readFile(canonicalCandidatePath))
    : undefined;
  const tag = `v${options.version}`;
  const releaseAssets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map(
    (name, index) => ({
      bytes: sources[name]!.length,
      contentType: contentType(name),
      digest: `sha256:${assetSha256[name]}` as const,
      id: String(options.idBase + index),
      name,
      url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}`
    })
  );
  void candidateReceiptPath;
  return {
    assetDirectory,
    candidateReceiptPath: options.includeCandidateReceipt
      ? canonicalCandidatePath
      : undefined,
    candidateReceiptSha256,
    release: {
      assets: releaseAssets,
      draft: false as const,
      id: String(options.idBase * 100),
      isLatest: options.isLatest,
      prerelease: false as const,
      repository: REPOSITORY,
      tag,
      targetCommitish: options.idBase.toString(16).padStart(40, "0")
    },
    sources
  };
}

function productionCandidateReceipt(
  version: string,
  sources: Readonly<Record<string, Buffer>>,
  assets: Readonly<Record<string, string>>
) {
  const artifact = (name: string, signatureName: string) => ({
    bytes: sources[name]!.length,
    fileName: name,
    sha256: assets[name],
    signatureBytes: sources[signatureName]!.length,
    signatureFileName: signatureName,
    signatureSha256: assets[signatureName]
  });
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-candidate",
    status: "verified-not-published",
    publication: { allowedByThisWorkflow: false, status: "candidate-only" },
    ownerGate: {
      approval: "BUILD ELECTRON PRODUCTION CANDIDATE",
      environment: "electron-production-release"
    },
    sourceSha: "a".repeat(40),
    version,
    publishedAt: PUBLISHED_AT,
    updaterBaseUrl: UPDATER_BASE_URL,
    updaterEndpoint: `${UPDATER_BASE_URL}latest.json`,
    updaterEndpointPolicy: { redirects: "forbidden", requiredStatus: 200 },
    publicKeySha256: "b".repeat(64),
    platforms: {
      "darwin-aarch64": {
        artifact: artifact(
          "Rion.Studio-mac.app.tar.gz",
          "Rion.Studio-mac.app.tar.gz.sig"
        ),
        distribution: {
          bytes: sources["Rion.Studio-mac.dmg"]!.length,
          fileName: "Rion.Studio-mac.dmg",
          sha256: assets["Rion.Studio-mac.dmg"]
        }
      },
      "windows-x86_64": {
        artifact: artifact(
          "Rion.Studio-win.exe",
          "Rion.Studio-win.exe.sig"
        )
      }
    },
    assets,
    compatibility: {
      stableTauriReleasePath: "preserved",
      tauriV22CutoverEvidence: "separate-required-gate"
    }
  };
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
