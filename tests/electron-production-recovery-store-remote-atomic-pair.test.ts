import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createElectronProductionRecoveryStoreRemoteAtomicPair,
  type ElectronProductionRecoveryStoreRemoteFetch,
  type ElectronProductionRecoveryStoreRemoteRequestInit,
  type ElectronProductionRecoveryStoreRemoteResponse
} from "../scripts/electronProductionRecoveryStoreRemote.mjs";
import {
  runElectronProductionRecoveryStoreRemoteCli
} from "../scripts/electronProductionRecoveryStoreRemoteCli.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
  readElectronProductionRecoveryStoreAtomicPairOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";

const TOKEN = "github-app-token";
const OWNER = "example-owner";
const REPO = "recovery-ledger";
const REF = "protected/main";
const FIRST_PATH = "transactions/tx/recovery-outcomes/attempt.json";
const SECOND_PATH = "transactions/tx/recovery-outcomes/terminal.json";
const target = (storePath: string) => ({
  owner: OWNER,
  repo: REPO,
  ref: REF,
  path: storePath,
  repositoryPolicy: { defaultBranch: REF, visibility: "private" as const }
});
const TARGETS = [target(FIRST_PATH), target(SECOND_PATH)] as const;
const REPOSITORY_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;
const READ_REF_URL = `${REPOSITORY_URL}/git/ref/heads/protected/main`;
const UPDATE_REF_URL = `${REPOSITORY_URL}/git/refs/heads/protected/main`;
const HEAD = "a".repeat(40);
const ROOT_TREE = "b".repeat(40);
const TRANSACTIONS_TREE = "c".repeat(40);
const TRANSACTION_TREE = "d".repeat(40);
const OUTCOMES_TREE = "e".repeat(40);
const NEW_TREE = "1".repeat(40);
const NEW_TRANSACTIONS_TREE = "2".repeat(40);
const NEW_TRANSACTION_TREE = "3".repeat(40);
const NEW_OUTCOMES_TREE = "4".repeat(40);
const NEW_COMMIT = "5".repeat(40);
const PRIOR_PARENT = "6".repeat(40);
const CONTENT = Buffer.from("terminal recovery outcome\n", "utf8");
const BLOB = gitBlobSha(CONTENT);
const MESSAGE = "recovery: store terminal outcome atomically";
const CLI_MESSAGE = `recovery: store package ${sha256(CONTENT)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery-store atomic-pair transport", () => {
  it("creates both absent paths with one blob, one commit, and one ref PATCH", async () => {
    const remote = successfulPairCreation(NEW_COMMIT);

    await expect(createElectronProductionRecoveryStoreRemoteAtomicPair({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      targets: TARGETS,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "applied",
      blobSha: BLOB,
      byteLength: CONTENT.length,
      commitSha: NEW_COMMIT,
      parentSha: HEAD,
      paths: [FIRST_PATH, SECOND_PATH],
      treeSha: NEW_TREE
    });

    const patchCalls = remote.calls.filter(({ init }) => init.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.url).toBe(UPDATE_REF_URL);
    expect(requestBody(patchCalls[0])).toEqual({
      force: false,
      sha: NEW_COMMIT
    });
    const treeCreate = remote.calls.find(({ url, init }) =>
      url === `${REPOSITORY_URL}/git/trees` && init.method === "POST"
    );
    expect(requestBody(treeCreate)).toEqual({
      base_tree: ROOT_TREE,
      tree: [
        { mode: "100644", path: FIRST_PATH, sha: BLOB, type: "blob" },
        { mode: "100644", path: SECOND_PATH, sha: BLOB, type: "blob" }
      ]
    });
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
    expect(remote.calls.at(-1)?.init.method).toBe("GET");
  });

  it("fails closed if the closing ref moves after both paths were reread", async () => {
    const remote = successfulPairCreation("7".repeat(40));

    await expect(createElectronProductionRecoveryStoreRemoteAtomicPair({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      targets: TARGETS,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
    expect(remote.calls.filter(({ init }) => init.method === "PATCH"))
      .toHaveLength(1);
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
  });

  it("rejects a partial pre-existing pair without creating objects or updating ref", async () => {
    const remote = sequenceFetch(
      repositoryResponse(),
      refResponse(HEAD),
      commitResponse(HEAD, ROOT_TREE, [PRIOR_PARENT], "previous commit"),
      ...pathSteps(ROOT_TREE, OUTCOMES_TREE, [blobEntry("attempt.json", BLOB)]),
      ...pathSteps(ROOT_TREE, OUTCOMES_TREE, [])
    );

    await expect(createElectronProductionRecoveryStoreRemoteAtomicPair({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      targets: TARGETS,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "path-conflict",
      status: 200
    });
    expect(remote.calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it("rejects unsorted or cross-repository targets before any request", async () => {
    const unsorted = sequenceFetch();
    await expect(createElectronProductionRecoveryStoreRemoteAtomicPair({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: unsorted.fetchImpl,
      targets: [TARGETS[1], TARGETS[0]],
      token: TOKEN
    })).rejects.toThrow("distinct, sorted, and co-located");
    expect(unsorted.calls).toHaveLength(0);

    const crossRepository = sequenceFetch();
    await expect(createElectronProductionRecoveryStoreRemoteAtomicPair({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: crossRepository.fetchImpl,
      targets: [TARGETS[0], { ...TARGETS[1], repo: "foreign" }],
      token: TOKEN
    })).rejects.toThrow("distinct, sorted, and co-located");
    expect(crossRepository.calls).toHaveLength(0);
  });

  it("writes one canonical atomic-pair receipt through the credentialled CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rion-atomic-pair-cli-"));
    temporaryDirectories.push(root);
    const packagePath = path.join(root, "terminal-outcome.json");
    const operationPath = path.join(
      root,
      ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE
    );
    await writeFile(packagePath, CONTENT, { flag: "wx", mode: 0o600 });
    const remote = successfulPairCreation(NEW_COMMIT, CLI_MESSAGE);
    const stdout: Buffer[] = [];

    const summary = await runElectronProductionRecoveryStoreRemoteCli([
      "create-atomic-pair",
      "--owner", OWNER,
      "--repo", REPO,
      "--ref", REF,
      "--first-path", FIRST_PATH,
      "--second-path", SECOND_PATH,
      "--repository-visibility", "private",
      "--repository-default-branch", REF,
      "--expected-head-sha", HEAD,
      "--package", packagePath,
      "--output", operationPath
    ], {
      environment: { GH_TOKEN: TOKEN },
      fetchImpl: remote.fetchImpl,
      writeStdout: (source) => {
        stdout.push(Buffer.from(source));
      }
    });

    expect(summary.receipt.terminal.classification).toBe("applied");
    expect(summary.receiptIdentity?.fileName).toBe(
      ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE
    );
    expect(stdout).toHaveLength(1);
    const read =
      await readElectronProductionRecoveryStoreAtomicPairOperationReceipt({
        receiptPath: operationPath,
        expectedSha256: summary.receiptIdentity!.sha256
      });
    expect(read.receipt.applied?.paths).toEqual([FIRST_PATH, SECOND_PATH]);
    expect(remote.calls.filter(({ init }) => init.method === "PATCH"))
      .toHaveLength(1);
  });
});

interface FetchCall {
  readonly init: ElectronProductionRecoveryStoreRemoteRequestInit;
  readonly url: string;
}

function successfulPairCreation(closingHead: string, message = MESSAGE) {
  return sequenceFetch(
    ...absentPairSteps(),
    jsonResponse({ sha: BLOB }, 201),
    jsonResponse({ sha: NEW_TREE }, 201),
    commitResponse(NEW_COMMIT, NEW_TREE, [HEAD], message, 201),
    refResponse(NEW_COMMIT),
    ...presentPairSteps(message),
    refResponse(closingHead)
  );
}

function absentPairSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    repositoryResponse(),
    refResponse(HEAD),
    commitResponse(HEAD, ROOT_TREE, [PRIOR_PARENT], "previous commit"),
    ...pathSteps(ROOT_TREE, OUTCOMES_TREE, []),
    ...pathSteps(ROOT_TREE, OUTCOMES_TREE, [])
  ];
}

function presentPairSteps(
  message = MESSAGE
): ElectronProductionRecoveryStoreRemoteResponse[] {
  const entries = [
    blobEntry("attempt.json", BLOB),
    blobEntry("terminal.json", BLOB)
  ];
  return [
    repositoryResponse(),
    refResponse(NEW_COMMIT),
    commitResponse(NEW_COMMIT, NEW_TREE, [HEAD], message),
    ...pathSteps(NEW_TREE, NEW_OUTCOMES_TREE, entries, true),
    ...pathSteps(NEW_TREE, NEW_OUTCOMES_TREE, entries, true),
    blobResponse(CONTENT)
  ];
}

function pathSteps(
  rootTree: string,
  outcomesTree: string,
  entries: unknown[],
  fresh = false
): ElectronProductionRecoveryStoreRemoteResponse[] {
  const transactionsTree = fresh ? NEW_TRANSACTIONS_TREE : TRANSACTIONS_TREE;
  const transactionTree = fresh ? NEW_TRANSACTION_TREE : TRANSACTION_TREE;
  return [
    treeResponse(rootTree, [treeEntry("transactions", transactionsTree)]),
    treeResponse(transactionsTree, [treeEntry("tx", transactionTree)]),
    treeResponse(transactionTree, [treeEntry("recovery-outcomes", outcomesTree)]),
    treeResponse(outcomesTree, entries)
  ];
}

function sequenceFetch(
  ...steps: Array<ElectronProductionRecoveryStoreRemoteResponse | Error>
) {
  const calls: FetchCall[] = [];
  const fetchImpl: ElectronProductionRecoveryStoreRemoteFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error("Unexpected fetch call.");
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchImpl };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function repositoryResponse() {
  return jsonResponse({
    default_branch: REF,
    full_name: `${OWNER}/${REPO}`,
    private: true,
    visibility: "private"
  });
}

function refResponse(sha: string) {
  return jsonResponse({
    object: { sha, type: "commit" },
    ref: `refs/heads/${REF}`
  });
}

function commitResponse(
  sha: string,
  treeSha: string,
  parentShas: string[],
  message: string,
  status = 200
) {
  return jsonResponse({
    message,
    parents: parentShas.map((parentSha) => ({ sha: parentSha })),
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

function requestBody(call: FetchCall | undefined) {
  if (!call?.init.body) throw new Error("Expected a request body.");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function sha256(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
