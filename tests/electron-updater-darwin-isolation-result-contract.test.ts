import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND,
  ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME,
  writeElectronUpdaterDarwinProcessIsolationResult
} from "../scripts/electronUpdaterDarwinIsolationResultContract.mjs";
import {
  MACOS_ATTEMPT_NONCE,
  MACOS_COMMAND_SHA256,
  MACOS_HELPER_ATTEMPT,
  MACOS_SANDBOX_SHA256,
  createMacosCompatibilityFinalizerFixture
} from "./support/electronUpdaterMacosCompatibilityFinalizerFixture";

describe("Electron updater Darwin isolation result contract", () => {
  it("writes factory-backed active-zero evidence as canonical create-new JSON", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const source = await readFile(fixture.isolationResultPath);

      expect(source).toEqual(serializeCanonicalJson(fixture.isolation.result));
      expect(fixture.isolation.result).toMatchObject({
        schemaVersion: 1,
        kind: ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND,
        platform: "darwin",
        attemptNonce: MACOS_ATTEMPT_NONCE,
        commandInvocationSha256: MACOS_COMMAND_SHA256,
        helperAttemptId: MACOS_HELPER_ATTEMPT,
        containment: {
          kind: "darwin-seatbelt-detached-cargo-process-group-v1",
          childSandbox: "seatbelt-v1",
          cargoProcessGroupOutcome: "active-zero",
          sandboxProfileSha256: MACOS_SANDBOX_SHA256
        },
        supervisor: {
          kind: "rion-electron-updater-darwin-supervisor-isolation",
          outcome: "active-zero",
          admittedIdentity: {
            auditToken: "ab".repeat(32),
            processId: 90_001
          }
        },
        activeProcessesAfterCleanup: 0,
        cleanupVerified: true
      });
      expect(Object.keys(fixture.isolation.result).sort()).toEqual([
        "activeProcessesAfterCleanup",
        "attemptNonce",
        "cleanupVerified",
        "commandInvocationSha256",
        "completedAt",
        "containment",
        "helperAttemptId",
        "kind",
        "platform",
        "schemaVersion",
        "supervisor"
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a serialized or caller-forged supervisor capability", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    const forgedRoot = await mkdtemp(join(tmpdir(), "rion-updater-forged-isolation-"));
    try {
      await expect(writeElectronUpdaterDarwinProcessIsolationResult({
        attemptNonce: MACOS_ATTEMPT_NONCE,
        cargoProcessGroupId: 91_001,
        cargoProcessGroupOutcome: "active-zero",
        childOutputRoot: forgedRoot,
        childSandbox: "seatbelt-v1",
        cleanupVerified: true,
        commandInvocationSha256: MACOS_COMMAND_SHA256,
        helperAttemptId: MACOS_HELPER_ATTEMPT,
        isolationEvidence: {
          ...fixture.isolation.result.supervisor,
          admittedIdentity: {
            ...fixture.isolation.result.supervisor.admittedIdentity
          }
        } as never,
        outputPath: join(
          forgedRoot,
          ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME
        ),
        sandboxProfileSha256: MACOS_SANDBOX_SHA256
      })).rejects.toThrow("supervisor-issued capability");
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(forgedRoot, { force: true, recursive: true })
      ]);
    }
  });
});
