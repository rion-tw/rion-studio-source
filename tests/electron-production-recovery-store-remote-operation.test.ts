import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  assertElectronProductionRecoveryStoreRemoteOperationReceipt,
  assertElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadFailureReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadRequestSha256,
  electronProductionRecoveryStoreRemoteRequestSha256,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  readElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  serializeElectronProductionRecoveryStoreRemoteOperationReceipt,
  serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteOperationRequest,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt,
  writeElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";

const EXPECTED_HEAD = "a".repeat(40);
const PACKAGE_SHA256 = digest("recovery package");
const TARGET = {
  owner: "example-owner",
  repo: "private-recovery",
  ref: "main",
  path: "capsules/recovery-package.json",
  repositoryPolicy: {
    defaultBranch: "main",
    visibility: "private"
  }
} as const;
const PACKAGE_IDENTITY = {
  fileName: "recovery-package.json",
  byteLength: 4096,
  sha256: PACKAGE_SHA256
} as const;
const READ_SOURCE = Buffer.from("canonical recovered package\n", "utf8");
const READ_SHA256 = createHash("sha256").update(READ_SOURCE).digest("hex");
const READ_BLOB_SHA = gitBlobSha(READ_SOURCE);
const READ_TREE_SHA = "5".repeat(40);
const READ_PARENT_SHA = "6".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery-store remote operation receipt", () => {
  it("derives one canonical request identity without recording a local package path", () => {
    const request = recoveryRequest();
    const receipt = appliedReceipt(request);

    expect(request).toEqual({
      schemaVersion: 1,
      kind: "rion-electron-production-recovery-store-remote-request",
      operation: "create",
      target: {
        repository: "example-owner/private-recovery",
        ref: "main",
        path: TARGET.path,
        repositoryPolicy: TARGET.repositoryPolicy
      },
      expectedHeadSha: EXPECTED_HEAD,
      package: PACKAGE_IDENTITY,
      commitMessage: `recovery: store package ${PACKAGE_SHA256}`
    });
    expect(receipt.requestIdentity.requestSha256).toBe(
      electronProductionRecoveryStoreRemoteRequestSha256(request)
    );
    expect(receipt.requestIdentity.expectedHeadSha256).toBe(
      digest(EXPECTED_HEAD)
    );
    expect(receipt.requestIdentity.commitMessageSha256).toBe(
      digest(request.commitMessage)
    );
    expect(JSON.stringify(receipt)).not.toContain("/tmp/");
    expect(() => verifyElectronProductionRecoveryStoreRemoteOperationRequest({
      receipt,
      request
    })).not.toThrow();
  });

  it("records exact applied Git identities and produces a consumer-verifiable digest", () => {
    const request = recoveryRequest();
    const receipt = appliedReceipt(request);
    const source = serializeElectronProductionRecoveryStoreRemoteOperationReceipt(
      receipt
    );

    expect(receipt).toMatchObject({
      terminal: {
        classification: "applied",
        reason: null,
        httpStatus: null
      },
      applied: {
        parentCommitSha: EXPECTED_HEAD,
        commitSha: "b".repeat(40),
        treeSha: "c".repeat(40),
        blobSha: "d".repeat(40),
        byteLength: PACKAGE_IDENTITY.byteLength
      }
    });
    expect(source).toEqual(serializeCanonicalJson(receipt));
    expect(electronProductionRecoveryStoreRemoteOperationReceiptSha256(receipt))
      .toBe(createHash("sha256").update(source).digest("hex"));
  });

  it.each([
    ["rejected", "conflict", 422],
    ["indeterminate", "unknown-acknowledgement", null]
  ] as const)("redacts all Git object IDs from a %s terminal receipt", (
    outcome,
    reason,
    status
  ) => {
    const request = recoveryRequest();
    const receipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
      request,
      result: { outcome, reason, status } as never
    });
    const source = serializeElectronProductionRecoveryStoreRemoteOperationReceipt(
      receipt
    ).toString("utf8");

    expect(receipt.terminal).toEqual({
      classification: outcome,
      reason,
      httpStatus: status
    });
    expect(receipt.applied).toBeNull();
    expect(source).not.toContain(EXPECTED_HEAD);
    for (const field of [
      "parentCommitSha",
      "commitSha",
      "treeSha",
      "blobSha"
    ]) {
      expect(source).not.toContain(`"${field}"`);
    }
  });

  it("rejects a non-applied result that attempts to smuggle an object identity", () => {
    expect(() => createElectronProductionRecoveryStoreRemoteOperationReceipt({
      request: recoveryRequest(),
      result: {
        outcome: "indeterminate",
        reason: "transport",
        status: null,
        blobSha: "d".repeat(40)
      } as never
    })).toThrow("unexpected schema");
  });

  it("rejects request, terminal, and applied-identity tampering", () => {
    const request = recoveryRequest();
    const receipt = appliedReceipt(request);

    const requestTamper = structuredClone(receipt) as unknown as {
      requestIdentity: { requestSha256: string };
    };
    requestTamper.requestIdentity.requestSha256 = "f".repeat(64);
    expect(() => verifyElectronProductionRecoveryStoreRemoteOperationRequest({
      receipt: requestTamper,
      request
    })).toThrow(/request SHA-256.*does not match/u);

    const terminalTamper = structuredClone(receipt) as unknown as {
      terminal: { classification: string };
    };
    terminalTamper.terminal.classification = "rejected";
    expect(() => assertElectronProductionRecoveryStoreRemoteOperationReceipt(
      terminalTamper
    )).toThrow("terminal result");

    const parentTamper = structuredClone(receipt) as unknown as {
      applied: null | { parentCommitSha: string };
    };
    if (!parentTamper.applied) throw new Error("Expected applied fixture.");
    parentTamper.applied.parentCommitSha = "9".repeat(40);
    expect(() => assertElectronProductionRecoveryStoreRemoteOperationReceipt(
      parentTamper
    )).toThrow("parent request fence");
  });

  it("writes and rereads a canonical create-new receipt by external digest", async () => {
    const receipt = appliedReceipt(recoveryRequest());
    const directory = await temporaryDirectory();
    const outputPath = path.join(
      directory,
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
    );
    const written = await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath,
      receipt
    });

    expect(await readFile(outputPath)).toEqual(
      serializeElectronProductionRecoveryStoreRemoteOperationReceipt(receipt)
    );
    await expect(readElectronProductionRecoveryStoreRemoteOperationReceipt({
      receiptPath: outputPath,
      expectedSha256: written.receiptIdentity.sha256
    })).resolves.toEqual(written);
    await expect(readElectronProductionRecoveryStoreRemoteOperationReceipt({
      receiptPath: outputPath,
      expectedSha256: "f".repeat(64)
    })).rejects.toThrow("SHA-256 does not match");
    await expect(writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath,
      receipt
    })).rejects.toThrow("must be create-new");
  });
});

