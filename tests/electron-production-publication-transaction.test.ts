import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState,
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  serializeElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import { runElectronProductionPublicationCli } from
  "../scripts/electronProductionPublicationCli.mjs";
import { writeElectronProductionPublicationReceipt } from
  "../scripts/electronProductionPublicationReceipt.mjs";
import {
  createElectronProductionBaselineLineageFromReceipts,
  createElectronProductionPublicationIntentFromSnapshots,
  recordElectronProductionPublicationRecovery,
  recordElectronProductionPublicationResult
} from "../scripts/electronProductionPublicationTransaction.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const BASELINE_SOURCE_SHA = "1".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production publication transaction snapshot bindings", () => {
  it("binds a real v22 latest observation to one projected v23 target", () => {
    const fixture = transactionFixture();
    const receipts = lineagePair(fixture);
    const lineage = createElectronProductionBaselineLineageFromReceipts({
      ...receipts,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    const intent = createElectronProductionPublicationIntentFromSnapshots({
      baselineLineage: lineage,
      lease: { id: LEASE_ID, generation: 1 },
      recordedAt: "2026-09-01T00:00:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target,
      transactionId: TRANSACTION_ID
    });

    expect(intent).toMatchObject({
      phase: "intent",
      terminal: false,
      baseline: {
        sourceSha: BASELINE_SOURCE_SHA,
        stateSha256: fixture.source.stateSha256,
        version: "8.4.2"
      },
      target: {
        candidateReceiptSha256: fixture.target.candidateReceipt?.sha256,
        sourceSha: fixture.target.candidateReceipt?.sourceSha,
        stateSha256: fixture.target.stateSha256,
        version: "8.6.0"
      }
    });

    const tampered = lineagePair(fixture);
    tampered.macos.assets.manifest.id = "999999";
    expect(() => createElectronProductionBaselineLineageFromReceipts({
      ...tampered,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    })).toThrow("manifest asset.id");

    const provisional = recordElectronProductionPublicationResult({
      acknowledgement: "confirmed",
      lease: heldLease(),
      observedSnapshot: fixture.observedTarget,
      previousReceipt: intent,
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    expect(provisional).toMatchObject({
      phase: "provisional",
      terminal: false,
      publication: {
        acknowledgement: "confirmed",
        observedState: "target",
        observedStateSha256: fixture.target.stateSha256
      },
      recovery: { rollbackAllowed: true }
    });
  });

  it("routes an unknown publication acknowledgement with exact target into guarded recovery", () => {
    const fixture = transactionFixture();
    const recoveryRequired = recordElectronProductionPublicationResult({
      acknowledgement: "unknown",
      lease: heldLease(),
      observedSnapshot: fixture.observedTarget,
      previousReceipt: createIntent(fixture),
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });

    expect(recoveryRequired).toMatchObject({
      phase: "recovery-required",
      terminal: false,
      publication: { acknowledgement: "unknown", observedState: "target" }
    });

    const rolledBack = recordElectronProductionPublicationRecovery({
      finalSnapshot: fixture.source,
      lease: heldLease(),
      observedSnapshot: fixture.observedTarget,
      previousReceipt: recoveryRequired,
      recordedAt: "2026-09-01T00:02:00Z",
      rollbackAcknowledgement: "confirmed",
      rollbackAttempted: true,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    expect(rolledBack).toMatchObject({
      phase: "terminal",
      terminal: true,
      outcome: "rolled-back",
      recovery: {
        acknowledgement: "confirmed",
        finalState: "baseline",
        reason: "source-snapshot-restored"
      }
    });
  });

  it("never converts an unavailable or foreign readback into success", () => {
    const fixture = transactionFixture();
    const unavailable = recordElectronProductionPublicationResult({
      acknowledgement: "confirmed",
      lease: heldLease(),
      observedSnapshot: null,
      previousReceipt: createIntent(fixture),
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    expect(unavailable).toMatchObject({
      terminal: true,
      outcome: "indeterminate",
      publication: { observedState: "unknown", observedStateSha256: null },
      recovery: { reason: "published-state-unknown" }
    });

    const foreignSnapshot = makeObservedSnapshot({
      candidate: null,
      idBase: 900,
      isLatest: true,
      version: "24.0.0"
    });
    const foreign = recordElectronProductionPublicationResult({
      acknowledgement: "confirmed",
      lease: heldLease(),
      observedSnapshot: foreignSnapshot,
      previousReceipt: createIntent(fixture),
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    expect(foreign).toMatchObject({
      terminal: true,
      outcome: "indeterminate",
      publication: { observedState: "foreign" },
      recovery: { rollbackAllowed: false, reason: "foreign-state-observed" }
    });
  });

  it("forbids rollback after lease loss or a foreign precondition", () => {
    const fixture = transactionFixture();
    const provisional = recordElectronProductionPublicationResult({
      acknowledgement: "confirmed",
      lease: heldLease(),
      observedSnapshot: fixture.observedTarget,
      previousReceipt: createIntent(fixture),
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    expect(() => recordElectronProductionPublicationRecovery({
      finalSnapshot: fixture.source,
      lease: { ...heldLease(), status: "lost" },
      observedSnapshot: fixture.observedTarget,
      previousReceipt: provisional,
      recordedAt: "2026-09-01T00:02:00Z",
      rollbackAcknowledgement: "confirmed",
      rollbackAttempted: true,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    })).toThrow("Rollback is forbidden");
  });

  it("rejects observed target snapshots as intent projections and detects rebinding", () => {
    const fixture = transactionFixture();
    expect(() => createElectronProductionPublicationIntentFromSnapshots({
      baselineLineage: baselineLineage(fixture.source),
      lease: { id: LEASE_ID, generation: 1 },
      recordedAt: "2026-09-01T00:00:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.observedTarget,
      transactionId: TRANSACTION_ID
    })).toThrow("target observation kind");

    const intent = createIntent(fixture);
    const otherTarget = deriveElectronProductionExpectedLatestState(
      makeObservedSnapshot({
        candidate: candidateSummary("8.7.0"),
        idBase: 500,
        isLatest: false,
        version: "8.7.0"
      })
    );
    expect(() => recordElectronProductionPublicationResult({
      acknowledgement: "confirmed",
      lease: heldLease(),
      observedSnapshot: fixture.observedTarget,
      previousReceipt: intent,
      recordedAt: "2026-09-01T00:01:00Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: otherTarget
    })).toThrow("publication target version");
  });

  it("records a canonical provisional receipt through the workflow-facing CLI", async () => {
    const fixture = transactionFixture();
    const intent = createIntent(fixture);
    const root = await mkdtemp(path.join(tmpdir(), "rion-publication-cli-"));
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "source-snapshot.json");
    const targetPath = path.join(root, "target-snapshot.json");
    const observedPath = path.join(root, "observed-snapshot.json");
    const sourceBytes = serializeElectronProductionPublicLatestSnapshot(fixture.source);
    const targetBytes = serializeElectronProductionPublicLatestSnapshot(fixture.target);
    const observedBytes = serializeElectronProductionPublicLatestSnapshot(
      fixture.observedTarget
    );
    await Promise.all([
      writeFile(sourcePath, sourceBytes, { flag: "wx" }),
      writeFile(targetPath, targetBytes, { flag: "wx" }),
      writeFile(observedPath, observedBytes, { flag: "wx" })
    ]);
    const writtenIntent = await writeElectronProductionPublicationReceipt({
      outputPath: path.join(
        root,
        "electron-production-publication-intent-receipt.json"
      ),
      receipt: intent
    });
    const output = path.join(
      root,
      "electron-production-publication-provisional-receipt.json"
    );
    const result = await runElectronProductionPublicationCli([
      "publication-result",
      "--acknowledgement", "confirmed",
      "--lease-id", LEASE_ID,
      "--lease-generation", "1",
      "--lease-status", "held",
      "--observation", "snapshot",
      "--observed-snapshot", observedPath,
      "--observed-snapshot-sha256", sha256(observedBytes),
      "--output", output,
      "--previous-receipt", writtenIntent.receiptPath,
      "--previous-receipt-sha256", writtenIntent.receiptIdentity.sha256,
      "--recorded-at", "2026-09-01T00:01:00Z",
      "--source-snapshot", sourcePath,
      "--source-snapshot-sha256", sha256(sourceBytes),
      "--target-snapshot", targetPath,
      "--target-snapshot-sha256", sha256(targetBytes)
    ]);

    expect("receipt" in result && result.receipt).toMatchObject({
      phase: "provisional",
      publication: { observedState: "target" }
    });
  });
});

function transactionFixture() {
  const source = makeObservedSnapshot({
    candidate: null,
    idBase: 100,
    isLatest: true,
    version: "8.4.2"
  });
  const staged = makeObservedSnapshot({
    candidate: candidateSummary("8.6.0"),
    idBase: 200,
    isLatest: false,
    version: "8.6.0"
  });
  const target = deriveElectronProductionExpectedLatestState(staged);
  const observedTarget = observedFromProjection(target);
  return { observedTarget, source, target };
}

function createIntent(fixture: ReturnType<typeof transactionFixture>) {
  return createElectronProductionPublicationIntentFromSnapshots({
    baselineLineage: baselineLineage(fixture.source),
    lease: { id: LEASE_ID, generation: 1 },
    recordedAt: "2026-09-01T00:00:00Z",
    sourceSnapshot: fixture.source,
    targetSnapshot: fixture.target,
    transactionId: TRANSACTION_ID
  });
}

function baselineLineage(source: ReturnType<typeof makeObservedSnapshot>) {
  return {
    manifestSha256: source.latestJson.sha256,
    releaseTag: source.release.tag,
    runtime: "tauri-v22" as const,
    sourceSha: BASELINE_SOURCE_SHA,
    version: source.latestJson.version
  };
}

function heldLease() {
  return {
    foreignLeaseGeneration: null,
    foreignLeaseId: null,
    generation: 1,
    id: LEASE_ID,
    status: "held" as const
  };
}

function lineagePair(fixture: ReturnType<typeof transactionFixture>) {
  return {
    macos: lineageReceipt(fixture, "darwin-aarch64"),
    windows: lineageReceipt(fixture, "windows-x86_64")
  };
}

function lineageReceipt(
  fixture: ReturnType<typeof transactionFixture>,
  platform: "darwin-aarch64" | "windows-x86_64"
) {
  const source = fixture.source;
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
  const artifactName = isMac
    ? "Rion.Studio-mac.app.tar.gz"
    : "Rion.Studio-win.exe";
  const producedAt = "2026-09-01T00:00:00Z";
  return {
    schemaVersion: 1 as const,
    kind: "rion-tauri-v22-public-source-lineage" as const,
    status: "verified-public-source-lineage" as const,
    cutoverEligible: false as const,
    runtime: "tauri-v22" as const,
    platform,
    release: {
      repository: "rion-tw/rion-studio" as const,
      id: source.release.id,
      tag: source.release.tag,
      version: source.latestJson.version,
      draft: false as const,
      prerelease: false as const,
      wasLatestAtCapture: true as const,
      publishedAt: producedAt,
      observedAt: producedAt
    },
    sourceTag: {
      repository: "rion-tw/rion-studio-source" as const,
      releaseTag: source.release.tag,
      refObjectType: "commit" as const,
      refObjectSha: BASELINE_SOURCE_SHA,
      peeledCommitSha: BASELINE_SOURCE_SHA,
      observedAt: producedAt
    },
    targetSourceSha: fixture.target.candidateReceipt!.sourceSha,
    trust: {
      updaterPublicKeySha256: fixture.target.candidateReceipt!.publicKeySha256
    },
    verifiedInputReceipt: {
      fileName: "verified-input-receipt.json" as const,
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
        ? "macos-exact-archive-member" as const
        : "windows-isolated-current-user-nsis-install" as const,
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
      event: "workflow_dispatch" as const,
      headSha: fixture.target.candidateReceipt!.sourceSha,
      producedAt,
      repository: "rion-tw/rion-studio-source" as const,
      runAttempt: 1,
      runId: "101",
      workflow: ".github/workflows/electron-updater-tauri-v22-compatibility.yml" as const
    },
    verifiedAt: producedAt
  };
}

function makeObservedSnapshot(input: Readonly<{
  candidate: ReturnType<typeof candidateSummary> | null;
  idBase: number;
  isLatest: boolean;
  version: string;
}>) {
  const tag = `v${input.version}`;
  const digests = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      sha256(`${input.version}:${name}`)
    ])
  );
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: 100 + index,
    contentType: contentType(name),
    digest: `sha256:${digests[name]}`,
    id: String(input.idBase + index),
    name,
    url: `https://github.com/rion-tw/rion-studio/releases/download/${tag}/${encodeURIComponent(name)}`
  }));
  const updaterBaseUrl = input.candidate?.updaterBaseUrl ??
    "https://updates.example.test/v22/";
  const state = {
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-snapshot",
    repository: "rion-tw/rion-studio",
    release: {
      draft: false,
      id: String(input.idBase * 10),
      isLatest: input.isLatest,
      prerelease: false,
      tag,
      targetCommitish: input.idBase.toString(16).padStart(40, "0")
    },
    assets,
    latestJson: {
      bytes: assets.find((asset) => asset.name === "latest.json")?.bytes,
      platforms: {
        "darwin-aarch64": {
          artifactName: "Rion.Studio-mac.app.tar.gz",
          artifactSha256: digests["Rion.Studio-mac.app.tar.gz"],
          signatureFileName: "Rion.Studio-mac.app.tar.gz.sig",
          signatureFileSha256: digests["Rion.Studio-mac.app.tar.gz.sig"],
          url: `${updaterBaseUrl}Rion.Studio-mac.app.tar.gz`
        },
        "windows-x86_64": {
          artifactName: "Rion.Studio-win.exe",
          artifactSha256: digests["Rion.Studio-win.exe"],
          signatureFileName: "Rion.Studio-win.exe.sig",
          signatureFileSha256: digests["Rion.Studio-win.exe.sig"],
          url: `${updaterBaseUrl}Rion.Studio-win.exe`
        }
      },
      publishedAt: "2026-09-01T00:00:00Z",
      sha256: digests["latest.json"],
      version: input.version
    },
    candidateReceipt: input.candidate === null ? null : {
      ...input.candidate,
      assets: digests,
      version: input.version
    }
  };
  const stateSha256 = sha256(serializeCanonicalJson(state));
  const body = { ...state, observationKind: "observed-release", stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function observedFromProjection(target: ReturnType<
  typeof deriveElectronProductionExpectedLatestState
>) {
  const state = {
    schemaVersion: target.schemaVersion,
    kind: target.kind,
    repository: target.repository,
    release: target.release,
    assets: target.assets,
    latestJson: target.latestJson,
    candidateReceipt: target.candidateReceipt
  };
  const body = {
    ...state,
    observationKind: "observed-release",
    stateSha256: target.stateSha256
  };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function candidateSummary(version: string) {
  return {
    assets: {} as Record<string, string>,
    bytes: 512,
    fileName: "electron-production-candidate-receipt.json" as const,
    publicKeySha256: "b".repeat(64),
    sha256: sha256(`candidate:${version}`),
    sourceSha: "a".repeat(40),
    updaterBaseUrl: PUBLIC_BASE,
    updaterEndpoint: `${PUBLIC_BASE}latest.json`,
    version
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
