import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertElectronProductionPublicationRecoveryOutcomeChainProof,
  assertElectronProductionPublicationRecoveryOutcomeDiscovery,
  electronProductionPublicationRecoveryLatestOutcomeSource,
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  verifyElectronProductionPublicationRecoveryOutcomeChain,
  verifyElectronProductionPublicationRecoveryOutcomeContinuity
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  discoverElectronProductionPublicationRecoveryOutcomes
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscoveryRemote.mjs";
import {
  electronProductionPublicationRecoveryOutcomeSha256,
  serializeElectronProductionPublicationRecoveryOutcome
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  createOutcomeDiscoveryFixture,
  gitBlobSha
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publication recovery outcome discovery contracts", () => {
  it("derives one unique open head across runs and permits persisted attempt gaps", async () => {
    const fixture = await newFixture();
    const first = fixture.createOutcome({
      runId: "9002",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const second = fixture.createOutcome({
      runId: "9001",
      runAttempt: 7,
      previousOutcomeSha256:
        electronProductionPublicationRecoveryOutcomeSha256(first),
      startedAt: "2026-09-01T00:05:00Z",
      determinedAt: "2026-09-01T00:06:00Z"
    });
    const discovery = fixture.discovery([
      fixture.entry(first),
      fixture.entry(second)
    ]);

    const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
    });

    expect(proof).toMatchObject({
      status: "open",
      transactionId: fixture.heldLease.transactionId,
      currentObservation: discovery.currentObservation,
      outcomeDirectory: discovery.outcomeDirectory,
      latestOutcome: {
        sha256: electronProductionPublicationRecoveryOutcomeSha256(second),
        recoveryRun: { runId: "9001", runAttempt: 7 },
        terminal: false
      }
    });
    expect(proof.outcomes.map((outcome) => outcome.sha256)).toEqual([
      electronProductionPublicationRecoveryOutcomeSha256(first),
      electronProductionPublicationRecoveryOutcomeSha256(second)
    ]);
    expect(electronProductionPublicationRecoveryLatestOutcomeSource(
      discovery,
      proof
    )).toEqual(serializeElectronProductionPublicationRecoveryOutcome(second));
  });

  it("preserves durable marker reservation authority and possibly-attempted taint", async () => {
    const fixture = await newFixture();
    const reservation = {
      attemptSha256: "7".repeat(64),
      authorizationSha256: "8".repeat(64)
    };
    const rollback = fixture.createOutcome({
      runId: "9051",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      beforeClassification: "target",
      beforeObservedAt: "2026-09-01T00:04:00Z",
      finalClassification: "source",
      finalObservedAt: "2026-09-01T00:06:00Z",
      determinedAt: "2026-09-01T00:07:00Z",
      mutation: {
        kind: "rollback",
        submitted: "possibly",
        acknowledgement: "unknown",
        reservedAt: "2026-09-01T00:05:00Z",
        submittedAt: null,
        resultRecordedAt: "2026-09-01T00:06:00Z",
        reservation
      },
      recoveryOperation: markerOperation(
        "rollback-public-latest",
        reservation
      )
    });
    const release = fixture.createOutcome({
      runId: "9052",
      runAttempt: 1,
      previousOutcomeSha256:
        electronProductionPublicationRecoveryOutcomeSha256(rollback),
      startedAt: "2026-09-01T00:08:00Z",
      beforeObservedAt: "2026-09-01T00:09:00Z",
      finalObservedAt: "2026-09-01T00:09:00Z",
      determinedAt: "2026-09-01T00:11:00Z",
      leaseRelease: {
        attempted: "possibly",
        acknowledgement: "unknown",
        attemptedAt: null,
        operationSha256: null,
        reservation,
        resolvedAt: "2026-09-01T00:10:00Z",
        successorEventSha256: null
      },
      recoveryOperation: markerOperation(
        "release-held-lease",
        reservation
      )
    });
    const discovery = fixture.discovery([
      fixture.entry(rollback),
      fixture.entry(release)
    ]);
    const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
    });

    expect(proof.outcomes[0]?.mutation).toMatchObject({
      submitted: "possibly",
      acknowledgement: "unknown",
      reservedAt: "2026-09-01T00:05:00Z",
      reservation
    });
    expect(proof.outcomes[1]?.leaseRelease).toEqual({
      attempted: "possibly",
      acknowledgement: "unknown",
      attemptedAt: null,
      operationSha256: null,
      reservation,
      resolvedAt: "2026-09-01T00:10:00Z",
      successorEventSha256: null
    });

    const forged = structuredClone(proof);
    const mutable = forged.outcomes[0]?.mutation as unknown as {
      reservation: { authorizationSha256: string };
    };
    mutable.reservation.authorizationSha256 = "invalid";
    expect(() => assertElectronProductionPublicationRecoveryOutcomeChainProof(forged))
      .toThrow("authorization SHA-256");

    const swappedAuthority = structuredClone(proof);
    const swappedMutation = swappedAuthority.outcomes[0]?.mutation as unknown as {
      reservation: { authorizationSha256: string };
    };
    swappedMutation.reservation.authorizationSha256 = "a".repeat(64);
    expect(() => assertElectronProductionPublicationRecoveryOutcomeChainProof(
      swappedAuthority
    )).toThrow("marker rollback authority does not match");

    const swappedMode = structuredClone(proof);
    const operation = swappedMode.outcomes[0]?.recoveryOperation as unknown as {
      mode: string;
    };
    operation.mode = "actual-transport";
    expect(() => assertElectronProductionPublicationRecoveryOutcomeChainProof(
      swappedMode
    )).toThrow("marker rollback mode");
  });

  it.each([
    ["gap", (fixture: Fixture) => {
      const outcome = fixture.createOutcome({
        runId: "9101",
        runAttempt: 1,
        previousOutcomeSha256: "f".repeat(64),
        startedAt: "2026-09-01T00:03:00Z",
        determinedAt: "2026-09-01T00:04:00Z"
      });
      return fixture.discovery([fixture.entry(outcome)]);
    }, "has a gap"],
    ["multiple genesis", (fixture: Fixture) => {
      const first = fixture.createOutcome({
        runId: "9102",
        runAttempt: 1,
        previousOutcomeSha256: null,
        startedAt: "2026-09-01T00:03:00Z",
        determinedAt: "2026-09-01T00:04:00Z"
      });
      const second = fixture.createOutcome({
        runId: "9103",
        runAttempt: 1,
        previousOutcomeSha256: null,
        startedAt: "2026-09-01T00:05:00Z",
        determinedAt: "2026-09-01T00:06:00Z"
      });
      return fixture.discovery([fixture.entry(first), fixture.entry(second)]);
    }, "needs one genesis"],
    ["fork", (fixture: Fixture) => {
      const first = fixture.createOutcome({
        runId: "9104",
        runAttempt: 1,
        previousOutcomeSha256: null,
        startedAt: "2026-09-01T00:03:00Z",
        determinedAt: "2026-09-01T00:04:00Z"
      });
      const previous = electronProductionPublicationRecoveryOutcomeSha256(first);
      const left = fixture.createOutcome({
        runId: "9105",
        runAttempt: 1,
        previousOutcomeSha256: previous,
        startedAt: "2026-09-01T00:05:00Z",
        determinedAt: "2026-09-01T00:06:00Z"
      });
      const right = fixture.createOutcome({
        runId: "9106",
        runAttempt: 1,
        previousOutcomeSha256: previous,
        startedAt: "2026-09-01T00:07:00Z",
        determinedAt: "2026-09-01T00:08:00Z"
      });
      return fixture.discovery([
        fixture.entry(first),
        fixture.entry(left),
        fixture.entry(right)
      ]);
    }, "has a fork"],
    ["chronology reversal", (fixture: Fixture) => {
      const first = fixture.createOutcome({
        runId: "9107",
        runAttempt: 1,
        previousOutcomeSha256: null,
        startedAt: "2026-09-01T00:03:00Z",
        determinedAt: "2026-09-01T00:10:00Z"
      });
      const second = fixture.createOutcome({
        runId: "9108",
        runAttempt: 1,
        previousOutcomeSha256:
          electronProductionPublicationRecoveryOutcomeSha256(first),
        startedAt: "2026-09-01T00:09:00Z",
        determinedAt: "2026-09-01T00:11:00Z"
      });
      return fixture.discovery([fixture.entry(first), fixture.entry(second)]);
    }, "precedes its predecessor"]
  ] as const)("rejects a %s", async (_label, build, message) => {
    const fixture = await newFixture();
    const discovery = build(fixture);
    expect(() => verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
    })).toThrow(message);
  });

  it("requires a terminal head and fixed file to be byte-identical", async () => {
    const fixture = await newFixture();
    const first = fixture.createOutcome({
      runId: "9201",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const terminal = fixture.createOutcome({
      runId: "9202",
      runAttempt: 1,
      previousOutcomeSha256:
        electronProductionPublicationRecoveryOutcomeSha256(first),
      startedAt: "2026-09-01T00:05:00Z",
      determinedAt: "2026-09-01T00:06:00Z",
      terminal: true
    });
    const exact = fixture.discovery([
      fixture.entry(first),
      fixture.entry(terminal),
      fixture.entry(terminal, "terminal")
    ]);
    const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery: exact,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(exact)
    });
    expect(proof.status).toBe("terminal");
    expect(proof.terminal?.sha256).toBe(proof.latestOutcome?.sha256);

    const differentTerminal = fixture.createOutcome({
      runId: "9203",
      runAttempt: 1,
      previousOutcomeSha256:
        electronProductionPublicationRecoveryOutcomeSha256(first),
      startedAt: "2026-09-01T00:05:00Z",
      determinedAt: "2026-09-01T00:07:00Z",
      terminal: true
    });
    const mismatched = fixture.discovery([
      fixture.entry(first),
      fixture.entry(terminal),
      fixture.entry(differentTerminal, "terminal")
    ]);
    expect(() => verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery: mismatched,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(mismatched)
    })).toThrow("byte-identical");
  });

  it("accepts an absent outcome directory as empty but rejects a missing foundation", async () => {
    const fixture = await newFixture();
    const empty = fixture.discovery([], { status: "outcome-directory-absent" });
    const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery: empty,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(empty)
    });
    expect(proof).toMatchObject({
      status: "empty",
      latestOutcome: null,
      terminal: null,
      outcomes: []
    });

    const missing = fixture.discovery([], {
      status: "transaction-directory-absent"
    });
    expect(() => verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery: missing,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(missing)
    })).toThrow("sealed recovery transaction directory is absent");
  });

  it("strictly binds foundation file digests, protected ref, proof paths, and source", async () => {
    const fixture = await newFixture();
    const outcome = fixture.createOutcome({
      runId: "9301",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const discovery = fixture.discovery([fixture.entry(outcome)]);
    expect(() => verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      heldLeaseSha256: "e".repeat(64),
      discovery,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
    })).toThrow("held-lease file SHA-256");

    const wrongRef = structuredClone(discovery) as MutableDiscovery;
    wrongRef.target.ref = "other-branch";
    expect(() => assertElectronProductionPublicationRecoveryOutcomeDiscovery(
      wrongRef
    )).toThrow("protected default branch");

    const proof = verifyElectronProductionPublicationRecoveryOutcomeChain({
      ...fixture.foundation,
      discovery,
      discoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
    });
    const forgedPath = structuredClone(proof) as Record<string, unknown>;
    const forgedLatest = (forgedPath.latestOutcome as Record<string, unknown>);
    forgedLatest.path = `transactions/${fixture.heldLease.transactionId}/` +
      "recovery-outcomes/foreign.json";
    (forgedPath.outcomes as Array<Record<string, unknown>>).at(-1)!.path =
      forgedLatest.path;
    expect(() => assertElectronProductionPublicationRecoveryOutcomeChainProof(
      forgedPath
    )).toThrow("proof path");

    const detachedProof = structuredClone(proof) as Record<string, unknown>;
    detachedProof.discoveryReceiptSha256 = "a".repeat(64);
    expect(() => electronProductionPublicationRecoveryLatestOutcomeSource(
      discovery,
      detachedProof as never
    )).toThrow("discovery proof binding");
  });

  it("requires byte-identical same-head continuity and binds the fresh receipt", async () => {
    const fixture = await newFixture();
    const outcome = fixture.createOutcome({
      runId: "9401",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const initial = fixture.discovery([fixture.entry(outcome)], {
      observedAt: "2026-09-01T01:00:00Z"
    });
    const fresh = fixture.discovery([fixture.entry(outcome)], {
      observedAt: "2026-09-01T01:01:00Z"
    });
    const proof = verifyElectronProductionPublicationRecoveryOutcomeContinuity({
      ...fixture.foundation,
      initialDiscovery: initial,
      initialDiscoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(initial),
      freshDiscovery: fresh,
      freshDiscoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(fresh)
    });
    expect(proof).toMatchObject({
      status: "verified-same-head-chain",
      discoveryReceipts: {
        freshSha256:
          electronProductionPublicationRecoveryOutcomeDiscoverySha256(fresh)
      }
    });
    expect(electronProductionPublicationRecoveryLatestOutcomeSource(
      fresh,
      proof
    )).toEqual(serializeElectronProductionPublicationRecoveryOutcome(outcome));

    const changed = structuredClone(fresh) as MutableDiscovery;
    changed.currentObservation.headCommitSha = "e".repeat(40);
    expect(() => verifyElectronProductionPublicationRecoveryOutcomeContinuity({
      ...fixture.foundation,
      initialDiscovery: initial,
      initialDiscoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(initial),
      freshDiscovery: changed as never,
      freshDiscoverySha256:
        electronProductionPublicationRecoveryOutcomeDiscoverySha256(changed)
    })).toThrow("changed between same-head reads");
  });
});

