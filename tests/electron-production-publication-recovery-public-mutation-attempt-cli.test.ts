import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  createElectronProductionPublicLatestRecoveryObservation,
  writeElectronProductionPublicLatestRecoveryObservation
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE,
  electronProductionPublicationRecoveryPublicMutationAttemptFileName,
  readElectronProductionPublicationRecoveryPublicMutationAttempt,
  readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  readElectronProductionPublicationRecoveryPublicMutationAttemptHistory,
  serializeElectronProductionPublicationRecoveryPublicMutationAttempt
} from "../scripts/electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_CLI_SUMMARY_KIND,
  runElectronProductionPublicationRecoveryPublicMutationAttemptCli,
  type ElectronProductionPublicationRecoveryPublicMutationAttemptCliDependencies
} from "../scripts/electronProductionPublicationRecoveryPublicMutationAttemptCli.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt,
  writeElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  createLeaseReleaseAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";
import {
  createOutcomeDiscoveryFixture,
  writeOutcomeDiscoveryFoundation
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const TOKEN = "public-mutation-marker-history-token-must-not-leak";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publication recovery public-mutation marker CLI", () => {
  it("materializes a canonical predecessor slot without reading a token", async () => {
    const fixture = await cliFixture();
    const stdout: Buffer[] = [];
    const summary = await materializeAttempt(fixture, {
      writeStdout: (source) => {
        stdout.push(Buffer.from(source));
      },
      readToken: () => {
        throw new Error("materialize-attempt must not read GH_TOKEN");
      }
    });

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_CLI_SUMMARY_KIND,
      command: "materialize-attempt",
      status: "created",
      operation: "release-held-lease",
      artifact: {
        fileName:
          electronProductionPublicationRecoveryPublicMutationAttemptFileName({
            previousOutcomeSha256: null
          })
      }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
    await expect(readElectronProductionPublicationRecoveryPublicMutationAttempt({
      receiptPath: fixture.attemptPath,
      expectedSha256: summary.artifact.sha256
    })).resolves.toMatchObject({ value: { operation: "release-held-lease" } });
  });

  it("authorizes only the exact created marker transition tokenlessly", async () => {
    const fixture = await cliFixture();
    const materialized = await materializeAttempt(fixture);
    const attemptFile =
      await readElectronProductionPublicationRecoveryPublicMutationAttempt({
        receiptPath: fixture.attemptPath,
        expectedSha256: materialized.artifact.sha256
      });
    const evidence = await writeMarkerEvidence(fixture, attemptFile.value);
    const post = await postMarkerAuthorization(fixture);
    const outputDirectory = path.join(fixture.root, "attempt-authorization");
    await mkdir(outputDirectory);
    const outputPath = path.join(
      outputDirectory,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE
    );
    const stdout: Buffer[] = [];
    const summary =
      await runElectronProductionPublicationRecoveryPublicMutationAttemptCli([
        "authorize-attempt",
        "--attempt", fixture.attemptPath,
        "--attempt-sha256", materialized.artifact.sha256,
        "--pre-marker-authorization", fixture.pre.authorizationFile.path,
        "--pre-marker-authorization-sha256", fixture.pre.sha256,
        "--create-operation", evidence.createPath,
        "--create-operation-sha256", evidence.createSha256,
        "--attempt-read-operation", evidence.readPath,
        "--attempt-read-operation-sha256", evidence.readSha256,
        "--post-marker-authorization", post.authorizationFile.path,
        "--post-marker-authorization-sha256", post.sha256,
        "--verified-at", "2026-09-01T00:06:00Z",
        "--output", outputPath
      ], {
        readToken: () => {
          throw new Error("authorize-attempt must not read GH_TOKEN");
        },
        writeStdout: (source) => {
          stdout.push(Buffer.from(source));
        }
      });

    expect(summary).toMatchObject({
      command: "authorize-attempt",
      operation: "release-held-lease",
      artifact: {
        fileName:
          ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE
      }
    });
    await expect(
      readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        receiptPath: outputPath,
        expectedSha256: summary.artifact.sha256
      })
    ).resolves.toMatchObject({
      value: { headTransition: { mode: "created-now" } }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
  });

  it("proves fixed-path history with one bounded token scope", async () => {
    const fixture = await cliFixture();
    const materialized = await materializeAttempt(fixture);
    const attemptFile =
      await readElectronProductionPublicationRecoveryPublicMutationAttempt({
        receiptPath: fixture.attemptPath,
        expectedSha256: materialized.artifact.sha256
      });
    const evidence = await writeMarkerEvidence(fixture, attemptFile.value);
    const outputDirectory = path.join(fixture.root, "attempt-history");
    await mkdir(outputDirectory);
    const outputPath = path.join(
      outputDirectory,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE
    );
    const remote = sequenceFetch(
      jsonResponse({
        full_name: "recovery-owner/recovery-vault",
        private: true,
        visibility: "private",
        default_branch: "recovery-main"
      }),
      refResponse("7".repeat(40)),
      jsonResponse([{ sha: "7".repeat(40) }]),
      jsonResponse({
        sha: "7".repeat(40),
        tree: { sha: "8".repeat(40) },
        parents: [{ sha: "1".repeat(40) }]
      }),
      jsonResponse({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        base_commit: { sha: "1".repeat(40) },
        merge_base_commit: { sha: "1".repeat(40) },
        commits: [{ sha: "7".repeat(40) }],
        files: [{
          filename: attemptFile.value.privateStore.path,
          status: "added",
          sha: gitBlobSha(
            serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
              attemptFile.value
            )
          )
        }]
      }),
      refResponse("7".repeat(40))
    );
    const stdout: Buffer[] = [];
    const summary =
      await runElectronProductionPublicationRecoveryPublicMutationAttemptCli([
        "prove-existing-attempt-history",
        "--attempt", fixture.attemptPath,
        "--attempt-sha256", materialized.artifact.sha256,
        "--attempt-read-operation", evidence.readPath,
        "--attempt-read-operation-sha256", evidence.readSha256,
        "--observed-at", "2026-09-01T00:06:00Z",
        "--output", outputPath
      ], {
        fetchImpl: remote.fetchImpl,
        readToken: () => TOKEN,
        writeStdout: (source) => {
          stdout.push(Buffer.from(source));
        }
      });

    expect(summary.artifact.fileName).toBe(
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE
    );
    await expect(
      readElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
        receiptPath: outputPath,
        expectedSha256: summary.artifact.sha256
      })
    ).resolves.toMatchObject({
      value: { pathHistory: { resultCount: 1, nextPage: false } }
    });
    expect(remote.calls).toHaveLength(6);
    expect(remote.calls.every(({ init }) =>
      init.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
  });
});

