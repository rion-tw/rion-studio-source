import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS,
  acquireElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  readElectronProductionPublicLatestLease,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  ElectronProductionPublicLatestLeaseRemoteCliFailure,
  runElectronProductionPublicLatestLeaseRemoteCli,
  type ElectronProductionPublicLatestLeaseRemoteCliDependencies,
  type ElectronProductionPublicLatestLeaseRemoteOperationSummary
} from "../scripts/electronProductionPublicLatestLeaseRemoteCli.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteFetch,
  ElectronProductionPublicLatestLeaseRemoteRequestInit,
  ElectronProductionPublicLatestLeaseRemoteResponse
} from "../scripts/electronProductionPublicLatestLeaseRemote.mjs";

const SECRET_TOKEN = "ghp_cli_must_never_emit_this_secret";
const CONTENT_URL =
  "https://api.github.com/repos/rion-tw/rion-studio/contents/" +
  "releases/electron-production-public-latest-lease.json";
const CONTENT_READ_URL = `${CONTENT_URL}?ref=main`;
const REPOSITORY_URL = "https://api.github.com/repos/rion-tw/rion-studio";
const REF_URL = `${REPOSITORY_URL}/git/ref/heads/main`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production remote lease CLI", () => {
  it("acquires genesis, writes the fixed canonical lease, and emits a redacted summary", async () => {
    const expected = heldLease();
    const outputPath = await newOutputPath();
    const harness = cliHarness(
      jsonResponse({}, 404),
      repositoryResponse(),
      refResponse(),
      jsonResponse({}, 201),
      contentResponse(expected)
    );

    const summary = await runElectronProductionPublicLatestLeaseRemoteCli(
      acquireArguments(outputPath),
      harness.dependencies
    );

    expect(summary).toMatchObject({
      command: "acquire",
      request: {
        expectedHeld: {
          transactionId: expected.transactionId,
          leaseId: expected.leaseId,
          source: { stateSha256: expected.source.stateSha256 },
          target: { stateSha256: expected.target.stateSha256 }
        }
      },
      outcome: "applied",
      reason: null,
      httpStatus: null,
      remote: {
        repository: "rion-tw/rion-studio",
        ref: "main",
        path: "releases/electron-production-public-latest-lease.json"
      },
      lease: {
        transactionId: expected.transactionId,
        leaseId: expected.leaseId,
        generation: 1,
        status: "held"
      },
      output: { fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE }
    });
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: requiredOutput(summary).sha256,
      leasePath: outputPath
    })).resolves.toMatchObject({ lease: expected });
    expect(harness.calls.map(({ url }) => url)).toEqual([
      CONTENT_READ_URL,
      REPOSITORY_URL,
      REF_URL,
      CONTENT_URL,
      CONTENT_READ_URL
    ]);
    expect(harness.calls[0]?.init.headers.Authorization)
      .toBe(`Bearer ${SECRET_TOKEN}`);
    assertCanonicalRedactedSummary(harness, summary);
    expect(harness.exitCodes).toEqual([]);
  });

  it("observes an exact canonical local held lease and copies it create-new", async () => {
    const held = heldLease();
    const local = await writeHeldInput(held);
    const outputPath = await newOutputPath();
    const harness = cliHarness(contentResponse(held));

    const summary = await runElectronProductionPublicLatestLeaseRemoteCli([
      "observe",
      "--held-lease", local.path,
      "--held-lease-sha256", local.sha256,
      "--output", outputPath
    ], harness.dependencies);

    expect(summary).toMatchObject({
      command: "observe",
      outcome: "observed",
      lease: { status: "held", generation: 1 }
    });
    expect(await readFile(outputPath)).toEqual(
      serializeElectronProductionPublicLatestLease(held)
    );
    assertCanonicalRedactedSummary(harness, summary);
  });

  it("releases only the locally fenced held lease and writes the released record", async () => {
    const held = heldLease();
    const released = releaseElectronProductionPublicLatestLease(
      held,
      releaseInput(held)
    );
    const local = await writeHeldInput(held);
    const outputPath = await newOutputPath();
    const harness = cliHarness(
      contentResponse(held),
      jsonResponse({}, 200),
      contentResponse(released)
    );

    const summary = await runElectronProductionPublicLatestLeaseRemoteCli([
      "release",
      "--held-lease", local.path,
      "--held-lease-sha256", local.sha256,
      "--recorded-at", "2026-09-01T00:10:00Z",
      "--output", outputPath
    ], harness.dependencies);

    expect(summary).toMatchObject({
      command: "release",
      request: {
        attemptedAt: "2026-09-01T00:10:00Z",
        held: {
          transactionId: held.transactionId,
          leaseId: held.leaseId,
          generation: held.generation,
          revision: held.revision,
          eventSha256: electronProductionPublicLatestLeaseEventSha256(held),
          sourceStateSha256: held.source.stateSha256,
          targetStateSha256: held.target.stateSha256
        }
      },
      outcome: "applied",
      lease: { status: "released", revision: 2 }
    });
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: requiredOutput(summary).sha256,
      leasePath: outputPath
    })).resolves.toMatchObject({ lease: released });
    expect(requestBody(harness.calls[1])).toHaveProperty("sha");
    assertCanonicalRedactedSummary(harness, summary);
  });

  it("reconciles an exact released successor without another PUT", async () => {
    const held = heldLease();
    const released = releaseElectronProductionPublicLatestLease(
      held,
      releaseInput(held)
    );
    const local = await writeHeldInput(held);
    const outputPath = await newOutputPath();
    const harness = cliHarness(contentResponse(released));

    const summary = await runElectronProductionPublicLatestLeaseRemoteCli([
      "observe-release",
      "--held-lease", local.path,
      "--held-lease-sha256", local.sha256,
      "--recorded-at", released.recordedAt,
      "--output", outputPath
    ], harness.dependencies);

    expect(summary).toMatchObject({
      command: "observe-release",
      outcome: "observed",
      lease: { status: "released", revision: held.revision + 1 }
    });
    expect(harness.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(0);
    await expect(readElectronProductionPublicLatestLease({
      expectedSha256: requiredOutput(summary).sha256,
      leasePath: outputPath
    })).resolves.toMatchObject({ lease: released });
  });

  it("emits a closed rejected summary, sets failure, and never creates output", async () => {
    const outputPath = await newOutputPath();
    const harness = cliHarness(contentResponse(heldLease()));

    const failure = await capturedFailure(
      runElectronProductionPublicLatestLeaseRemoteCli(
        acquireArguments(outputPath),
        harness.dependencies
      )
    );

    expect(failure.summary).toMatchObject({
      command: "acquire",
      request: {
        expectedHeld: {
          transactionId: heldLease().transactionId,
          leaseId: heldLease().leaseId
        }
      },
      outcome: "rejected",
      reason: "held",
      httpStatus: 200,
      lease: null,
      output: null
    });
    expect(harness.exitCodes).toEqual([1]);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    assertCanonicalRedactedSummary(harness, failure.summary);
  });

  it("preserves an indeterminate transport result as canonical nonzero failure", async () => {
    const outputPath = await newOutputPath();
    const harness = cliHarness(new Error(`transport failed with ${SECRET_TOKEN}`));

    const failure = await capturedFailure(
      runElectronProductionPublicLatestLeaseRemoteCli(
        acquireArguments(outputPath),
        harness.dependencies
      )
    );

    expect(failure.summary).toMatchObject({
      outcome: "indeterminate",
      reason: "transport",
      httpStatus: null,
      output: null
    });
    expect(failure.message).not.toContain(SECRET_TOKEN);
    expect(harness.exitCodes).toEqual([1]);
    expect(harness.calls).toHaveLength(1);
    assertCanonicalRedactedSummary(harness, failure.summary);
  });

  it.each(["repository", "ref", "path", "token"])(
    "forbids caller-controlled --%s",
    async (name) => {
      const outputPath = await newOutputPath();
      const harness = cliHarness();
      await expect(runElectronProductionPublicLatestLeaseRemoteCli([
        ...acquireArguments(outputPath),
        `--${name}`, "forbidden"
      ], harness.dependencies)).rejects.toThrow(
        `Unknown acquire option --${name}`
      );
      expect(harness.calls).toHaveLength(0);
      expect(harness.outputs).toHaveLength(0);
    }
  );

  it("rejects duplicate, missing, and malformed options before fetch", async () => {
    const outputPath = await newOutputPath();
    const harness = cliHarness();
    await expect(runElectronProductionPublicLatestLeaseRemoteCli([
      ...acquireArguments(outputPath),
      "--output", outputPath
    ], harness.dependencies)).rejects.toThrow("Duplicate");
    await expect(runElectronProductionPublicLatestLeaseRemoteCli([
      "acquire", "--output"
    ], harness.dependencies)).rejects.toThrow("must have one value");
    await expect(runElectronProductionPublicLatestLeaseRemoteCli([
      ...replaceOption(acquireArguments(outputPath), "holder-run-attempt", "0")
    ], harness.dependencies)).rejects.toThrow("positive integer");
    expect(harness.calls).toHaveLength(0);
  });

  it("reads the credential only from GH_TOKEN and never from an option", async () => {
    const outputPath = await newOutputPath();
    const harness = cliHarness();
    await expect(runElectronProductionPublicLatestLeaseRemoteCli(
      acquireArguments(outputPath),
      {
        ...harness.dependencies,
        environment: {}
      }
    )).rejects.toThrow("GH_TOKEN is required");
    expect(harness.calls).toHaveLength(0);
    expect(harness.outputs).toHaveLength(0);

    await expect(runElectronProductionPublicLatestLeaseRemoteCli(
      acquireArguments(outputPath),
      {
        ...harness.dependencies,
        token: SECRET_TOKEN
      } as ElectronProductionPublicLatestLeaseRemoteCliDependencies
    )).rejects.toThrow("Unknown remote lease CLI dependency token");
  });

  it("requires the fixed output filename before any remote mutation", async () => {
    const root = await temporaryDirectory();
    const harness = cliHarness();
    await expect(runElectronProductionPublicLatestLeaseRemoteCli(
      acquireArguments(path.join(root, "foreign.json")),
      harness.dependencies
    )).rejects.toThrow("filename does not match");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a local held lease digest mismatch before remote observation", async () => {
    const local = await writeHeldInput(heldLease());
    const outputPath = await newOutputPath();
    const harness = cliHarness();
    await expect(runElectronProductionPublicLatestLeaseRemoteCli([
      "observe",
      "--held-lease", local.path,
      "--held-lease-sha256", "f".repeat(64),
      "--output", outputPath
    ], harness.dependencies)).rejects.toThrow("SHA-256 does not match");
    expect(harness.calls).toHaveLength(0);
  });
});

