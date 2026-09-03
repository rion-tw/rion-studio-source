import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ElectronProductionRecoveryStoreRemoteCliFailure,
  runElectronProductionRecoveryStoreRemoteCli,
  type ElectronProductionRecoveryStoreRemoteCliDependencies
} from "../scripts/electronProductionRecoveryStoreRemoteCli.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteFetch,
  ElectronProductionRecoveryStoreRemoteRequestInit,
  ElectronProductionRecoveryStoreRemoteResponse
} from "../scripts/electronProductionRecoveryStoreRemote.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  readElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  serializeElectronProductionRecoveryStoreRemoteOperationReceipt,
  serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteOperationRequest,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";

const SECRET_TOKEN = "ghp_recovery_cli_must_never_emit_this";
const EXPECTED_HEAD = "a".repeat(40);
const ROOT_TREE = "b".repeat(40);
const OLD_CAPSULE_TREE = "c".repeat(40);
const NEW_ROOT_TREE = "d".repeat(40);
const NEW_CAPSULE_TREE = "e".repeat(40);
const NEW_COMMIT = "f".repeat(40);
const PRIOR_PARENT = "1".repeat(40);
const PACKAGE_NAME = "recovery-package.json";
const PACKAGE_SOURCE = Buffer.from("canonical recovery package\n", "utf8");
const PACKAGE_SHA256 = sha256(PACKAGE_SOURCE);
const PACKAGE_BLOB_SHA = gitBlobSha(PACKAGE_SOURCE);
const COMMIT_MESSAGE = `recovery: store package ${PACKAGE_SHA256}`;
const TARGET = {
  owner: "example-owner",
  repo: "private-recovery",
  ref: "main",
  path: `capsules/${PACKAGE_NAME}`,
  repositoryPolicy: {
    defaultBranch: "main",
    visibility: "private"
  }
} as const;
const REPOSITORY_URL =
  "https://api.github.com/repos/example-owner/private-recovery";
