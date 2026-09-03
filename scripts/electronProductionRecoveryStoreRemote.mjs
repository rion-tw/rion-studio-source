import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";

const API_ROOT = "https://api.github.com";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES =
  8 * 1024 * 1024;

const MAX_METADATA_RESPONSE_BYTES = 256 * 1024;
const MAX_TREE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_RESPONSE_BYTES =
  (2 * ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES) +
  MAX_METADATA_RESPONSE_BYTES;
const MAX_BASE64_SOURCE_LENGTH =
  (2 * ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES) + 16;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_REF_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export async function readElectronProductionRecoveryStoreRemote(input) {
  assertExactKeys(
    input,
    ["fetchImpl", "target", "token"],
    "recovery-store remote read input"
  );
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const target = assertElectronProductionRecoveryStoreRemoteTarget(input.target);
  const observed = await readCurrentState(dependencies, target);
  if (isFailure(observed)) return observed;
  const finalReference = await readJson(
    dependencies,
    readRefUrl(target),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(finalReference)) {
    return indeterminate("verification-failed", finalReference.status);
  }
  const finalHeadSha = referenceSha(finalReference.value, target);
  if (finalHeadSha === null || finalHeadSha !== observed.headSha) {
    return indeterminate("verification-failed", 200);
  }
  return observed;
}

