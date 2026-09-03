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

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  writeElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  assembleElectronProductionPublicationStagingPlan,
  ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW,
  ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL,
  ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT,
  readElectronProductionPublicationStagingPlan,
  serializeElectronProductionPublicationStagingPlan
} from "../scripts/electronProductionPublicationStagingPlan.mjs";
import {
  TAURI_V22_COMPATIBILITY_WORKFLOW,
  TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME
} from "../scripts/tauriV22PublicLineage.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const SOURCE_SHA = "1".repeat(40);
const TARGET_SHA = "a".repeat(40);
const PUBLIC_KEY_SHA256 = "b".repeat(64);
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const PUBLIC_ENDPOINT = `${PUBLIC_BASE}latest.json`;
const CREATED_AT = "2026-09-01T01:00:00Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production publication staging plan", () => {
  it("durably binds the actual v22 snapshot, paired lineage, candidate, and runs", async () => {
    const fixture = await createFixture();
    const written = await assembleElectronProductionPublicationStagingPlan(fixture.input);

    expect(written.plan).toMatchObject({
      terminal: false,
      publicationMutationAllowed: false,
      transaction: { id: TRANSACTION_ID },
      lease: { id: LEASE_ID, generation: 3 },
      source: {
        releaseTag: "v8.4.2",
        sourceSha: SOURCE_SHA,
        snapshot: {
          fileSha256: fixture.sourceFileSha256,
          stateSha256: fixture.source.stateSha256
        }
      },
      target: {
        releaseTag: "v8.6.0",
        sourceSha: TARGET_SHA,
        updater: { endpoint: PUBLIC_ENDPOINT, publicKeySha256: PUBLIC_KEY_SHA256 }
      },
      provenance: {
        candidate: {
          runId: "202",
          runAttempt: 2,
          workflow: ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW
        },
        lineage: {
          runId: "101",
          runAttempt: 1,
          workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
        }
      }
    });
    expect(Object.keys(written.plan.target.assets)).toEqual(
      ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES
    );
    expect(await readFile(written.receiptPath)).toEqual(
      serializeElectronProductionPublicationStagingPlan(written.plan)
    );
    await expect(readElectronProductionPublicationStagingPlan({
      expectedSha256: written.receiptIdentity.sha256,
      receiptPath: written.receiptPath
    })).resolves.toMatchObject({ plan: written.plan });
    await expect(assembleElectronProductionPublicationStagingPlan(fixture.input))
      .rejects.toThrow("create-new");
  });

  it("rejects a tampered candidate asset summary instead of trusting an applied flag", async () => {
    const fixture = await createFixture();
    if (fixture.input.targetCandidate.kind !== "verified-summary") {
      throw new Error("The fixture must use a preverified candidate summary.");
    }
    const verification = structuredClone(fixture.input.targetCandidate.verification);
    verification.assets["latest.json"].sha256 = "f".repeat(64);

    await expect(assembleElectronProductionPublicationStagingPlan({
      ...fixture.input,
      targetCandidate: { kind: "verified-summary", verification }
    })).rejects.toThrow("latest.json SHA-256");
  });

  it("rejects a foreign but internally valid v22 lineage pair", async () => {
    const fixture = await createFixture({ foreignLineageReleaseId: "9999" });

    await expect(assembleElectronProductionPublicationStagingPlan(fixture.input))
      .rejects.toThrow("lineage release ID");
  });

  it("rejects an internally consistent candidate aimed at a foreign endpoint", async () => {
    const fixture = await createFixture({
      candidateBaseUrl: "https://updates.example.test/rion/v23/"
    });

    await expect(assembleElectronProductionPublicationStagingPlan(fixture.input))
      .rejects.toThrow("publication target updater endpoint");
  });

  it("rejects provenance that is not the exact receipt-producing run", async () => {
    const fixture = await createFixture();

    await expect(assembleElectronProductionPublicationStagingPlan({
      ...fixture.input,
      provenance: {
        ...fixture.input.provenance,
        lineage: { ...fixture.input.provenance.lineage, runId: "102" }
      }
    })).rejects.toThrow("producer run ID");
    await expect(assembleElectronProductionPublicationStagingPlan({
      ...fixture.input,
      provenance: {
        ...fixture.input.provenance,
        candidate: {
          ...fixture.input.provenance.candidate,
          workflow: ".github/workflows/foreign.yml"
        }
      }
    })).rejects.toThrow("candidate run workflow");
  });

  it("rejects an unknown canonical receipt schema on attested reread", async () => {
    const fixture = await createFixture();
    const written = await assembleElectronProductionPublicationStagingPlan(fixture.input);
    const unknown = {
      ...JSON.parse(await readFile(written.receiptPath, "utf8")),
      futurePublicationPermission: true
    };
    const source = serializeCanonicalJson(unknown);
    await writeFile(written.receiptPath, source);

    await expect(readElectronProductionPublicationStagingPlan({
      expectedSha256: sha256(source),
      receiptPath: written.receiptPath
    })).rejects.toThrow("unexpected schema");
  });
});

