import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";

import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_API_ROOT,
  observeElectronProductionPublicLatestRecoveryRemote,
  rollbackElectronProductionPublicLatestRecoveryRemote,
  rollbackElectronProductionPublicLatestRecoveryRemoteAtResult,
  type ElectronProductionPublicLatestRecoveryFetch,
  type ElectronProductionPublicLatestRecoveryRequestInit,
  type ElectronProductionPublicLatestRecoveryResponse
} from "../scripts/electronProductionPublicLatestRecoveryRemote.mjs";
import {
  electronProductionPublicLatestRecoveryObservationSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  RECOVERY_FIXTURE_TOKEN,
  RECOVERY_FIXTURE_UPDATED_AT,
  createPublicLatestRecoveryFixture,
  githubRelease,
  githubTagReference
} from "./support/electronProductionPublicLatestRecoveryFixture";

const REPOSITORY_API =
  `${ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_API_ROOT}/repos/rion-tw/rion-studio`;
const LATEST_API = `${REPOSITORY_API}/releases/latest`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production public-latest independent recovery transport", () => {
  it("fresh-observes and rebuilds the exact target through all seven bounded assets", async () => {
    const fixture = await fixtureWithRoot();
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources)
    );

    const observation = await observe(remote.fetchImpl, fixture);

    expect(observation).toMatchObject({
      latest: {
        releaseId: fixture.target.release.id,
        updatedAt: RECOVERY_FIXTURE_UPDATED_AT
      },
      observation: {
        classification: "target",
        snapshot: {
          fileSha256: fixture.targetFileSha256,
          releaseId: fixture.target.release.id,
          stateSha256: fixture.target.stateSha256
        }
      },
      transport: { outcome: "observed", httpStatus: 200, reason: null }
    });
    expect(remote.calls).toHaveLength(12);
    expect(remote.calls.slice(3, 10).map(({ url }) => url)).toEqual(
      fixture.target.assets.map((asset) => asset.url)
    );
    expect(remote.calls.slice(3, 10).every(({ init }) =>
      !Object.hasOwn(init.headers, "Authorization") && init.redirect === "follow"
    )).toBe(true);
    expect(remote.calls.slice(0, 3).every(({ init }) =>
      init.headers.Authorization === `Bearer ${RECOVERY_FIXTURE_TOKEN}` &&
      init.cache === "no-store"
    )).toBe(true);
  });

  it("classifies a different authoritative latest ID as foreign without tag or asset reads", async () => {
    const fixture = await fixtureWithRoot();
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse({ id: 999999, updated_at: RECOVERY_FIXTURE_UPDATED_AT })
    );

    const observation = await observe(remote.fetchImpl, fixture);

    expect(observation).toMatchObject({
      latest: { releaseId: "999999", updatedAt: RECOVERY_FIXTURE_UPDATED_AT },
      observation: { classification: "foreign", snapshot: null },
      transport: { outcome: "observed" }
    });
    expect(remote.calls.map(({ url }) => url)).toEqual([
      REPOSITORY_API,
      LATEST_API
    ]);
  });

  it("rejects policy drift and exact known-release metadata drift before downloads", async () => {
    const fixture = await fixtureWithRoot();
    const wrongPolicy = sequenceFetch(jsonResponse({
      full_name: "rion-tw/rion-studio",
      private: false,
      visibility: "public",
      default_branch: "develop"
    }));
    const policyObservation = await observe(wrongPolicy.fetchImpl, fixture);
    expect(policyObservation).toMatchObject({
      observation: { classification: "unknown", snapshot: null },
      transport: {
        outcome: "rejected",
        reason: "repository-policy-mismatch"
      }
    });
    expect(wrongPolicy.calls).toHaveLength(1);

    const drifted = structuredClone(fixture.targetApi);
    drifted.assets[0]!.size += 1;
    const metadataDrift = sequenceFetch(
      repositoryResponse(),
      jsonResponse(drifted)
    );
    const driftObservation = await observe(metadataDrift.fetchImpl, fixture);
    expect(driftObservation.transport).toMatchObject({
      outcome: "rejected",
      reason: "snapshot-mismatch"
    });
    expect(metadataDrift.calls).toHaveLength(2);
  });

  it("rejects mismatched downloaded bytes and never turns elapsed work into success", async () => {
    const fixture = await fixtureWithRoot();
    const badFirstAsset = Buffer.from("wrong bounded bytes\n");
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      binaryResponse(badFirstAsset)
    );

    const observation = await observe(remote.fetchImpl, fixture);

    expect(observation).toMatchObject({
      observation: { classification: "unknown", snapshot: null },
      transport: { outcome: "rejected", reason: "snapshot-mismatch" }
    });
    expect(remote.calls).toHaveLength(4);
  });

  it("rejects a latest metadata change after downloads before any caller mutation", async () => {
    const fixture = await fixtureWithRoot();
    const changed = structuredClone(fixture.targetApi);
    changed.updated_at = "2026-09-01T00:04:01Z";
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...fixture.target.assets.map((asset) =>
        binaryResponse(fixture.targetSources[asset.name]!)
      ),
      jsonResponse(changed)
    );

    const observation = await observe(remote.fetchImpl, fixture);

    expect(observation).toMatchObject({
      observation: { classification: "unknown", snapshot: null },
      transport: { outcome: "rejected", reason: "snapshot-mismatch" }
    });
    expect(remote.calls.some(({ init }) => init.method === "PATCH")).toBe(false);
  });

  it("rejects a tag-ref change after downloads before any caller mutation", async () => {
    const fixture = await fixtureWithRoot();
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...fixture.target.assets.map((asset) =>
        binaryResponse(fixture.targetSources[asset.name]!)
      ),
      jsonResponse(fixture.targetApi),
      jsonResponse({
        ref: `refs/tags/${fixture.target.release.tag}`,
        object: { type: "commit", sha: "f".repeat(40) }
      })
    );

    const observation = await observe(remote.fetchImpl, fixture);

    expect(observation).toMatchObject({
      observation: { classification: "unknown", snapshot: null },
      transport: { outcome: "rejected", reason: "snapshot-mismatch" }
    });
    expect(remote.calls.some(({ init }) => init.method === "PATCH")).toBe(false);
  });

  it("submits one exact source make-latest PATCH then fresh-observes exact source", async () => {
    const fixture = await fixtureWithRoot();
    const preRemote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources)
    );
    const before = await observe(preRemote.fetchImpl, fixture);
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources),
      repositoryResponse(),
      leaseResponse(fixture.heldLease),
      jsonResponse({
        id: Number(fixture.source.release.id),
        tag_name: fixture.source.release.tag,
        draft: false,
        prerelease: false
      }),
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );

    const result = await rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: remote.fetchImpl,
      finalObservedAt: "2026-09-01T00:07:00Z",
      heldLease: fixture.heldLease,
      preObservation: before,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(before),
      resultRecordedAt: "2026-09-01T00:06:00Z",
      sourceSnapshot: fixture.source,
      sourceSnapshotFileSha256: fixture.sourceFileSha256,
      submittedAt: "2026-09-01T00:05:00Z",
      targetSnapshot: fixture.target,
      targetSnapshotFileSha256: fixture.targetFileSha256,
      token: RECOVERY_FIXTURE_TOKEN
    });

    expect(result.rollback).toMatchObject({
      status: "rollback-attempt-recorded",
      before: { classification: "target" },
      mutation: {
        submitted: true,
        releaseId: fixture.source.release.id,
        makeLatest: true,
        acknowledgement: "confirmed",
        reason: "applied-response",
        httpStatus: 200
      },
      final: { classification: "source" }
    });
    const patchCalls = remote.calls.filter(({ init }) => init.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({
      url: `${REPOSITORY_API}/releases/${fixture.source.release.id}`,
      init: { body: JSON.stringify({ make_latest: "true" }), redirect: "error" }
    });
    const patchIndex = remote.calls.findIndex(({ init }) => init.method === "PATCH");
    expect(remote.calls[patchIndex - 1]?.url).toContain(
      "/contents/releases/electron-production-public-latest-lease.json"
    );
    expect(remote.calls.filter(({ url }) => url === LATEST_API)).toHaveLength(4);
    expect(result.finalObservation.observation.classification).toBe("source");
  });

  it("records rollback times only at their authoritative network boundaries", async () => {
    const fixture = await fixtureWithRoot();
    const preRemote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources)
    );
    const before = await observe(preRemote.fetchImpl, fixture);
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources),
      repositoryResponse(),
      leaseResponse(fixture.heldLease),
      jsonResponse({
        id: Number(fixture.source.release.id),
        tag_name: fixture.source.release.tag,
        draft: false,
        prerelease: false
      }),
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );
    const events: string[] = [];
    const values = [
      "2026-09-01T00:05:00Z",
      "2026-09-01T00:05:10Z",
      "2026-09-01T00:05:20Z",
      "2026-09-01T00:05:30Z"
    ];
    const recordTime = vi.fn(() => {
      const value = values[recordTime.mock.calls.length - 1];
      if (value === undefined) throw new Error("The event clock was exhausted.");
      events.push(`clock:${value}`);
      return value;
    });
    const fetchImpl: ElectronProductionPublicLatestRecoveryFetch =
      async (url, init) => {
        events.push(init.method);
        return remote.fetchImpl(url, init);
      };

    const result =
      await rollbackElectronProductionPublicLatestRecoveryRemoteAtResult({
        fetchImpl,
        heldLease: fixture.heldLease,
        preObservation: before,
        preObservationSha256:
          electronProductionPublicLatestRecoveryObservationSha256(before),
        recordTime,
        sourceSnapshot: fixture.source,
        sourceSnapshotFileSha256: fixture.sourceFileSha256,
        submissionNotBefore: "2026-09-01T00:04:30Z",
        targetSnapshot: fixture.target,
        targetSnapshotFileSha256: fixture.targetFileSha256,
        token: RECOVERY_FIXTURE_TOKEN
      });

    expect(result.rollback.mutation).toMatchObject({
      submittedAt: "2026-09-01T00:05:10Z",
      resultRecordedAt: "2026-09-01T00:05:20Z",
      acknowledgement: "confirmed"
    });
    expect(result.preObservation.observedAt).toBe("2026-09-01T00:05:00Z");
    expect(result.finalObservation.observedAt).toBe("2026-09-01T00:05:30Z");
    expect(recordTime).toHaveBeenCalledTimes(4);
    const patchIndex = events.indexOf("PATCH");
    expect(events[patchIndex - 1]).toBe("clock:2026-09-01T00:05:10Z");
    expect(events[patchIndex + 1]).toBe("clock:2026-09-01T00:05:20Z");
    expect(events.at(-1)).toBe("clock:2026-09-01T00:05:30Z");
  });

  it.each([
    ["4xx rejection", jsonResponse({ message: "conflict secret" }, 422),
      "rejected", "github-rejected", 422],
    ["5xx unknown acknowledgement", jsonResponse({ message: "server secret" }, 503),
      "unknown", "server-error", 503],
    ["transport unknown acknowledgement", new Error("network secret"),
      "unknown", "transport", null]
  ] as const)("records %s and still fresh-observes source once", async (
    _label,
    patchStep,
    acknowledgement,
    reason,
    status
  ) => {
    const fixture = await fixtureWithRoot();
    const before = await targetObservation(fixture);
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources),
      repositoryResponse(),
      leaseResponse(fixture.heldLease),
      patchStep,
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );

    const result = await rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: remote.fetchImpl,
      finalObservedAt: "2026-09-01T00:07:00Z",
      heldLease: fixture.heldLease,
      preObservation: before,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(before),
      resultRecordedAt: "2026-09-01T00:06:00Z",
      sourceSnapshot: fixture.source,
      sourceSnapshotFileSha256: fixture.sourceFileSha256,
      submittedAt: "2026-09-01T00:05:00Z",
      targetSnapshot: fixture.target,
      targetSnapshotFileSha256: fixture.targetFileSha256,
      token: RECOVERY_FIXTURE_TOKEN
    });

    expect(result.rollback.mutation).toMatchObject({
      acknowledgement,
      reason,
      httpStatus: status,
      releaseId: fixture.source.release.id,
      makeLatest: true
    });
    expect(result.finalObservation.observation.classification).toBe("source");
    expect(remote.calls.filter(({ init }) => init.method === "PATCH")).toHaveLength(1);
    expect(remote.calls.filter(({ url }) => url === LATEST_API)).toHaveLength(4);
  });

  it("refuses PATCH when the last-moment observation no longer sees target", async () => {
    const fixture = await fixtureWithRoot();
    const before = await targetObservation(fixture);
    const changed = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );

    await expect(rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: changed.fetchImpl,
      finalObservedAt: "2026-09-01T00:07:00Z",
      heldLease: fixture.heldLease,
      preObservation: before,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(before),
      resultRecordedAt: "2026-09-01T00:06:00Z",
      sourceSnapshot: fixture.source,
      sourceSnapshotFileSha256: fixture.sourceFileSha256,
      submittedAt: "2026-09-01T00:05:00Z",
      targetSnapshot: fixture.target,
      targetSnapshotFileSha256: fixture.targetFileSha256,
      token: RECOVERY_FIXTURE_TOKEN
    })).rejects.toThrow("last-moment exact target observation");
    expect(changed.calls.some(({ init }) => init.method === "PATCH")).toBe(false);
  });

  it("refuses PATCH when the public lease is no longer the exact held event", async () => {
    const fixture = await fixtureWithRoot();
    const before = await targetObservation(fixture);
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      {
        transactionId: fixture.heldLease.transactionId,
        leaseId: fixture.heldLease.leaseId,
        generation: fixture.heldLease.generation,
        sourceStateSha256: fixture.heldLease.source.stateSha256,
        targetStateSha256: fixture.heldLease.target.stateSha256,
        recordedAt: "2026-09-01T00:04:30Z"
      }
    );
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources),
      repositoryResponse(),
      leaseResponse(released)
    );

    await expect(rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: remote.fetchImpl,
      finalObservedAt: "2026-09-01T00:07:00Z",
      heldLease: fixture.heldLease,
      preObservation: before,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(before),
      resultRecordedAt: "2026-09-01T00:06:00Z",
      sourceSnapshot: fixture.source,
      sourceSnapshotFileSha256: fixture.sourceFileSha256,
      submittedAt: "2026-09-01T00:05:00Z",
      targetSnapshot: fixture.target,
      targetSnapshotFileSha256: fixture.targetFileSha256,
      token: RECOVERY_FIXTURE_TOKEN
    })).rejects.toThrow("last-moment exact held lease");
    expect(remote.calls.some(({ init }) => init.method === "PATCH")).toBe(false);
  });

  it("refuses rollback before any request unless the bound pre-observation is exact target", async () => {
    const fixture = await fixtureWithRoot();
    const sourceRemote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );
    const before = await observe(sourceRemote.fetchImpl, fixture);
    const unused = sequenceFetch();

    await expect(rollbackElectronProductionPublicLatestRecoveryRemote({
      fetchImpl: unused.fetchImpl,
      finalObservedAt: "2026-09-01T00:07:00Z",
      heldLease: fixture.heldLease,
      preObservation: before,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(before),
      resultRecordedAt: "2026-09-01T00:06:00Z",
      sourceSnapshot: fixture.source,
      sourceSnapshotFileSha256: fixture.sourceFileSha256,
      submittedAt: "2026-09-01T00:05:00Z",
      targetSnapshot: fixture.target,
      targetSnapshotFileSha256: fixture.targetFileSha256,
      token: RECOVERY_FIXTURE_TOKEN
    })).rejects.toThrow("only after a fresh exact target observation");
    expect(unused.calls).toEqual([]);
  });
});