const READ_REF_URL = `${REPOSITORY_URL}/git/ref/heads/main`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery-store remote CLI", () => {
  it("stores an explicit private target and emits one canonical create-new applied receipt", async () => {
    const paths = await operationPaths();
    const harness = cliHarness(...successfulCreationSteps());

    const summary = await runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      harness.dependencies
    );

    expect(summary.receipt).toMatchObject({
      terminal: { classification: "applied", reason: null, httpStatus: null },
      requestIdentity: {
        target: {
          repository: "example-owner/private-recovery",
          ref: "main",
          path: TARGET.path,
          repositoryPolicy: TARGET.repositoryPolicy
        },
        package: {
          fileName: PACKAGE_NAME,
          byteLength: PACKAGE_SOURCE.length,
          sha256: PACKAGE_SHA256
        }
      },
      applied: {
        parentCommitSha: EXPECTED_HEAD,
        commitSha: NEW_COMMIT,
        treeSha: NEW_ROOT_TREE,
        blobSha: PACKAGE_BLOB_SHA,
        byteLength: PACKAGE_SOURCE.length
      }
    });
    if (!summary.receiptIdentity) throw new Error("Expected receipt identity.");
    const reread = await readElectronProductionRecoveryStoreRemoteOperationReceipt({
      receiptPath: paths.outputPath,
      expectedSha256: summary.receiptIdentity.sha256
    });
    expect(reread.receipt).toEqual(summary.receipt);
    expect(await readFile(paths.outputPath)).toEqual(
      serializeElectronProductionRecoveryStoreRemoteOperationReceipt(summary.receipt)
    );
    expect(harness.outputs).toEqual([await readFile(paths.outputPath)]);
    const request = createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: EXPECTED_HEAD,
      packageIdentity: {
        fileName: PACKAGE_NAME,
        byteLength: PACKAGE_SOURCE.length,
        sha256: PACKAGE_SHA256
      },
      target: TARGET
    });
    expect(() => verifyElectronProductionRecoveryStoreRemoteOperationRequest({
      receipt: summary.receipt,
      request
    })).not.toThrow();
    expect(harness.calls[0]?.url).toBe(REPOSITORY_URL);
    expect(harness.calls[1]?.url).toBe(READ_REF_URL);
    expect(harness.calls[0]?.init.headers.Authorization)
      .toBe(`Bearer ${SECRET_TOKEN}`);
    expect(harness.calls.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(harness.exitCodes).toEqual([]);
  });

  it("writes a canonical rejected receipt without exposing any Git object identity", async () => {
    const paths = await operationPaths();
    const harness = cliHarness(repositoryResponse({
      private: false,
      visibility: "public"
    }));

    const failure = await capturedFailure(runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      harness.dependencies
    ));

    expect(failure.summary.receipt).toMatchObject({
      terminal: {
        classification: "rejected",
        reason: "repository-policy-mismatch",
        httpStatus: 200
      },
      applied: null
    });
    const source = await readFile(paths.outputPath, "utf8");
    expect(source).not.toContain(EXPECTED_HEAD);
    for (const field of [
      "parentCommitSha",
      "commitSha",
      "treeSha",
      "blobSha"
    ]) {
      expect(source).not.toContain(`"${field}"`);
    }
    expect(harness.outputs.map((value) => value.toString("utf8"))).toEqual([source]);
    expect(harness.exitCodes).toEqual([1]);
    expect(harness.calls).toHaveLength(1);
  });

  it("preserves an indeterminate transport result, redacts errors, and never retries", async () => {
    const paths = await operationPaths();
    const harness = cliHarness(
      new Error(`transport response contained ${SECRET_TOKEN}`)
    );

    const failure = await capturedFailure(runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      harness.dependencies
    ));

    expect(failure.summary.receipt.terminal).toEqual({
      classification: "indeterminate",
      reason: "transport",
      httpStatus: null
    });
    if (failure.summary.receipt.operation !== "create") {
      throw new Error("Expected a create operation receipt.");
    }
    expect(failure.summary.receipt.applied).toBeNull();
    expect(failure.message).not.toContain(SECRET_TOKEN);
    expect((await readFile(paths.outputPath, "utf8"))).not.toContain(SECRET_TOKEN);
    expect(harness.calls).toHaveLength(1);
    expect(harness.exitCodes).toEqual([1]);
  });

  it("reads credentials only from GH_TOKEN and rejects token-shaped inputs", async () => {
    const paths = await operationPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      { ...harness.dependencies, environment: {} }
    )).rejects.toThrow("GH_TOKEN is required");
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...createArguments(paths),
      "--token", SECRET_TOKEN
    ], harness.dependencies)).rejects.toThrow("Unknown create option --token");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      {
        ...harness.dependencies,
        token: SECRET_TOKEN
      } as ElectronProductionRecoveryStoreRemoteCliDependencies
    )).rejects.toThrow("Unknown recovery-store CLI dependency token");
    expect(harness.calls).toHaveLength(0);
    expect(harness.outputs).toHaveLength(0);
  });

  it("requires every explicit target and private-policy option before fetch", async () => {
    const paths = await operationPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      withoutOption(createArguments(paths), "repo"),
      harness.dependencies
    )).rejects.toThrow("--repo is required");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(createArguments(paths), "repository-visibility", "public"),
      harness.dependencies
    )).rejects.toThrow("must be private");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(createArguments(paths), "repository-default-branch", "other"),
      harness.dependencies
    )).rejects.toThrow("expected default branch");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(createArguments(paths), "expected-head-sha", "A".repeat(40)),
      harness.dependencies
    )).rejects.toThrow("lowercase 40-character commit SHA");
    expect(harness.calls).toHaveLength(0);
  });

  it("validates package and create-new output paths before mutation", async () => {
    const paths = await operationPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(createArguments(paths), "package", PACKAGE_NAME),
      harness.dependencies
    )).rejects.toThrow("absolute path");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(createArguments(paths), "path", "capsules/foreign.json"),
      harness.dependencies
    )).rejects.toThrow("target filename does not match");
    await writeFile(paths.outputPath, "preexisting", { mode: 0o600 });
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      createArguments(paths),
      harness.dependencies
    )).rejects.toThrow("must be create-new");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects duplicate, unknown, and incomplete syntax without side effects", async () => {
    const paths = await operationPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...createArguments(paths),
      "--owner", TARGET.owner
    ], harness.dependencies)).rejects.toThrow("Duplicate");
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      "create", "--owner"
    ], harness.dependencies)).rejects.toThrow("must have one value");
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...createArguments(paths),
      "--commit-message", "caller controlled"
    ], harness.dependencies)).rejects.toThrow("Unknown create option --commit-message");
    expect(harness.calls).toHaveLength(0);
    expect(harness.outputs).toHaveLength(0);
  });
});

