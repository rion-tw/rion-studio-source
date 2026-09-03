import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_TOTAL_OUTCOME_BYTES,
  createElectronProductionPublicationRecoveryOutcomeDiscovery
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
} from "./electronProductionPublicationRecovery.mjs";
import {
  assertElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertExactKeys,
  requiredRfc3339
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const API_ROOT = "https://api.github.com";
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_RESPONSE_BYTES =
  (2 * ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES) +
  MAX_METADATA_BYTES;
const BLOB_READ_CONCURRENCY = 8;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ATTEMPT_FILE_PATTERN =
  /^electron-production-publication-recovery-outcome-run-[1-9][0-9]{0,29}-attempt-[0-9]{6}\.json$/u;

export async function discoverElectronProductionPublicationRecoveryOutcomes(
  input
) {
  assertExactKeys(input, [
    "fetchImpl",
    "observedAt",
    "target",
    "token",
    "transactionId"
  ], "publication recovery remote outcome discovery input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const observedAt = requiredRfc3339(
    input.observedAt,
    "publication recovery outcome discovery time"
  );
  const transactionId = requiredUuid(
    input.transactionId,
    "publication recovery discovery transaction ID"
  );
  const paths = electronProductionRecoveryStoreTransactionPaths({ transactionId });
  const outcomeDirectoryPath = paths.recoveryOutcomeTerminalPath
    .slice(0, -(`/${ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE}`.length));
  const target = assertElectronProductionRecoveryStoreRemoteTarget({
    ...input.target,
    path: outcomeDirectoryPath
  });
  if (target.ref !== target.repositoryPolicy.defaultBranch) {
    throw new Error(
      "The recovery outcome discovery ref must be the private default branch."
    );
  }
  const repository = await readJson(
    dependencies,
    repositoryUrl(target),
    MAX_METADATA_BYTES,
    "repository-policy"
  );
  assertRepositoryPolicy(repository, target);
  const reference = await readJson(
    dependencies,
    referenceUrl(target),
    MAX_METADATA_BYTES,
    "head-reference"
  );
  const headCommitSha = parseReference(reference, target);
  const commit = parseCommit(await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/commits/${headCommitSha}`,
    MAX_METADATA_BYTES,
    "head-commit"
  ), headCommitSha);
  const directory = await locateOutcomeDirectory(
    dependencies,
    target,
    commit.treeSha,
    transactionId,
    outcomeDirectoryPath
  );
  const entries = directory.status === "present"
    ? await readOutcomeEntries(
        dependencies,
        target,
        directory.treeSha,
        outcomeDirectoryPath
      )
    : [];
  const finalReference = await readJson(
    dependencies,
    referenceUrl(target),
    MAX_METADATA_BYTES,
    "closing-head-reference"
  );
  if (parseReference(finalReference, target) !== headCommitSha) {
    throw new Error("The recovery outcome discovery head changed during observation.");
  }
  return createElectronProductionPublicationRecoveryOutcomeDiscovery({
    transactionId,
    target: {
      repository: `${target.owner}/${target.repo}`,
      ref: target.ref,
      repositoryPolicy: target.repositoryPolicy
    },
    currentObservation: {
      headCommitSha,
      treeSha: commit.treeSha,
      parentCommitShas: commit.parentCommitShas
    },
    outcomeDirectory: {
      path: outcomeDirectoryPath,
      status: directory.status,
      treeSha: directory.treeSha
    },
    entries,
    observedAt
  });
}

async function locateOutcomeDirectory(
  dependencies,
  target,
  rootTreeSha,
  transactionId,
  outcomeDirectoryPath
) {
  const components = ["transactions", transactionId, "recovery-outcomes"];
  const absentStatuses = [
    "transactions-directory-absent",
    "transaction-directory-absent",
    "outcome-directory-absent"
  ];
  let treeSha = rootTreeSha;
  for (let index = 0; index < components.length; index += 1) {
    const entries = await readTree(dependencies, target, treeSha);
    assertUniqueTreePaths(entries);
    const matches = entries.filter((entry) => entry.path === components[index]);
    if (matches.length === 0) {
      return Object.freeze({
        path: outcomeDirectoryPath,
        status: absentStatuses[index],
        treeSha: null
      });
    }
    if (matches.length !== 1) {
      throw new Error("The recovery outcome directory path is ambiguous.");
    }
    const entry = matches[0];
    if (
      entry.mode !== "040000" || entry.type !== "tree" ||
      !isObjectSha(entry.sha)
    ) {
      throw new Error("The recovery outcome directory has a Git path conflict.");
    }
    treeSha = entry.sha;
  }
  return Object.freeze({
    path: outcomeDirectoryPath,
    status: "present",
    treeSha
  });
}

async function readOutcomeEntries(dependencies, target, directoryTreeSha, root) {
  const treeEntries = await readTree(dependencies, target, directoryTreeSha);
  assertUniqueTreePaths(treeEntries);
  if (treeEntries.length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES + 1) {
    throw new Error("The remote recovery outcome directory exceeds its entry bound.");
  }
  const descriptors = treeEntries.map((entry) => {
    const role = entry.path ===
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
      ? "terminal"
      : ATTEMPT_FILE_PATTERN.test(entry.path) ? "attempt" : null;
    if (role === null) {
      throw new Error("The remote recovery outcome directory has a foreign entry.");
    }
    if (
      entry.mode !== "100644" || entry.type !== "blob" ||
      !isObjectSha(entry.sha) || !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES
    ) {
      throw new Error("A remote recovery outcome has invalid Git metadata.");
    }
    return Object.freeze({
      role,
      fileName: entry.path,
      mode: "100644",
      type: "blob",
      blobSha: entry.sha,
      byteLength: entry.size
    });
  }).sort((left, right) => left.fileName.localeCompare(right.fileName));
  if (descriptors.filter((entry) => entry.role === "attempt").length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES ||
      descriptors.filter((entry) => entry.role === "terminal").length > 1) {
    throw new Error("The remote recovery outcome directory has invalid cardinality.");
  }
  const totalBytes = descriptors.reduce(
    (sum, descriptor) => sum + descriptor.byteLength,
    0
  );
  if (totalBytes >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_TOTAL_OUTCOME_BYTES) {
    throw new Error("The remote recovery outcome directory exceeds its byte bound.");
  }
  return mapConcurrent(descriptors, BLOB_READ_CONCURRENCY, async (descriptor) => {
    const source = parseBlob(await readJson(
      dependencies,
      `${repositoryUrl(target)}/git/blobs/${descriptor.blobSha}`,
      MAX_BLOB_RESPONSE_BYTES,
      "outcome-blob"
    ), descriptor.blobSha, descriptor.byteLength);
    return Object.freeze({
      ...descriptor,
      path: `${root}/${descriptor.fileName}`,
      sha256: sha256(source),
      contentBase64: source.toString("base64")
    });
  });
}

async function readTree(dependencies, target, treeSha) {
  const value = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/trees/${treeSha}`,
    MAX_TREE_BYTES,
    "tree"
  );
  if (
    !isObject(value) || value.sha !== treeSha || value.truncated !== false ||
    !Array.isArray(value.tree)
  ) {
    throw new Error("The recovery outcome Git tree is malformed or truncated.");
  }
  return value.tree.map((entry) => {
    if (
      !isObject(entry) || typeof entry.path !== "string" ||
      typeof entry.mode !== "string" || typeof entry.type !== "string" ||
      typeof entry.sha !== "string"
    ) throw new Error("The recovery outcome Git tree entry is malformed.");
    return entry;
  });
}

async function readJson(dependencies, url, maximumBytes, stage) {
  let response;
  try {
    response = await dependencies.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${dependencies.token}`,
        "User-Agent": "rion-studio-recovery-outcome-discovery",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      redirect: "error"
    });
  } catch (error) {
    throw new Error(`Recovery outcome remote ${stage} transport failed.`, {
      cause: error
    });
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Error(`Recovery outcome remote ${stage} response is invalid.`);
  }
  if (response.status !== 200) {
    await cancelResponse(response);
    throw new Error(`Recovery outcome remote ${stage} was not acknowledged.`);
  }
  return readBoundedJson(response, maximumBytes, stage);
}

async function readBoundedJson(response, maximumBytes, stage) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    await cancelResponse(response);
    throw new Error(`Recovery outcome remote ${stage} exceeds its byte bound.`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`Recovery outcome remote ${stage} body is unavailable.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const event = await reader.read();
      if (event.done) break;
      if (!(event.value instanceof Uint8Array)) {
        throw new Error("response chunk is invalid");
      }
      bytes += event.value.byteLength;
      if (bytes > maximumBytes) throw new Error("response is oversized");
      chunks.push(event.value);
    }
    return JSON.parse(UTF8_DECODER.decode(Buffer.concat(chunks, bytes)));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw new Error(`Recovery outcome remote ${stage} body is malformed.`, {
      cause: error
    });
  }
}

