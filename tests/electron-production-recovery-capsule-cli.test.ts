import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_CLI_OPERATION_KIND,
  runElectronProductionRecoveryCapsuleCli,
  type ElectronProductionRecoveryCapsuleCliDependencies,
  type ElectronProductionRecoveryCapsuleCliReadResult
} from "../scripts/electronProductionRecoveryCapsuleCli.mjs";

const SHA = Object.freeze({
  capsule: "1".repeat(64),
  manifest: "2".repeat(64),
  intent: "3".repeat(64),
  leaseEvent: "4".repeat(64),
  control: "a".repeat(40),
  candidateControl: "b".repeat(40),
  candidateSource: "c".repeat(40),
  priorControl: "d".repeat(40),
  priorSource: "e".repeat(40)
});
const SOURCE_ROOT = "/tmp/recovery-capsule";
const CAPSULE_PATH = path.join(
  "/tmp/recovery-capsule-package",
  "electron-production-publication-recovery-capsule.capsule.json"
);
const MATERIALIZED_ROOT = "/tmp/recovery-capsule-materialized";

describe("Electron production recovery capsule CLI", () => {
  it("creates through the bounded helper and emits exact canonical identities", async () => {
    const result = capsuleResult();
    const createCapsule = vi.fn(async () => ({
      ...result,
      manifestPath: path.join(
        SOURCE_ROOT,
        "electron-production-publication-recovery-capsule-manifest.json"
      )
    }));
    const outputs: Buffer[] = [];

    const summary = await runElectronProductionRecoveryCapsuleCli([
      "--",
      "create",
      ...commonArguments(),
      "--capsule-output", CAPSULE_PATH
    ], {
      createCapsule,
      writeStdout: (source) => {
        outputs.push(source);
      }
    });

    expect(createCapsule).toHaveBeenCalledOnce();
    expect(createCapsule).toHaveBeenCalledWith({
      sourceRoot: SOURCE_ROOT,
      capsulePath: CAPSULE_PATH,
      binding: expectedBinding()
    });
    expect(summary).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_CLI_OPERATION_KIND,
      command: "create",
      capsule: result.capsuleIdentity,
      manifest: result.manifestIdentity,
      intent: {
        bytes: 701,
        fileName: "electron-production-publication-intent-receipt.json",
        sha256: SHA.intent
      }
    });
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.capsule)).toBe(true);
  });

  it("verifies the packed package and directory as one exact identity", async () => {
    const result = capsuleResult();
    const readCapsule = vi.fn(async () => result);
    const readDirectory = vi.fn(async () => directoryResult(result));
    const outputs: Buffer[] = [];

    const summary = await runElectronProductionRecoveryCapsuleCli([
      "verify",
      ...commonArguments(),
      "--capsule-path", CAPSULE_PATH,
      "--capsule-sha256", SHA.capsule,
      "--manifest-sha256", SHA.manifest
    ], {
      readCapsule,
      readDirectory,
      writeStdout: (source) => {
        outputs.push(source);
      }
    });

    expect(readCapsule).toHaveBeenCalledWith({
      binding: expectedBinding(),
      capsulePath: CAPSULE_PATH,
      expectedCapsuleSha256: SHA.capsule
    });
    expect(readDirectory).toHaveBeenCalledWith({
      binding: expectedBinding(),
      expectedManifestSha256: SHA.manifest,
      sourceRoot: SOURCE_ROOT
    });
    expect(summary.command).toBe("verify");
    expect(summary.capsule.sha256).toBe(SHA.capsule);
    expect(summary.manifest.sha256).toBe(SHA.manifest);
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
  });

  it("materializes locally without passing credentials or remote authority", async () => {
    const result = capsuleResult();
    const materializeCapsule = vi.fn(async (
      _input: Parameters<NonNullable<
        ElectronProductionRecoveryCapsuleCliDependencies["materializeCapsule"]
      >>[0]
    ) => ({ ...result, materializedRoot: MATERIALIZED_ROOT }));
    const outputs: Buffer[] = [];

    const summary = await runElectronProductionRecoveryCapsuleCli([
      "materialize",
      ...bindingArguments(),
      "--capsule-path", CAPSULE_PATH,
      "--capsule-sha256", SHA.capsule,
      "--manifest-sha256", SHA.manifest,
      "--output-root", MATERIALIZED_ROOT
    ], {
      materializeCapsule,
      writeStdout: (source) => {
        outputs.push(source);
      }
    });

    expect(materializeCapsule).toHaveBeenCalledWith({
      binding: expectedBinding(),
      capsulePath: CAPSULE_PATH,
      expectedCapsuleSha256: SHA.capsule,
      expectedManifestSha256: SHA.manifest,
      outputRoot: MATERIALIZED_ROOT
    });
    expect(materializeCapsule.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(materializeCapsule.mock.calls[0]?.[0]).not.toHaveProperty("repository");
    expect(summary.command).toBe("materialize");
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);

    await expect(runElectronProductionRecoveryCapsuleCli([
      "materialize",
      ...bindingArguments(),
      "--capsule-path", CAPSULE_PATH,
      "--capsule-sha256", SHA.capsule,
      "--manifest-sha256", SHA.manifest,
      "--output-root", MATERIALIZED_ROOT,
      "--source-root", SOURCE_ROOT
    ], { materializeCapsule })).rejects.toThrow(
      "Unknown materialize option --source-root"
    );
  });

  it.each([
    ["manifest identity", (directory: ReturnType<typeof directoryResult>) => ({
      ...directory,
      manifestIdentity: { ...directory.manifestIdentity, bytes: 903 }
    })],
    ["manifest", (directory: ReturnType<typeof directoryResult>) => ({
      ...directory,
      manifest: { ...directory.manifest, status: "changed" }
    })],
    ["inventory", (directory: ReturnType<typeof directoryResult>) => ({
      ...directory,
      files: {
        ...directory.files,
        "electron-production-publication-intent-receipt.json": {
          bytes: 702,
          sha256: SHA.intent
        }
      }
    })]
  ])("rejects a directory/package %s mismatch without emitting output", async (
    _label,
    mutate
  ) => {
    const result = capsuleResult();
    const outputs: Buffer[] = [];

    await expect(runElectronProductionRecoveryCapsuleCli([
      "verify",
      ...commonArguments(),
      "--capsule-path", CAPSULE_PATH,
      "--capsule-sha256", SHA.capsule,
      "--manifest-sha256", SHA.manifest
    ], {
      readCapsule: async () => result,
      readDirectory: async () => mutate(directoryResult(result)),
      writeStdout: (source) => {
        outputs.push(source);
      }
    })).rejects.toThrow(/differs/u);
    expect(outputs).toHaveLength(0);
  });

  it("rejects unknown, duplicate, missing, and malformed options before work", async () => {
    const createCapsule = vi.fn();
    const dependencies = { createCapsule };
    const base = ["create", ...commonArguments(), "--capsule-output", CAPSULE_PATH];

    await expect(runElectronProductionRecoveryCapsuleCli([
      ...base,
      "--repository", "forbidden"
    ], dependencies)).rejects.toThrow("Unknown create option --repository");
    await expect(runElectronProductionRecoveryCapsuleCli([
      ...base,
      "--source-root", SOURCE_ROOT
    ], dependencies)).rejects.toThrow("Duplicate or empty");
    await expect(runElectronProductionRecoveryCapsuleCli([
      "create",
      "--source-root"
    ], dependencies)).rejects.toThrow("one value");
    await expect(runElectronProductionRecoveryCapsuleCli(
      base.flatMap((value, index) => value === "7" && base[index - 1] ===
        "--lease-generation" ? ["zero"] : [value]),
      dependencies
    )).rejects.toThrow("--lease-generation must be a positive integer");
    expect(createCapsule).not.toHaveBeenCalled();
  });

  it("closes dependency injection and never emits an invalid helper identity", async () => {
    await expect(runElectronProductionRecoveryCapsuleCli([], {
      unexpected: vi.fn()
    } as ElectronProductionRecoveryCapsuleCliDependencies)).rejects.toThrow(
      "Unknown recovery capsule CLI dependency unexpected"
    );

    const outputs: Buffer[] = [];
    await expect(runElectronProductionRecoveryCapsuleCli([
      "create",
      ...commonArguments(),
      "--capsule-output", CAPSULE_PATH
    ], {
      createCapsule: async () => ({
        ...capsuleResult(),
        capsuleIdentity: {
          ...capsuleResult().capsuleIdentity,
          sha256: "not-a-digest"
        },
        manifestPath: "/tmp/manifest"
      }),
      writeStdout: (source) => {
        outputs.push(source);
      }
    } as ElectronProductionRecoveryCapsuleCliDependencies)).rejects.toThrow(
      "packed recovery capsule identity is invalid"
    );
    expect(outputs).toHaveLength(0);
  });
});