describe("Electron production recovery-store remote read CLI", () => {
  it("writes exact fresh-read bytes and one canonical redacted present receipt", async () => {
    const paths = await readPaths();
    const harness = cliHarness(...stableFreshPresentSteps());

    const summary = await runElectronProductionRecoveryStoreRemoteCli(
      readArguments(paths),
      harness.dependencies
    );

    if (summary.receipt.operation !== "read") {
      throw new Error("Expected a read operation receipt.");
    }
    expect(await readFile(paths.contentOutputPath)).toEqual(PACKAGE_SOURCE);
    expect(summary.receipt).toMatchObject({
      requestIdentity: {
        target: {
          repository: "example-owner/private-recovery",
          ref: TARGET.ref,
          path: TARGET.path,
          repositoryPolicy: TARGET.repositoryPolicy
        },
        expectedContent: { byteLength: null, sha256: null }
      },
      terminal: { classification: "present", reason: null, httpStatus: null },
      observed: {
        headCommitSha: NEW_COMMIT,
        treeSha: NEW_ROOT_TREE,
        blobSha: PACKAGE_BLOB_SHA,
        parentCommitShas: [EXPECTED_HEAD],
        file: {
          fileName: PACKAGE_NAME,
          byteLength: PACKAGE_SOURCE.length,
          sha256: PACKAGE_SHA256
        }
      }
    });
    if (!summary.receiptIdentity) throw new Error("Expected receipt identity.");
    const reread =
      await readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
        receiptPath: paths.operationOutputPath,
        expectedSha256: summary.receiptIdentity.sha256
      });
    expect(reread.receipt).toEqual(summary.receipt);
    expect(await readFile(paths.operationOutputPath)).toEqual(
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
        summary.receipt
      )
    );
    expect(harness.outputs).toEqual([await readFile(paths.operationOutputPath)]);
    const request = createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: { byteLength: null, sha256: null },
      target: TARGET
    });
    expect(() => verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
      receipt: summary.receipt,
      request
    })).not.toThrow();
    const emitted = harness.outputs[0]?.toString("utf8") ?? "";
    expect(emitted).not.toContain(PACKAGE_SOURCE.toString("base64"));
    expect(emitted).not.toContain(SECRET_TOKEN);
    expect(emitted).not.toContain("contentBase64");
    expect(harness.calls).toHaveLength(stableFreshPresentSteps().length);
    expect(harness.calls.every(({ init }) => init.method === "GET")).toBe(true);
    expect(harness.calls.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(harness.exitCodes).toEqual([]);
  });

  it("accepts optional exact SHA-256 and byte fences", async () => {
    const paths = await readPaths();
    const harness = cliHarness(...stableFreshPresentSteps());

    const summary = await runElectronProductionRecoveryStoreRemoteCli([
      ...readArguments(paths),
      "--expected-content-sha256", PACKAGE_SHA256,
      "--expected-content-bytes", String(PACKAGE_SOURCE.length)
    ], harness.dependencies);

    if (summary.receipt.operation !== "read") {
      throw new Error("Expected a read operation receipt.");
    }
    expect(summary.receipt.requestIdentity.expectedContent).toEqual({
      byteLength: PACKAGE_SOURCE.length,
      sha256: PACKAGE_SHA256
    });
    expect(await readFile(paths.contentOutputPath)).toEqual(PACKAGE_SOURCE);
    expect(harness.exitCodes).toEqual([]);
  });

  it("rejects an identity mismatch without writing content or Git IDs", async () => {
    const paths = await readPaths();
    const harness = cliHarness(...stableFreshPresentSteps());

    const failure = await capturedFailure(
      runElectronProductionRecoveryStoreRemoteCli([
        ...readArguments(paths),
        "--expected-content-sha256", sha256(Buffer.from("other", "utf8")),
        "--expected-content-bytes", String(PACKAGE_SOURCE.length + 1)
      ], harness.dependencies)
    );

    if (failure.summary.receipt.operation !== "read") {
      throw new Error("Expected a read operation receipt.");
    }
    expect(failure.summary.receipt.terminal).toEqual({
      classification: "rejected",
      reason: "content-identity-mismatch",
      httpStatus: null
    });
    expect(failure.summary.receipt.observed).toBeNull();
    await expect(readFile(paths.contentOutputPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    const receiptSource = await readFile(paths.operationOutputPath, "utf8");
    for (const identity of [
      NEW_COMMIT,
      NEW_ROOT_TREE,
      EXPECTED_HEAD,
      PACKAGE_BLOB_SHA
    ]) expect(receiptSource).not.toContain(identity);
    expect(harness.exitCodes).toEqual([1]);
  });

  it("records absent and transport terminals without creating content", async () => {
    for (const scenario of [
      {
        steps: stableInitialAbsentSteps(),
        terminal: {
          classification: "absent",
          reason: "path-absent",
          httpStatus: null
        }
      },
      {
        steps: [new Error(`transport contained ${SECRET_TOKEN}`)],
        terminal: {
          classification: "indeterminate",
          reason: "transport",
          httpStatus: null
        }
      }
    ] as const) {
      const paths = await readPaths();
      const harness = cliHarness(...scenario.steps);
      const failure = await capturedFailure(
        runElectronProductionRecoveryStoreRemoteCli(
          readArguments(paths),
          harness.dependencies
        )
      );
      if (failure.summary.receipt.operation !== "read") {
        throw new Error("Expected a read operation receipt.");
      }
      expect(failure.summary.receipt.terminal).toEqual(scenario.terminal);
      expect(failure.summary.receipt.observed).toBeNull();
      await expect(readFile(paths.contentOutputPath)).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await readFile(paths.operationOutputPath, "utf8"))
        .not.toContain(SECRET_TOKEN);
      expect(harness.exitCodes).toEqual([1]);
    }
  });

  it("removes its exact new content file when stable reread fails", async () => {
    const paths = await readPaths();
    const harness = cliHarness(...stableFreshPresentSteps());

    const failure = await capturedFailure(
      runElectronProductionRecoveryStoreRemoteCli(
        readArguments(paths),
        {
          ...harness.dependencies,
          rereadContentFile: async () => {
            throw new Error(`reread contained ${SECRET_TOKEN}`);
          }
        }
      )
    );

    if (failure.summary.receipt.operation !== "read") {
      throw new Error("Expected a read operation receipt.");
    }
    expect(failure.summary.receipt.terminal).toEqual({
      classification: "indeterminate",
      reason: "content-verification-failed",
      httpStatus: null
    });
    expect(failure.summary.receipt.observed).toBeNull();
    await expect(readFile(paths.contentOutputPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(paths.operationOutputPath, "utf8"))
      .not.toContain(SECRET_TOKEN);
    expect(harness.exitCodes).toEqual([1]);
  });

  it("removes only its exact content inode when receipt persistence fails", async () => {
    const exactPaths = await readPaths();
    const exactHarness = cliHarness(...stableFreshPresentSteps());
    const exactFailure = await capturedFailure(
      runElectronProductionRecoveryStoreRemoteCli(
        readArguments(exactPaths),
        {
          ...exactHarness.dependencies,
          rereadContentFile: async (filePath) => {
            const source = await readFile(filePath);
            await writeFile(exactPaths.operationOutputPath, "raced receipt", {
              flag: "wx",
              mode: 0o600
            });
            return {
              bytes: source.length,
              sha256: sha256(source),
              source
            };
          }
        }
      )
    );
    expect(exactFailure.summary.localFailure).toBe("receipt-output-failed");
    await expect(readFile(exactPaths.contentOutputPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(exactPaths.operationOutputPath, "utf8"))
      .toBe("raced receipt");

    const replacementPaths = await readPaths();
    const replacementHarness = cliHarness(...stableFreshPresentSteps());
    const replacement = Buffer.from("replacement must survive\n", "utf8");
    const replacementFailure = await capturedFailure(
      runElectronProductionRecoveryStoreRemoteCli(
        readArguments(replacementPaths),
        {
          ...replacementHarness.dependencies,
          rereadContentFile: async (filePath) => {
            const source = await readFile(filePath);
            const replacementPath = `${filePath}.replacement`;
            await writeFile(replacementPath, replacement, {
              flag: "wx",
              mode: 0o600
            });
            await rm(filePath);
            await rename(replacementPath, filePath);
            await writeFile(
              replacementPaths.operationOutputPath,
              "raced receipt",
              { flag: "wx", mode: 0o600 }
            );
            return {
              bytes: source.length,
              sha256: sha256(source),
              source
            };
          }
        }
      )
    );
    expect(replacementFailure.summary.localFailure).toBe("receipt-output-failed");
    expect(await readFile(replacementPaths.contentOutputPath)).toEqual(replacement);
  });

  it("preserves verified content after the receipt succeeds but stdout fails", async () => {
    const paths = await readPaths();
    const harness = cliHarness(...stableFreshPresentSteps());

    const failure = await capturedFailure(
      runElectronProductionRecoveryStoreRemoteCli(
        readArguments(paths),
        {
          ...harness.dependencies,
          writeStdout: () => {
            throw new Error(`stdout contained ${SECRET_TOKEN}`);
          }
        }
      )
    );

    expect(failure.summary.localFailure).toBe("stdout-output-failed");
    expect(failure.summary.receiptIdentity).not.toBeNull();
    expect(await readFile(paths.contentOutputPath)).toEqual(PACKAGE_SOURCE);
    await expect(readFile(paths.operationOutputPath)).resolves.toEqual(
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
        failure.summary.receipt
      )
    );
    expect(harness.exitCodes).toEqual([1]);
  });

  it("rejects invalid or pre-existing read outputs before fetch and preserves them", async () => {
    const paths = await readPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      replaceOption(
        readArguments(paths),
        "content-output",
        path.join(path.dirname(paths.contentOutputPath), "foreign.json")
      ),
      harness.dependencies
    )).rejects.toThrow("filename does not match");
    await writeFile(paths.contentOutputPath, "preexisting", { mode: 0o600 });
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      readArguments(paths),
      harness.dependencies
    )).rejects.toThrow("must be create-new");
    expect(await readFile(paths.contentOutputPath, "utf8")).toBe("preexisting");
    expect(harness.calls).toHaveLength(0);
  });

  it("reads only GH_TOKEN and rejects invalid optional identities before fetch", async () => {
    const paths = await readPaths();
    const harness = cliHarness();
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...readArguments(paths),
      "--token", SECRET_TOKEN
    ], harness.dependencies)).rejects.toThrow("Unknown read option --token");
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...readArguments(paths),
      "--expected-content-sha256", "A".repeat(64)
    ], harness.dependencies)).rejects.toThrow("lowercase SHA-256");
    await expect(runElectronProductionRecoveryStoreRemoteCli([
      ...readArguments(paths),
      "--expected-content-bytes", "01"
    ], harness.dependencies)).rejects.toThrow("positive decimal byte count");
    await expect(runElectronProductionRecoveryStoreRemoteCli(
      readArguments(paths),
      { ...harness.dependencies, environment: {} }
    )).rejects.toThrow("GH_TOKEN is required");
    expect(harness.calls).toHaveLength(0);
  });
});