async function cliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-public-mutation-cli-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const foundationFiles = await writeOutcomeDiscoveryFoundation(root, fixture);
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:03:00Z",
    fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:02:30Z",
    suffix: "marker-cli-pre",
    verifiedAt: "2026-09-01T00:04:00Z"
  });
  const observationDirectory = path.join(root, "public-observation");
  const attemptDirectory = path.join(root, "attempt");
  await Promise.all([observationDirectory, attemptDirectory].map((directory) =>
    mkdir(directory)
  ));
  const publicObservation = createElectronProductionPublicLatestRecoveryObservation({
    observedAt: "2026-09-01T00:04:30Z",
    result: {
      outcome: "observed",
      latest: {
        releaseId: fixture.source.release.id,
        updatedAt: "2026-09-01T00:00:00Z"
      },
      snapshot: fixture.source
    },
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: foundationFiles.sourceSnapshotSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: foundationFiles.targetSnapshotSha256
  });
  const observation = await writeElectronProductionPublicLatestRecoveryObservation({
    outputPath: path.join(
      observationDirectory,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    ),
    receipt: publicObservation
  });
  return {
    ...fixture,
    attemptPath: path.join(
      attemptDirectory,
      electronProductionPublicationRecoveryPublicMutationAttemptFileName({
        previousOutcomeSha256: null
      })
    ),
    foundationFiles,
    observation,
    pre,
    root
  };
}

async function materializeAttempt(
  fixture: Awaited<ReturnType<typeof cliFixture>>,
  dependencies:
    ElectronProductionPublicationRecoveryPublicMutationAttemptCliDependencies = {
      writeStdout: () => {}
    }
) {
  return runElectronProductionPublicationRecoveryPublicMutationAttemptCli([
    "materialize-attempt",
    "--authorization", fixture.pre.authorizationFile.path,
    "--authorization-sha256", fixture.pre.sha256,
    "--operation", "release-held-lease",
    "--public-observation", fixture.observation.receiptPath,
    "--public-observation-sha256", fixture.observation.receiptIdentity.sha256,
    "--source-snapshot", fixture.foundationFiles.sourceSnapshot,
    "--source-snapshot-sha256", fixture.foundationFiles.sourceSnapshotSha256,
    "--target-snapshot", fixture.foundationFiles.targetSnapshot,
    "--target-snapshot-sha256", fixture.foundationFiles.targetSnapshotSha256,
    "--reserved-at", "2026-09-01T00:05:00Z",
    "--output", fixture.attemptPath
  ], dependencies);
}

