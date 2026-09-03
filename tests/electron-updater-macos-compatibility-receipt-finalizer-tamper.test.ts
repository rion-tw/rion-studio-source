import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  createMacosCompatibilityFinalizerFixture,
  finalizeMacosCompatibilityFixture,
  sha256
} from "./support/electronUpdaterMacosCompatibilityFinalizerFixture";

describe("macOS compatibility terminal receipt tamper rejection", () => {
  it("requires the exact parent-observed isolation result digest", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      fixture.expected.isolationResultSha256 = sha256("another isolation result");
      await expect(finalizeMacosCompatibilityFixture(fixture)).rejects.toThrow(
        "Darwin process isolation result SHA-256 does not match"
      );
      await expect(lstat(fixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects non-active cleanup even when its new digest is supplied", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const value = JSON.parse(await readFile(fixture.isolationResultPath, "utf8"));
      value.activeProcessesAfterCleanup = 1;
      const source = serializeCanonicalJson(value);
      await writeFile(fixture.isolationResultPath, source);
      fixture.expected.isolationResultSha256 = sha256(source);
      await writeFile(
        fixture.commandExecutablePath,
        "command bytes that must not be read before active-zero\n"
      );

      await expect(finalizeMacosCompatibilityFixture(fixture)).rejects.toThrow(
        "Darwin isolation active process count does not match"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rereads exact parent command inputs only after active-zero", async () => {
    const executableFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await writeFile(
        executableFixture.commandExecutablePath,
        "replaced macOS command executable\n"
      );
      await expect(
        finalizeMacosCompatibilityFixture(executableFixture)
      ).rejects.toThrow("macOS isolation command executable SHA-256 does not match");
      await expect(lstat(executableFixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await executableFixture.cleanup();
    }

    const symlinkFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const linkedHarnessPath = join(symlinkFixture.root, "linked-command-harness.mjs");
      await symlink(symlinkFixture.commandHarnessPath, linkedHarnessPath);
      symlinkFixture.expected.isolationCommandHarnessPath = linkedHarnessPath;
      await expect(
        finalizeMacosCompatibilityFixture(symlinkFixture)
      ).rejects.toThrow("must be a bounded, nonempty, single-link regular file");
    } finally {
      await symlinkFixture.cleanup();
    }

    const canonicalPathFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const commandRootAlias = join(canonicalPathFixture.root, "command-root-alias");
      await symlink(canonicalPathFixture.root, commandRootAlias, "dir");
      canonicalPathFixture.expected.isolationCommandHarnessPath = join(
        commandRootAlias,
        "runElectronUpdaterTransactionProbe.mjs"
      );
      await expect(
        finalizeMacosCompatibilityFixture(canonicalPathFixture)
      ).rejects.toThrow("macOS isolation command harness canonical path does not match");
    } finally {
      await canonicalPathFixture.cleanup();
    }

    const boundaryFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const childHarnessPath = join(
        boundaryFixture.childOutputRoot,
        "child-controlled-command-harness.mjs"
      );
      const childHarness = Buffer.from("child-controlled command harness\n", "utf8");
      await writeFile(childHarnessPath, childHarness);
      boundaryFixture.expected.isolationCommandHarnessPath = childHarnessPath;
      boundaryFixture.expected.isolationCommandHarnessSha256 = sha256(childHarness);
      await expect(
        finalizeMacosCompatibilityFixture(boundaryFixture)
      ).rejects.toThrow("must stay outside the child-authorized root");
    } finally {
      await boundaryFixture.cleanup();
    }
  });

  it("revalidates the admitted executable identity after child exit", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await writeFile(
        fixture.isolation.result.supervisor.mainExecutable.path,
        "replaced Electron executable bytes\n",
        { mode: 0o700 }
      );
      await expect(finalizeMacosCompatibilityFixture(fixture)).rejects.toThrow(
        "Darwin admitted bundle executable bytes does not match"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("cross-binds immutable v22 input and target trust before output", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      fixture.expected.updaterPublicKeySha256 = sha256("different trust root");
      await expect(finalizeMacosCompatibilityFixture(fixture)).rejects.toThrow(
        "expected macOS updater public-key SHA-256 does not match"
      );
      await expect(lstat(fixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("cross-binds observed source and target versions before output", async () => {
    const priorFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await mutateProvisionalReceipt(priorFixture.provisionalReceiptPath, (receipt) => {
        receipt.cases[2].sourceVersion = "23.1.0";
      });
      await expect(finalizeMacosCompatibilityFixture(priorFixture)).rejects.toThrow();
      await expect(lstat(priorFixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await priorFixture.cleanup();
    }

    const v22Fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await mutateProvisionalReceipt(v22Fixture.provisionalReceiptPath, (receipt) => {
        receipt.cases[1].sourceVersion = "22.8.1";
        receipt.cases[3].sourceVersion = "22.8.1";
      });
      await expect(finalizeMacosCompatibilityFixture(v22Fixture)).rejects.toThrow();
      await expect(lstat(v22Fixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await v22Fixture.cleanup();
    }

    const targetFixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await mutateProvisionalReceipt(targetFixture.provisionalReceiptPath, (receipt) => {
        for (const observation of receipt.cases.slice(1)) {
          observation.targetVersion = "23.3.0";
        }
      });
      await expect(finalizeMacosCompatibilityFixture(targetFixture)).rejects.toThrow();
      await expect(lstat(targetFixture.sealedOutputRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await targetFixture.cleanup();
    }
  });
});

async function mutateProvisionalReceipt(
  receiptPath: string,
  mutate: (receipt: {
    cases: Array<{
      sourceVersion?: string;
      targetVersion?: string;
    }>;
  }) => void
) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(receipt);
  await writeFile(receiptPath, serializeCanonicalJson(receipt));
}
