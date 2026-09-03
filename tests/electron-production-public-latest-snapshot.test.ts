import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertElectronProductionPublicLatestSnapshot,
  assertElectronProductionRestorableSourceRelease,
  classifyElectronProductionPublicLatestSnapshot,
  createElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  deriveTauriV22ExpectedLatestState,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  readElectronProductionPublicLatestSnapshot,
  serializeElectronProductionPublicLatestSnapshot,
  writeElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";

const REPOSITORY = "rion-tw/rion-studio" as const;
const PUBLISHED_AT = "2026-08-30T00:00:00Z";
const UPDATER_BASE_URL = "https://updates.example.test/rion/stable/";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production public latest snapshot", () => {
  it("canonically binds a GitHub latest release to all assets and its candidate receipt", async () => {
    const fixture = await createFixture({ reverseReleaseAssets: true });
    const snapshot = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: fixture.release
    });

    expect(snapshot.assets.map((asset) => asset.name)).toEqual(
      ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES
    );
    expect(snapshot).toMatchObject({
      candidateReceipt: {
        assets: fixture.assetSha256,
        sha256: fixture.candidateReceiptSha256,
        sourceSha: "a".repeat(40),
        version: fixture.version
      },
      release: {
        id: fixture.release.id,
        isLatest: true,
        tag: `v${fixture.version}`,
        targetCommitish: fixture.release.targetCommitish
      },
      observationKind: "observed-release"
    });
    expect(snapshot.candidateReceipt?.sourceSha).not.toBe(
      snapshot.release.targetCommitish
    );
    const first = serializeElectronProductionPublicLatestSnapshot(snapshot);
    const second = serializeElectronProductionPublicLatestSnapshot(
      JSON.parse(JSON.stringify(snapshot))
    );
    expect(second).toEqual(first);

    const snapshotPath = path.join(fixture.root, "public-latest-snapshot.json");
    await expect(writeElectronProductionPublicLatestSnapshot({
      outputPath: snapshotPath,
      snapshot
    })).resolves.toMatchObject({
      file: { bytes: first.length, sha256: sha256(first) },
      snapshot
    });
    expect(await readFile(snapshotPath)).toEqual(first);
    await expect(readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: sha256(first),
      snapshotPath
    })).resolves.toMatchObject({ snapshot });
    await expect(writeElectronProductionPublicLatestSnapshot({
      outputPath: snapshotPath,
      snapshot
    })).rejects.toThrow("create-new");
  });

  it("supports a source snapshot without relabelling it as an Electron candidate", async () => {
    const fixture = await createFixture({ includeCandidateReceipt: false, version: "8.4.2" });
    const snapshot = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      release: fixture.release
    });

    expect(snapshot.candidateReceipt).toBeNull();
    expect(snapshot.latestJson.version).toBe("8.4.2");
    expect(snapshot.release.tag).toBe("v8.4.2");
  });

  it("proves a by-tag baseline is the exact candidate-less source with only latest status changed", async () => {
    const fixture = await createFixture({ version: "8.4.2" });
    const source = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      release: fixture.release
    });
    const observed = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      release: { ...fixture.release, isLatest: false }
    });

    const asserted = assertElectronProductionRestorableSourceRelease({
      observed: JSON.parse(JSON.stringify(observed)),
      source: JSON.parse(JSON.stringify(source))
    });
    expect(asserted).toEqual(observed);
    expect(Object.isFrozen(asserted)).toBe(true);
    expect(asserted.release.isLatest).toBe(false);
    expect(asserted.candidateReceipt).toBeNull();

    const changedRelease = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      release: { ...fixture.release, id: "9999", isLatest: false }
    });
    expect(() => assertElectronProductionRestorableSourceRelease({
      observed: changedRelease,
      source
    })).toThrow("does not match the original source snapshot");

    const candidateSource = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: fixture.release
    });
    expect(() => assertElectronProductionRestorableSourceRelease({
      observed,
      source: candidateSource
    })).toThrow("source snapshot must not bind an Electron candidate receipt");

    const candidateObserved = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: { ...fixture.release, isLatest: false }
    });
    expect(() => assertElectronProductionRestorableSourceRelease({
      observed: candidateObserved,
      source
    })).toThrow("release-by-tag must not bind an Electron candidate receipt");
    expect(() => assertElectronProductionRestorableSourceRelease({
      observed: source,
      source
    })).toThrow("release-by-tag must be an observed non-latest release");
  });

  it("rejects duplicate GitHub asset identities and non-exact local inventories", async () => {
    const fixture = await createFixture();
    const duplicated = fixture.release.assets.map((asset) => ({ ...asset }));
    duplicated[1]!.id = duplicated[0]!.id;
    await expect(createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: { ...fixture.release, assets: duplicated }
    })).rejects.toThrow("asset ID");

    await writeFile(path.join(fixture.assetDirectory, "unexpected.bin"), "extra\n");
    await expect(createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: fixture.release
    })).rejects.toThrow("asset inventory");
  });

  it("rejects candidate, manifest, and snapshot digest rebinding", async () => {
    const fixture = await createFixture();
    if (!fixture.candidateReceiptPath) {
      throw new Error("The default fixture must include its candidate receipt.");
    }
    const candidateReceiptPath = fixture.candidateReceiptPath;
    const candidate = JSON.parse(await readFile(candidateReceiptPath, "utf8"));
    candidate.assets["latest.json"] = "f".repeat(64);
    await writeFile(
      candidateReceiptPath,
      `${JSON.stringify(candidate, null, 2)}\n`
    );
    const reboundReceipt = await readFile(candidateReceiptPath);
    await expect(createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath,
      candidateReceiptSha256: sha256(reboundReceipt),
      release: fixture.release
    })).rejects.toThrow("candidate latest.json SHA-256");

    const wrongPolicy = await createFixture({ idBase: 32, version: "8.6.4" });
    if (!wrongPolicy.candidateReceiptPath) {
      throw new Error("The default fixture must include its candidate receipt.");
    }
    const wrongPolicyReceipt = JSON.parse(
      await readFile(wrongPolicy.candidateReceiptPath, "utf8")
    );
    wrongPolicyReceipt.publication.allowedByThisWorkflow = true;
    await writeFile(
      wrongPolicy.candidateReceiptPath,
      `${JSON.stringify(wrongPolicyReceipt, null, 2)}\n`
    );
    const wrongPolicySource = await readFile(wrongPolicy.candidateReceiptPath);
    await expect(createElectronProductionPublicLatestSnapshot({
      assetDirectory: wrongPolicy.assetDirectory,
      candidateReceiptPath: wrongPolicy.candidateReceiptPath,
      candidateReceiptSha256: sha256(wrongPolicySource),
      release: wrongPolicy.release
    })).rejects.toThrow("publication permission");

    const clean = await createFixture({ version: "8.6.1" });
    await writeFile(path.join(clean.assetDirectory, "latest.json"), "{}\n");
    await expect(createElectronProductionPublicLatestSnapshot({
      assetDirectory: clean.assetDirectory,
      candidateReceiptPath: clean.candidateReceiptPath,
      candidateReceiptSha256: clean.candidateReceiptSha256,
      release: clean.release
    })).rejects.toThrow("latest.json");

    const intact = await createFixture({ version: "8.6.2" });
    const snapshot = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: intact.assetDirectory,
      candidateReceiptPath: intact.candidateReceiptPath,
      candidateReceiptSha256: intact.candidateReceiptSha256,
      release: intact.release
    });
    expect(() => assertElectronProductionPublicLatestSnapshot({
      ...snapshot,
      snapshotSha256: "0".repeat(64)
    })).toThrow("snapshot digest");
    expect(() => assertElectronProductionPublicLatestSnapshot({
      ...snapshot,
      unexpected: true
    })).toThrow("unexpected schema");
  });

  it("classifies the observed latest state as source, target, or foreign", async () => {
    const [source, foreign] = await Promise.all([
      createSnapshotFixture("8.4.2", 100),
      createSnapshotFixture("9.1.0", 300)
    ]);
    const targetFixture = await createFixture({
      idBase: 200,
      isLatest: false,
      version: "8.6.0"
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
      candidateReceiptPath: targetFixture.candidateReceiptPath,
      candidateReceiptSha256: targetFixture.candidateReceiptSha256,
      release: { ...targetFixture.release, isLatest: true }
    });

    expect(stagedTarget.observationKind).toBe("observed-release");
    expect(stagedTarget.release.isLatest).toBe(false);
    expect(target.observationKind).toBe("expected-latest-projection");
    expect(target.release.isLatest).toBe(true);
    expect(target.stateSha256).toBe(observedTarget.stateSha256);
    expect(target.snapshotSha256).not.toBe(observedTarget.snapshotSha256);

    expect(classifyElectronProductionPublicLatestSnapshot({
      observed: JSON.parse(JSON.stringify(source)), source, target
    })).toBe("source");
    expect(classifyElectronProductionPublicLatestSnapshot({
      observed: observedTarget, source, target
    })).toBe("target");
    expect(classifyElectronProductionPublicLatestSnapshot({
      observed: foreign, source, target
    })).toBe("foreign");
    expect(() => classifyElectronProductionPublicLatestSnapshot({
      observed: target,
      source,
      target
    })).toThrow("post-readback");
    expect(() => deriveElectronProductionExpectedLatestState(source)).toThrow(
      "must be observed as non-latest"
    );

    const candidateLessFixture = await createFixture({
      idBase: 400,
      includeCandidateReceipt: false,
      isLatest: false,
      version: "8.7.0"
    });
    const candidateLessObserved = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: candidateLessFixture.assetDirectory,
      release: candidateLessFixture.release
    });
    expect(() => deriveElectronProductionExpectedLatestState(
      candidateLessObserved
    )).toThrow("candidate receipt");
  });

  it("projects and classifies a candidate-less Tauri v22 restore target", async () => {
    const sourceFixture = await createFixture({
      idBase: 500,
      includeCandidateReceipt: false,
      version: "8.4.2"
    });
    const targetFixture = await createFixture({
      idBase: 600,
      includeCandidateReceipt: false,
      isLatest: false,
      version: "8.3.9"
    });
    const source = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: sourceFixture.assetDirectory,
      release: sourceFixture.release
    });
    const staged = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: targetFixture.assetDirectory,
      release: targetFixture.release
    });
    const target = deriveTauriV22ExpectedLatestState(staged);
    const observedTarget = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: targetFixture.assetDirectory,
      release: { ...targetFixture.release, isLatest: true }
    });

    expect(target).toMatchObject({
      candidateReceipt: null,
      observationKind: "expected-tauri-v22-latest-projection",
      release: { isLatest: true }
    });
    expect(target.stateSha256).toBe(observedTarget.stateSha256);
    expect(classifyElectronProductionPublicLatestSnapshot({
      observed: observedTarget,
      source,
      target
    })).toBe("target");

    const electronFixture = await createFixture({
      idBase: 700,
      isLatest: false,
      version: "9.0.0"
    });
    const electron = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: electronFixture.assetDirectory,
      candidateReceiptPath: electronFixture.candidateReceiptPath,
      candidateReceiptSha256: electronFixture.candidateReceiptSha256,
      release: electronFixture.release
    });
    expect(() => deriveTauriV22ExpectedLatestState(electron)).toThrow(
      "must not bind an Electron candidate receipt"
    );
    expect(() => deriveTauriV22ExpectedLatestState(source)).toThrow(
      "must be observed as non-latest"
    );
  });

  it("rejects noncanonical snapshot files even when their values are valid", async () => {
    const fixture = await createFixture();
    const snapshot = await createElectronProductionPublicLatestSnapshot({
      assetDirectory: fixture.assetDirectory,
      candidateReceiptPath: fixture.candidateReceiptPath,
      candidateReceiptSha256: fixture.candidateReceiptSha256,
      release: fixture.release
    });
    const snapshotPath = path.join(fixture.root, "noncanonical.json");
    const noncanonical = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
    await writeFile(snapshotPath, noncanonical, { flag: "wx" });

    await expect(readElectronProductionPublicLatestSnapshot({
      expectedFileSha256: sha256(noncanonical),
      snapshotPath
    })).rejects.toThrow("stable canonical JSON");
  });
});

