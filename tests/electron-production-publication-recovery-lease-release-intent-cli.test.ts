import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE,
  readElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  readElectronProductionPublicationRecoveryLeaseReleaseIntent,
  readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory,
  serializeElectronProductionPublicationRecoveryLeaseReleaseIntent,
  writeElectronProductionPublicationRecoveryLeaseReleaseIntent
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_CLI_SUMMARY_KIND,
  runElectronProductionPublicationRecoveryLeaseReleaseIntentCli
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntentCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
  writeElectronProductionPublicationRecoveryOutcomeChainProof
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  serializeElectronProductionPublicationRecoveryStoreSeal
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "../scripts/electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
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

const TOKEN = "intent-history-token-must-not-leak";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publication recovery lease-release intent CLI", () => {
  it("materializes one canonical fixed durable intent without a token surface", async () => {
    const fixture = await cliFixture();
    const outputDirectory = path.join(fixture.root, "materialized-intent");
    await mkdir(outputDirectory);
    const outputPath = path.join(
      outputDirectory,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE
    );
    const stdout: Buffer[] = [];
    const summary =
      await runElectronProductionPublicationRecoveryLeaseReleaseIntentCli([
        "materialize-intent",
        "--held-lease", fixture.foundation.heldLease,
        "--held-lease-sha256", fixture.foundation.heldLeaseSha256,
        "--store-seal", fixture.foundation.storeSeal,
        "--store-seal-sha256", fixture.foundation.storeSealSha256,
        "--chain-proof", fixture.initialProofPath,
        "--chain-proof-sha256", fixture.initialProofSha256,
        "--run-repository", "rion-tw/rion-studio-source",
        "--run-workflow",
        ".github/workflows/electron-production-provisional-recovery.yml",
        "--run-id", "9901",
        "--run-attempt", "1",
        "--control-sha", "e".repeat(40),
        "--run-started-at", "2026-09-01T00:02:30Z",
        "--authorized-at", "2026-09-01T00:03:00Z",
        "--output", outputPath
      ], {
        readToken: () => {
          throw new Error("materialize-intent must not read GH_TOKEN");
        },
        writeStdout: (source) => {
          stdout.push(Buffer.from(source));
        }
      });

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_CLI_SUMMARY_KIND,
      command: "materialize-intent",
      status: "created",
      transactionId: fixture.fixture.heldLease.transactionId,
      artifact: {
        fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE
      }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
    await expect(readElectronProductionPublicationRecoveryLeaseReleaseIntent({
      receiptPath: outputPath,
      expectedSha256: summary.artifact.sha256
    })).resolves.toMatchObject({ value: fixture.authority.intent });
  });

  it("authorizes a created intent tokenlessly from exact same-head readback", async () => {
    const fixture = await cliFixture();
    const outputDirectory = path.join(fixture.root, "authorized-intent");
    await mkdir(outputDirectory);
    const outputPath = path.join(
      outputDirectory,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE
    );
    const stdout: Buffer[] = [];
    const summary =
      await runElectronProductionPublicationRecoveryLeaseReleaseIntentCli([
        "authorize",
        "--owner", "recovery-owner",
        "--repo", "recovery-vault",
        "--ref", "recovery-main",
        "--current-run-repository", "rion-tw/rion-studio-source",
        "--current-run-workflow",
        ".github/workflows/electron-production-provisional-recovery.yml",
        "--current-run-id", "9901",
        "--current-run-attempt", "1",
        "--current-control-sha", "e".repeat(40),
        "--current-run-started-at", "2026-09-01T00:02:30Z",
        "--intent", fixture.intentPath,
        "--intent-sha256", fixture.intentSha256,
        "--create-operation", fixture.createOperationPath,
        "--create-operation-sha256", fixture.createOperationSha256,
        "--intent-read-operation", fixture.intentReadPath,
        "--intent-read-operation-sha256", fixture.intentReadSha256,
        "--fresh-chain-proof", fixture.freshProofPath,
        "--fresh-chain-proof-sha256", fixture.freshProofSha256,
        "--capsule", fixture.capsulePath,
        "--capsule-read-operation", fixture.capsuleReadPath,
        "--capsule-read-operation-sha256", fixture.capsuleReadSha256,
        "--store-seal", fixture.foundation.storeSeal,
        "--seal-read-operation", fixture.sealReadPath,
        "--seal-read-operation-sha256", fixture.sealReadSha256,
        "--verified-at", "2026-09-01T00:04:00Z",
        "--output", outputPath
      ], {
        readToken: () => {
          throw new Error("authorize must not read GH_TOKEN");
        },
        writeStdout: (source) => {
          stdout.push(Buffer.from(source));
        }
      });

    expect(summary).toMatchObject({
      command: "authorize",
      status: "created",
      artifact: {
        fileName:
          ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE
      }
    });
    const authorization =
      await readElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        receiptPath: outputPath,
        expectedSha256: summary.artifact.sha256
      });
    expect(authorization.value).toMatchObject({
      status: "verified-durable-release-authority",
      headTransition: { mode: "created-now" }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
    expect(stdout[0]?.toString("utf8")).not.toContain(
      fixture.fixture.capsuleSource.toString("base64")
    );
  });

  it("proves the unique fixed-path create history with one bounded token scope", async () => {
    const fixture = await cliFixture();
    const outputDirectory = path.join(fixture.root, "intent-history");
    await mkdir(outputDirectory);
    const outputPath = path.join(
      outputDirectory,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE
    );
    const currentHead = "1".repeat(40);
    const initialHead = "4".repeat(40);
    const intentBlob = gitBlobSha(
      serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(
        fixture.authority.intent
      )
    );
    const remote = sequenceFetch(
      jsonResponse({
        full_name: "recovery-owner/recovery-vault",
        private: true,
        visibility: "private",
        default_branch: "recovery-main"
      }),
      refResponse(currentHead),
      jsonResponse([{ sha: currentHead }]),
      jsonResponse({
        sha: currentHead,
        tree: { sha: "2".repeat(40) },
        parents: [{ sha: initialHead }]
      }),
      jsonResponse({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        base_commit: { sha: initialHead },
        merge_base_commit: { sha: initialHead },
        commits: [{ sha: currentHead }],
        files: [{
          filename: fixture.authority.intent.privateStore.path,
          status: "added",
          sha: intentBlob
        }]
      }),
      refResponse(currentHead)
    );
    const stdout: Buffer[] = [];
    const summary =
      await runElectronProductionPublicationRecoveryLeaseReleaseIntentCli([
        "prove-existing-intent-history",
        "--intent", fixture.intentPath,
        "--intent-sha256", fixture.intentSha256,
        "--intent-read-operation", fixture.intentReadPath,
        "--intent-read-operation-sha256", fixture.intentReadSha256,
        "--observed-at", "2026-09-01T00:04:00Z",
        "--output", outputPath
      ], {
        fetchImpl: remote.fetchImpl,
        readToken: () => TOKEN,
        writeStdout: (source) => {
          stdout.push(Buffer.from(source));
        }
      });

    expect(summary).toMatchObject({
      command: "prove-existing-intent-history",
      artifact: {
        fileName:
          ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE
      }
    });
    await expect(readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
      receiptPath: outputPath,
      expectedSha256: summary.artifact.sha256
    })).resolves.toMatchObject({
      value: {
        status: "verified-exact-create-and-reachable-path-history",
        pathHistory: { resultCount: 1, nextPage: false }
      }
    });
    expect(remote.calls).toHaveLength(6);
    expect(remote.calls.every(({ init }) =>
      init.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(stdout[0]?.toString("utf8")).not.toContain(TOKEN);
  });
});

