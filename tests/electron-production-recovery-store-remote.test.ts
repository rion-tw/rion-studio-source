import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
  createElectronProductionRecoveryStoreRemote,
  readElectronProductionRecoveryStoreRemote,
  type ElectronProductionRecoveryStoreRemoteFetch,
  type ElectronProductionRecoveryStoreRemoteRequestInit,
  type ElectronProductionRecoveryStoreRemoteResponse
} from "../scripts/electronProductionRecoveryStoreRemote.mjs";

const TOKEN = "github-app-token";
const TARGET = {
  owner: "example-owner",
  repo: "recovery-ledger",
  ref: "protected/main",
  path: "capsules/transaction.json",
  repositoryPolicy: {
    defaultBranch: "protected/main",
    visibility: "private"
  }
} as const;
const REPOSITORY_URL = "https://api.github.com/repos/example-owner/recovery-ledger";
const READ_REF_URL = `${REPOSITORY_URL}/git/ref/heads/protected/main`;
const UPDATE_REF_URL = `${REPOSITORY_URL}/git/refs/heads/protected/main`;
const HEAD = "a".repeat(40);
const ROOT_TREE = "b".repeat(40);
const OLD_CAPSULE_TREE = "c".repeat(40);
const NEW_ROOT_TREE = "d".repeat(40);
const NEW_CAPSULE_TREE = "e".repeat(40);
const NEW_COMMIT = "f".repeat(40);
const PRIOR_PARENT = "1".repeat(40);
const CONTENT = Buffer.from("sealed recovery capsule\n", "utf8");
const CONTENT_BLOB = gitBlobSha(CONTENT);
const MESSAGE = "recovery: preserve transaction capsule";