async function createFixture(options: Readonly<{
  candidateBaseUrl?: string;
  foreignLineageReleaseId?: string;
}> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rion-publication-staging-plan-"));
  temporaryDirectories.push(root);
  const source = sourceSnapshot();
  const sourcePath = path.join(root, "actual-v22-public-latest-snapshot.json");
  const sourceWritten = await writeElectronProductionPublicLatestSnapshot({
    outputPath: sourcePath,
    snapshot: source
  });
  const candidate = candidateVerification(options.candidateBaseUrl ?? PUBLIC_BASE);
  const lineages = {
    "darwin-aarch64": lineageReceipt(
      source,
      "darwin-aarch64",
      options.foreignLineageReleaseId
    ),
    "windows-x86_64": lineageReceipt(
      source,
      "windows-x86_64",
      options.foreignLineageReleaseId
    )
  };
  const lineageInput = {} as Record<
    keyof typeof lineages,
    { path: string; sha256: string }
  >;
  for (const platform of Object.keys(lineages) as Array<keyof typeof lineages>) {
    const directory = path.join(root, platform);
    await mkdir(directory);
    const receiptPath = path.join(directory, TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME);
    const receiptSource = serializeCanonicalJson(lineages[platform]);
    await writeFile(receiptPath, receiptSource, { flag: "wx", mode: 0o600 });
    lineageInput[platform] = { path: receiptPath, sha256: sha256(receiptSource) };
  }
  return {
    input: {
      createdAt: CREATED_AT,
      lease: { id: LEASE_ID, generation: 3 },
      lineage: lineageInput,
      outputPath: path.join(root, ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_RECEIPT),
      ownerApproval: ELECTRON_PRODUCTION_PUBLICATION_STAGING_PLAN_APPROVAL,
      provenance: {
        candidate: {
          headSha: TARGET_SHA,
          repository: "rion-tw/rion-studio-source" as const,
          runAttempt: 2,
          runId: "202",
          workflow: ELECTRON_PRODUCTION_CANDIDATE_WORKFLOW
        },
        lineage: {
          headSha: TARGET_SHA,
          repository: "rion-tw/rion-studio-source" as const,
          runAttempt: 1,
          runId: "101",
          workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
        }
      },
      sourceSnapshot: { path: sourcePath, sha256: sourceWritten.file.sha256 },
      targetCandidate: { kind: "verified-summary" as const, verification: candidate },
      transaction: { id: TRANSACTION_ID }
    },
    source,
    sourceFileSha256: sourceWritten.file.sha256
  };
}

