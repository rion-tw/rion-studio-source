import { describe, expect, it, vi } from "vitest";

import {
  proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntentRemote.mjs";

const TARGET = {
  owner: "recovery-owner",
  repo: "recovery-vault",
  ref: "recovery-main",
  path: "transactions/018f7777-7c4d-7b4a-8a5c-111111111111/" +
    "electron-production-publication-recovery-lease-release-intent.json",
  repositoryPolicy: {
    defaultBranch: "recovery-main",
    visibility: "private"
  }
} as const;
const H0 = "0".repeat(40);
const H1 = "1".repeat(40);
const HEAD = "3".repeat(40);
const TREE1 = "a".repeat(40);
const HEAD_TREE = "b".repeat(40);
const HEAD_PARENT = "2".repeat(40);
const BLOB = "c".repeat(40);

describe("publication recovery lease-release intent history remote", () => {
  it("proves one reachable fixed-path create without traversing unrelated commits", async () => {
    const fetchImpl = vi.fn(sequence([
      response(repository()),
      response(reference(HEAD)),
      response([{ sha: H1 }]),
      response(commit(H1, TREE1, H0)),
      response(comparison()),
      response(reference(HEAD))
    ]));

    const history =
      await proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
        target: TARGET,
        token: "secret-token",
        initialHeadCommitSha: H0,
        intentBlobSha: BLOB,
        currentObservation: currentObservation(),
        observedAt: "2026-09-01T01:01:00Z",
        fetchImpl
      });

    expect(history).toMatchObject({
      status: "verified-exact-create-and-reachable-path-history",
      initialHeadCommitSha: H0,
      intentCommit: {
        commitSha: H1,
        treeSha: TREE1,
        parentCommitSha: H0,
        blobSha: BLOB
      },
      currentObservation: currentObservation(),
      pathHistory: {
        reachableFromHeadCommitSha: HEAD,
        commitSha: H1,
        resultCount: 1,
        nextPage: false
      }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls[2]?.[0]).toContain(`sha=${HEAD}`);
    expect(fetchImpl.mock.calls.some(([url]) =>
      String(url).includes("ancestry"))).toBe(false);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
    }
  });

  it.each([
    ["a next page", () => response([{ sha: H1 }], {
      link: "<https://api.github.com/next>; rel=\"next\""
    }), "exactly one"],
    ["a foreign diff", () => response({
      ...comparison(),
      files: [
        { filename: TARGET.path, status: "added", sha: BLOB },
        { filename: "foreign.json", status: "added", sha: "d".repeat(40) }
      ]
    }), "one exact commit"]
  ] as const)("rejects %s", async (_label, changed, message) => {
    const responses = [
      response(repository()),
      response(reference(HEAD)),
      response([{ sha: H1 }]),
      response(commit(H1, TREE1, H0)),
      response(comparison()),
      response(reference(HEAD))
    ];
    responses[_label === "a next page" ? 2 : 4] = changed();
    await expect(
      proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
        target: TARGET,
        token: "secret-token",
        initialHeadCommitSha: H0,
        intentBlobSha: BLOB,
        currentObservation: currentObservation(),
        observedAt: "2026-09-01T01:01:00Z",
        fetchImpl: sequence(responses)
      })
    ).rejects.toThrow(message);
  });

  it("rejects a moving head after the history read", async () => {
    await expect(
      proveElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
        target: TARGET,
        token: "secret-token",
        initialHeadCommitSha: H0,
        intentBlobSha: BLOB,
        currentObservation: currentObservation(),
        observedAt: "2026-09-01T01:01:00Z",
        fetchImpl: sequence([
          response(repository()),
          response(reference(HEAD)),
          response([{ sha: H1 }]),
          response(commit(H1, TREE1, H0)),
          response(comparison()),
          response(reference("9".repeat(40)))
        ])
      })
    ).rejects.toThrow("head changed");
  });
});

function repository() {
  return {
    full_name: `${TARGET.owner}/${TARGET.repo}`,
    private: true,
    visibility: "private",
    default_branch: TARGET.ref
  };
}

function reference(sha: string) {
  return {
    ref: `refs/heads/${TARGET.ref}`,
    object: { type: "commit", sha }
  };
}

function commit(sha: string, treeSha: string, parentSha: string) {
  return { sha, tree: { sha: treeSha }, parents: [{ sha: parentSha }] };
}

function comparison() {
  return {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    base_commit: { sha: H0 },
    merge_base_commit: { sha: H0 },
    commits: [{ sha: H1 }],
    files: [{ filename: TARGET.path, status: "added", sha: BLOB }]
  };
}

function currentObservation() {
  return {
    headCommitSha: HEAD,
    treeSha: HEAD_TREE,
    parentCommitShas: [HEAD_PARENT] as const
  };
}

function response(value: unknown, headers: Readonly<Record<string, string>> = {}) {
  const source = Buffer.from(JSON.stringify(value), "utf8");
  let delivered = false;
  return {
    status: 200,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-length") return String(source.length);
        return headers[name.toLowerCase()] ?? null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (delivered) return { done: true };
            delivered = true;
            return { done: false, value: source };
          },
          async cancel() {}
        };
      }
    }
  };
}

function sequence(responses: ReturnType<typeof response>[]) {
  let index = 0;
  return async (_url: string, _init: unknown) => {
    const next = responses[index];
    index += 1;
    if (!next) throw new Error("Unexpected fetch.");
    return next;
  };
}