describe("Electron production recovery-store Git Database transport", () => {
  it("creates one immutable path from the exact observed parent and verifies it from the ref", async () => {
    const remote = successfulCreation();

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "applied",
      blobSha: CONTENT_BLOB,
      byteLength: CONTENT.length,
      commitSha: NEW_COMMIT,
      parentSha: HEAD,
      treeSha: NEW_ROOT_TREE
    });

    expect(remote.calls.map(({ url }) => url)).toEqual([
      REPOSITORY_URL,
      READ_REF_URL,
      `${REPOSITORY_URL}/git/commits/${HEAD}`,
      `${REPOSITORY_URL}/git/trees/${ROOT_TREE}`,
      `${REPOSITORY_URL}/git/trees/${OLD_CAPSULE_TREE}`,
      `${REPOSITORY_URL}/git/blobs`,
      `${REPOSITORY_URL}/git/trees`,
      `${REPOSITORY_URL}/git/commits`,
      UPDATE_REF_URL,
      REPOSITORY_URL,
      READ_REF_URL,
      `${REPOSITORY_URL}/git/commits/${NEW_COMMIT}`,
      `${REPOSITORY_URL}/git/trees/${NEW_ROOT_TREE}`,
      `${REPOSITORY_URL}/git/trees/${NEW_CAPSULE_TREE}`,
      `${REPOSITORY_URL}/git/blobs/${CONTENT_BLOB}`
    ]);
    expect(requestBody(remote.calls[5])).toEqual({
      content: CONTENT.toString("base64"),
      encoding: "base64"
    });
    expect(requestBody(remote.calls[6])).toEqual({
      base_tree: ROOT_TREE,
      tree: [{
        mode: "100644",
        path: TARGET.path,
        sha: CONTENT_BLOB,
        type: "blob"
      }]
    });
    expect(requestBody(remote.calls[7])).toEqual({
      message: MESSAGE,
      parents: [HEAD],
      tree: NEW_ROOT_TREE
    });
    expect(requestBody(remote.calls[8])).toEqual({
      force: false,
      sha: NEW_COMMIT
    });
    expect(remote.calls[0]?.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(remote.calls.every(({ init }) => init.redirect === "error")).toBe(true);
  });

  it("reads the exact head, tree path, blob identity, and bytes", async () => {
    const remote = sequenceFetch(...freshPresentSteps(), refResponse(NEW_COMMIT));

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "present",
      blobSha: CONTENT_BLOB,
      byteLength: CONTENT.length,
      commitMessage: MESSAGE,
      contentBase64: CONTENT.toString("base64"),
      headSha: NEW_COMMIT,
      parentShas: [HEAD],
      treeSha: NEW_ROOT_TREE
    });
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
  });

  it("reports an absent path together with the exact head fence", async () => {
    const remote = sequenceFetch(...initialAbsentSteps(), refResponse(HEAD));

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "absent",
      commitMessage: "previous commit",
      headSha: HEAD,
      parentShas: [PRIOR_PARENT],
      treeSha: ROOT_TREE
    });
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
  });

  it("returns indeterminate when the ref changes after exact blob traversal", async () => {
    const remote = sequenceFetch(
      ...freshPresentSteps(),
      refResponse("2".repeat(40))
    );

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
    expect(remote.calls).toHaveLength(freshPresentSteps().length + 1);
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
  });

  it("returns indeterminate when the ref changes after an absent path traversal", async () => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      refResponse("2".repeat(40))
    );

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
    expect(remote.calls).toHaveLength(initialAbsentSteps().length + 1);
    expect(remote.calls.at(-1)?.url).toBe(READ_REF_URL);
  });

  it("rejects a stale expected head before creating any Git objects", async () => {
    const remote = sequenceFetch(...initialAbsentSteps());

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: "9".repeat(40),
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "conflict", status: 200 });
    expect(remote.calls).toHaveLength(5);
    expect(remote.calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it("preserves create-new path semantics and never overwrites an existing capsule", async () => {
    const remote = sequenceFetch(...freshPresentSteps());

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: NEW_COMMIT,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "path-exists", status: 200 });
    expect(remote.calls).toHaveLength(6);
    expect(remote.calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it.each([409, 422])("classifies a %s non-forced ref rejection as a conflict", async (status) => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      jsonResponse({ sha: CONTENT_BLOB }, 201),
      jsonResponse({ sha: NEW_ROOT_TREE }, 201),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE, 201),
      jsonResponse({ message: "ref conflict must stay redacted" }, status)
    );

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "conflict", status });
    expect(remote.calls).toHaveLength(9);
  });

  it("treats a ref transport failure as unknown acknowledgement and does not retry", async () => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      jsonResponse({ sha: CONTENT_BLOB }, 201),
      jsonResponse({ sha: NEW_ROOT_TREE }, 201),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE, 201),
      new Error(`connection reset after ${TOKEN}`)
    );

    const result = await createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    });
    expect(result).toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: null
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result).not.toHaveProperty("blobSha");
    expect(result).not.toHaveProperty("commitSha");
    expect(remote.calls).toHaveLength(9);
  });

  it("keeps a mutation 5xx indeterminate and leaves orphan objects non-authoritative", async () => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      jsonResponse({ message: "server included sensitive raw output" }, 503)
    );

    const result = await createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    });
    expect(result).toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: 503
    });
    expect(JSON.stringify(result)).not.toContain("sensitive raw output");
    expect(remote.calls).toHaveLength(6);
  });

  it("does not authorize created objects when the mandatory fresh reread fails", async () => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      jsonResponse({ sha: CONTENT_BLOB }, 201),
      jsonResponse({ sha: NEW_ROOT_TREE }, 201),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE, 201),
      refResponse(NEW_COMMIT),
      repositoryResponse(),
      jsonResponse({ ref: "refs/heads/foreign" })
    );

    const result = await createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    });
    expect(result).toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
    expect(result).not.toHaveProperty("commitSha");
    expect(remote.calls).toHaveLength(11);
  });

  it("requires the fresh commit to retain the exact observed parent", async () => {
    const remote = sequenceFetch(
      ...initialAbsentSteps(),
      jsonResponse({ sha: CONTENT_BLOB }, 201),
      jsonResponse({ sha: NEW_ROOT_TREE }, 201),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE, 201),
      refResponse(NEW_COMMIT),
      repositoryResponse(),
      refResponse(NEW_COMMIT),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, ["9".repeat(40)], MESSAGE),
      treeResponse(NEW_ROOT_TREE, [treeEntry("capsules", NEW_CAPSULE_TREE)]),
      treeResponse(NEW_CAPSULE_TREE, [blobEntry("transaction.json", CONTENT_BLOB)]),
      blobResponse(CONTENT)
    );

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: HEAD,
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
  });

  it("rejects forged blob bytes even when the tree names the expected blob", async () => {
    const forged = Buffer.from("forged recovery capsule\n", "utf8");
    const remote = sequenceFetch(
      repositoryResponse(),
      refResponse(NEW_COMMIT),
      commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE),
      treeResponse(NEW_ROOT_TREE, [treeEntry("capsules", NEW_CAPSULE_TREE)]),
      treeResponse(NEW_CAPSULE_TREE, [blobEntry("transaction.json", CONTENT_BLOB)]),
      jsonResponse({
        content: forged.toString("base64"),
        encoding: "base64",
        sha: CONTENT_BLOB,
        size: forged.length
      })
    );

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "malformed-record",
      status: 200
    });
  });

  it("bounds every streamed API response before parsing it", async () => {
    const remote = sequenceFetch(new Response("{}", {
      headers: { "Content-Length": "999999999" },
      status: 200
    }));

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "malformed-record",
      status: 200
    });
  });

  it.each(["invalid", "999999999"])(
    "cancels a response whose declared length %s is invalid before rejection",
    async (declaredLength) => {
      let cancelled = false;
      const remote = sequenceFetch(declaredLengthResponse(
        declaredLength,
        () => { cancelled = true; }
      ));

      await expect(readElectronProductionRecoveryStoreRemote({
        fetchImpl: remote.fetchImpl,
        target: TARGET,
        token: TOKEN
      })).resolves.toEqual({
        outcome: "rejected",
        reason: "malformed-record",
        status: 200
      });
      expect(cancelled).toBe(true);
    }
  );

  it.each([
    ["public visibility", { visibility: "public", private: false }],
    ["foreign full name", { full_name: "example-owner/foreign" }],
    ["foreign default branch", { default_branch: "foreign" }]
  ] as const)("rejects repository metadata with %s before reading its ref", async (
    _label,
    overrides
  ) => {
    const remote = sequenceFetch(repositoryResponse(overrides));

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "repository-policy-mismatch",
      status: 200
    });
    expect(remote.calls).toHaveLength(1);
  });

  it.each([
    ["owner", "bad/owner"],
    ["repo", "bad repo"],
    ["ref", "main..foreign"],
    ["path", "../capsule.json"]
  ] as const)("rejects an unsafe target %s before making a request", async (field, value) => {
    const remote = sequenceFetch();
    const target = { ...TARGET, [field]: value };

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target,
      token: TOKEN
    })).rejects.toThrow(/recovery-store/u);
    expect(remote.calls).toHaveLength(0);
  });

  it("rejects non-canonical 40-hex head fences without exposing credentials", async () => {
    const remote = sequenceFetch();
    const secretToken = "very-secret-token";

    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: CONTENT,
      expectedHeadSha: "A".repeat(40),
      fetchImpl: remote.fetchImpl,
      target: TARGET,
      token: secretToken
    })).rejects.not.toThrow(secretToken);
    expect(remote.calls).toHaveLength(0);
  });

  it("requires an explicit private default-branch policy matching the target ref", async () => {
    const remote = sequenceFetch();

    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: remote.fetchImpl,
      target: {
        ...TARGET,
        repositoryPolicy: {
          defaultBranch: "main",
          visibility: "private"
        }
      },
      token: TOKEN
    })).rejects.toThrow("expected default branch");
    expect(remote.calls).toHaveLength(0);
  });

  it("accepts the inclusive shared 8 MiB package bound and rejects one byte beyond it", async () => {
    const atLimitRemote = sequenceFetch(new Error("stop after input validation"));
    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: Buffer.alloc(ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES),
      expectedHeadSha: HEAD,
      fetchImpl: atLimitRemote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "transport",
      status: null
    });
    expect(atLimitRemote.calls).toHaveLength(1);

    const oversizedRemote = sequenceFetch();
    await expect(createElectronProductionRecoveryStoreRemote({
      commitMessage: MESSAGE,
      content: Buffer.alloc(
        ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES + 1
      ),
      expectedHeadSha: HEAD,
      fetchImpl: oversizedRemote.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).rejects.toThrow("content size");
    expect(oversizedRemote.calls).toHaveLength(0);
  });

  it("keeps read transport and server failures indeterminate without retrying", async () => {
    const transport = sequenceFetch(new Error("network unavailable"));
    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: transport.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "transport",
      status: null
    });
    expect(transport.calls).toHaveLength(1);

    const server = sequenceFetch(jsonResponse({}, 502));
    await expect(readElectronProductionRecoveryStoreRemote({
      fetchImpl: server.fetchImpl,
      target: TARGET,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "server-error",
      status: 502
    });
    expect(server.calls).toHaveLength(1);
  });
});

