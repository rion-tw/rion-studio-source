import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from
  "../scripts/canonicalJson.mjs";
import { normalizeUpdaterPublicKey } from
  "../scripts/electronProductionCandidate.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND
} from "../scripts/electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE,
  ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND,
  createElectronProductionUpdaterTrustedControlBindings,
  readElectronProductionUpdaterTrustedControlBindings,
  type ElectronProductionUpdaterTrustedControlIntakeDependencies
} from "../scripts/electronProductionUpdaterTrustedControlIntake.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterTrustedControlIntakeCli
} from "../scripts/electronProductionUpdaterTrustedControlIntakeCli.mjs";

const PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const KEY_SHA = normalizeUpdaterPublicKey(PUBLIC_KEY).sha256;
const TARGET_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const TAURI_SHA = "c".repeat(40);
const TARGET_VERSION = "8.6.0";
const PRIOR_VERSION = "8.5.0";
const TAURI_VERSION = "8.4.2";
const TARGET_MANIFEST_SHA = sha256("target-latest");
const TAURI_MANIFEST_SHA = sha256("tauri-latest");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater trusted-control intake", () => {
  it("cross-binds all verified upstream controls into one canonical plan input", async () => {
    const fixture = await createFixture();
    const calls: string[] = [];
    const result = await createElectronProductionUpdaterTrustedControlBindings({
      descriptorPath: fixture.descriptorPath,
      outputPath: fixture.outputPath
    }, asIntakeDependencies(dependencies(fixture.descriptor, calls)));

    expect(calls.sort()).toEqual([
      "candidate:8.5.0",
      "candidate:8.6.0",
      "control:8.5.0",
      "control:8.6.0",
      "lineage-pair",
      "lineage:darwin-aarch64",
      "lineage:windows-x86_64",
      "provisional"
    ]);
    expect(result.bindings).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
      producer: fixture.descriptor.producer,
      upstream: {
        target: expectedCandidateIdentity(fixture.descriptor.target),
        priorV23: expectedCandidateIdentity(fixture.descriptor.priorV23),
        tauriV22: {
          artifacts: {
            "darwin-aarch64": expectedLineageArtifact(
              fixture.descriptor.tauriV22.artifacts["darwin-aarch64"]
            ),
            "windows-x86_64": expectedLineageArtifact(
              fixture.descriptor.tauriV22.artifacts["windows-x86_64"]
            )
          },
          controlSha: fixture.descriptor.tauriV22.controlSha,
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
          artifactName: fixture.descriptor.provisionalPublication.artifactName,
          controlSha: fixture.descriptor.provisionalPublication.controlSha,
          receiptSha256: fixture.descriptor.provisionalPublication.receiptSha256,
          repository: "rion-tw/rion-studio-source",
          revision: 2,
          runAttempt: 1,
          runId: "103",
          transactionId: "20000000-0000-4000-8000-000000000001",
          workflow: ".github/workflows/electron-production-provisional-publish.yml"
        }
      }
    });
    expect(result.bindingsIdentity).toMatchObject({
      fileName: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(await readFile(fixture.outputPath)).toEqual(
      serializeCanonicalJson(result.bindings)
    );
    await expect(readElectronProductionUpdaterTrustedControlBindings({
      bindingsPath: fixture.outputPath,
      expectedSha256: result.bindingsIdentity.sha256
    })).resolves.toMatchObject({ bindings: result.bindings });
  });

  it("fails before output for a forged control or provisional readback", async () => {
    const controlFixture = await createFixture();
    const controlDependencies = dependencies(controlFixture.descriptor, []);
    await expect(createElectronProductionUpdaterTrustedControlBindings({
      descriptorPath: controlFixture.descriptorPath,
      outputPath: controlFixture.outputPath
    }, asIntakeDependencies({
      ...controlDependencies,
      readTrustedControl: async (input: Record<string, unknown>) => {
        const result = await controlDependencies.readTrustedControl!(input);
        return input.version === TARGET_VERSION
          ? { ...result, receiptSha256: "0".repeat(64) }
          : result;
      }
    }))).rejects.toThrow("target trusted-control receipt SHA-256 does not match");
    await expect(readFile(controlFixture.outputPath)).rejects.toMatchObject({
      code: "ENOENT"
    });

    const provisionalFixture = await createFixture();
    const provisionalDependencies = dependencies(provisionalFixture.descriptor, []);
    await expect(createElectronProductionUpdaterTrustedControlBindings({
      descriptorPath: provisionalFixture.descriptorPath,
      outputPath: provisionalFixture.outputPath
    }, asIntakeDependencies({
      ...provisionalDependencies,
      readPublicationReceipt: async (input: Record<string, unknown>) => {
        const result = await provisionalDependencies.readPublicationReceipt!(input);
        return {
          ...result,
          receipt: {
            ...result.receipt,
            publication: {
              ...result.receipt.publication,
              observedState: "baseline"
            }
          }
        };
      }
    }))).rejects.toThrow("provisional-publication observed state does not match");
    await expect(readFile(provisionalFixture.outputPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("exposes exact create and verify CLI contracts", async () => {
    const fixture = await createFixture();
    const stdout: Buffer[] = [];
    const identity = {
      bytes: 100,
      fileName: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE,
      sha256: sha256("bindings")
    };
    const create = await runElectronProductionUpdaterTrustedControlIntakeCli([
      "create",
      "--descriptor", fixture.descriptorPath,
      "--output", fixture.outputPath
    ], {
      create: (async () => ({ bindingsIdentity: identity })) as never,
      writeStdout: (source) => { stdout.push(source); }
    });
    expect(create).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_CLI_SUMMARY_KIND,
      command: "create",
      status: "created",
      artifact: identity
    });
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(create);

    const verify = await runElectronProductionUpdaterTrustedControlIntakeCli([
      "verify",
      "--bindings", fixture.outputPath,
      "--expected-sha256", identity.sha256
    ], {
      read: (async () => ({ bindingsIdentity: identity })) as never,
      writeStdout: () => undefined
    });
    expect(verify).toMatchObject({ command: "verify", status: "verified" });
    await expect(runElectronProductionUpdaterTrustedControlIntakeCli([
      "create", "--descriptor", fixture.descriptorPath,
      "--descriptor", fixture.descriptorPath,
      "--output", fixture.outputPath
    ])).rejects.toThrow("Duplicate updater trusted-control create option --descriptor");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-control-intake-"));
  temporaryDirectories.push(root);
  const descriptor = createDescriptor(root);
  const descriptorPath = join(root, "trusted-control-intake.json");
  const outputPath = join(
    root,
    ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_BINDINGS_FILE
  );
  await writeFile(descriptorPath, serializeCanonicalJson(descriptor));
  return { descriptor, descriptorPath, outputPath, root };
}

function createDescriptor(root: string) {
  const target = candidateDescriptor(
    root,
    "target",
    TARGET_SHA,
    TARGET_VERSION,
    "101",
    3,
    "1".repeat(40)
  );
  const priorV23 = candidateDescriptor(
    root,
    "prior",
    PRIOR_SHA,
    PRIOR_VERSION,
    "100",
    2,
    "2".repeat(40)
  );
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TRUSTED_CONTROL_INTAKE_KIND,
    producer: {
      aggregateArtifactName:
        `electron-production-updater-terminal-evidence-${TARGET_VERSION}-` +
        `${TARGET_SHA}-attempt-4`,
      controlSha: "d".repeat(40),
      repository: "rion-tw/rion-studio-source",
      runAttempt: 4,
      runId: "104",
      workflow: ".github/workflows/electron-production-updater-evidence.yml"
    },
    productionUpdaterPublicKey: PUBLIC_KEY,
    target,
    priorV23,
    tauriV22: {
      artifacts: {
        "darwin-aarch64": lineageArtifact(root, "darwin-aarch64"),
        "windows-x86_64": lineageArtifact(root, "windows-x86_64")
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
        `electron-production-publication-provisional-${TARGET_VERSION}-` +
        `${TARGET_SHA}-attempt-1`,
      controlSha: "f".repeat(40),
      receiptPath: join(root, "provisional-receipt.json"),
      receiptSha256: sha256("provisional-receipt"),
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "103",
      workflow: ".github/workflows/electron-production-provisional-publish.yml"
    }
  } as const;
}

function candidateDescriptor(
  root: string,
  label: string,
  sourceSha: string,
  version: string,
  runId: string,
  runAttempt: number,
  controlSha: string
) {
  return {
    artifactName:
      `electron-production-candidate-${version}-${sourceSha}-attempt-${runAttempt}`,
    candidateDirectory: join(root, `${label}-candidate`),
    candidateReceiptPath: join(root, `${label}-candidate-receipt.json`),
    candidateReceiptSha256: sha256(`${label}-candidate-receipt`),
    controlReceiptPath: join(root, `${label}-control-receipt.json`),
    controlSha,
    macDirectory: join(root, `${label}-macos`),
    repository: "rion-tw/rion-studio-source" as const,
    runAttempt,
    runId,
    sourceSha,
    trustedControlReceiptSha256: sha256(`${label}-control-receipt`),
    version,
    windowsDirectory: join(root, `${label}-windows`),
    workflow: ".github/workflows/electron-production-candidate.yml" as const
  };
}

function lineageArtifact(root: string, platform: string) {
  return {
    artifactName: `tauri-v22-public-lineage-${platform}-102-2`,
    receiptPath: join(root, `${platform}-lineage-receipt.json`),
    receiptSha256: sha256(`${platform}-lineage-receipt`)
  };
}

function dependencies(
  descriptor: ReturnType<typeof createDescriptor>,
  calls: string[]
) {
  return {
    verifyCandidate: async (input: Record<string, unknown>) => {
      const version = String(input.version);
      calls.push(`candidate:${version}`);
      const expected = version === TARGET_VERSION
        ? descriptor.target
        : descriptor.priorV23;
      return candidateVerification(expected);
    },
    readTrustedControl: async (input: Record<string, unknown>) => {
      const version = String(input.version);
      calls.push(`control:${version}`);
      const expected = version === TARGET_VERSION
        ? descriptor.target
        : descriptor.priorV23;
      return controlReceipt(expected);
    },
    readTauriLineage: async (input: Record<string, unknown>) => {
      const platform = String(input.receiptPath).includes("darwin")
        ? "darwin-aarch64"
        : "windows-x86_64";
      calls.push(`lineage:${platform}`);
      return lineageReceipt(platform, descriptor);
    },
    assertTauriLineagePair: (input: Record<string, unknown>) => {
      calls.push("lineage-pair");
      return input;
    },
    readPublicationReceipt: async (_input: Record<string, unknown>) => {
      calls.push("provisional");
      return provisionalReceipt(descriptor);
    }
  };
}

function asIntakeDependencies(value: unknown) {
  return value as ElectronProductionUpdaterTrustedControlIntakeDependencies;
}

function candidateVerification(value: ReturnType<typeof candidateDescriptor>) {
  return {
    assets: {},
    receipt: {
      assets: { "latest.json": TARGET_MANIFEST_SHA },
      publicKeySha256: KEY_SHA
    },
    receiptSha256: value.candidateReceiptSha256,
    sourceSha: value.sourceSha,
    updaterBaseUrl: "https://updates.example.test/rion/v23/",
    updaterEndpoint: "https://updates.example.test/rion/v23/latest.json",
    version: value.version
  };
}

function controlReceipt(value: ReturnType<typeof candidateDescriptor>) {
  return {
    receipt: {
      candidate: {
        sourceSha: value.sourceSha,
        updaterEndpoint: "https://updates.example.test/rion/v23/latest.json",
        version: value.version
      },
      updaterTrust: { publicKeySha256: KEY_SHA }
    },
    receiptPath: value.controlReceiptPath,
    receiptSha256: value.trustedControlReceiptSha256
  };
}

function lineageReceipt(
  platform: string,
  descriptor: ReturnType<typeof createDescriptor>
) {
  return {
    platform,
    release: { tag: `v${TAURI_VERSION}`, version: TAURI_VERSION },
    sourceTag: { peeledCommitSha: TAURI_SHA },
    targetSourceSha: TARGET_SHA,
    trust: { updaterPublicKeySha256: KEY_SHA },
    assets: { manifest: { sha256: TAURI_MANIFEST_SHA } },
    producer: {
      headSha: TARGET_SHA,
      repository: descriptor.tauriV22.repository,
      runAttempt: descriptor.tauriV22.runAttempt,
      runId: descriptor.tauriV22.runId,
      workflow: descriptor.tauriV22.workflow
    }
  };
}

function provisionalReceipt(descriptor: ReturnType<typeof createDescriptor>) {
  return {
    receiptIdentity: {
      bytes: 100,
      fileName: "electron-production-publication-provisional-receipt.json",
      sha256: descriptor.provisionalPublication.receiptSha256
    },
    receipt: {
      transactionId: "20000000-0000-4000-8000-000000000001",
      revision: 2,
      phase: "provisional",
      terminal: false,
      outcome: null,
      publication: {
        acknowledgement: "confirmed",
        observedState: "target",
        observedStateSha256: sha256("target-state")
      },
      target: {
        candidateReceiptSha256: descriptor.target.candidateReceiptSha256,
        sourceSha: TARGET_SHA,
        version: TARGET_VERSION,
        manifestSha256: TARGET_MANIFEST_SHA,
        stateSha256: sha256("target-state")
      },
      baseline: {
        sourceSha: TAURI_SHA,
        version: TAURI_VERSION,
        releaseTag: `v${TAURI_VERSION}`,
        manifestSha256: TAURI_MANIFEST_SHA
      }
    }
  };
}

function expectedCandidateIdentity(value: ReturnType<typeof candidateDescriptor>) {
  const {
    candidateDirectory: _candidateDirectory,
    candidateReceiptPath: _candidateReceiptPath,
    controlReceiptPath: _controlReceiptPath,
    macDirectory: _macDirectory,
    windowsDirectory: _windowsDirectory,
    ...identity
  } = value;
  return identity;
}

function expectedLineageArtifact(value: ReturnType<typeof lineageArtifact>) {
  return {
    artifactName: value.artifactName,
    receiptSha256: value.receiptSha256
  };
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