export async function createElectronProductionRecoveryStoreRemote(input) {
  assertExactKeys(
    input,
    [
      "commitMessage",
      "content",
      "expectedHeadSha",
      "fetchImpl",
      "target",
      "token"
    ],
    "recovery-store remote creation input"
  );
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const target = assertElectronProductionRecoveryStoreRemoteTarget(input.target);
  const expectedHeadSha = assertHeadSha(input.expectedHeadSha);
  const commitMessage = assertCommitMessage(input.commitMessage);
  const source = assertContent(input.content);

  const current = await readCurrentState(dependencies, target);
  if (isFailure(current)) return current;
  if (current.headSha !== expectedHeadSha) {
    return rejected("conflict", 200);
  }
  if (current.outcome === "present") {
    return rejected("path-exists", 200);
  }

  const expectedBlobSha = gitBlobSha(source);
  const blobRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(target)}/git/blobs`,
    {
      method: "POST",
      body: JSON.stringify({
        content: source.toString("base64"),
        encoding: "base64"
      })
    },
    201
  );
  if (isFailure(blobRequest)) return blobRequest;
  if (!isObject(blobRequest.value) || blobRequest.value.sha !== expectedBlobSha) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const treeRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(target)}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: current.treeSha,
        tree: [{
          mode: "100644",
          path: target.path,
          sha: expectedBlobSha,
          type: "blob"
        }]
      })
    },
    201
  );
  if (isFailure(treeRequest)) return treeRequest;
  const createdTreeSha = objectSha(treeRequest.value);
  if (createdTreeSha === null || createdTreeSha === current.treeSha) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const commitRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(target)}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        parents: [current.headSha],
        tree: createdTreeSha
      })
    },
    201
  );
  if (isFailure(commitRequest)) return commitRequest;
  const createdCommit = parseCommit(commitRequest.value, null);
  if (
    createdCommit === null ||
    createdCommit.message !== commitMessage ||
    createdCommit.treeSha !== createdTreeSha ||
    !isDeepStrictEqual(createdCommit.parentShas, [current.headSha])
  ) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const refRequest = await mutateJson(
    dependencies,
    updateRefUrl(target),
    {
      method: "PATCH",
      body: JSON.stringify({ sha: createdCommit.sha, force: false })
    },
    200
  );
  if (isFailure(refRequest)) return refRequest;
  if (!isExactReference(refRequest.value, target, createdCommit.sha)) {
    return indeterminate("unknown-acknowledgement", 200);
  }

  const fresh = await readCurrentState(dependencies, target);
  if (isFailure(fresh)) {
    return indeterminate("verification-failed", fresh.status);
  }
  if (
    fresh.outcome !== "present" ||
    fresh.headSha !== createdCommit.sha ||
    fresh.treeSha !== createdTreeSha ||
    fresh.blobSha !== expectedBlobSha ||
    fresh.byteLength !== source.length ||
    fresh.contentBase64 !== source.toString("base64") ||
    fresh.commitMessage !== commitMessage ||
    !isDeepStrictEqual(fresh.parentShas, [current.headSha])
  ) {
    return indeterminate("verification-failed", 200);
  }
  return Object.freeze({
    outcome: "applied",
    blobSha: expectedBlobSha,
    byteLength: source.length,
    commitSha: createdCommit.sha,
    parentSha: current.headSha,
    treeSha: createdTreeSha
  });
}

export async function createElectronProductionRecoveryStoreRemoteAtomicPair(
  input
) {
  assertExactKeys(
    input,
    [
      "commitMessage",
      "content",
      "expectedHeadSha",
      "fetchImpl",
      "targets",
      "token"
    ],
    "recovery-store remote atomic-pair creation input"
  );
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const targets = assertAtomicPairTargets(input.targets);
  const expectedHeadSha = assertHeadSha(input.expectedHeadSha);
  const commitMessage = assertCommitMessage(input.commitMessage);
  const source = assertContent(input.content);
  const current = await readCurrentPairState(dependencies, targets);
  if (isFailure(current)) return current;
  if (current.headSha !== expectedHeadSha) {
    return rejected("conflict", 200);
  }
  if (current.outcome !== "absent") {
    return rejected(
      current.outcome === "partial" ? "path-conflict" : "path-exists",
      200
    );
  }

  const expectedBlobSha = gitBlobSha(source);
  const blobRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(targets[0])}/git/blobs`,
    {
      method: "POST",
      body: JSON.stringify({
        content: source.toString("base64"),
        encoding: "base64"
      })
    },
    201
  );
  if (isFailure(blobRequest)) return blobRequest;
  if (!isObject(blobRequest.value) || blobRequest.value.sha !== expectedBlobSha) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const treeRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(targets[0])}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: current.treeSha,
        tree: targets.map((target) => ({
          mode: "100644",
          path: target.path,
          sha: expectedBlobSha,
          type: "blob"
        }))
      })
    },
    201
  );
  if (isFailure(treeRequest)) return treeRequest;
  const createdTreeSha = objectSha(treeRequest.value);
  if (createdTreeSha === null || createdTreeSha === current.treeSha) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const commitRequest = await mutateJson(
    dependencies,
    `${repositoryUrl(targets[0])}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        parents: [current.headSha],
        tree: createdTreeSha
      })
    },
    201
  );
  if (isFailure(commitRequest)) return commitRequest;
  const createdCommit = parseCommit(commitRequest.value, null);
  if (
    createdCommit === null ||
    createdCommit.message !== commitMessage ||
    createdCommit.treeSha !== createdTreeSha ||
    !isDeepStrictEqual(createdCommit.parentShas, [current.headSha])
  ) {
    return indeterminate("unknown-acknowledgement", 201);
  }

  const refRequest = await mutateJson(
    dependencies,
    updateRefUrl(targets[0]),
    {
      method: "PATCH",
      body: JSON.stringify({ sha: createdCommit.sha, force: false })
    },
    200
  );
  if (isFailure(refRequest)) return refRequest;
  if (!isExactReference(refRequest.value, targets[0], createdCommit.sha)) {
    return indeterminate("unknown-acknowledgement", 200);
  }

  const fresh = await readCurrentPairState(dependencies, targets);
  if (isFailure(fresh)) {
    return indeterminate("verification-failed", fresh.status);
  }
  if (
    fresh.outcome !== "present" ||
    fresh.headSha !== createdCommit.sha ||
    fresh.treeSha !== createdTreeSha ||
    fresh.blobSha !== expectedBlobSha ||
    fresh.byteLength !== source.length ||
    fresh.contentBase64 !== source.toString("base64") ||
    fresh.commitMessage !== commitMessage ||
    !isDeepStrictEqual(fresh.parentShas, [current.headSha])
  ) {
    return indeterminate("verification-failed", 200);
  }
  const closingReference = await readJson(
    dependencies,
    readRefUrl(targets[0]),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(closingReference)) {
    return indeterminate("verification-failed", closingReference.status);
  }
  if (
    referenceSha(closingReference.value, targets[0]) !== createdCommit.sha
  ) {
    return indeterminate("verification-failed", 200);
  }

  return Object.freeze({
    outcome: "applied",
    blobSha: expectedBlobSha,
    byteLength: source.length,
    commitSha: createdCommit.sha,
    parentSha: current.headSha,
    paths: Object.freeze(targets.map((target) => target.path)),
    treeSha: createdTreeSha
  });
}

async function readCurrentPairState(dependencies, targets) {
  const target = targets[0];
  const repositoryRequest = await readJson(
    dependencies,
    repositoryUrl(target),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(repositoryRequest)) return repositoryRequest;
  if (!repositoryMatchesPolicy(repositoryRequest.value, target)) {
    return rejected("repository-policy-mismatch", 200);
  }
  const referenceRequest = await readJson(
    dependencies,
    readRefUrl(target),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(referenceRequest)) return referenceRequest;
  const headSha = referenceSha(referenceRequest.value, target);
  if (headSha === null) return rejected("malformed-record", 200);
  const commitRequest = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/commits/${headSha}`,
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(commitRequest)) return commitRequest;
  const commit = parseCommit(commitRequest.value, headSha);
  if (commit === null) return rejected("malformed-record", 200);
  const pathStates = [];
  for (const pairTarget of targets) {
    const state = await readPathAtTree(
      dependencies,
      pairTarget,
      commit.treeSha
    );
    if (isFailure(state)) return state;
    pathStates.push(state);
  }
  const present = pathStates.filter((state) => state.outcome === "present");
  const commitState = {
    commitMessage: commit.message,
    headSha,
    parentShas: Object.freeze(commit.parentShas),
    treeSha: commit.treeSha
  };
  if (present.length === 0) {
    return Object.freeze({ outcome: "absent", ...commitState });
  }
  if (
    present.length !== targets.length ||
    new Set(present.map((state) => state.blobSha)).size !== 1
  ) {
    return Object.freeze({ outcome: "partial", ...commitState });
  }
  const blobSha = present[0].blobSha;
  const blobRequest = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/blobs/${blobSha}`,
    MAX_BLOB_RESPONSE_BYTES
  );
  if (isFailure(blobRequest)) return blobRequest;
  const blob = parseBlob(blobRequest.value, blobSha);
  if (blob === null) return rejected("malformed-record", 200);
  return Object.freeze({
    outcome: "present",
    ...commitState,
    blobSha,
    byteLength: blob.length,
    contentBase64: blob.toString("base64")
  });
}

function assertAtomicPairTargets(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("The recovery-store atomic pair must contain two targets.");
  }
  const targets = value.map(assertElectronProductionRecoveryStoreRemoteTarget);
  const [first, second] = targets;
  if (
    first.path >= second.path ||
    first.owner !== second.owner ||
    first.repo !== second.repo ||
    first.ref !== second.ref ||
    !isDeepStrictEqual(first.repositoryPolicy, second.repositoryPolicy)
  ) {
    throw new Error(
      "The recovery-store atomic-pair targets must be distinct, sorted, and co-located."
    );
  }
  return Object.freeze(targets);
}

async function readCurrentState(dependencies, target) {
  const repositoryRequest = await readJson(
    dependencies,
    repositoryUrl(target),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(repositoryRequest)) return repositoryRequest;
  if (!repositoryMatchesPolicy(repositoryRequest.value, target)) {
    return rejected("repository-policy-mismatch", 200);
  }

  const referenceRequest = await readJson(
    dependencies,
    readRefUrl(target),
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(referenceRequest)) return referenceRequest;
  const headSha = referenceSha(referenceRequest.value, target);
  if (headSha === null) return rejected("malformed-record", 200);

  const commitRequest = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/commits/${headSha}`,
    MAX_METADATA_RESPONSE_BYTES
  );
  if (isFailure(commitRequest)) return commitRequest;
  const commit = parseCommit(commitRequest.value, headSha);
  if (commit === null) return rejected("malformed-record", 200);

  const pathState = await readPathAtTree(
    dependencies,
    target,
    commit.treeSha
  );
  if (isFailure(pathState)) return pathState;
  if (pathState.outcome === "absent") {
    return Object.freeze({
      outcome: "absent",
      commitMessage: commit.message,
      headSha,
      parentShas: Object.freeze(commit.parentShas),
      treeSha: commit.treeSha
    });
  }

  const blobRequest = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/blobs/${pathState.blobSha}`,
    MAX_BLOB_RESPONSE_BYTES
  );
  if (isFailure(blobRequest)) return blobRequest;
  const blob = parseBlob(blobRequest.value, pathState.blobSha);
  if (blob === null) return rejected("malformed-record", 200);
  return Object.freeze({
    outcome: "present",
    blobSha: pathState.blobSha,
    byteLength: blob.length,
    commitMessage: commit.message,
    contentBase64: blob.toString("base64"),
    headSha,
    parentShas: Object.freeze(commit.parentShas),
    treeSha: commit.treeSha
  });
}

async function readPathAtTree(dependencies, target, rootTreeSha) {
  const components = target.path.split("/");
  let treeSha = rootTreeSha;
  for (let index = 0; index < components.length; index += 1) {
    const treeRequest = await readJson(
      dependencies,
      `${repositoryUrl(target)}/git/trees/${treeSha}`,
      MAX_TREE_RESPONSE_BYTES
    );
    if (isFailure(treeRequest)) return treeRequest;
    const entries = parseTree(treeRequest.value, treeSha);
    if (entries === null) return rejected("malformed-record", 200);
    const matches = entries.filter((entry) =>
      isObject(entry) && entry.path === components[index]
    );
    if (matches.length === 0) return Object.freeze({ outcome: "absent" });
    if (matches.length !== 1) return rejected("malformed-record", 200);
    const entry = matches[0];
    const final = index === components.length - 1;
    if (final) {
      if (
        entry.mode !== "100644" ||
        entry.type !== "blob" ||
        !isObjectSha(entry.sha)
      ) {
        return rejected("path-conflict", 200);
      }
      return Object.freeze({ outcome: "present", blobSha: entry.sha });
    }
    if (
      entry.mode !== "040000" ||
      entry.type !== "tree" ||
      !isObjectSha(entry.sha)
    ) {
      return rejected("path-conflict", 200);
    }
    treeSha = entry.sha;
  }
  return rejected("malformed-record", 200);
}

async function readJson(dependencies, url, maximumBytes) {
  const request = await fetchOnce(dependencies, url, { method: "GET" });
  if (request.outcome === "transport-error") {
    return indeterminate("transport", null);
  }
  const { response } = request;
  if (response.status === 409 || response.status === 422) {
    await cancelResponseBody(response);
    return rejected("conflict", response.status);
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    return indeterminate("server-error", response.status);
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return response.status >= 400 && response.status < 500
      ? rejected(response.status === 404 ? "not-found" : "github-rejected", response.status)
      : indeterminate("unexpected-response", response.status);
  }
  try {
    return Object.freeze({
      outcome: "value",
      value: await readBoundedJson(response, maximumBytes)
    });
  } catch {
    return rejected("malformed-record", 200);
  }
}

async function mutateJson(dependencies, url, init, expectedStatus) {
  const request = await fetchOnce(dependencies, url, init);
  if (request.outcome === "transport-error") {
    return indeterminate("unknown-acknowledgement", null);
  }
  const { response } = request;
  if (response.status === 409 || response.status === 422) {
    await cancelResponseBody(response);
    return rejected("conflict", response.status);
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    return indeterminate("unknown-acknowledgement", response.status);
  }
  if (response.status !== expectedStatus) {
    await cancelResponseBody(response);
    return response.status >= 400 && response.status < 500
      ? rejected("github-rejected", response.status)
      : indeterminate("unknown-acknowledgement", response.status);
  }
  try {
    return Object.freeze({
      outcome: "value",
      value: await readBoundedJson(response, MAX_METADATA_RESPONSE_BYTES)
    });
  } catch {
    return indeterminate("unknown-acknowledgement", response.status);
  }
}

async function fetchOnce(dependencies, url, init) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${dependencies.token}`,
    "User-Agent": "rion-studio-recovery-store",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
  };
  try {
    const response = await dependencies.fetchImpl(url, {
      ...init,
      headers,
      redirect: "error"
    });
    if (!response || !Number.isInteger(response.status)) {
      return Object.freeze({ outcome: "transport-error" });
    }
    return Object.freeze({ outcome: "response", response });
  } catch {
    return Object.freeze({ outcome: "transport-error" });
  }
}