describe("publication recovery outcome remote discovery", () => {
  it("reads one immutable tree, verifies blobs, and closes on the same ref", async () => {
    const fixture = await newFixture();
    const outcome = fixture.createOutcome({
      runId: "9501",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const source = serializeElectronProductionPublicationRecoveryOutcome(outcome);
    const fetchImpl = vi.fn(remoteFetch({
      files: [{
        name: fixture.entry(outcome).fileName,
        source
      }]
    }));

    const discovery = await discoverElectronProductionPublicationRecoveryOutcomes({
      fetchImpl,
      observedAt: "2026-09-01T01:00:00Z",
      target: remoteTarget(),
      token: "private-reader-token",
      transactionId: fixture.heldLease.transactionId
    });

    expect(discovery).toMatchObject({
      currentObservation: {
        headCommitSha: "4".repeat(40),
        treeSha: "5".repeat(40)
      },
      outcomeDirectory: {
        status: "present",
        treeSha: "6".repeat(40)
      },
      entries: [{
        blobSha: gitBlobSha(source),
        sha256: electronProductionPublicationRecoveryOutcomeSha256(outcome)
      }]
    });
    const referenceCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/git/ref/heads/recovery-main")
    );
    expect(referenceCalls).toHaveLength(2);
    expect(fetchImpl.mock.calls.every(([, init]) =>
      init?.redirect === "error" &&
      init.headers?.Authorization === "Bearer private-reader-token"
    )).toBe(true);
  });

  it("rejects truncated trees, closing-head drift, and oversized descriptors", async () => {
    const fixture = await newFixture();
    await expect(discoverElectronProductionPublicationRecoveryOutcomes({
      fetchImpl: remoteFetch({ truncatedTree: true }),
      observedAt: "2026-09-01T01:00:00Z",
      target: remoteTarget(),
      token: "token",
      transactionId: fixture.heldLease.transactionId
    })).rejects.toThrow("malformed or truncated");

    await expect(discoverElectronProductionPublicationRecoveryOutcomes({
      fetchImpl: remoteFetch({ closingHead: "e".repeat(40) }),
      observedAt: "2026-09-01T01:00:00Z",
      target: remoteTarget(),
      token: "token",
      transactionId: fixture.heldLease.transactionId
    })).rejects.toThrow("head changed");

    const oversizedFetch = vi.fn(remoteFetch({
      oversizedDescriptors: true
    }));
    await expect(discoverElectronProductionPublicationRecoveryOutcomes({
      fetchImpl: oversizedFetch,
      observedAt: "2026-09-01T01:00:00Z",
      target: remoteTarget(),
      token: "token",
      transactionId: fixture.heldLease.transactionId
    })).rejects.toThrow("exceeds its byte bound");
    expect(oversizedFetch.mock.calls.some(([url]) =>
      String(url).includes("/git/blobs/")
    )).toBe(false);
  });
});

function markerOperation(
  operation: "release-held-lease" | "rollback-public-latest",
  authority: Readonly<{ attemptSha256: string; authorizationSha256: string }>
) {
  return {
    kind:
      "rion-electron-production-publication-recovery-public-mutation-operation" as const,
    operation,
    mode: "marker-reconciliation" as const,
    authority,
    sha256: "9".repeat(64)
  };
}

async function newFixture() {
  const root = await mkdtemp(`${tmpdir()}/rion-outcome-discovery-`);
  temporaryDirectories.push(root);
  return createOutcomeDiscoveryFixture(root);
}

function remoteTarget() {
  return {
    owner: "recovery-owner",
    repo: "recovery-vault",
    ref: "recovery-main",
    repositoryPolicy: {
      defaultBranch: "recovery-main",
      visibility: "private" as const
    }
  };
}

function remoteFetch(options: Readonly<{
  closingHead?: string;
  files?: readonly Readonly<{ name: string; source: Buffer }>[];
  oversizedDescriptors?: boolean;
  truncatedTree?: boolean;
}> = {}) {
  let referenceReads = 0;
  const files = options.oversizedDescriptors
    ? Array.from({ length: 9 }, (_unused, index) => ({
        name: `electron-production-publication-recovery-outcome-run-${9600 + index}` +
          "-attempt-000001.json",
        source: Buffer.alloc(1024 * 1024)
      }))
    : options.files ?? [];
  const blobs = new Map(files.map((file) => [gitBlobSha(file.source), file.source]));
  return async (url: string | URL, _init?: RemoteFetchInit) => {
    const value = String(url);
    if (value.endsWith("/repos/recovery-owner/recovery-vault")) {
      return jsonResponse({
        full_name: "recovery-owner/recovery-vault",
        private: true,
        visibility: "private",
        default_branch: "recovery-main"
      });
    }
    if (value.includes("/git/ref/heads/recovery-main")) {
      referenceReads += 1;
      return jsonResponse({
        ref: "refs/heads/recovery-main",
        object: {
          type: "commit",
          sha: referenceReads === 2 && options.closingHead
            ? options.closingHead
            : "4".repeat(40)
        }
      });
    }
    if (value.endsWith(`/git/commits/${"4".repeat(40)}`)) {
      return jsonResponse({
        sha: "4".repeat(40),
        tree: { sha: "5".repeat(40) },
        parents: [{ sha: "d".repeat(40) }]
      });
    }
    if (value.endsWith(`/git/trees/${"5".repeat(40)}`)) {
      return jsonResponse({
        sha: "5".repeat(40),
        truncated: options.truncatedTree ?? false,
        tree: [{
          path: "transactions",
          mode: "040000",
          type: "tree",
          sha: "a".repeat(40)
        }]
      });
    }
    if (value.endsWith(`/git/trees/${"a".repeat(40)}`)) {
      return jsonResponse({
        sha: "a".repeat(40),
        truncated: false,
        tree: [{
          path: "018f47a0-2d3e-7abc-8def-1234567890ab",
          mode: "040000",
          type: "tree",
          sha: "b".repeat(40)
        }]
      });
    }
    if (value.endsWith(`/git/trees/${"b".repeat(40)}`)) {
      return jsonResponse({
        sha: "b".repeat(40),
        truncated: false,
        tree: [{
          path: "recovery-outcomes",
          mode: "040000",
          type: "tree",
          sha: "6".repeat(40)
        }]
      });
    }
    if (value.endsWith(`/git/trees/${"6".repeat(40)}`)) {
      return jsonResponse({
        sha: "6".repeat(40),
        truncated: false,
        tree: files.map((file) => ({
          path: file.name,
          mode: "100644",
          type: "blob",
          sha: gitBlobSha(file.source),
          size: file.source.length
        }))
      });
    }
    const blobSha = value.split("/git/blobs/")[1];
    const blob = blobSha ? blobs.get(blobSha) : undefined;
    if (blob !== undefined) {
      return jsonResponse({
        sha: blobSha,
        size: blob.length,
        encoding: "base64",
        content: blob.toString("base64")
      });
    }
    return jsonResponse({ message: "not found" }, 404);
  };
}

function jsonResponse(value: unknown, status = 200) {
  const source = JSON.stringify(value);
  return new Response(source, {
    status,
    headers: { "content-length": String(Buffer.byteLength(source)) }
  });
}

interface MutableDiscovery {
  target: { ref: string };
  currentObservation: { headCommitSha: string };
}

type Fixture = Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>;

interface RemoteFetchInit {
  readonly redirect?: string;
  readonly headers?: Readonly<Record<string, string>>;
}
