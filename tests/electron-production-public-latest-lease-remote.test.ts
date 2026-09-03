import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS,
  acquireElectronProductionPublicLatestLease,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
  acquireElectronProductionPublicLatestLeaseRemote,
  observeElectronProductionPublicLatestLeaseRemote,
  observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote,
  readElectronProductionPublicLatestLeaseRemote,
  releaseElectronProductionPublicLatestLeaseRemote,
  type ElectronProductionPublicLatestLeaseRemoteFetch,
  type ElectronProductionPublicLatestLeaseRemoteRequestInit,
  type ElectronProductionPublicLatestLeaseRemoteResponse
} from "../scripts/electronProductionPublicLatestLeaseRemote.mjs";

const TOKEN = "github-token";
const CONTENT_URL = `https://api.github.com/repos/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY}/contents/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH}`;
const CONTENT_READ_URL = `${CONTENT_URL}?ref=${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF}`;
const REPOSITORY_URL =
  `https://api.github.com/repos/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY}`;
const REF_URL = `${REPOSITORY_URL}/git/ref/heads/main`;
const FIRST_TRANSACTION_ID = "10000000-0000-4000-8000-000000000001";
const FIRST_LEASE_ID = "20000000-0000-4000-8000-000000000002";
const SECOND_TRANSACTION_ID = "30000000-0000-4000-8000-000000000003";
const SECOND_LEASE_ID = "40000000-0000-4000-8000-000000000004";