function sourceSnapshot() {
  const version = "8.4.2";
  const releaseTag = `v${version}`;
  const digests = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      sha256(`${version}:${name}`)
    ])
  );
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: 100 + index,
    contentType: contentType(name),
    digest: `sha256:${digests[name]}`,
    id: String(100 + index),
    name,
    url: `https://github.com/rion-tw/rion-studio/releases/download/` +
      `${releaseTag}/${encodeURIComponent(name)}`
  }));
  const state = {
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-snapshot",
    repository: "rion-tw/rion-studio",
    release: {
      draft: false,
      id: "1000",
      isLatest: true,
      prerelease: false,
      tag: releaseTag,
      targetCommitish: "2".repeat(40)
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
      publishedAt: "2026-08-01T00:00:00Z",
      sha256: digests["latest.json"],
      version
    },
    candidateReceipt: null
  };
  const stateSha256 = sha256(serializeCanonicalJson(state));
  const body = { ...state, observationKind: "observed-release", stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function candidateVerification(baseUrl: string) {
  const version = "8.6.0";
  const updaterEndpoint = new URL("latest.json", baseUrl).href;
  const assets = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => [
      name,
      { bytes: 200 + index, sha256: sha256(`${version}:${name}`) }
    ])
  );
  const receiptAssets = Object.fromEntries(
    Object.entries(assets).map(([name, identity]) => [name, identity.sha256])
  );
  return {
    assets,
    receipt: {
      schemaVersion: 1,
      kind: "rion-electron-production-candidate",
      status: "verified-not-published",
      publication: { allowedByThisWorkflow: false, status: "candidate-only" },
      ownerGate: {
        approval: "BUILD ELECTRON PRODUCTION CANDIDATE",
        environment: "electron-production-release"
      },
      sourceSha: TARGET_SHA,
      version,
      publishedAt: "2026-09-01T00:00:00Z",
      updaterBaseUrl: baseUrl,
      updaterEndpoint,
      updaterEndpointPolicy: { redirects: "forbidden", requiredStatus: 200 },
      publicKeySha256: PUBLIC_KEY_SHA256,
      platforms: { "darwin-aarch64": {}, "windows-x86_64": {} },
      assets: receiptAssets,
      compatibility: {
        stableTauriReleasePath: "preserved",
        tauriV22CutoverEvidence: "separate-required-gate"
      }
    },
    receiptSha256: sha256(`candidate:${version}`),
    sourceSha: TARGET_SHA,
    updaterBaseUrl: baseUrl,
    updaterEndpoint,
    version
  };
}

function lineageReceipt(
  source: ReturnType<typeof sourceSnapshot>,
  platform: "darwin-aarch64" | "windows-x86_64",
  releaseId?: string
) {
  const asset = (name: string) => {
    const observed = source.assets.find((entry) => entry.name === name)!;
    return {
      bytes: observed.bytes,
      id: observed.id,
      name,
      sha256: observed.digest.slice("sha256:".length)
    };
  };
  const isMac = platform === "darwin-aarch64";
  const artifactName = isMac ? "Rion.Studio-mac.app.tar.gz" : "Rion.Studio-win.exe";
  const observedAt = "2026-09-01T00:00:00Z";
  return {
    schemaVersion: 1,
    kind: "rion-tauri-v22-public-source-lineage",
    status: "verified-public-source-lineage",
    cutoverEligible: false,
    runtime: "tauri-v22",
    platform,
    release: {
      repository: "rion-tw/rion-studio",
      id: releaseId ?? source.release.id,
      tag: source.release.tag,
      version: source.latestJson.version,
      draft: false,
      prerelease: false,
      wasLatestAtCapture: true,
      publishedAt: "2026-08-01T00:00:00Z",
      observedAt
    },
    sourceTag: {
      repository: "rion-tw/rion-studio-source",
      releaseTag: source.release.tag,
      refObjectType: "commit",
      refObjectSha: SOURCE_SHA,
      peeledCommitSha: SOURCE_SHA,
      observedAt
    },
    targetSourceSha: TARGET_SHA,
    trust: { updaterPublicKeySha256: PUBLIC_KEY_SHA256 },
    verifiedInputReceipt: {
      fileName: "verified-input-receipt.json",
      sha256: sha256(`input:${platform}`)
    },
    assets: {
      artifact: asset(artifactName),
      checksums: asset("SHA256SUMS.txt"),
      manifest: asset("latest.json"),
      signature: asset(`${artifactName}.sig`)
    },
    runningExecutable: {
      derivation: isMac
        ? "macos-exact-archive-member"
        : "windows-isolated-current-user-nsis-install",
      relativePath: isMac
        ? "Rion Studio.app/Contents/MacOS/rion-tauri"
        : "rion-tauri.exe",
      fileName: isMac ? "rion-tauri" : "rion-tauri.exe",
      bytes: 700,
      sha256: sha256(`running:${platform}`),
      derivedFromArtifactSha256: asset(artifactName).sha256
    },
    producer: {
      artifactName: `tauri-v22-public-lineage-${platform}-101-1`,
      event: "workflow_dispatch",
      headSha: TARGET_SHA,
      producedAt: observedAt,
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "101",
      workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
    },
    verifiedAt: observedAt
  };
}

function contentType(name: string) {
  if (name.endsWith(".sig") || name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/vnd.microsoft.portable-executable";
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