function commonArguments(): string[] {
  return [
    "--source-root", SOURCE_ROOT,
    ...bindingArguments()
  ];
}

function bindingArguments(): string[] {
  return [
    "--transaction-id", "11111111-1111-4111-8111-111111111111",
    "--lease-id", "22222222-2222-4222-8222-222222222222",
    "--lease-generation", "7",
    "--lease-event-sha256", SHA.leaseEvent,
    "--control-head-sha", SHA.control,
    "--control-run-id", "701",
    "--control-run-attempt", "3",
    "--candidate-source-sha", SHA.candidateSource,
    "--candidate-version", "23.2.0",
    "--candidate-control-sha", SHA.candidateControl,
    "--candidate-run-id", "702",
    "--candidate-run-attempt", "4",
    "--prior-candidate-source-sha", SHA.priorSource,
    "--prior-candidate-version", "23.1.0",
    "--prior-candidate-control-sha", SHA.priorControl,
    "--prior-candidate-run-id", "703",
    "--prior-candidate-run-attempt", "5"
  ];
}

function expectedBinding() {
  return {
    transaction: { id: "11111111-1111-4111-8111-111111111111" },
    lease: {
      id: "22222222-2222-4222-8222-222222222222",
      generation: 7,
      eventSha256: SHA.leaseEvent
    },
    control: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      event: "workflow_dispatch",
      runId: "701",
      runAttempt: 3,
      headSha: SHA.control
    },
    candidate: {
      sourceSha: SHA.candidateSource,
      version: "23.2.0",
      controlSha: SHA.candidateControl,
      runId: "702",
      runAttempt: 4
    },
    priorCandidate: {
      sourceSha: SHA.priorSource,
      version: "23.1.0",
      controlSha: SHA.priorControl,
      runId: "703",
      runAttempt: 5
    }
  };
}

function capsuleResult(): ElectronProductionRecoveryCapsuleCliReadResult {
  return {
    capsuleIdentity: {
      bytes: 2_104,
      fileName: "electron-production-publication-recovery-capsule.capsule.json",
      sha256: SHA.capsule
    },
    manifestIdentity: {
      bytes: 902,
      fileName: "electron-production-publication-recovery-capsule-manifest.json",
      sha256: SHA.manifest
    },
    manifest: {
      kind: "rion-electron-production-publication-recovery-capsule",
      status: "attested-pre-mutation-intent"
    },
    files: {
      "electron-production-publication-intent-receipt.json": {
        bytes: 701,
        sha256: SHA.intent
      },
      "electron-production-publication-recovery-capsule-manifest.json": {
        bytes: 902,
        sha256: SHA.manifest
      }
    }
  };
}

function directoryResult(result: ElectronProductionRecoveryCapsuleCliReadResult) {
  return {
    files: result.files,
    manifest: result.manifest,
    manifestIdentity: result.manifestIdentity,
    sourceRoot: SOURCE_ROOT
  };
}