interface FetchCall {
  readonly init: ElectronProductionRecoveryStoreRemoteRequestInit;
  readonly url: string;
}

interface Harness {
  readonly calls: FetchCall[];
  readonly dependencies: ElectronProductionRecoveryStoreRemoteCliDependencies;
  readonly exitCodes: number[];
  readonly outputs: Buffer[];
}

function cliHarness(
  ...steps: Array<ElectronProductionRecoveryStoreRemoteResponse | Error>
): Harness {
  const calls: FetchCall[] = [];
  const outputs: Buffer[] = [];
  const exitCodes: number[] = [];
  const fetchImpl: ElectronProductionRecoveryStoreRemoteFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error("Unexpected fetch call.");
    if (step instanceof Error) throw step;
    return step;
  };
  return {
    calls,
    outputs,
    exitCodes,
    dependencies: {
      environment: { GH_TOKEN: SECRET_TOKEN },
      fetchImpl,
      setExitCode: (code) => exitCodes.push(code),
      writeStdout: (source) => {
        outputs.push(Buffer.from(source));
      }
    }
  };
}

function successfulCreationSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    ...initialAbsentSteps(),
    jsonResponse({ sha: PACKAGE_BLOB_SHA }, 201),
    jsonResponse({ sha: NEW_ROOT_TREE }, 201),
    commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [EXPECTED_HEAD], COMMIT_MESSAGE, 201),
    refResponse(NEW_COMMIT),
    ...freshPresentSteps()
  ];
}

function initialAbsentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    repositoryResponse(),
    refResponse(EXPECTED_HEAD),
    commitResponse(EXPECTED_HEAD, ROOT_TREE, [PRIOR_PARENT], "previous commit"),
    treeResponse(ROOT_TREE, [treeEntry("capsules", OLD_CAPSULE_TREE)]),
    treeResponse(OLD_CAPSULE_TREE, [])
  ];
}

function freshPresentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    repositoryResponse(),
    refResponse(NEW_COMMIT),
    commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [EXPECTED_HEAD], COMMIT_MESSAGE),
    treeResponse(NEW_ROOT_TREE, [treeEntry("capsules", NEW_CAPSULE_TREE)]),
    treeResponse(NEW_CAPSULE_TREE, [blobEntry(PACKAGE_NAME, PACKAGE_BLOB_SHA)]),
    blobResponse(PACKAGE_SOURCE)
  ];
}

function stableInitialAbsentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [...initialAbsentSteps(), refResponse(EXPECTED_HEAD)];
}

function stableFreshPresentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [...freshPresentSteps(), refResponse(NEW_COMMIT)];
}

function repositoryResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    default_branch: TARGET.repositoryPolicy.defaultBranch,
    full_name: `${TARGET.owner}/${TARGET.repo}`,
    private: true,
    visibility: "private",
    ...overrides
  });
}

