import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assembleElectronProductionCandidate,
  createMacosPackageBindingEvidence,
  ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
  ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
  stageElectronProductionPlatformCandidate
} from "../scripts/electronProductionCandidate.mjs";
import {
  serializePackagedElectronBlackBoxReport,
  type PackagedElectronBlackBoxReport
} from "../scripts/packagedElectronBlackBoxReportContract.mjs";
import {
  capturePackagedElectronPackageManifest,
  createPortablePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest
} from "../scripts/packagedElectronPackageManifest.mjs";
import {
  ELECTRON_PRODUCTION_EVIDENCE_WORKFLOW,
  ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL,
  ELECTRON_PRODUCTION_PROVISIONAL_PUBLICATION_WORKFLOW,
  verifyElectronProductionPromotionReadiness as verifyReadiness
} from "../scripts/electronProductionPromotionReadiness.mjs";
import {
  runElectronProductionPromotionReadinessCli
} from "../scripts/electronProductionPromotionReadinessCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES,
  createElectronProductionPublicationIntent,
  transitionElectronProductionPublication,
  writeElectronProductionPublicationReceipt
} from "../scripts/electronProductionPublicationReceipt.mjs";
import { TAURI_V22_COMPATIBILITY_WORKFLOW } from
  "../scripts/tauriV22PublicLineage.mjs";