async function cliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-release-intent-cli-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const foundation = await writeOutcomeDiscoveryFoundation(root, fixture);
  const authority = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:03:00Z",
    fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:02:30Z",
    suffix: "cli-source",
    verifiedAt: "2026-09-01T00:04:00Z"
  });
  const initialProofDirectory = path.join(root, "initial-proof");
  const freshProofDirectory = path.join(root, "fresh-proof");
  const intentDirectory = path.join(root, "intent-source");
  const createDirectory = path.join(root, "intent-create-operation");
  const intentReadDirectory = path.join(root, "intent-read-operation");
  const capsuleReadDirectory = path.join(root, "capsule-read-operation");
  const sealReadDirectory = path.join(root, "seal-read-operation");
  await Promise.all([
    initialProofDirectory,
    freshProofDirectory,
    intentDirectory,
    createDirectory,
    intentReadDirectory,
    capsuleReadDirectory,
    sealReadDirectory
  ].map((directory) => mkdir(directory)));
  const initialProof =
    await writeElectronProductionPublicationRecoveryOutcomeChainProof({
      outputPath: path.join(
        initialProofDirectory,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      ),
      value: authority.initialProof
    });
  const freshProof =
    await writeElectronProductionPublicationRecoveryOutcomeChainProof({
      outputPath: path.join(
        freshProofDirectory,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      ),
      value: authority.freshProof
    });
  const intent =
    await writeElectronProductionPublicationRecoveryLeaseReleaseIntent({
      outputPath: path.join(
        intentDirectory,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE
      ),
      value: authority.intent
    });
  if (authority.evidence.createOperation === null) {
    throw new Error("Expected a created-now operation fixture.");
  }
  const createOperationPath = path.join(
    createDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const createOperation =
    await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath: createOperationPath,
      receipt: authority.evidence.createOperation
    });
  const intentReadPath = path.join(
    intentReadDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
  );
  const intentRead =
    await writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath: intentReadPath,
      receipt: authority.evidence.intentReadOperation
    });
  const capsulePath = path.join(
    root,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
  );
  await writeFile(capsulePath, fixture.capsuleSource, { flag: "wx" });
  const sealSource = serializeElectronProductionPublicationRecoveryStoreSeal(
    fixture.storeSeal
  );
  const observation = authority.evidence.intentReadOperation.observed;
  if (observation === null) throw new Error("Expected present intent readback.");
  const capsuleRead = await writeReadOperation({
    content: fixture.capsuleSource,
    directory: capsuleReadDirectory,
    headSha: observation.headCommitSha,
    parentShas: observation.parentCommitShas,
    storePath: authority.intent.foundation.capsule.path,
    treeSha: observation.treeSha
  });
  const sealRead = await writeReadOperation({
    content: sealSource,
    directory: sealReadDirectory,
    headSha: observation.headCommitSha,
    parentShas: observation.parentCommitShas,
    storePath: authority.intent.foundation.storeSeal.path,
    treeSha: observation.treeSha
  });
  return {
    root,
    fixture,
    foundation,
    authority,
    initialProofPath: initialProof.valuePath,
    initialProofSha256: initialProof.valueIdentity.sha256,
    freshProofPath: freshProof.valuePath,
    freshProofSha256: freshProof.valueIdentity.sha256,
    intentPath: intent.valuePath,
    intentSha256: intent.valueIdentity.sha256,
    createOperationPath,
    createOperationSha256: createOperation.receiptIdentity.sha256,
    intentReadPath,
    intentReadSha256: intentRead.receiptIdentity.sha256,
    capsulePath,
    capsuleReadPath: capsuleRead.path,
    capsuleReadSha256: capsuleRead.sha256,
    sealReadPath: sealRead.path,
    sealReadSha256: sealRead.sha256
  } as const;
}