async function readBoundedJson(response, maximumBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      await cancelResponseBody(response);
      throw new Error("The GitHub API response exceeds its size limit.");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("The GitHub API response body is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const event = await reader.read();
    if (event.done) break;
    if (!(event.value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The GitHub API response body is invalid.");
    }
    bytes += event.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The GitHub API response exceeds its size limit.");
    }
    chunks.push(event.value);
  }
  return JSON.parse(UTF8_DECODER.decode(Buffer.concat(chunks, bytes)));
}

async function cancelResponseBody(response) {
  try {
    await response.body?.getReader?.().cancel();
  } catch {
    // The response is already terminal and its body is intentionally discarded.
  }
}

function parseCommit(value, expectedSha) {
  if (
    !isObject(value) ||
    !isObjectSha(value.sha) ||
    (expectedSha !== null && value.sha !== expectedSha) ||
    typeof value.message !== "string" ||
    !isObject(value.tree) ||
    !isObjectSha(value.tree.sha) ||
    !Array.isArray(value.parents) ||
    !value.parents.every((parent) => isObject(parent) && isObjectSha(parent.sha))
  ) {
    return null;
  }
  return Object.freeze({
    message: value.message,
    parentShas: value.parents.map((parent) => parent.sha),
    sha: value.sha,
    treeSha: value.tree.sha
  });
}