describe("Electron production remote public-latest lease", () => {
  it("creates genesis only after an authoritative fixed-repository 404", async () => {
    const expected = firstHeld();
    const remote = sequenceFetch(
      jsonResponse({}, 404),
      repositoryResponse(),
      refResponse(),
      jsonResponse({}, 201),
      contentResponse(expected)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: firstAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual(expect.objectContaining({
      outcome: "applied",
      lease: expected
    }));

    expect(remote.calls.map(({ url }) => url)).toEqual([
      CONTENT_READ_URL,
      REPOSITORY_URL,
      REF_URL,
      CONTENT_URL,
      CONTENT_READ_URL
    ]);
    const create = requestBody(remote.calls[3]);
    expect(create).toEqual({
      message: "ci: held public-latest lease generation 1",
      content: serializeElectronProductionPublicLatestLease(expected).toString("base64"),
      branch: "main"
    });
    expect(create).not.toHaveProperty("sha");
    expect(remote.calls[0]?.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(remote.calls.every(({ init }) => init.redirect === "error")).toBe(true);
  });

  it("records an Electron latest as the source of a Tauri v22 restore", async () => {
    const acquisition = {
      transactionId: FIRST_TRANSACTION_ID,
      leaseId: FIRST_LEASE_ID,
      purpose: "tauri-v22-latest-restore" as const,
      holder: {
        repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
        workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
          "tauri-v22-latest-restore"
        ],
        runId: "123456789",
        runAttempt: 1,
        headSha: "c".repeat(40)
      },
      source: {
        runtime: "electron-v23" as const,
        version: "8.5.0",
        stateSha256: "a".repeat(64)
      },
      target: {
        runtime: "tauri-v22" as const,
        version: "8.4.2",
        stateSha256: "b".repeat(64)
      },
      recordedAt: "2026-09-01T00:00:00Z"
    };
    const expected = acquireElectronProductionPublicLatestLease({
      ...acquisition,
      previous: null,
      vacantGeneration: 0
    });
    const remote = sequenceFetch(
      jsonResponse({}, 404),
      repositoryResponse(),
      refResponse(),
      jsonResponse({}, 201),
      contentResponse(expected)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition,
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual(expect.objectContaining({
      outcome: "applied",
      lease: expected
    }));
    expect(expected).toMatchObject({
      purpose: "tauri-v22-latest-restore",
      source: { runtime: "electron-v23" },
      target: { runtime: "tauri-v22" }
    });
  });

  it("treats an unverified repository or main ref after 404 as indeterminate", async () => {
    const privateRepository = sequenceFetch(
      jsonResponse({}, 404),
      repositoryResponse({ visibility: "private", private: true })
    );
    await expect(readElectronProductionPublicLatestLeaseRemote({
      fetchImpl: privateRepository.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unauthoritative-absence",
      status: 200
    });

    const unavailableRef = sequenceFetch(
      jsonResponse({}, 404),
      repositoryResponse(),
      jsonResponse({}, 503)
    );
    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: firstAcquisition(),
      fetchImpl: unavailableRef.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unauthoritative-absence",
      status: 503
    });
    expect(unavailableRef.calls).toHaveLength(3);
  });

  it("acquires a successor from the exact released blob using its SHA CAS", async () => {
    const previous = firstReleased();
    const expected = secondHeld(previous);
    const initial = contentBody(previous);
    const remote = sequenceFetch(
      jsonResponse(initial),
      jsonResponse({}, 200),
      contentResponse(expected)
    );

    const result = await acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    });

    expect(result).toEqual(expect.objectContaining({
      outcome: "applied",
      lease: expected
    }));
    expect(requestBody(remote.calls[1])).toEqual({
      message: "ci: held public-latest lease generation 2",
      content: serializeElectronProductionPublicLatestLease(expected).toString("base64"),
      branch: "main",
      sha: initial.sha
    });
  });

  it("refuses an existing held lease without attempting a write", async () => {
    const remote = sequenceFetch(contentResponse(firstHeld()));

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "held", status: 200 });
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.init.method).toBe("GET");
  });

  it.each([409, 422])("classifies a %s SHA-CAS response as a conflict", async (status) => {
    const previous = firstReleased();
    const remote = sequenceFetch(
      contentResponse(previous),
      jsonResponse({}, status)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "conflict", status });
    expect(remote.calls).toHaveLength(2);
  });

  it("reconciles an ambiguous PUT as applied after one exact authoritative reread", async () => {
    const previous = firstReleased();
    const expected = secondHeld(previous);
    const remote = sequenceFetch(
      contentResponse(previous),
      new Error("connection reset after upload"),
      contentResponse(expected)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual(expect.objectContaining({
      outcome: "applied",
      lease: expected
    }));
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("keeps read transport and server failures indeterminate", async () => {
    const transport = sequenceFetch(new Error("network unavailable"));
    await expect(readElectronProductionPublicLatestLeaseRemote({
      fetchImpl: transport.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "transport",
      status: null
    });

    const server = sequenceFetch(jsonResponse({}, 503));
    await expect(readElectronProductionPublicLatestLeaseRemote({
      fetchImpl: server.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "server-error",
      status: 503
    });
  });

  it("keeps a PUT server response as unknown acknowledgement without retry", async () => {
    const previous = firstReleased();
    const remote = sequenceFetch(
      contentResponse(previous),
      jsonResponse({}, 503),
      contentResponse(previous)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: 503
    });
    expect(remote.calls).toHaveLength(3);
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("keeps an ambiguous PUT indeterminate when its one reread is unreadable", async () => {
    const remote = sequenceFetch(
      contentResponse(firstReleased()),
      new Error("connection reset after upload"),
      new Error("reread unavailable")
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: null
    });
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("fails indeterminate when the mandatory post-PUT reread is malformed", async () => {
    const previous = firstReleased();
    const expected = secondHeld(previous);
    const noncanonical = Buffer.from(JSON.stringify(expected), "utf8");
    const remote = sequenceFetch(
      contentResponse(previous),
      jsonResponse({}, 200),
      jsonResponse(contentBodyFromSource(noncanonical))
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "verification-failed",
      status: 200
    });
  });

  it("keeps a valid but foreign post-PUT reread acknowledgement unknown", async () => {
    const previous = firstReleased();
    const foreign = secondHeld(previous, {
      transactionId: "50000000-0000-4000-8000-000000000005",
      leaseId: "60000000-0000-4000-8000-000000000006"
    });
    const remote = sequenceFetch(
      contentResponse(previous),
      jsonResponse({}, 200),
      contentResponse(foreign)
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: 200
    });
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("keeps a vacant post-PUT reread acknowledgement unknown", async () => {
    const previous = firstReleased();
    const remote = sequenceFetch(
      contentResponse(previous),
      jsonResponse({}, 200),
      jsonResponse({}, 404),
      repositoryResponse(),
      refResponse()
    );

    await expect(acquireElectronProductionPublicLatestLeaseRemote({
      acquisition: secondAcquisition(),
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: 200
    });
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("observes and releases only the exact held lease through SHA CAS", async () => {
    const held = firstHeld();
    const released = releaseElectronProductionPublicLatestLease(held, releaseInput(held));
    const observation = sequenceFetch(contentResponse(held));
    await expect(observeElectronProductionPublicLatestLeaseRemote({
      expected: held,
      fetchImpl: observation.fetchImpl,
      token: TOKEN
    })).resolves.toEqual(expect.objectContaining({
      outcome: "observed",
      lease: held
    }));

    const initial = contentBody(held);
    const mutation = sequenceFetch(
      jsonResponse(initial),
      jsonResponse({}, 200),
      contentResponse(released)
    );
    await expect(releaseElectronProductionPublicLatestLeaseRemote({
      expected: held,
      fetchImpl: mutation.fetchImpl,
      release: releaseInput(held),
      token: TOKEN
    })).resolves.toEqual(expect.objectContaining({
      outcome: "applied",
      lease: released
    }));
    expect(requestBody(mutation.calls[1])).toMatchObject({ sha: initial.sha });

    const foreign = sequenceFetch(contentResponse(secondGenesisHeld()));
    await expect(releaseElectronProductionPublicLatestLeaseRemote({
      expected: held,
      fetchImpl: foreign.fetchImpl,
      release: releaseInput(held),
      token: TOKEN
    })).resolves.toEqual({ outcome: "rejected", reason: "conflict", status: 200 });
    expect(foreign.calls).toHaveLength(1);
  });

  it("keeps an overtaken accepted release acknowledgement unknown", async () => {
    const held = firstHeld();
    const released = releaseElectronProductionPublicLatestLease(
      held,
      releaseInput(held)
    );
    const laterHeld = secondHeld(released);
    const remote = sequenceFetch(
      contentResponse(held),
      jsonResponse({}, 200),
      contentResponse(laterHeld)
    );

    await expect(releaseElectronProductionPublicLatestLeaseRemote({
      expected: held,
      fetchImpl: remote.fetchImpl,
      release: releaseInput(held),
      token: TOKEN
    })).resolves.toEqual({
      outcome: "indeterminate",
      reason: "unknown-acknowledgement",
      status: 200
    });
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
  });

  it("observes only the exact direct released successor without mutation", async () => {
    const held = firstHeld();
    const released = releaseElectronProductionPublicLatestLease(
      held,
      releaseInput(held)
    );
    const exact = sequenceFetch(contentResponse(released));
    await expect(
      observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote({
        expected: held,
        fetchImpl: exact.fetchImpl,
        token: TOKEN
      })
    ).resolves.toEqual(expect.objectContaining({
      outcome: "observed",
      lease: released
    }));
    expect(exact.calls).toHaveLength(1);
    expect(exact.calls[0]?.init.method).toBe("GET");

    const stillHeld = sequenceFetch(contentResponse(held));
    await expect(
      observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote({
        expected: held,
        fetchImpl: stillHeld.fetchImpl,
        token: TOKEN
      })
    ).resolves.toEqual({ outcome: "rejected", reason: "held", status: 200 });
    expect(stillHeld.calls).toHaveLength(1);

    const overtaken = sequenceFetch(contentResponse(secondHeld(released)));
    await expect(
      observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote({
        expected: held,
        fetchImpl: overtaken.fetchImpl,
        token: TOKEN
      })
    ).resolves.toEqual({ outcome: "rejected", reason: "conflict", status: 200 });
    expect(overtaken.calls).toHaveLength(1);
    expect(overtaken.calls[0]?.init.method).toBe("GET");
  });

  it.each([
    ["path", "releases/foreign.json"],
    ["type", "dir"],
    ["encoding", "utf-8"],
    ["size", 1],
    ["sha", "f".repeat(40)],
    ["content", "not base64!"]
  ] as const)("rejects malformed GET blob field %s", async (field, value) => {
    const remote = sequenceFetch(jsonResponse({
      ...contentBody(firstHeld()),
      [field]: value
    }));

    await expect(readElectronProductionPublicLatestLeaseRemote({
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "malformed-record",
      status: 200
    });
  });

  it("rejects a contents response whose declared body exceeds the bound", async () => {
    const remote = sequenceFetch(new Response("{}", {
      headers: {
        "Content-Length": "999999999",
        "Content-Type": "application/json"
      },
      status: 200
    }));

    await expect(readElectronProductionPublicLatestLeaseRemote({
      fetchImpl: remote.fetchImpl,
      token: TOKEN
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "malformed-record",
      status: 200
    });
  });
});

interface FetchCall {
  readonly init: ElectronProductionPublicLatestLeaseRemoteRequestInit;
  readonly url: string;
}

function sequenceFetch(
  ...steps: Array<ElectronProductionPublicLatestLeaseRemoteResponse | Error>
) {
  const calls: FetchCall[] = [];
  const fetchImpl: ElectronProductionPublicLatestLeaseRemoteFetch = async (url, init) => {
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
    full_name: "rion-tw/rion-studio",
    visibility: "public",
    private: false,
    default_branch: "main",
    ...overrides
  });
}

function refResponse() {
  return jsonResponse({
    ref: "refs/heads/main",
    object: { type: "commit", sha: "9".repeat(40) }
  });
}

function contentResponse(lease: ElectronProductionPublicLatestLease) {
  return jsonResponse(contentBody(lease));
}

function contentBody(lease: ElectronProductionPublicLatestLease) {
  return contentBodyFromSource(serializeElectronProductionPublicLatestLease(lease));
}

function contentBodyFromSource(source: Buffer) {
  return {
    type: "file",
    name: "electron-production-public-latest-lease.json",
    path: "releases/electron-production-public-latest-lease.json",
    encoding: "base64",
    size: source.length,
    sha: gitBlobSha(source),
    content: source.toString("base64")
  };
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function requestBody(call: FetchCall | undefined) {
  if (!call?.init.body) throw new Error("Expected a request body.");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function firstHeld() {
  return acquireElectronProductionPublicLatestLease({
    ...firstAcquisition(),
    previous: null,
    vacantGeneration: 0
  });
}

function firstReleased() {
  const held = firstHeld();
  return releaseElectronProductionPublicLatestLease(held, releaseInput(held));
}

function secondHeld(
  previous: ElectronProductionPublicLatestLease,
  overrides: Partial<ReturnType<typeof secondAcquisition>> = {}
) {
  return acquireElectronProductionPublicLatestLease({
    ...secondAcquisition(),
    ...overrides,
    previous,
    vacantGeneration: previous.generation
  });
}

function secondGenesisHeld() {
  return acquireElectronProductionPublicLatestLease({
    ...firstAcquisition(),
    transactionId: SECOND_TRANSACTION_ID,
    leaseId: SECOND_LEASE_ID,
    previous: null,
    vacantGeneration: 0
  });
}

function firstAcquisition() {
  return acquisition({
    transactionId: FIRST_TRANSACTION_ID,
    leaseId: FIRST_LEASE_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    runId: "123456789"
  });
}

function secondAcquisition() {
  return acquisition({
    transactionId: SECOND_TRANSACTION_ID,
    leaseId: SECOND_LEASE_ID,
    recordedAt: "2026-09-01T00:20:00Z",
    runId: "123456790"
  });
}

function acquisition(input: {
  leaseId: string;
  recordedAt: string;
  runId: string;
  transactionId: string;
}) {
  return {
    transactionId: input.transactionId,
    leaseId: input.leaseId,
    purpose: "electron-v23-provisional-publication" as const,
    holder: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
      workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
        "electron-v23-provisional-publication"
      ],
      runId: input.runId,
      runAttempt: 1,
      headSha: "c".repeat(40)
    },
    source: {
      runtime: "tauri-v22" as const,
      version: "8.4.2",
      stateSha256: "a".repeat(64)
    },
    target: {
      runtime: "electron-v23" as const,
      version: "8.5.0",
      stateSha256: "b".repeat(64)
    },
    recordedAt: input.recordedAt
  };
}

function releaseInput(held: ElectronProductionPublicLatestLease) {
  return {
    transactionId: held.transactionId,
    leaseId: held.leaseId,
    generation: held.generation,
    sourceStateSha256: held.source.stateSha256,
    targetStateSha256: held.target.stateSha256,
    recordedAt: "2026-09-01T00:10:00Z"
  };
}