interface FetchCall {
  readonly init: ElectronProductionPublicLatestLeaseRemoteRequestInit;
  readonly url: string;
}

interface CliHarness {
  readonly calls: FetchCall[];
  readonly dependencies: ElectronProductionPublicLatestLeaseRemoteCliDependencies;
  readonly exitCodes: number[];
  readonly outputs: Buffer[];
}

function cliHarness(
  ...steps: Array<ElectronProductionPublicLatestLeaseRemoteResponse | Error>
): CliHarness {
  const calls: FetchCall[] = [];
  const outputs: Buffer[] = [];
  const exitCodes: number[] = [];
  const fetchImpl: ElectronProductionPublicLatestLeaseRemoteFetch = async (url, init) => {
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

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function repositoryResponse() {
  return jsonResponse({
    full_name: "rion-tw/rion-studio",
    visibility: "public",
    private: false,
    default_branch: "main"
  });
}

function refResponse() {
  return jsonResponse({
    ref: "refs/heads/main",
    object: { type: "commit", sha: "9".repeat(40) }
  });
}

function contentResponse(lease: ElectronProductionPublicLatestLease) {
  const source = serializeElectronProductionPublicLatestLease(lease);
  return jsonResponse({
    type: "file",
    name: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
    path: "releases/electron-production-public-latest-lease.json",
    encoding: "base64",
    size: source.length,
    sha: gitBlobSha(source),
    content: source.toString("base64")
  });
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function heldLease() {
  return acquireElectronProductionPublicLatestLease({
    ...acquisitionInput(),
    previous: null,
    vacantGeneration: 0
  });
}

function acquisitionInput() {
  return {
    transactionId: "10000000-0000-4000-8000-000000000001",
    leaseId: "20000000-0000-4000-8000-000000000002",
    purpose: "electron-v23-provisional-publication" as const,
    holder: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY,
      workflow: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS[
        "electron-v23-provisional-publication"
      ],
      runId: "123456789",
      runAttempt: 2,
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
    recordedAt: "2026-09-01T00:00:00Z"
  };
}

function acquireArguments(outputPath: string) {
  const input = acquisitionInput();
  return [
    "acquire",
    "--transaction-id", input.transactionId,
    "--lease-id", input.leaseId,
    "--purpose", input.purpose,
    "--holder-workflow", input.holder.workflow,
    "--holder-run-id", input.holder.runId,
    "--holder-run-attempt", String(input.holder.runAttempt),
    "--control-head-sha", input.holder.headSha,
    "--source-runtime", input.source.runtime,
    "--source-version", input.source.version,
    "--source-state-sha256", input.source.stateSha256,
    "--target-runtime", input.target.runtime,
    "--target-version", input.target.version,
    "--target-state-sha256", input.target.stateSha256,
    "--recorded-at", input.recordedAt,
    "--output", outputPath
  ];
}

function replaceOption(argumentsList: string[], name: string, value: string) {
  const next = [...argumentsList];
  const index = next.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing test option ${name}.`);
  next[index + 1] = value;
  return next;
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

async function writeHeldInput(held: ElectronProductionPublicLatestLease) {
  const root = await temporaryDirectory();
  const leasePath = path.join(root, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE);
  const written = await writeElectronProductionPublicLatestLease({
    lease: held,
    outputPath: leasePath
  });
  return { path: written.leasePath, sha256: written.leaseIdentity.sha256 };
}

async function newOutputPath() {
  return path.join(
    await temporaryDirectory(),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
  );
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-remote-lease-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function capturedFailure(
  operation: Promise<ElectronProductionPublicLatestLeaseRemoteOperationSummary>
) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof ElectronProductionPublicLatestLeaseRemoteCliFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the remote lease CLI operation to fail.");
}

function assertCanonicalRedactedSummary(
  harness: CliHarness,
  summary: ElectronProductionPublicLatestLeaseRemoteOperationSummary
) {
  expect(harness.outputs).toHaveLength(1);
  expect(harness.outputs[0]).toEqual(serializeCanonicalJson(summary));
  expect(harness.outputs[0]?.toString("utf8")).not.toContain(SECRET_TOKEN);
}

function requiredOutput(summary: ElectronProductionPublicLatestLeaseRemoteOperationSummary) {
  if (!summary.output) throw new Error("Expected a CLI output identity.");
  return summary.output;
}

function requestBody(call: FetchCall | undefined) {
  if (!call?.init.body) throw new Error("Expected a request body.");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}
