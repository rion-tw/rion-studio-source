import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND,
  createElectronProductionUpdaterEvidenceCellBindings,
  type ElectronProductionUpdaterEvidenceCellBindingsDependencies
} from "../scripts/electronProductionUpdaterEvidenceCellBindings.mjs";
import {
  runElectronProductionUpdaterEvidenceCellBindingsCli
} from "../scripts/electronProductionUpdaterEvidenceCellBindingsCli.mjs";

const TARGET_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const TAURI_SHA = "c".repeat(40);
const TARGET_VERSION = "8.6.0";
const PRIOR_VERSION = "8.5.0";
const TAURI_VERSION = "8.4.0";
const TARGET_RECEIPT_SHA = sha256("target receipt");
const PRIOR_RECEIPT_SHA = sha256("prior receipt");
const TRUSTED_BINDINGS_SHA = sha256("trusted bindings");
const PLAN_SHA = sha256("attempt plan");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater evidence cell bindings", () => {
  it.each([
    ["darwin-aarch64", "tauri-v22-to-electron-v23"],
    ["darwin-aarch64", "electron-v23-to-electron-v23"],
    ["windows-x86_64", "tauri-v22-to-electron-v23"],
    ["windows-x86_64", "electron-v23-to-electron-v23"]
  ] as const)(
    "derives canonical %s %s bundle and endpoint bindings from trusted inputs",
    async (platform, transitionKind) => {
      const fixture = await createFixture(platform, transitionKind);
      const result = await createElectronProductionUpdaterEvidenceCellBindings(
        fixture.input,
        fixture.dependencies
      );

      expect(result).toMatchObject({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND,
        platform,
        transitionKind,
        bundleIdentity: {
          fileName: "bundle-bindings.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        },
        endpointIdentity: {
          fileName: "endpoint-observation-bindings.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      });
      const source = result.bundleBindings.sourceBinding as Record<string, unknown>;
      expect(source.runtime).toBe(
        transitionKind === "tauri-v22-to-electron-v23"
          ? "tauri-v22"
          : "electron-v23"
      );
      expect(result.bundleBindings.targetBinding).toMatchObject({
        sourceSha: TARGET_SHA,
        version: TARGET_VERSION,
        targetRunningImageSha256: sha256(`target-${platform}-executable`)
      });
      expect(result.endpointBindings).toMatchObject({
        attemptPlanSha256: PLAN_SHA,
        context: { platform, transitionKind },
        endpoint: {
          requestEndpoint: transitionKind === "tauri-v22-to-electron-v23"
            ? "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json"
            : "https://updates.example.test/prior/latest.json",
          targetEmbeddedUpdaterEndpoint:
            "https://updates.example.test/target/latest.json"
        }
      });
      expect(JSON.parse(await readFile(
        join(fixture.outputRoot, "bundle-bindings.json"),
        "utf8"
      ))).toEqual(result.bundleBindings);
    }
  );

  it("rejects a candidate result that diverges from the sealed attempt plan", async () => {
    const fixture = await createFixture(
      "darwin-aarch64",
      "electron-v23-to-electron-v23"
    );
    await expect(createElectronProductionUpdaterEvidenceCellBindings(
      fixture.input,
      {
        ...fixture.dependencies,
        verifyCandidate: async (input) => ({
          ...candidateVerification(
            String(input.version) === TARGET_VERSION ? "target" : "prior"
          ),
          sourceSha: "d".repeat(40)
        }) as never
      }
    )).rejects.toThrow("source SHA does not match");
  });

  it("requires exact CLI options and returns only derived public identities", async () => {
    const fixture = await createFixture(
      "windows-x86_64",
      "tauri-v22-to-electron-v23"
    );
    const stdout: Buffer[] = [];
    const result = {
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_CELL_BINDINGS_KIND,
      platform: fixture.platform,
      transitionKind: fixture.transitionKind,
      outputRoot: fixture.outputRoot,
      bundleBindings: {},
      bundleIdentity: {
        bytes: 100,
        fileName: "bundle-bindings.json",
        sha256: sha256("bundle")
      },
      endpointBindings: {},
      endpointIdentity: {
        bytes: 100,
        fileName: "endpoint-observation-bindings.json",
        sha256: sha256("endpoint")
      }
    } as const;
    const summary = await runElectronProductionUpdaterEvidenceCellBindingsCli(
      cliArguments(fixture),
      {
        create: (async () => result) as never,
        writeStdout: (source) => { stdout.push(source); }
      }
    );
    expect(summary).toMatchObject({
      status: "created",
      bundleBindings: result.bundleIdentity,
      endpointBindings: result.endpointIdentity
    });
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(summary);

    await expect(runElectronProductionUpdaterEvidenceCellBindingsCli([
      ...cliArguments(fixture),
      "--timeout", "1000"
    ])).rejects.toThrow("Unknown updater cell-bindings option --timeout");
  });
});

interface Fixture {
  dependencies: ElectronProductionUpdaterEvidenceCellBindingsDependencies;
  input: Parameters<typeof createElectronProductionUpdaterEvidenceCellBindings>[0];
  outputRoot: string;
  platform: "darwin-aarch64" | "windows-x86_64";
  root: string;
  transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
}

async function createFixture(
  platform: Fixture["platform"],
  transitionKind: Fixture["transitionKind"]
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-cell-bindings-"));
  temporaryDirectories.push(root);
  const outputRoot = join(root, "output");
  await mkdir(join(root, "inputs"));
  const plan = attemptPlan();
  const trustedBindings = { producer: plan.producer, upstream: plan.upstream };
  const descriptor = trustedDescriptor(root);
  return {
    dependencies: {
      readDescriptor: async () => ({
        descriptor,
        descriptorIdentity: {
          bytes: 100,
          fileName: "descriptor.json",
          sha256: sha256("descriptor")
        },
        descriptorPath: join(root, "inputs", "descriptor.json")
      }) as never,
      readLineage: async () => lineage(platform) as never,
      readPlan: async () => ({
        plan,
        planIdentity: {
          bytes: 100,
          fileName: "electron-production-updater-evidence-attempt-plan.json",
          sha256: PLAN_SHA
        },
        planPath: join(root, "inputs", "plan.json")
      }) as never,
      readTrustedBindings: async () => ({
        bindings: trustedBindings,
        bindingsIdentity: {
          bytes: 100,
          fileName: "trusted-bindings.json",
          sha256: TRUSTED_BINDINGS_SHA
        },
        bindingsPath: join(root, "inputs", "trusted-bindings.json")
      }) as never,
      verifyCandidate: async (input) => candidateVerification(
        String(input.version) === TARGET_VERSION ? "target" : "prior"
      ) as never
    },
    input: {
      attemptPlanPath: join(root, "inputs", "plan.json"),
      descriptorPath: join(root, "inputs", "descriptor.json"),
      expectedAttemptPlanSha256: PLAN_SHA,
      expectedTrustedBindingsSha256: TRUSTED_BINDINGS_SHA,
      outputRoot,
      platform,
      transitionKind,
      trustedBindingsPath: join(root, "inputs", "trusted-bindings.json")
    },
    outputRoot,
    platform,
    root,
    transitionKind
  };
}

function attemptPlan() {
  const producer = {
    aggregateArtifactName:
      `electron-production-updater-terminal-evidence-${TARGET_VERSION}-` +
      `${TARGET_SHA}-attempt-4`,
    controlSha: "d".repeat(40),
    repository: "rion-tw/rion-studio-source",
    runAttempt: 4,
    runId: "104",
    workflow: ".github/workflows/electron-production-updater-evidence.yml"
  };
  const upstream = {
    target: candidateIdentity("target", TARGET_SHA, TARGET_VERSION, TARGET_RECEIPT_SHA),
    priorV23: candidateIdentity("prior", PRIOR_SHA, PRIOR_VERSION, PRIOR_RECEIPT_SHA),
    tauriV22: {
      artifacts: {
        "darwin-aarch64": {
          artifactName: "tauri-v22-public-lineage-darwin-aarch64-102-2",
          receiptSha256: sha256("darwin lineage")
        },
        "windows-x86_64": {
          artifactName: "tauri-v22-public-lineage-windows-x86_64-102-2",
          receiptSha256: sha256("windows lineage")
        }
      },
      controlSha: "e".repeat(40),
      releaseTag: `v${TAURI_VERSION}`,
      repository: "rion-tw/rion-studio-source",
      runAttempt: 2,
      runId: "102",
      sourceSha: TAURI_SHA,
      targetSourceSha: TARGET_SHA,
      version: TAURI_VERSION,
      workflow: ".github/workflows/electron-updater-tauri-v22-compatibility.yml"
    },
    provisionalPublication: {
      artifactName:
        `electron-production-publication-provisional-${TARGET_VERSION}-${TARGET_SHA}-attempt-1`,
      controlSha: "f".repeat(40),
      receiptSha256: sha256("provisional"),
      repository: "rion-tw/rion-studio-source",
      revision: 2,
      runAttempt: 1,
      runId: "103",
      transactionId: "20000000-0000-4000-8000-000000000001",
      workflow: ".github/workflows/electron-production-provisional-publish.yml"
    }
  };
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-updater-evidence-attempt-plan",
    producer,
    upstream,
    challenge: {
      expiresAt: "2026-09-03T00:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000001",
      issuedAt: "2026-09-02T00:00:00.000Z",
      nonceSha256: sha256("challenge")
    },
    cells: [
      ["darwin-aarch64", "tauri-v22-to-electron-v23"],
      ["windows-x86_64", "tauri-v22-to-electron-v23"],
      ["darwin-aarch64", "electron-v23-to-electron-v23"],
      ["windows-x86_64", "electron-v23-to-electron-v23"]
    ].map(([cellPlatform, cellTransition], index) => ({
      challengeId: "10000000-0000-4000-8000-000000000001",
      evidenceAttemptId: `10000000-0000-4000-8000-00000000000${index + 2}`,
      platform: cellPlatform,
      transitionKind: cellTransition
    }))
  };
}

function candidateIdentity(
  label: string,
  sourceSha: string,
  version: string,
  candidateReceiptSha256: string
) {
  return {
    artifactName: `electron-production-candidate-${version}-${sourceSha}-attempt-1`,
    candidateReceiptSha256,
    controlSha: label === "target" ? "1".repeat(40) : "2".repeat(40),
    repository: "rion-tw/rion-studio-source",
    runAttempt: 1,
    runId: label === "target" ? "101" : "100",
    sourceSha,
    trustedControlReceiptSha256: sha256(`${label} trusted control`),
    version,
    workflow: ".github/workflows/electron-production-candidate.yml"
  };
}

function trustedDescriptor(root: string) {
  const candidate = (label: string, sourceSha: string, version: string) => ({
    candidateDirectory: join(root, label, "candidate"),
    candidateReceiptPath: join(root, label, "candidate-receipt.json"),
    candidateReceiptSha256: label === "target" ? TARGET_RECEIPT_SHA : PRIOR_RECEIPT_SHA,
    macDirectory: join(root, label, "mac"),
    public: label,
    sourceSha,
    version,
    windowsDirectory: join(root, label, "windows")
  });
  return {
    productionUpdaterPublicKey: "RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    target: candidate("target", TARGET_SHA, TARGET_VERSION),
    priorV23: candidate("prior", PRIOR_SHA, PRIOR_VERSION),
    tauriV22: {
      artifacts: {
        "darwin-aarch64": {
          receiptPath: join(root, "lineage-mac.json"),
          receiptSha256: sha256("darwin lineage")
        },
        "windows-x86_64": {
          receiptPath: join(root, "lineage-windows.json"),
          receiptSha256: sha256("windows lineage")
        }
      }
    }
  };
}

function candidateVerification(label: "target" | "prior") {
  const isTarget = label === "target";
  const version = isTarget ? TARGET_VERSION : PRIOR_VERSION;
  const sourceSha = isTarget ? TARGET_SHA : PRIOR_SHA;
  const endpoint = `https://updates.example.test/${label}/latest.json`;
  const receipt = {
    sourceSha,
    version,
    updaterEndpoint: endpoint,
    publicKeySha256: sha256("public key"),
    assets: { "latest.json": sha256(`${label} manifest`) },
    platforms: Object.fromEntries(
      ["darwin-aarch64", "windows-x86_64"].map((platform) => {
        const isMac = platform === "darwin-aarch64";
        return [platform, {
          artifact: {
            fileName: isMac
              ? "Rion.Studio-mac.app.tar.gz"
              : "Rion.Studio-win.exe",
            sha256: sha256(`${label}-${platform}-artifact`),
            signatureFileName: isMac
              ? "Rion.Studio-mac.app.tar.gz.sig"
              : "Rion.Studio-win.exe.sig",
            signatureSha256: sha256(`${label}-${platform}-signature`)
          },
          blackBox: {
            executable: { sha256: sha256(`${label}-${platform}-executable`) }
          }
        }];
      })
    )
  };
  return {
    assets: receipt.assets,
    receipt,
    receiptSha256: isTarget ? TARGET_RECEIPT_SHA : PRIOR_RECEIPT_SHA,
    sourceSha,
    updaterBaseUrl: endpoint.replace("latest.json", ""),
    updaterEndpoint: endpoint,
    version
  };
}

function lineage(platform: Fixture["platform"]) {
  return {
    platform,
    release: { tag: `v${TAURI_VERSION}`, version: TAURI_VERSION },
    sourceTag: { peeledCommitSha: TAURI_SHA },
    targetSourceSha: TARGET_SHA,
    assets: {
      artifact: {
        name: platform === "darwin-aarch64"
          ? "Rion.Studio-mac.app.tar.gz"
          : "Rion.Studio-win.exe",
        sha256: sha256(`tauri-${platform}-artifact`)
      },
      manifest: { sha256: sha256("tauri manifest") }
    },
    runningExecutable: { sha256: sha256(`tauri-${platform}-executable`) }
  };
}

function cliArguments(fixture: Fixture) {
  return [
    "create",
    "--attempt-plan", fixture.input.attemptPlanPath,
    "--attempt-plan-sha256", PLAN_SHA,
    "--descriptor", fixture.input.descriptorPath,
    "--output-root", fixture.outputRoot,
    "--platform", fixture.platform,
    "--transition-kind", fixture.transitionKind,
    "--trusted-bindings", fixture.input.trustedBindingsPath,
    "--trusted-bindings-sha256", TRUSTED_BINDINGS_SHA
  ];
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
