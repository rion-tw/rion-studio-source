import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND,
  createElectronProductionUpdaterEvidenceAttemptPlan,
  readElectronProductionUpdaterEvidenceAttemptPlan,
  type ElectronProductionUpdaterEvidenceAttemptPlanBindings
} from "../scripts/electronProductionUpdaterEvidenceAttemptPlan.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterEvidenceAttemptPlanCli
} from "../scripts/electronProductionUpdaterEvidenceAttemptPlanCli.mjs";

const NOW = new Date("2026-09-02T00:00:00.000Z");
const TARGET_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const TAURI_SHA = "c".repeat(40);
const TARGET_VERSION = "8.6.0";
const PRIOR_VERSION = "8.5.0";
const TAURI_VERSION = "8.4.2";
const PRODUCER_RUN_ATTEMPT = 4;
const CHALLENGE_NONCE = Buffer.alloc(32, 0xa5);
const GENERATED_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005"
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("Electron production updater evidence attempt plan", () => {
  it("creates and verifies one canonical control-bound four-cell plan", async () => {
    const fixture = await createFixture();
    const stdout: Buffer[] = [];

    const createSummary = await runElectronProductionUpdaterEvidenceAttemptPlanCli([
      "create",
      "--bindings", fixture.bindingsPath,
      "--challenge-nonce-file", fixture.noncePath,
      "--output", fixture.planPath
    ], {
      now: () => new Date(NOW),
      randomUuid: uuidFactory(),
      writeStdout: (source) => { stdout.push(source); }
    });

    expect(createSummary).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_CLI_SUMMARY_KIND,
      command: "create",
      status: "created",
      artifact: {
        bytes: expect.any(Number),
        fileName: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    const created = await readElectronProductionUpdaterEvidenceAttemptPlan({
      expectedSha256: createSummary.artifact.sha256,
      planPath: fixture.planPath
    }, { now: () => new Date(NOW) });
    expect(created.plan).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND,
      producer: fixture.bindings.producer,
      upstream: fixture.bindings.upstream,
      challenge: {
        expiresAt: "2026-09-03T00:00:00.000Z",
        id: GENERATED_IDS[0],
        issuedAt: NOW.toISOString(),
        nonceSha256: sha256(CHALLENGE_NONCE)
      },
      cells: [
        cell("tauri-v22-to-electron-v23", "darwin-aarch64", GENERATED_IDS[1]),
        cell("tauri-v22-to-electron-v23", "windows-x86_64", GENERATED_IDS[2]),
        cell("electron-v23-to-electron-v23", "darwin-aarch64", GENERATED_IDS[3]),
        cell("electron-v23-to-electron-v23", "windows-x86_64", GENERATED_IDS[4])
      ]
    });
    expect(await readFile(fixture.planPath)).toEqual(
      serializeCanonicalJson(created.plan)
    );
    expect(JSON.stringify(created.plan)).not.toContain(CHALLENGE_NONCE.toString("hex"));
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(createSummary);
    expect(stdout[0].toString("utf8")).not.toContain(CHALLENGE_NONCE.toString("hex"));

    const verifySummary = await runElectronProductionUpdaterEvidenceAttemptPlanCli([
      "verify",
      "--plan", fixture.planPath,
      "--expected-sha256", createSummary.artifact.sha256
    ], {
      now: () => new Date(NOW),
      writeStdout: (source) => { stdout.push(source); }
    });
    expect(verifySummary).toMatchObject({
      command: "verify",
      status: "verified",
      artifact: createSummary.artifact
    });
  });

  it("requires canonical stable bindings and an exact 32-byte raw nonce", async () => {
    const noncanonical = await createFixture();
    await writeFile(noncanonical.bindingsPath, JSON.stringify(noncanonical.bindings));
    await expect(runCreate(noncanonical)).rejects.toThrow("not canonical JSON");

    const shortNonce = await createFixture();
    await writeFile(shortNonce.noncePath, Buffer.alloc(31));
    await expect(runCreate(shortNonce)).rejects.toThrow("exactly 32 raw bytes");

    const linkedNonce = await createFixture();
    await link(linkedNonce.noncePath, `${linkedNonce.noncePath}.link`);
    await expect(runCreate(linkedNonce)).rejects.toThrow(
      "bounded, nonempty, single-link regular file"
    );
  });

  it("rejects unknown bindings and a mismatched aggregate artifact name", async () => {
    const unknown = await createFixture();
    await rewriteCanonical(unknown.bindingsPath, (value) => {
      value.untrusted = true;
    });
    await expect(runCreate(unknown)).rejects.toThrow("unexpected schema");

    const mismatched = await createFixture();
    await rewriteCanonical(mismatched.bindingsPath, (value) => {
      const producer = value.producer as Record<string, unknown>;
      producer.aggregateArtifactName = "electron-production-updater-terminal-evidence-forged";
    });
    await expect(runCreate(mismatched)).rejects.toThrow(
      "aggregate artifact name does not match"
    );
  });

  it("rejects duplicate or non-RFC-9562 generated identifiers before output", async () => {
    const duplicate = await createFixture();
    const duplicateIds = [...GENERATED_IDS];
    duplicateIds[4] = duplicateIds[3];
    await expect(runCreate(duplicate, duplicateIds)).rejects.toThrow(
      "generated challenge and evidence attempt IDs must be unique"
    );
    await expect(readFile(duplicate.planPath)).rejects.toMatchObject({ code: "ENOENT" });

    const invalid = await createFixture();
    const invalidIds: string[] = [...GENERATED_IDS];
    invalidIds[2] = "10000000-0000-4000-7000-000000000003";
    await expect(runCreate(invalid, invalidIds)).rejects.toThrow(
      "lowercase RFC 9562 UUID"
    );
  });

  it("rejects expired, overlong, unknown, multiply-linked, and digest-mismatched plans", async () => {
    const expired = await createFixture();
    const expiredFile = await createDirect(expired);
    await expect(readElectronProductionUpdaterEvidenceAttemptPlan({
      planPath: expired.planPath
    }, { now: () => new Date("2026-09-03T00:00:00.000Z") })).rejects.toThrow(
      "challenge is expired"
    );
    await expect(readElectronProductionUpdaterEvidenceAttemptPlan({
      expectedSha256: "0".repeat(64),
      planPath: expired.planPath
    }, { now: () => new Date(NOW) })).rejects.toThrow("SHA-256 does not match");
    expect(expiredFile.planIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const overlong = await createFixture();
    await createDirect(overlong);
    await rewriteCanonical(overlong.planPath, (value) => {
      const challenge = value.challenge as Record<string, unknown>;
      challenge.expiresAt = "2026-09-03T00:00:00.001Z";
    });
    await expect(readElectronProductionUpdaterEvidenceAttemptPlan({
      planPath: overlong.planPath
    }, { now: () => new Date(NOW) })).rejects.toThrow("at most 24 hours");

    const unknown = await createFixture();
    await createDirect(unknown);
    await rewriteCanonical(unknown.planPath, (value) => { value.applied = true; });
    await expect(readElectronProductionUpdaterEvidenceAttemptPlan({
      planPath: unknown.planPath
    }, { now: () => new Date(NOW) })).rejects.toThrow("unexpected schema");

    const linked = await createFixture();
    await createDirect(linked);
    await link(linked.planPath, `${linked.planPath}.link`);
    await expect(readElectronProductionUpdaterEvidenceAttemptPlan({
      planPath: linked.planPath
    }, { now: () => new Date(NOW) })).rejects.toThrow(
      "bounded, nonempty, single-link regular file"
    );
  });

  it("rejects duplicate and unknown CLI options", async () => {
    const fixture = await createFixture();
    await expect(runElectronProductionUpdaterEvidenceAttemptPlanCli([
      "verify", "--plan", fixture.planPath, "--plan", fixture.planPath
    ])).rejects.toThrow("Duplicate verify option --plan");
    await expect(runElectronProductionUpdaterEvidenceAttemptPlanCli([
      "verify", "--plan", fixture.planPath, "--unknown", "value"
    ])).rejects.toThrow("Unknown verify option --unknown");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-attempt-plan-"));
  temporaryDirectories.push(root);
  const bindings = createBindings();
  const bindingsPath = join(root, "trusted-control-bindings.json");
  const noncePath = join(root, "challenge-nonce.bin");
  const planPath = join(root, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE);
  await Promise.all([
    writeFile(bindingsPath, serializeCanonicalJson(bindings)),
    writeFile(noncePath, CHALLENGE_NONCE)
  ]);
  return { bindings, bindingsPath, noncePath, planPath, root };
}

function createBindings(): ElectronProductionUpdaterEvidenceAttemptPlanBindings {
  const target = candidateIdentity("target", TARGET_VERSION, TARGET_SHA, "101", 3);
  const priorV23 = candidateIdentity("prior", PRIOR_VERSION, PRIOR_SHA, "100", 2);
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND,
    producer: {
      aggregateArtifactName:
        `electron-production-updater-terminal-evidence-${TARGET_VERSION}-` +
        `${TARGET_SHA}-attempt-${PRODUCER_RUN_ATTEMPT}`,
      controlSha: "d".repeat(40),
      repository: "rion-tw/rion-studio-source",
      runAttempt: PRODUCER_RUN_ATTEMPT,
      runId: "104",
      workflow: ".github/workflows/electron-production-updater-evidence.yml"
    },
    upstream: {
      target,
      priorV23,
      tauriV22: {
        artifacts: {
          "darwin-aarch64": {
            artifactName: "tauri-v22-public-lineage-darwin-aarch64-102-2",
            receiptSha256: sha256("tauri-lineage-macos")
          },
          "windows-x86_64": {
            artifactName: "tauri-v22-public-lineage-windows-x86_64-102-2",
            receiptSha256: sha256("tauri-lineage-windows")
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
          `electron-production-publication-provisional-${TARGET_VERSION}-` +
          `${TARGET_SHA}-attempt-1`,
        controlSha: "f".repeat(40),
        receiptSha256: sha256("provisional-publication-receipt"),
        repository: "rion-tw/rion-studio-source",
        revision: 1,
        runAttempt: 1,
        runId: "103",
        transactionId: "20000000-0000-4000-8000-000000000001",
        workflow: ".github/workflows/electron-production-provisional-publish.yml"
      }
    }
  };
}

function candidateIdentity(
  label: string,
  version: string,
  sourceSha: string,
  runId: string,
  runAttempt: number
) {
  return {
    artifactName:
      `electron-production-candidate-${version}-${sourceSha}-attempt-${runAttempt}`,
    candidateReceiptSha256: sha256(`${label}-candidate-receipt`),
    controlSha: label === "target" ? "1".repeat(40) : "2".repeat(40),
    repository: "rion-tw/rion-studio-source" as const,
    runAttempt,
    runId,
    sourceSha,
    trustedControlReceiptSha256: sha256(`${label}-trusted-control-receipt`),
    version,
    workflow: ".github/workflows/electron-production-candidate.yml" as const
  };
}

async function runCreate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  ids: readonly string[] = GENERATED_IDS
) {
  return runElectronProductionUpdaterEvidenceAttemptPlanCli([
    "create",
    "--bindings", fixture.bindingsPath,
    "--challenge-nonce-file", fixture.noncePath,
    "--output", fixture.planPath
  ], {
    now: () => new Date(NOW),
    randomUuid: uuidFactory(ids),
    writeStdout: () => undefined
  });
}

async function createDirect(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return createElectronProductionUpdaterEvidenceAttemptPlan({
    bindings: fixture.bindings,
    challengeNonce: CHALLENGE_NONCE,
    outputPath: fixture.planPath
  }, {
    now: () => new Date(NOW),
    randomUuid: uuidFactory()
  });
}

function uuidFactory(ids: readonly string[] = GENERATED_IDS) {
  const remaining = [...ids];
  return () => remaining.shift() ?? "";
}

function cell(transitionKind: string, platform: string, evidenceAttemptId: string) {
  return { evidenceAttemptId, platform, transitionKind };
}

async function rewriteCanonical(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void
) {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(filePath, serializeCanonicalJson(value));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