async function postMarkerAuthorization(
  fixture: Awaited<ReturnType<typeof cliFixture>>
) {
  return createLeaseReleaseAuthorizationFixture({
    authorizedAt: fixture.pre.intent.authorizedAt,
    currentObservation: { head: "7", parent: "1", tree: "8" },
    currentRun: fixture.pre.authorization.currentRun,
    fixture,
    freshEntries: [],
    intent: fixture.pre.intent,
    mode: "resumed-existing",
    outputRoot: fixture.root,
    recoveryRunStartedAt: fixture.pre.intent.recoveryRun.startedAt,
    suffix: "marker-cli-post",
    verifiedAt: "2026-09-01T00:05:30Z"
  });
}

async function writeMarkerEvidence(
  fixture: Awaited<ReturnType<typeof cliFixture>>,
  attempt: Awaited<ReturnType<typeof readElectronProductionPublicationRecoveryPublicMutationAttempt>>["value"]
) {
  const source =
    serializeElectronProductionPublicationRecoveryPublicMutationAttempt(attempt);
  const sha256 = createHash("sha256").update(source).digest("hex");
  const target = {
    owner: "recovery-owner",
    repo: "recovery-vault",
    ref: attempt.privateStore.target.ref,
    path: attempt.privateStore.path,
    repositoryPolicy: attempt.privateStore.target.repositoryPolicy
  };
  const createReceipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request: createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: attempt.privateStore.expectedHeadCommitSha,
      packageIdentity: {
        fileName: path.posix.basename(attempt.privateStore.path),
        byteLength: source.length,
        sha256
      },
      target
    }),
    result: {
      outcome: "applied",
      parentSha: "1".repeat(40),
      commitSha: "7".repeat(40),
      treeSha: "8".repeat(40),
      blobSha: gitBlobSha(source),
      byteLength: source.length
    }
  });
  const readReceipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    request: createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: { byteLength: source.length, sha256 },
      target
    }),
    content: source,
    result: {
      outcome: "present",
      blobSha: gitBlobSha(source),
      byteLength: source.length,
      commitMessage: "marker readback",
      contentBase64: source.toString("base64"),
      headSha: "7".repeat(40),
      parentShas: ["1".repeat(40)],
      treeSha: "8".repeat(40)
    }
  });
  const createDirectory = path.join(fixture.root, "attempt-create-operation");
  const readDirectory = path.join(fixture.root, "attempt-read-operation");
  await Promise.all([createDirectory, readDirectory].map((directory) =>
    mkdir(directory)
  ));
  const createPath = path.join(
    createDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const readPath = path.join(
    readDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
  );
  const [created, read] = await Promise.all([
    writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath: createPath,
      receipt: createReceipt
    }),
    writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath: readPath,
      receipt: readReceipt
    })
  ]);
  return {
    createPath,
    createSha256: created.receiptIdentity.sha256,
    readPath,
    readSha256: read.receiptIdentity.sha256
  };
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function refResponse(sha: string) {
  return jsonResponse({
    ref: "refs/heads/recovery-main",
    object: { type: "commit", sha }
  });
}

function jsonResponse(value: unknown) {
  const source = Buffer.from(JSON.stringify(value), "utf8");
  let delivered = false;
  return {
    status: 200,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-length" ? String(source.length) : null;
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

function sequenceFetch(...responses: ReturnType<typeof jsonResponse>[]) {
  type FetchInit = Readonly<{
    headers: Readonly<Record<string, string>>;
    method: string;
    redirect: string;
  }>;
  const calls: Array<{ url: string; init: FetchInit }> = [];
  let index = 0;
  return {
    calls,
    async fetchImpl(url: string, init: unknown) {
      calls.push({ url, init: init as FetchInit });
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("Unexpected marker-history fetch.");
      return response;
    }
  };
}