function refResponse(sha: string) {
  return jsonResponse({
    object: { sha, type: "commit" },
    ref: `refs/heads/${TARGET.ref}`
  });
}

function commitResponse(
  sha: string,
  treeSha: string,
  parents: string[],
  message: string,
  status = 200
) {
  return jsonResponse({
    message,
    parents: parents.map((parentSha) => ({ sha: parentSha })),
    sha,
    tree: { sha: treeSha }
  }, status);
}

function treeResponse(sha: string, tree: unknown[]) {
  return jsonResponse({ sha, tree, truncated: false });
}

function treeEntry(entryPath: string, sha: string) {
  return { mode: "040000", path: entryPath, sha, type: "tree" };
}

function blobEntry(entryPath: string, sha: string) {
  return { mode: "100644", path: entryPath, sha, type: "blob" };
}

function blobResponse(source: Buffer) {
  return jsonResponse({
    content: source.toString("base64"),
    encoding: "base64",
    sha: gitBlobSha(source),
    size: source.length
  });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

async function operationPaths() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-recovery-store-cli-"));
  temporaryDirectories.push(directory);
  const packagePath = path.join(directory, PACKAGE_NAME);
  const outputPath = path.join(
    directory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  await writeFile(packagePath, PACKAGE_SOURCE, { mode: 0o600 });
  return { packagePath, outputPath };
}

async function readPaths() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-recovery-read-cli-"));
  temporaryDirectories.push(directory);
  const contentDirectory = path.join(directory, "content");
  const operationDirectory = path.join(directory, "operation");
  await Promise.all([
    mkdir(contentDirectory, { mode: 0o700 }),
    mkdir(operationDirectory, { mode: 0o700 })
  ]);
  return {
    contentOutputPath: path.join(contentDirectory, PACKAGE_NAME),
    operationOutputPath: path.join(
      operationDirectory,
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
    )
  };
}

function createArguments(paths: { packagePath: string; outputPath: string }) {
  return [
    "create",
    "--owner", TARGET.owner,
    "--repo", TARGET.repo,
    "--ref", TARGET.ref,
    "--path", TARGET.path,
    "--repository-visibility", TARGET.repositoryPolicy.visibility,
    "--repository-default-branch", TARGET.repositoryPolicy.defaultBranch,
    "--expected-head-sha", EXPECTED_HEAD,
    "--package", paths.packagePath,
    "--output", paths.outputPath
  ];
}

function readArguments(paths: {
  contentOutputPath: string;
  operationOutputPath: string;
}) {
  return [
    "read",
    "--owner", TARGET.owner,
    "--repo", TARGET.repo,
    "--ref", TARGET.ref,
    "--path", TARGET.path,
    "--repository-visibility", TARGET.repositoryPolicy.visibility,
    "--repository-default-branch", TARGET.repositoryPolicy.defaultBranch,
    "--content-output", paths.contentOutputPath,
    "--operation-output", paths.operationOutputPath
  ];
}

function replaceOption(argumentsList: string[], name: string, value: string) {
  const copy = [...argumentsList];
  const index = copy.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing fixture option --${name}.`);
  copy[index + 1] = value;
  return copy;
}

function withoutOption(argumentsList: string[], name: string) {
  const copy = [...argumentsList];
  const index = copy.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing fixture option --${name}.`);
  copy.splice(index, 2);
  return copy;
}

async function capturedFailure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ElectronProductionRecoveryStoreRemoteCliFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the recovery-store CLI to fail.");
}

function sha256(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