describe("Electron production recovery-store remote read operation receipt", () => {
  it("supports a first read without a pre-known identity and records exact observation proof", () => {
    const request = recoveryReadRequest();
    const receipt = presentReadReceipt(request);
    const source =
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(receipt);

    expect(request).toEqual({
      schemaVersion: 1,
      kind: "rion-electron-production-recovery-store-remote-read-request",
      operation: "read",
      target: {
        repository: "example-owner/private-recovery",
        ref: "main",
        path: TARGET.path,
        repositoryPolicy: TARGET.repositoryPolicy
      },
      expectedContent: { byteLength: null, sha256: null }
    });
    expect(receipt).toMatchObject({
      terminal: { classification: "present", reason: null, httpStatus: null },
      observed: {
        headCommitSha: EXPECTED_HEAD,
        treeSha: READ_TREE_SHA,
        blobSha: READ_BLOB_SHA,
        parentCommitShas: [READ_PARENT_SHA],
        file: {
          fileName: PACKAGE_IDENTITY.fileName,
          byteLength: READ_SOURCE.length,
          sha256: READ_SHA256
        }
      }
    });
    expect(receipt.requestIdentity.requestSha256).toBe(
      electronProductionRecoveryStoreRemoteReadRequestSha256(request)
    );
    expect(source).toEqual(serializeCanonicalJson(receipt));
    expect(source.toString("utf8")).not.toContain(READ_SOURCE.toString("base64"));
    expect(source.toString("utf8")).not.toContain("contentBase64");
    expect(electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(receipt))
      .toBe(createHash("sha256").update(source).digest("hex"));
    expect(() => verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
      receipt,
      request
    })).not.toThrow();
  });

  it("accepts exact optional content fences and redacts a mismatch", () => {
    const matchingRequest = recoveryReadRequest({
      byteLength: READ_SOURCE.length,
      sha256: READ_SHA256
    });
    expect(presentReadReceipt(matchingRequest).terminal.classification)
      .toBe("present");

    const mismatchedRequest = recoveryReadRequest({
      byteLength: READ_SOURCE.length + 1,
      sha256: digest("different content")
    });
    const receipt = presentReadReceipt(mismatchedRequest);
    const source =
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(receipt)
        .toString("utf8");

    expect(receipt.terminal).toEqual({
      classification: "rejected",
      reason: "content-identity-mismatch",
      httpStatus: null
    });
    expect(receipt.observed).toBeNull();
    for (const identity of [
      EXPECTED_HEAD,
      READ_TREE_SHA,
      READ_BLOB_SHA,
      READ_PARENT_SHA
    ]) expect(source).not.toContain(identity);
    expect(source).not.toContain("headCommitSha");
  });

  it.each([
    [
      "absent",
      {
        outcome: "absent",
        commitMessage: "no package",
        headSha: EXPECTED_HEAD,
        parentShas: [READ_PARENT_SHA],
        treeSha: READ_TREE_SHA
      },
      { classification: "absent", reason: "path-absent", httpStatus: null }
    ],
    [
      "rejected",
      { outcome: "rejected", reason: "repository-policy-mismatch", status: 200 },
      {
        classification: "rejected",
        reason: "repository-policy-mismatch",
        httpStatus: 200
      }
    ],
    [
      "indeterminate",
      { outcome: "indeterminate", reason: "transport", status: null },
      { classification: "indeterminate", reason: "transport", httpStatus: null }
    ]
  ] as const)("redacts observed identities from a %s read", (
    _label,
    result,
    terminal
  ) => {
    const receipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      content: null,
      request: recoveryReadRequest(),
      result
    });
    const source =
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(receipt)
        .toString("utf8");

    expect(receipt.terminal).toEqual(terminal);
    expect(receipt.observed).toBeNull();
    expect(source).not.toContain(EXPECTED_HEAD);
    expect(source).not.toContain(READ_TREE_SHA);
    expect(source).not.toContain(READ_PARENT_SHA);
    expect(source).not.toContain("headCommitSha");
  });

  it("rejects schema, request digest, and present observation tampering", () => {
    const request = recoveryReadRequest({
      byteLength: READ_SOURCE.length,
      sha256: READ_SHA256
    });
    const receipt = presentReadReceipt(request);
    const requestTamper = structuredClone(receipt) as unknown as {
      requestIdentity: { requestSha256: string };
    };
    requestTamper.requestIdentity.requestSha256 = "f".repeat(64);
    expect(() => assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      requestTamper
    )).toThrow(/read request SHA-256.*does not match/u);

    const observedTamper = structuredClone(receipt) as unknown as {
      observed: null | { file: { sha256: string } };
    };
    if (!observedTamper.observed) throw new Error("Expected read observation.");
    observedTamper.observed.file.sha256 = digest("tampered content");
    expect(() => assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      observedTamper
    )).toThrow("observed content identity does not match");

    const nonPresentTamper = structuredClone(receipt) as unknown as {
      terminal: { classification: string; reason: string; httpStatus: number | null };
    };
    nonPresentTamper.terminal = {
      classification: "absent",
      reason: "path-absent",
      httpStatus: null
    };
    expect(() => assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
      nonPresentTamper
    )).toThrow("cannot expose Git identities");
  });

  it("writes and rereads one canonical create-new read receipt by digest", async () => {
    const receipt = presentReadReceipt(recoveryReadRequest());
    const directory = await temporaryDirectory();
    const outputPath = path.join(
      directory,
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
    );
    const written =
      await writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
        outputPath,
        receipt
      });

    expect(await readFile(outputPath)).toEqual(
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(receipt)
    );
    await expect(readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: outputPath,
      expectedSha256: written.receiptIdentity.sha256
    })).resolves.toEqual(written);
    await expect(readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: outputPath,
      expectedSha256: "f".repeat(64)
    })).rejects.toThrow("SHA-256 does not match");
    await expect(writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath,
      receipt
    })).rejects.toThrow("must be create-new");
  });

  it("creates a redacted local output failure receipt", () => {
    const receipt = createElectronProductionRecoveryStoreRemoteReadFailureReceipt({
      request: recoveryReadRequest(),
      reason: "content-verification-failed"
    });

    expect(receipt.terminal).toEqual({
      classification: "indeterminate",
      reason: "content-verification-failed",
      httpStatus: null
    });
    expect(receipt.observed).toBeNull();
  });
});