async function createSnapshotFixture(version: string, idBase: number) {
  const fixture = await createFixture({ idBase, version });
  return createElectronProductionPublicLatestSnapshot({
    assetDirectory: fixture.assetDirectory,
    candidateReceiptPath: fixture.candidateReceiptPath,
    candidateReceiptSha256: fixture.candidateReceiptSha256,
    release: fixture.release
  });
}

async function createFixture(options: Readonly<{
  idBase?: number;
  includeCandidateReceipt?: boolean;
  isLatest?: boolean;
  reverseReleaseAssets?: boolean;
  version?: string;
}> = {}) {
  const idBase = options.idBase ?? 10;
  const includeCandidateReceipt = options.includeCandidateReceipt ?? true;
  const version = options.version ?? "8.6.0";
  const root = await mkdtemp(path.join(tmpdir(), "rion-public-latest-snapshot-"));
  temporaryDirectories.push(root);
  const assetDirectory = path.join(root, "assets");
  await mkdir(assetDirectory);
  const signatures = {
    "Rion.Studio-mac.app.tar.gz.sig": `mac-signature-${version}\n`,
    "Rion.Studio-win.exe.sig": `windows-signature-${version}\n`
  };
  const manifest = {
    version,
    pub_date: PUBLISHED_AT,
    platforms: {
      "darwin-aarch64": {
        url: `${UPDATER_BASE_URL}Rion.Studio-mac.app.tar.gz`,
        signature: signatures["Rion.Studio-mac.app.tar.gz.sig"].trim(),
        sha256: sha256(`mac-archive-${version}\n`)
      },
      "windows-x86_64": {
        url: `${UPDATER_BASE_URL}Rion.Studio-win.exe`,
        signature: signatures["Rion.Studio-win.exe.sig"].trim(),
        sha256: sha256(`windows-installer-${version}\n`)
      }
    }
  };
  const sources: Record<string, Buffer> = {
    "Rion.Studio-mac.app.tar.gz": Buffer.from(`mac-archive-${version}\n`),
    "Rion.Studio-mac.app.tar.gz.sig": Buffer.from(
      signatures["Rion.Studio-mac.app.tar.gz.sig"]
    ),
    "Rion.Studio-mac.dmg": Buffer.from(`mac-dmg-${version}\n`),
    "Rion.Studio-win.exe": Buffer.from(`windows-installer-${version}\n`),
    "Rion.Studio-win.exe.sig": Buffer.from(
      signatures["Rion.Studio-win.exe.sig"]
    ),
    "latest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  };
  const checksumNames = Object.keys(sources).sort();
  sources["SHA256SUMS.txt"] = Buffer.from(
    `${checksumNames.map((name) => `${sha256(sources[name]!)}  ${name}`).join("\n")}\n`
  );
  await Promise.all(Object.entries(sources).map(([name, source]) =>
    writeFile(path.join(assetDirectory, name), source, { flag: "wx" })
  ));
  const assetSha256 = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) =>
      [name, sha256(sources[name]!)]
    )
  );
  const candidateReceiptPath = path.join(root, "electron-production-candidate-receipt.json");
  const candidateReceipt = productionCandidateReceipt(version, sources, assetSha256);
  await writeFile(
    candidateReceiptPath,
    `${JSON.stringify(candidateReceipt, null, 2)}\n`,
    { flag: "wx" }
  );
  const candidateReceiptSha256 = sha256(await readFile(candidateReceiptPath));
  const tag = `v${version}`;
  const releaseAssets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: sources[name]!.length,
    contentType: contentType(name),
    digest: `sha256:${assetSha256[name]}` as const,
    id: String(idBase + index),
    name,
    url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}`
  }));
  if (options.reverseReleaseAssets) releaseAssets.reverse();
  return {
    assetDirectory,
    assetSha256,
    candidateReceiptPath: includeCandidateReceipt ? candidateReceiptPath : undefined,
    candidateReceiptSha256: includeCandidateReceipt ? candidateReceiptSha256 : undefined,
    release: {
      assets: releaseAssets,
      draft: false as const,
      id: String(idBase * 100),
      isLatest: options.isLatest ?? true,
      prerelease: false as const,
      repository: REPOSITORY,
      tag,
      targetCommitish: idBase.toString(16).padStart(40, "0")
    },
    root,
    version
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
        artifact: artifact("Rion.Studio-win.exe", "Rion.Studio-win.exe.sig")
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