interface FetchCall {
  readonly init: ElectronProductionRecoveryStoreRemoteRequestInit;
  readonly url: string;
}

function successfulCreation() {
  return sequenceFetch(
    ...initialAbsentSteps(),
    jsonResponse({ sha: CONTENT_BLOB }, 201),
    jsonResponse({ sha: NEW_ROOT_TREE }, 201),
    commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE, 201),
    refResponse(NEW_COMMIT),
    ...freshPresentSteps()
  );
}

function initialAbsentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    repositoryResponse(),
    refResponse(HEAD),
    commitResponse(HEAD, ROOT_TREE, [PRIOR_PARENT], "previous commit"),
    treeResponse(ROOT_TREE, [treeEntry("capsules", OLD_CAPSULE_TREE)]),
    treeResponse(OLD_CAPSULE_TREE, [])
  ];
}

function freshPresentSteps(): ElectronProductionRecoveryStoreRemoteResponse[] {
  return [
    repositoryResponse(),
    refResponse(NEW_COMMIT),
    commitResponse(NEW_COMMIT, NEW_ROOT_TREE, [HEAD], MESSAGE),
    treeResponse(NEW_ROOT_TREE, [treeEntry("capsules", NEW_CAPSULE_TREE)]),
    treeResponse(NEW_CAPSULE_TREE, [blobEntry("transaction.json", CONTENT_BLOB)]),
    blobResponse(CONTENT)
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

function repositoryResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    default_branch: TARGET.repositoryPolicy.defaultBranch,
    full_name: `${TARGET.owner}/${TARGET.repo}`,
    private: true,
    visibility: "private",
    ...overrides
  });
}

function declaredLengthResponse(
  declaredLength: string,
  onCancel: () => void
): ElectronProductionRecoveryStoreRemoteResponse {
  return {
    body: {
      getReader: () => ({
        cancel: async () => { onCancel(); },
        read: async () => ({ done: true })
      })
    },
    headers: {
      get: (name) => name.toLowerCase() === "content-length" ? declaredLength : null
    },
    status: 200
  };
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

function treeEntry(path: string, sha: string) {
  return { mode: "040000", path, sha, type: "tree" };
}

function blobEntry(path: string, sha: string) {
  return { mode: "100644", path, sha, type: "blob" };
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