function parseTree(value, expectedSha) {
  if (
    !isObject(value) ||
    value.sha !== expectedSha ||
    value.truncated !== false ||
    !Array.isArray(value.tree)
  ) {
    return null;
  }
  return value.tree;
}

function parseBlob(value, expectedSha) {
  if (
    !isObject(value) ||
    value.sha !== expectedSha ||
    value.encoding !== "base64" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES ||
    typeof value.content !== "string"
  ) {
    return null;
  }
  let source;
  try {
    source = decodeStrictBase64(value.content);
  } catch {
    return null;
  }
  if (source.length !== value.size || gitBlobSha(source) !== expectedSha) {
    return null;
  }
  return source;
}

function decodeStrictBase64(value) {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_SOURCE_LENGTH ||
    /[^A-Za-z0-9+/=\r\n]/u.test(value)
  ) {
    throw new Error("The recovery-store blob base64 is invalid.");
  }
  const normalized = value.replace(/[\r\n]/gu, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(normalized)
  ) {
    throw new Error("The recovery-store blob base64 is invalid.");
  }
  const source = Buffer.from(normalized, "base64");
  if (
    source.toString("base64") !== normalized ||
    source.length > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
  ) {
    throw new Error("The recovery-store blob base64 is not canonical.");
  }
  return source;
}