async function writeReadOperation(input: Readonly<{
  content: Buffer;
  directory: string;
  headSha: string;
  parentShas: readonly string[];
  storePath: string;
  treeSha: string;
}>) {
  const target = {
    owner: "recovery-owner",
    repo: "recovery-vault",
    ref: "recovery-main",
    path: input.storePath,
    repositoryPolicy: {
      defaultBranch: "recovery-main",
      visibility: "private" as const
    }
  };
  const request = createElectronProductionRecoveryStoreRemoteReadRequest({
    target,
    expectedContent: {
      byteLength: input.content.length,
      sha256: sha256(input.content)
    }
  });
  const receipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    request,
    content: input.content,
    result: {
      outcome: "present",
      blobSha: gitBlobSha(input.content),
      byteLength: input.content.length,
      commitMessage: "current private recovery-store head",
      contentBase64: input.content.toString("base64"),
      headSha: input.headSha,
      parentShas: input.parentShas,
      treeSha: input.treeSha
    }
  });
  const outputPath = path.join(
    input.directory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
  );
  const written =
    await writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath,
      receipt
    });
  return {
    path: outputPath,
    sha256: written.receiptIdentity.sha256
  };
}

function sequenceFetch(...responses: Response[]) {
  const calls: Array<{
    url: string;
    init: Readonly<{
      headers: Readonly<Record<string, string>>;
      method: string;
      redirect: "error";
    }>;
  }> = [];
  const fetchImpl = async (url: string, init: typeof calls[number]["init"]) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (response === undefined) throw new Error(`Unexpected request ${url}.`);
    return response;
  };
  return { calls, fetchImpl };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200
  });
}

function refResponse(sha: string) {
  return jsonResponse({
    ref: "refs/heads/recovery-main",
    object: { type: "commit", sha }
  });
}

function sha256(source: Uint8Array) {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