async function cancelResponse(response) {
  try {
    await response.body?.getReader?.().cancel();
  } catch {
    // The rejected response body is intentionally discarded.
  }
}

function assertRepositoryPolicy(value, target) {
  if (
    !isObject(value) || value.full_name !== `${target.owner}/${target.repo}` ||
    value.private !== true || value.visibility !== "private" ||
    value.default_branch !== target.repositoryPolicy.defaultBranch
  ) throw new Error("The recovery outcome repository policy does not match.");
}

function parseReference(value, target) {
  if (
    !isObject(value) || value.ref !== `refs/heads/${target.ref}` ||
    !isObject(value.object) || value.object.type !== "commit" ||
    !isObjectSha(value.object.sha)
  ) throw new Error("The recovery outcome head reference is malformed.");
  return value.object.sha;
}

function parseCommit(value, expectedSha) {
  if (
    !isObject(value) || value.sha !== expectedSha ||
    !isObject(value.tree) || !isObjectSha(value.tree.sha) ||
    !Array.isArray(value.parents) || value.parents.length > 16 ||
    !value.parents.every((parent) => isObject(parent) && isObjectSha(parent.sha))
  ) throw new Error("The recovery outcome head commit is malformed.");
  const parentCommitShas = value.parents.map((parent) => parent.sha);
  if (new Set(parentCommitShas).size !== parentCommitShas.length) {
    throw new Error("The recovery outcome head commit has duplicate parents.");
  }
  return Object.freeze({ treeSha: value.tree.sha, parentCommitShas });
}