export function assertElectronProductionRecoveryStoreRemoteTarget(value) {
  assertExactKeys(
    value,
    ["owner", "path", "ref", "repo", "repositoryPolicy"],
    "recovery-store target"
  );
  if (
    typeof value.owner !== "string" ||
    value.owner.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value.owner)
  ) {
    throw new Error("The recovery-store owner is invalid.");
  }
  if (
    typeof value.repo !== "string" ||
    value.repo.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/u.test(value.repo) ||
    value.repo === "." ||
    value.repo === ".."
  ) {
    throw new Error("The recovery-store repository is invalid.");
  }
  assertRef(value.ref);
  assertPath(value.path);
  assertRepositoryPolicy(value.repositoryPolicy);
  if (value.ref !== value.repositoryPolicy.defaultBranch) {
    throw new Error("The recovery-store ref must be the expected default branch.");
  }
  return Object.freeze({
    owner: value.owner,
    path: value.path,
    ref: value.ref,
    repo: value.repo,
    repositoryPolicy: Object.freeze({
      defaultBranch: value.repositoryPolicy.defaultBranch,
      visibility: value.repositoryPolicy.visibility
    })
  });
}

function assertRepositoryPolicy(value) {
  assertExactKeys(
    value,
    ["defaultBranch", "visibility"],
    "recovery-store repository policy"
  );
  assertRef(value.defaultBranch);
  if (value.visibility !== "private") {
    throw new Error("The recovery-store repository must be private.");
  }
}