function recoveryRequest() {
  return createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: EXPECTED_HEAD,
    packageIdentity: PACKAGE_IDENTITY,
    target: TARGET
  });
}

function appliedReceipt(request: ReturnType<typeof recoveryRequest>) {
  return createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request,
    result: {
      outcome: "applied",
      parentSha: EXPECTED_HEAD,
      commitSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      blobSha: "d".repeat(40),
      byteLength: PACKAGE_IDENTITY.byteLength
    }
  });
}

function recoveryReadRequest(expectedContent: {
  byteLength: number | null;
  sha256: string | null;
} = { byteLength: null, sha256: null }) {
  return createElectronProductionRecoveryStoreRemoteReadRequest({
    expectedContent,
    target: TARGET
  });
}

function presentReadReceipt(request: ReturnType<typeof recoveryReadRequest>) {
  return createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    content: READ_SOURCE,
    request,
    result: {
      outcome: "present",
      blobSha: READ_BLOB_SHA,
      byteLength: READ_SOURCE.length,
      commitMessage: "stored recovery package",
      contentBase64: READ_SOURCE.toString("base64"),
      headSha: EXPECTED_HEAD,
      parentShas: [READ_PARENT_SHA],
      treeSha: READ_TREE_SHA
    }
  });
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-recovery-store-operation-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