function parseBlob(value, expectedSha, expectedBytes) {
  if (
    !isObject(value) || value.sha !== expectedSha || value.encoding !== "base64" ||
    value.size !== expectedBytes || typeof value.content !== "string"
  ) throw new Error("The recovery outcome blob response is malformed.");
  const normalized = value.content.replace(/[\r\n]/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length >
      Math.ceil(ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(normalized)
  ) throw new Error("The recovery outcome blob base64 is invalid.");
  const source = Buffer.from(normalized, "base64");
  if (
    source.length !== expectedBytes || source.toString("base64") !== normalized ||
    gitBlobSha(source) !== expectedSha
  ) throw new Error("The recovery outcome blob identity does not match.");
  return source;
}

async function mapConcurrent(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function assertDependencies(fetchImpl, token) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A recovery outcome discovery fetch implementation is required.");
  }
  if (
    typeof token !== "string" || token.length === 0 || token.length > 4096 ||
    /\s/u.test(token)
  ) throw new Error("A bounded recovery outcome discovery token is required.");
  return Object.freeze({ fetchImpl, token });
}

function assertUniqueTreePaths(entries) {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("The recovery outcome Git tree has duplicate paths.");
  }
}

function repositoryUrl(target) {
  return `${API_ROOT}/repos/${target.owner}/${target.repo}`;
}

function referenceUrl(target) {
  return `${repositoryUrl(target)}/git/ref/heads/${target.ref.split("/")
    .map(encodeURIComponent).join("/")}`;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}