function assertRef(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined ||
        code <= 32 ||
        code === 127 ||
        FORBIDDEN_REF_CHARACTERS.has(character);
    }) ||
    value.split("/").some((part) =>
      part === "." || part === ".." || part.endsWith(".lock")
    )
  ) {
    throw new Error("The recovery-store ref is invalid.");
  }
}

function assertPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    !value.split("/").every((part) =>
      part.length > 0 &&
      part.length <= 255 &&
      /^[A-Za-z0-9._-]+$/u.test(part) &&
      part !== "." &&
      part !== ".." &&
      part.toLowerCase() !== ".git"
    )
  ) {
    throw new Error("The recovery-store path is invalid.");
  }
}

function assertDependencies(fetchImpl, token) {
  if (typeof fetchImpl !== "function") {
    throw new Error("The recovery-store fetch implementation is required.");
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    /\s/u.test(token)
  ) {
    throw new Error("The recovery-store token is invalid.");
  }
  return Object.freeze({ fetchImpl, token });
}

function assertHeadSha(value) {
  if (!isObjectSha(value)) {
    throw new Error("The recovery-store expected head SHA is invalid.");
  }
  return value;
}

function assertCommitMessage(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code <= 31 || code === 127;
    })
  ) {
    throw new Error("The recovery-store commit message is invalid.");
  }
  return value;
}

function assertContent(value) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
  ) {
    throw new Error("The recovery-store content size is invalid.");
  }
  return Buffer.from(value);
}

function repositoryUrl(target) {
  return `${API_ROOT}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

function encodedRef(target) {
  return target.ref.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function readRefUrl(target) {
  return `${repositoryUrl(target)}/git/ref/heads/${encodedRef(target)}`;
}

function updateRefUrl(target) {
  return `${repositoryUrl(target)}/git/refs/heads/${encodedRef(target)}`;
}

function referenceSha(value, target) {
  if (
    !isObject(value) ||
    value.ref !== `refs/heads/${target.ref}` ||
    !isObject(value.object) ||
    value.object.type !== "commit" ||
    !isObjectSha(value.object.sha)
  ) {
    return null;
  }
  return value.object.sha;
}

function repositoryMatchesPolicy(value, target) {
  return isObject(value) &&
    value.full_name === `${target.owner}/${target.repo}` &&
    value.private === true &&
    value.visibility === target.repositoryPolicy.visibility &&
    value.default_branch === target.repositoryPolicy.defaultBranch;
}

function isExactReference(value, target, expectedSha) {
  return referenceSha(value, target) === expectedSha;
}

function objectSha(value) {
  return isObject(value) && isObjectSha(value.sha) ? value.sha : null;
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (
    !isObject(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  ) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isFailure(value) {
  return value.outcome === "rejected" || value.outcome === "indeterminate";
}

function rejected(reason, status) {
  return Object.freeze({ outcome: "rejected", reason, status });
}

function indeterminate(reason, status) {
  return Object.freeze({ outcome: "indeterminate", reason, status });
}