async function fixtureWithRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-public-recovery-"));
  temporaryDirectories.push(root);
  return createPublicLatestRecoveryFixture(root);
}

async function observe(
  fetchImpl: ElectronProductionPublicLatestRecoveryFetch,
  fixture: Awaited<ReturnType<typeof fixtureWithRoot>>
) {
  return observeElectronProductionPublicLatestRecoveryRemote({
    fetchImpl,
    observedAt: "2026-09-01T00:04:00Z",
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: fixture.sourceFileSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: fixture.targetFileSha256,
    token: RECOVERY_FIXTURE_TOKEN
  });
}

async function targetObservation(
  fixture: Awaited<ReturnType<typeof fixtureWithRoot>>
) {
  const remote = sequenceFetch(
    repositoryResponse(),
    jsonResponse(fixture.targetApi),
    jsonResponse(githubTagReference(fixture.target)),
    ...assetResponses(fixture.target, fixture.targetSources)
  );
  return observe(remote.fetchImpl, fixture);
}

function repositoryResponse() {
  return jsonResponse({
    full_name: "rion-tw/rion-studio",
    private: false,
    visibility: "public",
    default_branch: "main"
  });
}

function assetResponses(
  snapshot: Awaited<ReturnType<typeof fixtureWithRoot>>["source"],
  sources: Readonly<Record<string, Buffer>>
) {
  return [
    ...snapshot.assets.map((asset) => binaryResponse(sources[asset.name]!)),
    jsonResponse(githubRelease(snapshot, sources)),
    jsonResponse(githubTagReference(snapshot))
  ];
}