import {
  buildWindowsElectronInstallerPayloadProof,
  captureStableRegularFileArtifact
} from "../scripts/windowsElectronInstallerPayloadProof.mjs";
import {
  serializeWindowsElectronInstallerPayloadProof,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
  WINDOWS_ELECTRON_UNINSTALLER_PATH
} from "../scripts/windowsElectronInstallerPayloadProofContract.mjs";
import {
  CANDIDATE_CONTROL_SHA,
  CHALLENGE_ID,
  CHALLENGE_SHA256,
  DARWIN,
  ELECTRON_TRANSITION,
  EVIDENCE_CONTROL_SHA,
  PRIOR_CANDIDATE_CONTROL_SHA,
  PRIOR_ELECTRON_SOURCE_SHA,
  PRIOR_ELECTRON_VERSION,
  PROVISIONAL_PUBLICATION_CONTROL_SHA,
  PROVISIONAL_PUBLICATION_RUN_ATTEMPT,
  PROVISIONAL_PUBLICATION_RUN_ID,
  PUBLIC_KEY,
  PUBLISHED_AT,
  READINESS_CONTROL_SHA,
  SCREENSHOT_PNG,
  SIGNATURE,
  SOURCE_EVENTS,
  SOURCE_SHA,
  TAURI_FETCH_ENDPOINT,
  TAURI_FINAL_ENDPOINT,
  TAURI_LINEAGE_CONTROL_SHA,
  TAURI_LINEAGE_RUN_ATTEMPT,
  TAURI_LINEAGE_RUN_ID,
  TAURI_RELEASE_TAG,
  TAURI_SOURCE_SHA,
  TAURI_TRANSITION,
  TAURI_VERSION,
  UPDATER_BASE_URL,
  VERSION,
  WINDOWS,
  type AttachmentName,
  type CandidateReceiptFixture,
  type MutableEvidenceInput
} from "./support/electronProductionPromotionReadinessFixtureConstants";
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});
describe("Electron production promotion readiness", () => {
  it("rebuilds the exact candidate and aggregates four independent terminal receipts", async () => {
    const fixture = await createReadinessFixture();
    const receipt = await verifyReadiness(fixture.input);
    expect(receipt).toMatchObject({
      schemaVersion: 4,
      status: "verified-terminal-evidence",
      publication: {
        allowedByThisWorkflow: false,
        status: "externally-served-terminal-evidence-observed",
        terminalPromotionReceipt: false
      },
      candidate: {
        receiptSha256: fixture.candidateReceiptSha256,
        sourceSha: SOURCE_SHA,
        version: VERSION
      },
      provenance: {
        candidateRunControlSha: CANDIDATE_CONTROL_SHA,
        evidenceRunControlSha: EVIDENCE_CONTROL_SHA,
        priorCandidateRunControlSha: PRIOR_CANDIDATE_CONTROL_SHA,
        provisionalPublicationRunControlSha: PROVISIONAL_PUBLICATION_CONTROL_SHA,
        readinessControlSha: READINESS_CONTROL_SHA,
        tauriLineageRunControlSha: TAURI_LINEAGE_CONTROL_SHA
      },
      compatibility: {
        macosAppKitRetained: true,
        stableTauriReleasePath: "retained-as-rollback-source-until-terminal-promotion",
        windowsEvidenceIndependent: true
      },
      tauriV22PublicLineage: {
        sourceSha: TAURI_SOURCE_SHA,
        targetSourceSha: SOURCE_SHA,
        producer: {
          runId: TAURI_LINEAGE_RUN_ID,
          runAttempt: TAURI_LINEAGE_RUN_ATTEMPT
        }
      },
      provisionalPublication: {
        receiptSha256: fixture.provisionalPublicationReceiptSha256,
        phase: "provisional",
        terminal: false,
        publication: { acknowledgement: "confirmed", observedState: "target" },
        producer: {
          workflow: ELECTRON_PRODUCTION_PROVISIONAL_PUBLICATION_WORKFLOW,
          runId: PROVISIONAL_PUBLICATION_RUN_ID,
          runAttempt: PROVISIONAL_PUBLICATION_RUN_ATTEMPT
        }
      },
      challenge: {
        issuedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2026-09-01T12:00:00Z"
      }
    });
    expect(await readFile(fixture.input.outputPath, "utf8")).toContain(
      "verified-terminal-evidence"
    );
    const tauriEvidence = receipt.evidence[TAURI_TRANSITION];
    expect(tauriEvidence[DARWIN].sourceInstallAttemptId).toBe("update-install-1");
    expect(tauriEvidence[WINDOWS].sourceInstallAttemptId).toBe("update-install-1");
    expect(tauriEvidence[DARWIN].evidenceAttemptId).not.toBe(
      tauriEvidence[WINDOWS].evidenceAttemptId
    );
    expect(tauriEvidence[DARWIN].sourceFetchEndpoint).toBe(
      TAURI_FETCH_ENDPOINT
    );
    expect(tauriEvidence[DARWIN].sourceFetchFinalUrlSha256).toBe(
      sha256(TAURI_FINAL_ENDPOINT)
    );
    const endpointEvidence = await readFile(
      join(
        fixture.evidenceDirectory,
        TAURI_TRANSITION,
        DARWIN,
        "endpoint-observation.json"
      ),
      "utf8"
    );
    expect(endpointEvidence).not.toContain("token=fixture");
    expect(receipt.candidate.sourceSha).not.toBe(receipt.provenance.candidateRunControlSha);
    expect(receipt.candidate.trustedControlReceiptSha256).toBe(sha256(
      await readFile(fixture.input.candidateTrustedControlReceiptPath)
    ));
    expect(
      (tauriEvidence[DARWIN].target as { embeddedUpdaterEndpoint: string })
        .embeddedUpdaterEndpoint
    ).toBe(`${UPDATER_BASE_URL}/latest.json`);
  });
  it("rejects a fabricated source install identity instead of coercing it to an evidence UUID", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, DARWIN, (receipt) => {
      receipt.transaction.sourceInstallAttemptId = "10000000-0000-4000-8000-000000000099";
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("source install attempt ID must be an exact Tauri v22 update-install sequence");
  });
  it("rejects unknown aggregate and transition-level terminal evidence siblings", async () => {
    const aggregateFixture = await createReadinessFixture();
    await writeFile(join(aggregateFixture.evidenceDirectory, "foreign.json"), "{}\n");
    await expect(verifyReadiness(aggregateFixture.input)).rejects.toThrow(
      "terminal evidence aggregate inventory must be exact"
    );

    const transitionFixture = await createReadinessFixture();
    await writeFile(
      join(transitionFixture.evidenceDirectory, TAURI_TRANSITION, "foreign.json"),
      "{}\n"
    );
    await expect(verifyReadiness(transitionFixture.input)).rejects.toThrow(
      `${TAURI_TRANSITION} terminal evidence inventory must be exact`
    );
  });
  it("rejects v23 source lineage that does not match the independently rebuilt prior candidate", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, ELECTRON_TRANSITION, DARWIN, (receipt) => {
      receipt.source.artifactSha256 = sha256("self-declared-prior-artifact");
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("source v23 artifact SHA-256 does not match");
  });
  it("rejects a tampered attested public-lineage receipt after its digest is recomputed", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTauriLineage(fixture.input, DARWIN, (receipt) => {
      receipt.unexpected = true;
    });
    await expect(verifyReadiness(fixture.input)).rejects.toThrow(
      "public-lineage receipt has an unexpected schema"
    );
  });
  it("cross-binds public-lineage artifact and running executable to terminal source evidence", async () => {
    const artifactFixture = await createReadinessFixture();
    await rewriteTauriLineage(artifactFixture.input, DARWIN, (receipt) => {
      const assets = receipt.assets as Record<string, Record<string, unknown>>;
      const running = receipt.runningExecutable as Record<string, unknown>;
      assets.artifact.sha256 = sha256("different-stable-artifact");
      running.derivedFromArtifactSha256 = assets.artifact.sha256;
    });
    await expect(verifyReadiness(artifactFixture.input)).rejects.toThrow(
      "Tauri v22 public-lineage artifact SHA-256"
    );
    const runningFixture = await createReadinessFixture();
    await rewriteTauriLineage(runningFixture.input, WINDOWS, (receipt) => {
      const running = receipt.runningExecutable as Record<string, unknown>;
      running.sha256 = sha256("different-stable-running-image");
    });
    await expect(verifyReadiness(runningFixture.input)).rejects.toThrow(
      "Tauri v22 public-lineage running executable SHA-256"
    );
    const manifestFixture = await createReadinessFixture();
    for (const platform of [DARWIN, WINDOWS] as const) {
      await rewriteTauriLineage(manifestFixture.input, platform, (receipt) => {
        const assets = receipt.assets as Record<string, Record<string, unknown>>;
        assets.manifest.sha256 = sha256("different-stable-manifest");
      });
    }
    await expect(verifyReadiness(manifestFixture.input)).rejects.toThrow(
      "provisional baseline manifest SHA-256"
    );
  });
  it("cross-binds both public-lineage receipts to target SHA, key, and run provenance", async () => {
    const targetFixture = await createReadinessFixture();
    for (const platform of [DARWIN, WINDOWS] as const) {
      await rewriteTauriLineage(targetFixture.input, platform, (receipt) => {
        receipt.targetSourceSha = "e".repeat(40);
        (receipt.producer as Record<string, unknown>).headSha = receipt.targetSourceSha;
      });
    }
    await expect(verifyReadiness(targetFixture.input)).rejects.toThrow(
      "public-lineage target candidate SHA"
    );
    const keyFixture = await createReadinessFixture();
    for (const platform of [DARWIN, WINDOWS] as const) {
      await rewriteTauriLineage(keyFixture.input, platform, (receipt) => {
        (receipt.trust as Record<string, unknown>).updaterPublicKeySha256 = "e".repeat(64);
      });
    }
    await expect(verifyReadiness(keyFixture.input)).rejects.toThrow(
      "public-lineage updater public-key SHA-256"
    );
    const sourceFixture = await createReadinessFixture();
    for (const platform of [DARWIN, WINDOWS] as const) {
      await rewriteTauriLineage(sourceFixture.input, platform, (receipt) => {
        (receipt.sourceTag as Record<string, unknown>).peeledCommitSha = "e".repeat(40);
      });
    }
    await expect(verifyReadiness(sourceFixture.input)).rejects.toThrow(
      "public-lineage Tauri source SHA"
    );
    const provenanceFixture = await createReadinessFixture();
    provenanceFixture.input.provenance.tauriLineageRunAttempt += 1;
    await expect(verifyReadiness(provenanceFixture.input)).rejects.toThrow(
      "public-lineage producer run attempt"
    );
  });
  it("keeps evidence identity globally unique while allowing independent sources to reuse a sequence", async () => {
    const fixture = await createReadinessFixture();
    const transition = TAURI_TRANSITION;
    const macReceiptPath = terminalReceiptPath(
      fixture.evidenceDirectory,
      transition,
      DARWIN
    );
    const windowsDirectory = join(
      fixture.evidenceDirectory,
      transition,
      WINDOWS
    );
    const macReceipt = JSON.parse(await readFile(macReceiptPath, "utf8"));
    await rewriteEvidenceAttemptId(
      windowsDirectory,
      macReceipt.transaction.evidenceAttemptId
    );
    const windowsReceiptPath = join(windowsDirectory, "terminal-receipt.json");
    fixture.input.evidenceReceiptSha256[transition][WINDOWS] =
      sha256(await readFile(windowsReceiptPath));
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("distinct evidence attempt ID");
  });
  it("rejects layout-only receipts and self-declared source-updater success", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, DARWIN, (receipt) => {
      receipt.evidenceKind = "tauri-v22-input-plus-v23-layout-replacement-probe";
      receipt.cutoverEligible = false;
      receipt.transaction.sourceUpdaterInvoked = false;
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("terminal updater evidence kind does not match");
  });
  it("rejects attachment tampering even when the receipt itself is unchanged", async () => {
    const fixture = await createReadinessFixture();
    const observationPath = join(
      fixture.evidenceDirectory,
      ELECTRON_TRANSITION,
      WINDOWS,
      "target-terminal-record.json"
    );
    await writeFile(observationPath, "tampered-target-terminal-record\n");
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("target-terminal-record.json SHA-256 does not match");
  });
  it("rejects a forged product terminal receipt after every enclosing digest is recomputed", async () => {
    const fixture = await createReadinessFixture();
    const transition = TAURI_TRANSITION;
    const platform = DARWIN;
    const evidenceRoot = join(fixture.evidenceDirectory, transition, platform);
    const productPath = join(evidenceRoot, "product-terminal-receipt.json");
    const targetRecordPath = join(evidenceRoot, "target-terminal-record.json");
    const receiptPath = join(evidenceRoot, "terminal-receipt.json");
    const product = JSON.parse(await readFile(productPath, "utf8"));
    product.sourcePhase = "preparing";
    await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
    const productSha256 = sha256(await readFile(productPath));
    const targetRecord = JSON.parse(await readFile(targetRecordPath, "utf8"));
    targetRecord.productTerminalReceiptSha256 = productSha256;
    await writeFile(targetRecordPath, `${JSON.stringify(targetRecord, null, 2)}\n`);
    const targetRecordSha256 = sha256(await readFile(targetRecordPath));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.attachments["product-terminal-receipt.json"] = productSha256;
    receipt.attachments["target-terminal-record.json"] = targetRecordSha256;
    receipt.transaction.productTerminalReceiptSha256 = productSha256;
    receipt.transaction.targetTerminalRecordSha256 = targetRecordSha256;
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    fixture.input.evidenceReceiptSha256[transition][platform] =
      sha256(await readFile(receiptPath));
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("product terminal receipt source phase does not match");
  });
  it("rejects a semantic endpoint lie even when all enclosing hashes are recomputed", async () => {
    const fixture = await createReadinessFixture();
    await rewriteEndpointObservation(fixture.input, ELECTRON_TRANSITION, WINDOWS,
      (observation) => { observation.endpoint.status = 204; });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("endpoint observation result status does not match");
  });
  it("rejects an unordered Tauri v22 redirect chain after coherent hash updates", async () => {
    const fixture = await createReadinessFixture();
    await rewriteEndpointObservation(fixture.input, TAURI_TRANSITION, WINDOWS, (observation) => {
      observation.endpoint.redirects[1].fromUrlSha256 = sha256(TAURI_FETCH_ENDPOINT);
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("endpoint redirect 2 source URL SHA-256 does not match");
  });
  it("rejects a Tauri v22 first hop that targets the source tag instead of the target tag", async () => {
    const fixture = await createReadinessFixture();
    await rewriteEndpointObservation(fixture.input, TAURI_TRANSITION, DARWIN, (observation) => {
      observation.endpoint.redirects[0].locationUrlSha256 = sha256(
        `https://github.com/rion-tw/rion-studio/releases/download/${TAURI_RELEASE_TAG}/latest.json`
      );
      observation.endpoint.redirects[1].fromUrlSha256 =
        observation.endpoint.redirects[0].locationUrlSha256;
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("endpoint redirect 1 exact target release URL SHA-256 does not match");
  });
  it("rejects a zero-hop Tauri v22 source-fetch claim", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, WINDOWS, (receipt) => {
      receipt.transaction.endpointRedirectCount = 0;
      receipt.transaction.sourceFetchFinalUrlSha256 = sha256(TAURI_FETCH_ENDPOINT);
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("Tauri v22 updater endpoint must follow between 1 and 3 redirects");
  });
  it("rejects a Tauri v22 redirect that breaks the GitHub-to-release-assets host order", async () => {
    const fixture = await createReadinessFixture();
    await rewriteEndpointObservation(fixture.input, TAURI_TRANSITION, WINDOWS, (observation) => {
      observation.endpoint.redirects[1].toHost = "github.com";
      observation.endpoint.final.host = "github.com";
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("endpoint redirect 2 target host does not match");
  });
  it("rejects any redirect from a prior Electron v23 direct endpoint", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, ELECTRON_TRANSITION, DARWIN, (receipt) => {
      receipt.transaction.endpointRedirectCount = 1;
      receipt.transaction.sourceFetchFinalUrlSha256 = sha256(TAURI_FINAL_ENDPOINT);
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("observed updater endpoint redirects does not match");
  });
  it("binds the prior Electron running image to its rebuilt candidate executable", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, ELECTRON_TRANSITION, WINDOWS, (receipt) => {
      receipt.source.runningImageSha256 = sha256("different-prior-running-image");
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("source v23 running image canonical executable SHA-256 does not match");
  });
  it("binds the target running image to its rebuilt candidate executable", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, DARWIN, (receipt) => {
      receipt.transaction.targetRunningImageSha256 = sha256("different-target-running-image");
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("target running image canonical executable SHA-256 does not match");
  });
  it("rejects a reordered source event stream after coherent hash updates", async () => {
    const fixture = await createReadinessFixture();
    const transition = TAURI_TRANSITION;
    const platform = DARWIN;
    const evidenceRoot = join(fixture.evidenceDirectory, transition, platform);
    const streamPath = join(evidenceRoot, "source-event-stream.jsonl");
    const receiptPath = join(evidenceRoot, "terminal-receipt.json");
    const events = (await readFile(streamPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    [events[0].event, events[1].event] = [events[1].event, events[0].event];
    await writeFile(streamPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const streamSha256 = sha256(await readFile(streamPath));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.attachments["source-event-stream.jsonl"] = streamSha256;
    receipt.transaction.sourceEventStreamSha256 = streamSha256;
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    fixture.input.evidenceReceiptSha256[transition][platform] =
      sha256(await readFile(receiptPath));
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("source event 1 event does not match");
  });
  it("rejects an output parent symlink that aliases terminal evidence", async () => {
    const fixture = await createReadinessFixture();
    const alias = join(dirname(fixture.evidenceDirectory), "evidence-output-alias");
    await symlink(fixture.evidenceDirectory, alias);
    fixture.input.outputPath = join(alias, "escaped-readiness-receipt.json");
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("parent directory must be a real directory");
  });
  it("requires the stable source tag and version to describe one release", async () => {
    const fixture = await createReadinessFixture();
    fixture.input.tauriReleaseTag = "v8.4.3";
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("release tag must exactly match its semantic version");
  });
  it("requires the Electron target app version to be newer than the Tauri source", async () => {
    const tauri = await createReadinessFixture();
    tauri.input.tauriVersion = VERSION;
    tauri.input.tauriReleaseTag = `v${VERSION}`;
    await expect(verifyReadiness(tauri.input)).rejects.toThrow(
      `Target version ${VERSION} must be strictly newer than source version ${VERSION}.`);
  });
  it("cross-binds the provisional receipt to the target manifest", async () => {
    const fixture = await createReadinessFixture();
    const receiptPath = fixture.input.provisionalPublicationReceiptPath;
    const provisional = JSON.parse(await readFile(
      receiptPath,
      "utf8"
    ));
    provisional.target.manifestSha256 = sha256("foreign-provisional-manifest");
    await writeFile(receiptPath, serializeCanonicalJson(provisional));
    fixture.input.provisionalPublicationReceiptSha256 = sha256(
      await readFile(receiptPath)
    );
    await expect(verifyReadiness(fixture.input)).rejects.toThrow(
      "provisional target manifest SHA-256 does not match");
  });
  it("requires all four terminal receipts to share exact challenge timestamps", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, WINDOWS, (receipt) => {
      receipt.challenge.issuedAt = "2026-09-01T00:00:01Z";
    });
    await expect(verifyReadiness(fixture.input)).rejects.toThrow(
      "shared evidence challenge issued-at does not match");
  });
  it("rejects impossible calendar timestamps in terminal evidence", async () => {
    const fixture = await createReadinessFixture();
    await rewriteTerminalReceipt(fixture.input, TAURI_TRANSITION, DARWIN, (receipt) => {
      receipt.challenge.issuedAt = "2026-02-30T00:00:00Z";
    });
    await expect(
      verifyReadiness(fixture.input)
    ).rejects.toThrow("evidence challenge issued-at is not a valid timestamp");
  });
  it("keeps candidate source identity separate from trusted run control identity", async () => {
    const controlFixture = await createReadinessFixture();
    controlFixture.input.provenance.candidateRunControlSha = SOURCE_SHA;
    await expect(verifyReadiness(controlFixture.input)).rejects.toThrow(
      "trusted-control control-plane SHA does not match"
    );
    const inventoryFixture = await createReadinessFixture();
    await writeFile(
      join(dirname(inventoryFixture.input.candidateTrustedControlReceiptPath), "foreign.json"),
      "{}\n"
    );
    await expect(verifyReadiness(inventoryFixture.input)).rejects.toThrow(
      "trusted-control artifact inventory must contain only"
    );
  });
  it.each([
    ["repository", "foreign/repository", "trusted-control repository is not the fixed"],
    ["ref", "refs/heads/candidate", "trusted control-plane ref does not match"]
  ])("rejects a trusted-control %s tamper", async (field, value, message) => {
    const fixture = await createReadinessFixture();
    const receiptPath = fixture.input.candidateTrustedControlReceiptPath;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.controlPlane[field] = value;
    await writeFile(receiptPath, serializeCanonicalJson(receipt));
    await expect(verifyReadiness(fixture.input)).rejects.toThrow(message);
  });
  it("rejects unknown CLI options before evidence verification", async () => {
    await expect(
      runElectronProductionPromotionReadinessCli(["verify", "--unexpected", "value"], {})
    ).rejects.toThrow("Unknown promotion-readiness option --unexpected");
  });
  it("orders arbitrarily large numeric SemVer prerelease identifiers exactly", async () => {
    const targetVersion = "8.6.0-9007199254740993";
    const fixture = await createReadinessFixture({
      priorElectronVersion: "8.6.0-9007199254740992",
      targetVersion
    });
    const receipt = await verifyReadiness(fixture.input);
    expect(receipt.candidate.version).toBe(targetVersion);
  });
});
async function createReadinessFixture(options: {
  priorElectronVersion?: string;
  targetVersion?: string;
} = {}) {
  const priorElectronVersion = options.priorElectronVersion ?? PRIOR_ELECTRON_VERSION;
  const targetVersion = options.targetVersion ?? VERSION;
  const root = await temporaryDirectory();
  const candidate = await createCandidate(join(root, "target"), targetVersion, SOURCE_SHA);
  const priorCandidate = await createCandidate(
    join(root, "prior"),
    priorElectronVersion,
    PRIOR_ELECTRON_SOURCE_SHA
  );
  const candidateTrustedControlReceiptPath = await writeTrustedControlReceipt({
    controlPlaneSha: CANDIDATE_CONTROL_SHA,
    directory: join(root, "candidate-trusted-control"),
    runId: "101",
    sourceSha: SOURCE_SHA,
    version: targetVersion
  });
  const priorCandidateTrustedControlReceiptPath = await writeTrustedControlReceipt({
    controlPlaneSha: PRIOR_CANDIDATE_CONTROL_SHA,
    directory: join(root, "prior-candidate-trusted-control"),
    runId: "100",
    sourceSha: PRIOR_ELECTRON_SOURCE_SHA,
    version: priorElectronVersion
  });
  const evidenceDirectory = join(root, "terminal-evidence");
  const candidateReceiptSource = await readFile(candidate.receiptPath);
  const candidateReceiptSha256 = sha256(candidateReceiptSource);
  const candidateReceipt = JSON.parse(candidateReceiptSource.toString("utf8"));
  const priorCandidateReceiptSource = await readFile(priorCandidate.receiptPath);
  const priorCandidateReceiptSha256 = sha256(priorCandidateReceiptSource);
  const priorCandidateReceipt = JSON.parse(priorCandidateReceiptSource.toString("utf8"));
  const tauriLineageReceiptPath = {} as Record<
    typeof DARWIN | typeof WINDOWS, string
  >;
  const tauriLineageReceiptSha256 = {} as Record<
    typeof DARWIN | typeof WINDOWS, string
  >;
  for (const platform of [DARWIN, WINDOWS] as const) {
    const receiptPath = await writeTauriLineageReceipt(root, platform, candidateReceipt);
    tauriLineageReceiptPath[platform] = receiptPath;
    tauriLineageReceiptSha256[platform] = sha256(await readFile(receiptPath));
  }
  const publicationIntent = createElectronProductionPublicationIntent({
    transactionId: "40000000-0000-4000-8000-000000000004",
    recordedAt: "2026-09-01T00:00:00Z",
    lease: { id: "50000000-0000-4000-8000-000000000005", generation: 1 },
    baseline: {
      runtime: "tauri-v22", version: TAURI_VERSION, releaseTag: TAURI_RELEASE_TAG,
      sourceSha: TAURI_SOURCE_SHA, manifestSha256: sha256("tauri-v22-published-manifest"),
      stateSha256: sha256("tauri-v22-public-latest-state")
    },
    target: {
      runtime: "electron-v23", version: targetVersion,
      releaseTag: `v${targetVersion}`, sourceSha: SOURCE_SHA, candidateReceiptSha256,
      manifestSha256: candidateReceipt.assets["latest.json"],
      stateSha256: sha256("electron-v23-provisional-public-latest-state")
    }
  });
  const publicationReceipt = transitionElectronProductionPublication(publicationIntent, {
    kind: "publication-result", acknowledgement: "confirmed", observedState: "target",
    observedStateSha256: publicationIntent.target.stateSha256,
    lease: {
      ...publicationIntent.lease, status: "held",
      foreignLeaseId: null, foreignLeaseGeneration: null
    },
    recordedAt: "2026-09-01T00:01:00Z"
  });
  const publicationDirectory = join(root, "provisional-publication");
  await mkdir(publicationDirectory);
  const provisionalPublicationReceiptPath = join(
    publicationDirectory,
    ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES.provisional
  );
  const writtenPublication = await writeElectronProductionPublicationReceipt({
    outputPath: provisionalPublicationReceiptPath,
    receipt: publicationReceipt
  });
  const provisionalPublicationReceiptSha256 = writtenPublication.receiptIdentity.sha256;
  const evidenceReceiptSha256 = {
    [TAURI_TRANSITION]: {
      [DARWIN]: "",
      [WINDOWS]: ""
    },
    [ELECTRON_TRANSITION]: {
      [DARWIN]: "",
      [WINDOWS]: ""
    }
  };
  let evidenceAttemptSequence = 2;
  let electronInstallAttemptSequence = 2;
  for (const transition of [
    TAURI_TRANSITION,
    ELECTRON_TRANSITION
  ] as const) {
    for (const platform of [DARWIN, WINDOWS] as const) {
      const receiptPath = await writeTerminalEvidence({
        evidenceAttemptId:
          `20000000-0000-4000-8000-${String(evidenceAttemptSequence).padStart(12, "0")}`,
        candidateReceipt,
        candidateReceiptSha256,
        directory: join(evidenceDirectory, transition, platform),
        platform,
        priorCandidateReceipt,
        priorCandidateReceiptSha256,
        priorElectronVersion,
        sourceInstallAttemptId: transition === TAURI_TRANSITION
          ? "update-install-1"
          : `update-install-10000000-0000-4000-8000-${String(
            electronInstallAttemptSequence
          ).padStart(12, "0")}`,
        targetVersion,
        transition
      });
      evidenceReceiptSha256[transition][platform] = sha256(await readFile(receiptPath));
      evidenceAttemptSequence += 1;
      if (transition === ELECTRON_TRANSITION) {
        electronInstallAttemptSequence += 1;
      }
    }
  }
  const outputPath = join(root, "readiness-receipt.json");
  return {
    candidateReceiptSha256,
    evidenceDirectory,
    provisionalPublicationReceiptSha256,
    input: {
      candidateDirectory: candidate.candidateDirectory,
      candidateReceiptPath: candidate.receiptPath,
      candidateReceiptSha256,
      candidateTrustedControlReceiptPath,
      challengeId: CHALLENGE_ID,
      challengeNonceSha256: CHALLENGE_SHA256,
      evidenceDirectory,
      evidenceReceiptSha256,
      macDirectory: candidate.macCandidate,
      now: new Date("2026-09-01T01:00:00Z"),
      outputPath,
      ownerApproval: ELECTRON_PRODUCTION_PROMOTION_READINESS_APPROVAL,
      provenance: {
        candidateRunControlSha: CANDIDATE_CONTROL_SHA,
        candidateRunAttempt: 1,
        candidateRunId: "101",
        evidenceRunControlSha: EVIDENCE_CONTROL_SHA,
        evidenceRunAttempt: 1,
        evidenceRunId: "202",
        priorCandidateRunControlSha: PRIOR_CANDIDATE_CONTROL_SHA,
        priorCandidateRunAttempt: 1,
        priorCandidateRunId: "100",
        provisionalPublicationRunControlSha: PROVISIONAL_PUBLICATION_CONTROL_SHA,
        provisionalPublicationRunAttempt: PROVISIONAL_PUBLICATION_RUN_ATTEMPT,
        provisionalPublicationRunId: PROVISIONAL_PUBLICATION_RUN_ID,
        readinessControlSha: READINESS_CONTROL_SHA,
        repository: "rion-tw/rion-studio-source" as const,
        tauriLineageRunControlSha: TAURI_LINEAGE_CONTROL_SHA,
        tauriLineageRunAttempt: TAURI_LINEAGE_RUN_ATTEMPT,
        tauriLineageRunId: TAURI_LINEAGE_RUN_ID
      },
      priorCandidateDirectory: priorCandidate.candidateDirectory,
      priorCandidateReceiptPath: priorCandidate.receiptPath,
      priorCandidateReceiptSha256,
      priorCandidateTrustedControlReceiptPath,
      provisionalPublicationReceiptPath,
      provisionalPublicationReceiptSha256,
      priorElectronSourceSha: PRIOR_ELECTRON_SOURCE_SHA,
      priorElectronVersion,
      priorMacDirectory: priorCandidate.macCandidate,
      priorWindowsDirectory: priorCandidate.windowsCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      tauriReleaseTag: TAURI_RELEASE_TAG,
      tauriLineageReceiptPath,
      tauriLineageReceiptSha256,
      tauriSourceSha: TAURI_SOURCE_SHA,
      tauriVersion: TAURI_VERSION,
      version: targetVersion,
      windowsDirectory: candidate.windowsCandidate
    }
  };
}
async function writeTrustedControlReceipt(input: {
  controlPlaneSha: string;
  directory: string;
  runId: string;
  sourceSha: string;
  version: string;
}) {
  await mkdir(input.directory);
  const outputPath = join(
    input.directory,
    "electron-production-candidate-trusted-control-receipt.json"
  );
  await writeFile(outputPath, serializeCanonicalJson({
    schemaVersion: 1,
    kind: "rion-electron-production-candidate-trusted-control",
    candidate: {
      publishedAt: PUBLISHED_AT,
      sourceSha: input.sourceSha,
      updaterBaseUrl: `${UPDATER_BASE_URL}/`,
      updaterEndpoint: `${UPDATER_BASE_URL}/latest.json`,
      version: input.version
    },
    controlPlane: {
      ref: "refs/heads/main",
      repository: "rion-tw/rion-studio-source",
      sha: input.controlPlaneSha,
      workflow: ".github/workflows/electron-production-candidate.yml"
    },
    ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    producer: { event: "workflow_dispatch", runAttempt: 1, runId: input.runId },
    updaterTrust: {
      publicKey: PUBLIC_KEY,
      publicKeySha256: sha256(Buffer.from(PUBLIC_KEY, "base64"))
    }
  }));
  return outputPath;
}
async function createCandidate(root: string, version: string, sourceSha: string) {
  const macSource = join(root, "mac-source");
  const windowsSource = join(root, "windows-source");
  const macCandidate = join(root, "mac-candidate");
  const windowsCandidate = join(root, "windows-candidate");
  const candidateDirectory = join(root, "candidate");
  const receiptPath = join(root, "electron-production-candidate-receipt.json");
  await mkdir(root, { recursive: true });
  await Promise.all([mkdir(macSource), mkdir(windowsSource)]);
  const macArtifact = join(macSource, "Rion.Studio-mac.app.tar.gz");
  const windowsArtifact = join(windowsSource, "Rion.Studio-win.exe");
  const macDmg = join(macSource, "Rion.Studio-mac.dmg");
  const [macBlackBox, windowsBlackBox] = await Promise.all([
    writeBlackBoxFixture(root, DARWIN, version),
    writeBlackBoxFixture(root, WINDOWS, version)
  ]);
  await Promise.all([
    writeFile(macArtifact, "test"),
    writeFile(`${macArtifact}.sig`, SIGNATURE),
    writeFile(macDmg, "mac-dmg"),
    writeFile(windowsArtifact, "test"),
    writeFile(`${windowsArtifact}.sig`, SIGNATURE)
  ]);
  const windowsInstallerPayloadProofPath = await writeWindowsInstallerPayloadProofFixture({
    applicationPath: windowsBlackBox.applicationPath,
    installerPath: windowsArtifact,
    outputDirectory: windowsSource,
    sourceSha,
    version
  });
  const macosPackageBinding = createMacosPackageBindingEvidence({
    artifact: {
      bytes: Buffer.byteLength("test"),
      fileName: "Rion.Studio-mac.app.tar.gz",
      sha256: sha256("test")
    },
    distribution: {
      bytes: Buffer.byteLength("mac-dmg"),
      fileName: "Rion.Studio-mac.dmg",
      sha256: sha256("mac-dmg")
    },
    packageManifest: summarizePackagedElectronPackageManifest(
      await capturePackagedElectronPackageManifest(macBlackBox.applicationPath)
    )
  });
  const input = {
    ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    publicKey: PUBLIC_KEY,
    publishedAt: PUBLISHED_AT,
    sourceSha,
    updaterBaseUrl: UPDATER_BASE_URL,
    version
  };
  await Promise.all([
    stageElectronProductionPlatformCandidate({
      ...input,
      applicationPath: macBlackBox.applicationPath,
      artifactPath: macArtifact,
      blackBoxReportPath: macBlackBox.reportPath,
      distributionPath: macDmg,
      macosPackageBinding,
      outputDirectory: macCandidate,
      platform: DARWIN
    }),
    stageElectronProductionPlatformCandidate({
      ...input,
      applicationPath: windowsBlackBox.applicationPath,
      artifactPath: windowsArtifact,
      blackBoxReportPath: windowsBlackBox.reportPath,
      outputDirectory: windowsCandidate,
      platform: WINDOWS,
      windowsInstallerPayloadProofPath
    })
  ]);
  await assembleElectronProductionCandidate({
    ...input,
    macDirectory: macCandidate,
    outputDirectory: candidateDirectory,
    receiptPath,
    windowsDirectory: windowsCandidate
  });
  return { candidateDirectory, macCandidate, receiptPath, windowsCandidate };
}
async function writeTauriLineageReceipt(
  root: string,
  platform: typeof DARWIN | typeof WINDOWS,
  candidateReceipt: CandidateReceiptFixture
) {
  const isMac = platform === DARWIN;
  const sequence = isMac ? 1 : 2;
  const artifactName = isMac ? "Rion.Studio-mac.app.tar.gz" : "Rion.Studio-win.exe";
  const signatureName = `${artifactName}.sig`;
  const artifactSha256 = sha256(`${platform}:tauri-artifact`);
  const producedAt = `2026-08-31T10:0${sequence + 4}:00Z`;
  const receipt = {
    schemaVersion: 1,
    kind: "rion-tauri-v22-public-source-lineage",
    status: "verified-public-source-lineage",
    cutoverEligible: false,
    runtime: "tauri-v22",
    platform,
    release: {
      repository: "rion-tw/rion-studio",
      id: "9001",
      tag: TAURI_RELEASE_TAG,
      version: TAURI_VERSION,
      draft: false,
      prerelease: false,
      wasLatestAtCapture: true,
      publishedAt: "2026-08-31T09:00:00Z",
      observedAt: `2026-08-31T10:0${sequence}:00Z`
    },
    sourceTag: {
      repository: "rion-tw/rion-studio-source",
      releaseTag: TAURI_RELEASE_TAG,
      refObjectType: "tag",
      refObjectSha: "9".repeat(40),
      peeledCommitSha: TAURI_SOURCE_SHA,
      observedAt: `2026-08-31T10:0${sequence + 2}:00Z`
    },
    targetSourceSha: SOURCE_SHA,
    trust: { updaterPublicKeySha256: candidateReceipt.publicKeySha256 },
    verifiedInputReceipt: {
      fileName: "verified-input-receipt.json",
      sha256: sha256(`${platform}:verified-input-receipt`)
    },
    assets: {
      artifact: {
        id: isMac ? "101" : "103",
        name: artifactName,
        bytes: isMac ? 31 : 41,
        sha256: artifactSha256
      },
      signature: {
        id: isMac ? "102" : "104",
        name: signatureName,
        bytes: isMac ? 32 : 42,
        sha256: sha256(`${platform}:tauri-signature`)
      },
      manifest: {
        id: "105",
        name: "latest.json",
        bytes: 501,
        sha256: sha256("tauri-v22-published-manifest")
      },
      checksums: {
        id: "106",
        name: "SHA256SUMS.txt",
        bytes: 601,
        sha256: sha256("tauri-v22-published-checksums")
      }
    },
    runningExecutable: {
      derivation: isMac
        ? "macos-exact-archive-member"
        : "windows-isolated-current-user-nsis-install",
      relativePath: isMac ? "Rion Studio.app/Contents/MacOS/rion-tauri" : "rion-tauri.exe",
      fileName: isMac ? "rion-tauri" : "rion-tauri.exe",
      bytes: isMac ? 701 : 702,
      sha256: sha256(`${platform}:tauri-running-image`),
      derivedFromArtifactSha256: artifactSha256
    },
    producer: {
      artifactName:
        `tauri-v22-public-lineage-${platform}-${TAURI_LINEAGE_RUN_ID}-${TAURI_LINEAGE_RUN_ATTEMPT}`,
      event: "workflow_dispatch",
      headSha: SOURCE_SHA,
      producedAt,
      repository: "rion-tw/rion-studio-source",
      runAttempt: TAURI_LINEAGE_RUN_ATTEMPT,
      runId: TAURI_LINEAGE_RUN_ID,
      workflow: TAURI_V22_COMPATIBILITY_WORKFLOW
    },
    verifiedAt: producedAt
  };
  const directory = join(root, `tauri-lineage-${platform}`);
  const receiptPath = join(directory, "tauri-v22-public-lineage-receipt.json");
  await mkdir(directory);
  await writeFile(receiptPath, serializeCanonicalJson(receipt));
  return receiptPath;
}
async function writeTerminalEvidence(input: {
  evidenceAttemptId: string;
  candidateReceipt: CandidateReceiptFixture;
  candidateReceiptSha256: string;
  directory: string;
  platform: typeof DARWIN | typeof WINDOWS;
  priorCandidateReceipt: CandidateReceiptFixture;
  priorCandidateReceiptSha256: string;
  priorElectronVersion: string;
  sourceInstallAttemptId: string;
  targetVersion: string;
  transition: typeof TAURI_TRANSITION | typeof ELECTRON_TRANSITION;
}) {
  await mkdir(input.directory, { recursive: true });
  const attachments: Record<string, string> = {};
  const targetArtifact = input.candidateReceipt.platforms[input.platform].artifact;
  const isTauri = input.transition === TAURI_TRANSITION;
  const challenge = {
    expiresAt: "2026-09-01T12:00:00Z",
    id: CHALLENGE_ID,
    issuedAt: "2026-09-01T00:00:00Z",
    nonceSha256: CHALLENGE_SHA256
  };
  const attachmentContext = {
    schemaVersion: 1,
    challenge,
    evidenceAttemptId: input.evidenceAttemptId,
    platform: input.platform,
    sourceInstallAttemptId: input.sourceInstallAttemptId,
    transitionKind: input.transition
  };
  const sourceSnapshot = isTauri ? {
    artifactName: input.platform === DARWIN
      ? "Rion.Studio-mac.app.tar.gz"
      : "Rion.Studio-win.exe",
    artifactSha256: sha256(`${input.platform}:tauri-artifact`),
    lineageKind: "published-release",
    manifestName: "latest.json",
    manifestSha256: sha256("tauri-v22-published-manifest"),
    defaultUpdaterEndpoint: TAURI_FETCH_ENDPOINT,
    releaseTag: TAURI_RELEASE_TAG,
    runningImageSha256: sha256(`${input.platform}:tauri-running-image`),
    runtime: "tauri-v22",
    sourceSha: TAURI_SOURCE_SHA,
    version: TAURI_VERSION
  } : {
    artifactName: input.priorCandidateReceipt.platforms[input.platform].artifact.fileName,
    artifactSha256: input.priorCandidateReceipt.platforms[input.platform].artifact.sha256,
    candidateReceiptSha256: input.priorCandidateReceiptSha256,
    embeddedUpdaterEndpoint: input.priorCandidateReceipt.updaterEndpoint,
    lineageKind: "production-candidate",
    manifestName: "latest.json",
    manifestSha256: input.priorCandidateReceipt.assets["latest.json"],
    runningImageSha256:
      input.priorCandidateReceipt.platforms[input.platform].blackBox.executable.sha256,
    runtime: "electron-v23",
    sourceSha: PRIOR_ELECTRON_SOURCE_SHA,
    version: input.priorElectronVersion
  };
  attachments["source-release-snapshot.json"] = await writeJsonAttachment(
    input.directory,
    "source-release-snapshot.json",
    {
      ...attachmentContext,
      kind: "rion-production-updater-source-release-snapshot",
      capturedAt: "2026-09-01T00:05:00Z",
      source: sourceSnapshot
    }
  );
  const source = {
    ...sourceSnapshot,
    releaseSnapshotSha256: attachments["source-release-snapshot.json"]
  };
  const target = {
    artifactName: targetArtifact.fileName,
    artifactSha256: targetArtifact.sha256,
    candidateReceiptSha256: input.candidateReceiptSha256,
    manifestName: "latest.json",
    servedManifestSha256: input.candidateReceipt.assets["latest.json"],
    signatureName: targetArtifact.signatureFileName,
    signatureSha256: targetArtifact.signatureSha256,
    sourceSha: SOURCE_SHA,
    embeddedUpdaterEndpoint: input.candidateReceipt.updaterEndpoint,
    version: input.targetVersion,
    runtime: "electron-v23"
  };
  const trust = {
    updaterPublicKeySha256: input.candidateReceipt.publicKeySha256
  };
  const preservation = {
    afterChallengeSha256: CHALLENGE_SHA256,
    beforeChallengeSha256: CHALLENGE_SHA256,
    preserved: true,
    userDataIdentitySha256: sha256(`${input.platform}:user-data-identity`)
  };
  const nativeRuntime = {
    nativeHostKind: input.platform === DARWIN
      ? "appkit-chromium"
      : "bundled-chromium",
    remoteDebugging: false,
    retainedAppKitHost: input.platform === DARWIN,
    targetVersionObserved: input.targetVersion
  };
  const targetRunningImageSha256 =
    input.candidateReceipt.platforms[input.platform].blackBox.executable.sha256;
  const terminalAuthority = "target-first-boot-journal-reconciliation";
  const sourceHandoffJournalPhase = input.platform === DARWIN
    ? "restartPending"
    : "installerHandoff";
  const sourceFetchEndpoint = isTauri
    ? TAURI_FETCH_ENDPOINT
    : input.priorCandidateReceipt.updaterEndpoint;
  const targetTaggedEndpoint =
    `https://github.com/rion-tw/rion-studio/releases/download/v${input.targetVersion}/latest.json`;
  const redirectSources = [
    { from: TAURI_FETCH_ENDPOINT, status: 302, to: targetTaggedEndpoint },
    { from: targetTaggedEndpoint, status: 302, to: TAURI_FINAL_ENDPOINT }
  ] as const;
  const endpointRedirects = isTauri ? redirectSources.map((redirect, index) => {
    const from = new URL(redirect.from);
    const to = new URL(redirect.to);
    return {
      sequence: index + 1,
      status: redirect.status,
      fromScheme: from.protocol,
      fromHost: from.hostname,
      fromUrlSha256: sha256(redirect.from),
      toScheme: to.protocol,
      toHost: to.hostname,
      locationUrlSha256: sha256(redirect.to)
    };
  }) : [];
  const sourceFetchFinalUrl = isTauri ? TAURI_FINAL_ENDPOINT : sourceFetchEndpoint;
  const sourceFetchFinalUrlSha256 = sha256(sourceFetchFinalUrl);
  const sourceFetchFinal = new URL(sourceFetchFinalUrl);
  const sourceInstallJournal = {
    schemaVersion: 1,
    attempt: {
      attemptId: input.sourceInstallAttemptId,
      targetVersion: input.targetVersion,
      phase: sourceHandoffJournalPhase,
      startedAt: SOURCE_EVENTS[3][2],
      updatedAt: SOURCE_EVENTS[6][2]
    }
  };
  attachments["source-install-journal.json"] = await writeJsonAttachment(
    input.directory,
    "source-install-journal.json",
    sourceInstallJournal
  );
  const sourceInstallJournalBytes = (await readFile(
    join(input.directory, "source-install-journal.json")
  )).length;
  const productTerminalReceipt = {
    schemaVersion: 1,
    kind: "rion-updater-install-terminal",
    authority: terminalAuthority,
    sourceJournalBytes: sourceInstallJournalBytes,
    sourceJournalSha256: attachments["source-install-journal.json"],
    sourcePhase: sourceHandoffJournalPhase,
    runningVersion: input.targetVersion,
    terminalOutcome: "applied",
    reconciledAt: SOURCE_EVENTS[8][2],
    attempt: {
      attemptId: input.sourceInstallAttemptId,
      targetVersion: input.targetVersion,
      phase: "applied",
      startedAt: SOURCE_EVENTS[3][2],
      updatedAt: SOURCE_EVENTS[8][2]
    }
  };
  attachments["product-terminal-receipt.json"] = await writeJsonAttachment(
    input.directory,
    "product-terminal-receipt.json",
    productTerminalReceipt
  );
  const sourceEvents = SOURCE_EVENTS.map(([event, phase, observedAt], index) => ({
    ...attachmentContext,
    kind: "rion-production-updater-source-event",
    event,
    observedAt,
    phase: phase ?? sourceHandoffJournalPhase,
    sequence: index + 1,
    source,
    target
  }));
  attachments["source-event-stream.jsonl"] = await writeJsonLinesAttachment(
    input.directory,
    "source-event-stream.jsonl",
    sourceEvents
  );
  attachments["endpoint-observation.json"] = await writeJsonAttachment(
    input.directory,
    "endpoint-observation.json",
    {
      ...attachmentContext,
      kind: "rion-production-updater-endpoint-observation",
      endpoint: {
        artifactName: target.artifactName,
        artifactSha256: target.artifactSha256,
        final: {
          host: sourceFetchFinal.hostname,
          scheme: sourceFetchFinal.protocol,
          status: 200,
          urlSha256: sourceFetchFinalUrlSha256
        },
        manifestName: target.manifestName,
        redirectCount: endpointRedirects.length,
        redirects: endpointRedirects,
        servedManifestSha256: target.servedManifestSha256,
        signatureName: target.signatureName,
        signatureSha256: target.signatureSha256,
        status: 200,
        requestEndpoint: sourceFetchEndpoint,
        targetEmbeddedUpdaterEndpoint: target.embeddedUpdaterEndpoint,
        updaterPublicKeySha256: trust.updaterPublicKeySha256
      },
      observedAt: SOURCE_EVENTS[1][2]
    }
  );
  attachments["data-preservation-observation.json"] = await writeJsonAttachment(
    input.directory,
    "data-preservation-observation.json",
    {
      ...attachmentContext,
      kind: "rion-production-updater-data-preservation-observation",
      observedAt: SOURCE_EVENTS[8][2],
      preservation,
      target
    }
  );
  attachments["native-host-observation.json"] = await writeJsonAttachment(
    input.directory,
    "native-host-observation.json",
    {
      ...attachmentContext,
      capturedAt: SOURCE_EVENTS[8][2],
      kind: "rion-production-updater-native-host-observation",
      observedAt: SOURCE_EVENTS[7][2],
      runtime: nativeRuntime,
      target,
      targetRunningImageSha256
    }
  );
  attachments["target-terminal-record.json"] = await writeJsonAttachment(
    input.directory,
    "target-terminal-record.json",
    {
      ...attachmentContext,
      kind: "rion-production-updater-target-terminal-record",
      deadlineUsedAsSuccess: false,
      firstBoot: true,
      journal: {
        attemptId: input.sourceInstallAttemptId,
        phase: "applied",
        reconciled: true,
        reconciledAt: productTerminalReceipt.reconciledAt,
        targetVersion: input.targetVersion
      },
      productTerminalReceiptSha256: attachments["product-terminal-receipt.json"],
      recordedAt: SOURCE_EVENTS[8][2],
      target,
      targetRunningImageSha256,
      terminalAuthority,
      terminalOutcome: "applied"
    }
  );
  const receipt = {
    schemaVersion: 1,
    evidenceKind: "rion-production-updater-terminal-transaction",
    cutoverEligible: true,
    platform: input.platform,
    transitionKind: input.transition,
    challenge,
    source,
    target,
    trust,
    transaction: {
      dataPreservationObservationSha256: attachments["data-preservation-observation.json"],
      deadlineUsedAsSuccess: false,
      endpointObservationSha256: attachments["endpoint-observation.json"],
      endpointRedirectCount: endpointRedirects.length,
      endpointStatus: 200,
      evidenceAttemptId: input.evidenceAttemptId,
      nativeHostObservationSha256: attachments["native-host-observation.json"],
      preservedChallengeSha256: CHALLENGE_SHA256,
      productTerminalReceiptSha256: attachments["product-terminal-receipt.json"],
      sourceEventStreamSha256: attachments["source-event-stream.jsonl"],
      sourceHandoffJournalPhase,
      sourceHandoffStatus: "restart_pending",
      sourceInstallAttemptId: input.sourceInstallAttemptId,
      sourceInstallJournalSha256: attachments["source-install-journal.json"],
      sourceFetchEndpoint,
      sourceFetchFinalUrlSha256,
      sourceFetchMode: "embedded-default",
      sourceUpdaterInvoked: true,
      targetRunningImageSha256,
      targetTerminalRecordSha256: attachments["target-terminal-record.json"],
      terminalAuthority,
      terminalOutcome: "applied"
    },
    preservation,
    nativeRuntime,
    producer: {
      artifactName: `electron-production-updater-terminal-evidence-${input.targetVersion}-${SOURCE_SHA}-attempt-1`,
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "202",
      sourceSha: SOURCE_SHA,
      workflow: ELECTRON_PRODUCTION_EVIDENCE_WORKFLOW
    },
    attachments,
    completedAt: "2026-09-01T00:30:00Z"
  };
  const receiptPath = join(input.directory, "terminal-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}
async function rewriteEvidenceAttemptId(directory: string, evidenceAttemptId: string) {
  const attachmentBindings: Record<AttachmentName, string | undefined> = {
    "source-release-snapshot.json": undefined,
    "data-preservation-observation.json": "dataPreservationObservationSha256",
    "endpoint-observation.json": "endpointObservationSha256",
    "native-host-observation.json": "nativeHostObservationSha256",
    "product-terminal-receipt.json": "productTerminalReceiptSha256",
    "source-event-stream.jsonl": "sourceEventStreamSha256",
    "source-install-journal.json": "sourceInstallJournalSha256",
    "target-terminal-record.json": "targetTerminalRecordSha256"
  };
  const receiptPath = join(directory, "terminal-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.transaction.evidenceAttemptId = evidenceAttemptId;
  for (const [name, transactionField] of Object.entries(attachmentBindings) as Array<
    [AttachmentName, string | undefined]
  >) {
    const path = join(directory, name);
    const isRawProductRecord = name === "product-terminal-receipt.json" ||
      name === "source-install-journal.json";
    if (name.endsWith(".jsonl")) {
      const records = (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => ({
          ...JSON.parse(line),
          evidenceAttemptId,
          source: receipt.source
        }));
      await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    } else if (!isRawProductRecord) {
      const record = JSON.parse(await readFile(path, "utf8"));
      record.evidenceAttemptId = evidenceAttemptId;
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    }
    const digest = sha256(await readFile(path));
    receipt.attachments[name] = digest;
    if (transactionField) receipt.transaction[transactionField] = digest;
    if (name === "source-release-snapshot.json") receipt.source.releaseSnapshotSha256 = digest;
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
async function rewriteTauriLineage(
  input: {
    tauriLineageReceiptPath: Record<typeof DARWIN | typeof WINDOWS, string>;
    tauriLineageReceiptSha256: Record<typeof DARWIN | typeof WINDOWS, string>;
  },
  platform: typeof DARWIN | typeof WINDOWS,
  mutate: (receipt: Record<string, unknown>) => void
) {
  const receiptPath = input.tauriLineageReceiptPath[platform];
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  mutate(receipt);
  await writeFile(receiptPath, serializeCanonicalJson(receipt));
  input.tauriLineageReceiptSha256[platform] = sha256(await readFile(receiptPath));
}
async function writeJsonAttachment(
  directory: string,
  name: AttachmentName,
  value: unknown
) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(directory, name), content);
  return sha256(content);
}
async function writeJsonLinesAttachment(
  directory: string,
  name: "source-event-stream.jsonl",
  values: readonly unknown[]
) {
  const content = `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeFile(join(directory, name), content);
  return sha256(content);
}
async function writeBlackBoxFixture(
  root: string,
  platform: typeof DARWIN | typeof WINDOWS,
  version: string
) {
  const fixtureRoot = join(root, `black-box-${platform}`);
  const applicationPath = platform === DARWIN
    ? join(fixtureRoot, "Rion Studio.app")
    : join(fixtureRoot, "win-unpacked");
  const resourcesPath = platform === DARWIN
    ? join(applicationPath, "Contents", "Resources")
    : join(applicationPath, "resources");
  const executablePath = platform === DARWIN
    ? join(applicationPath, "Contents", "MacOS", "Rion Studio")
    : join(applicationPath, "Rion Studio.exe");
  const appAsarPath = join(resourcesPath, "app.asar");
  const nativeAddonPath = join(resourcesPath, "native", "rion-core.node");
  const screenshotPath = join(
    fixtureRoot,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME
  );
  await Promise.all([
    mkdir(dirname(executablePath), { recursive: true }),
    mkdir(dirname(nativeAddonPath), { recursive: true })
  ]);
  const executable = `${platform}-executable`;
  const appAsar = `${platform}-app-asar`;
  const nativeAddon = `${platform}-native-addon`;
  await Promise.all([
    writeFile(executablePath, executable),
    writeFile(appAsarPath, appAsar),
    writeFile(nativeAddonPath, nativeAddon),
    writeFile(screenshotPath, SCREENSHOT_PNG)
  ]);
  const packageManifest = summarizePackagedElectronPackageManifest(
    await capturePackagedElectronPackageManifest(applicationPath)
  );
  const report = {
    schemaVersion: 1,
    kind: "rion-packaged-electron-black-box-smoke",
    verdict: "passed",
    appVersion: version,
    application: { path: applicationPath },
    executable: { path: executablePath, sha256: sha256(executable) },
    appAsar: { path: appAsarPath, sha256: sha256(appAsar) },
    nativeAddon: { path: nativeAddonPath, sha256: sha256(nativeAddon) },
    exitCode: 0,
    fixtureInteraction: "visible-os-accessibility-click",
    gameId: "10000000-0000-4000-8000-000000000010",
    isolationKind: platform === DARWIN
      ? "fixed-macos-home"
      : "temporary-local-windows-user-profile-v1",
    nativeHostKind: platform === DARWIN
      ? "appkit-chromium"
      : "bundled-chromium",
    packageManifest,
    platform: platform === DARWIN ? "darwin" : "win32",
    remoteDebugging: false,
    roleId: "10000000-0000-4000-8000-000000000011",
    runtimeHomeDirectory: join(fixtureRoot, "runtime-home"),
    runtimeTarget: platform === DARWIN
      ? "chromium-v23-macos-appkit"
      : "chromium-v23-windows",
    screenshot: {
      byteLength: SCREENSHOT_PNG.length,
      path: screenshotPath,
      sha256: sha256(SCREENSHOT_PNG)
    },
    userDataDirectory: join(fixtureRoot, "runtime-home", "Rion Studio")
  } satisfies PackagedElectronBlackBoxReport;
  const reportPath = join(fixtureRoot, "packaged-smoke-report.json");
  await writeFile(reportPath, serializePackagedElectronBlackBoxReport(report));
  return { applicationPath, reportPath };
}
async function writeWindowsInstallerPayloadProofFixture(input: {
  applicationPath: string;
  installerPath: string;
  outputDirectory: string;
  sourceSha: string;
  version: string;
}): Promise<string> {
  const [capturedSourceManifest, installer] = await Promise.all([
    capturePackagedElectronPackageManifest(input.applicationPath),
    captureStableRegularFileArtifact(input.installerPath)
  ]);
  const sourceManifest = createPortablePackagedElectronPackageManifest(
    capturedSourceManifest.entries,
    capturedSourceManifest.rootMode
  );
  const uninstallerSource = "unsigned-nsis-uninstaller";
  const installedManifest = createPortablePackagedElectronPackageManifest([
    ...sourceManifest.entries,
    {
      bytes: Buffer.byteLength(uninstallerSource),
      mode: 0o755,
      path: WINDOWS_ELECTRON_UNINSTALLER_PATH,
      sha256: sha256(uninstallerSource),
      type: "regular-file" as const
    }
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))),
  sourceManifest.rootMode);
  const proof = buildWindowsElectronInstallerPayloadProof({
    installedAppVersion: input.version,
    installedManifest,
    installer,
    installerAuthenticodeStatus: "NotSigned",
    isolationResult: {
      activeProcessesAfterRootExit: 0,
      attemptNonce: "0123456789abcdef0123456789abcdef",
      attestedInputs: {
        commandExecutable: {
          bytes: 4,
          fileName: "pwsh.exe",
          sha256: sha256("pwsh")
        },
        commandHarness: {
          bytes: 7,
          fileName: "install.ps1",
          sha256: sha256("harness")
        },
        forbiddenSourceList: {
          bytes: 8,
          fileName: "forbidden-source-files.json",
          sha256: sha256("forbidden-source-list")
        },
        installer
      },
      cleanupVerified: true,
      commandExitCode: 0,
      commandInvocationSha256: sha256("command-invocation"),
      expectedTotalProcesses: 3,
      isolationKind: "temporary-local-windows-user-profile-v1",
      kind: "rion-windows-isolated-profile-result",
      schemaVersion: 1,
      totalProcesses: 3
    },
    mainAuthenticodeStatus: "NotSigned",
    sourceAppVersion: input.version,
    sourceManifest,
    sourceSha: input.sourceSha,
    uninstallerAuthenticodeStatus: "NotSigned",
    version: input.version
  });
  const proofPath = join(
    input.outputDirectory,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
  );
  await writeFile(
    proofPath,
    serializeWindowsElectronInstallerPayloadProof(proof)
  );
  return proofPath;
}
function terminalReceiptPath(
  evidenceDirectory: string,
  transition: string,
  platform: string
) {
  return join(evidenceDirectory, transition, platform, "terminal-receipt.json");
}
async function rewriteTerminalReceipt(
  input: MutableEvidenceInput,
  transition: string,
  platform: string,
  mutate: (receipt: ReturnType<typeof JSON.parse>) => void
) {
  const receiptPath = terminalReceiptPath(input.evidenceDirectory, transition, platform);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(receipt);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  input.evidenceReceiptSha256[transition][platform] = sha256(await readFile(receiptPath));
}
async function rewriteEndpointObservation(
  input: MutableEvidenceInput,
  transition: string,
  platform: string,
  mutate: (observation: ReturnType<typeof JSON.parse>) => void
) {
  const root = join(input.evidenceDirectory, transition, platform);
  const observationPath = join(root, "endpoint-observation.json");
  const receiptPath = join(root, "terminal-receipt.json");
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  mutate(observation);
  await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  const digest = sha256(await readFile(observationPath));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.attachments["endpoint-observation.json"] = digest;
  receipt.transaction.endpointObservationSha256 = digest;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  input.evidenceReceiptSha256[transition][platform] = sha256(await readFile(receiptPath));
}
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rion-promotion-readiness-"));
  temporaryDirectories.push(directory);
  return directory;
}
function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
