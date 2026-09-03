import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  createCompatibilityFinalizerFixture,
  finalizeCompatibilityFixture,
  sha256
} from "./support/electronUpdaterCompatibilityFinalizerFixture";

describe("Windows compatibility terminal receipt tamper rejection", () => {
  it("rejects provisional fields that claim parent-recomputable identity", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      const provisional = JSON.parse(
        await readFile(fixture.provisionalReceiptPath, "utf8")
      );
      provisional.targetVersion = "99.0.0";
      await writeFile(
        fixture.provisionalReceiptPath,
        serializeCanonicalJson(provisional)
      );

      await expect(finalizeCompatibilityFixture(fixture)).rejects.toThrow(
        "provisional compatibility receipt has an unexpected schema"
      );
      await expect(lstat(fixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects noncanonical sealed v22 input before creating output", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      const inputReceipt = JSON.parse(
        await readFile(fixture.inputReceiptPath, "utf8")
      );
      await writeFile(
        fixture.inputReceiptPath,
        `${JSON.stringify(inputReceipt)}\n`
      );
      fixture.expected.tauriV22InputReceiptSha256 = sha256(
        await readFile(fixture.inputReceiptPath)
      );

      await expect(finalizeCompatibilityFixture(fixture)).rejects.toThrow(
        "Tauri v22 input receipt is not canonical JSON"
      );
      await expect(lstat(fixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a changed prepared receipt digest or target payload", async () => {
    const digestFixture = await createCompatibilityFinalizerFixture();
    try {
      digestFixture.expected.preparedInputReceiptSha256 = sha256(
        "different prepared receipt"
      );
      await expect(finalizeCompatibilityFixture(digestFixture)).rejects.toThrow(
        "prepared-input receipt SHA-256 does not match"
      );
    } finally {
      await digestFixture.cleanup();
    }

    const payloadFixture = await createCompatibilityFinalizerFixture();
    try {
      await writeFile(payloadFixture.preparedArtifactPath, "tampered target artifact");
      await expect(finalizeCompatibilityFixture(payloadFixture)).rejects.toThrow(
        "prepared updater artifact changed after signing"
      );
    } finally {
      await payloadFixture.cleanup();
    }
  });

  it("cross-binds the immutable v22 input to expected updater trust", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      fixture.expected.updaterPublicKeySha256 = sha256("different trust root");
      await expect(finalizeCompatibilityFixture(fixture)).rejects.toThrow(
        "expected updater public-key SHA-256 does not match"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires outer active-zero and the exact parent invocation", async () => {
    const activeFixture = await createCompatibilityFinalizerFixture();
    try {
      await writeFile(
        activeFixture.isolationResultPath,
        serializeCanonicalJson({
          ...activeFixture.isolationResult,
          activeProcessesAfterRootExit: 1
        })
      );
      await expect(finalizeCompatibilityFixture(activeFixture)).rejects.toThrow(
        "did not reach active-zero"
      );
    } finally {
      await activeFixture.cleanup();
    }

    const invocationFixture = await createCompatibilityFinalizerFixture();
    try {
      invocationFixture.expected.isolationCommandInvocationSha256 = sha256(
        "another invocation"
      );
      await expect(finalizeCompatibilityFixture(invocationFixture)).rejects.toThrow(
        "outer Windows command invocation SHA-256 does not match"
      );
    } finally {
      await invocationFixture.cleanup();
    }
  });

  it("cross-binds parent-reread command inputs and the prepared deny list", async () => {
    const executableFixture = await createCompatibilityFinalizerFixture();
    try {
      await writeFile(
        executableFixture.commandExecutablePath,
        "replaced command executable"
      );
      await expect(finalizeCompatibilityFixture(executableFixture)).rejects.toThrow(
        "command executable pre-run SHA-256 does not match"
      );
    } finally {
      await executableFixture.cleanup();
    }

    const harnessFixture = await createCompatibilityFinalizerFixture();
    try {
      const result = {
        ...harnessFixture.isolationResult,
        attestedInputs: {
          ...harnessFixture.isolationResult.attestedInputs,
          commandHarness: {
            ...harnessFixture.isolationResult.attestedInputs.commandHarness,
            sha256: sha256("forged harness attestation")
          }
        }
      };
      await writeFile(
        harnessFixture.isolationResultPath,
        serializeCanonicalJson(result)
      );
      await expect(finalizeCompatibilityFixture(harnessFixture)).rejects.toThrow(
        "attested command harness sha256 does not match"
      );
    } finally {
      await harnessFixture.cleanup();
    }

    const denyListFixture = await createCompatibilityFinalizerFixture();
    try {
      const result = {
        ...denyListFixture.isolationResult,
        attestedInputs: {
          ...denyListFixture.isolationResult.attestedInputs,
          forbiddenSourceList: {
            ...denyListFixture.isolationResult.attestedInputs.forbiddenSourceList,
            bytes: 1
          }
        }
      };
      await writeFile(
        denyListFixture.isolationResultPath,
        serializeCanonicalJson(result)
      );
      await expect(finalizeCompatibilityFixture(denyListFixture)).rejects.toThrow(
        "attested forbidden-source list bytes does not match"
      );
    } finally {
      await denyListFixture.cleanup();
    }
  });

  it("fails if the child predicted or occupied the sibling sealed root", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      await mkdir(fixture.sealedOutputRoot);
      await expect(finalizeCompatibilityFixture(fixture)).rejects.toThrow(
        "created only after child active-zero"
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