function jsonResponse(value: unknown, status = 200) {
  return response(Buffer.from(JSON.stringify(value)), status, "application/json");
}

function binaryResponse(value: Buffer, status = 200) {
  return response(value, status, "application/octet-stream");
}

function leaseResponse(
  lease: Awaited<ReturnType<typeof fixtureWithRoot>>["heldLease"]
) {
  const source = serializeElectronProductionPublicLatestLease(lease);
  return jsonResponse({
    type: "file",
    name: "electron-production-public-latest-lease.json",
    path: "releases/electron-production-public-latest-lease.json",
    encoding: "base64",
    size: source.length,
    sha: createHash("sha1")
      .update(`blob ${source.length}\0`)
      .update(source)
      .digest("hex"),
    content: source.toString("base64")
  });
}

function response(source: Buffer, status: number, contentType: string) {
  let delivered = false;
  let cancelled = false;
  return {
    status,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-length") return String(source.length);
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || delivered) return { done: true };
            delivered = true;
            return { done: false, value: new Uint8Array(source) };
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  } satisfies ElectronProductionPublicLatestRecoveryResponse;
}

function sequenceFetch(
  ...steps: Array<ElectronProductionPublicLatestRecoveryResponse | Error>
) {
  const calls: Array<{
    url: string;
    init: ElectronProductionPublicLatestRecoveryRequestInit;
  }> = [];
  const fetchImpl: ElectronProductionPublicLatestRecoveryFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) throw new Error(`Unexpected recovery request ${url}.`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchImpl };
}
