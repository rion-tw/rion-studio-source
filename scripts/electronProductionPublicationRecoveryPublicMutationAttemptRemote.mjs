import { TextDecoder } from "node:util";

import {
  createElectronProductionPublicationRecoveryPublicMutationAttemptHistory
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  assertElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  assertExactKeys,
  requiredCommitSha,
  requiredRfc3339
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const API_ROOT = "https://api.github.com";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_COMPARE_BYTES = 8 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function proveElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input
) {
  assertExactKeys(input, [
    "attemptBlobSha",
    "currentObservation",
    "fetchImpl",
    "initialHeadCommitSha",
    "observedAt",
    "target",
    "token"
  ], "publication recovery public-mutation history remote input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const target = assertElectronProductionRecoveryStoreRemoteTarget(input.target);
  if (target.ref !== target.repositoryPolicy.defaultBranch) {
    throw new Error("The public-mutation history ref must be the private default branch.");
  }
  const currentObservation = assertExpectedObservation(input.currentObservation);
  const initialHeadCommitSha = requiredCommitSha(
    input.initialHeadCommitSha,
    "publication recovery public-mutation history initial head"
  );
  const attemptBlobSha = requiredCommitSha(
    input.attemptBlobSha,
    "publication recovery public-mutation history blob SHA"
  );
  const observedAt = requiredRfc3339(
    input.observedAt,
    "publication recovery public-mutation history observation time"
  );
  const repository = await readJson(
    dependencies,
    repositoryUrl(target),
    "repository-policy"
  );
  assertRepositoryPolicy(repository, target);
  const openingHead = await readHead(dependencies, target, "opening-head");
  if (openingHead !== currentObservation.headCommitSha) {
    throw new Error("The public-mutation history opening head is not the reader head.");
  }
  const pathCommitPage = await readJsonResponse(
    dependencies,
    `${repositoryUrl(target)}/commits?sha=${openingHead}` +
      `&path=${encodeURIComponent(target.path)}&per_page=2`,
    "path-commit-list",
    MAX_METADATA_BYTES
  );
  const pathCommits = pathCommitPage.value;
  if (!Array.isArray(pathCommits) || pathCommits.length !== 1 ||
      !isObject(pathCommits[0]) || !isObjectSha(pathCommits[0].sha) ||
      hasNextPage(pathCommitPage.link)) {
    throw new Error(
      "The durable public-mutation path must have exactly one creating commit."
    );
  }
  const attemptCommitSha = pathCommits[0].sha;
  const attemptCommit = await readCommit(
    dependencies,
    target,
    attemptCommitSha,
    "attempt-create-commit"
  );
  if (attemptCommit.parentCommitSha !== initialHeadCommitSha) {
    throw new Error("The public-mutation create commit does not directly follow H0.");
  }
  const comparison = await readJson(
    dependencies,
    `${repositoryUrl(target)}/compare/${initialHeadCommitSha}...${attemptCommitSha}`,
    "attempt-create-diff",
    MAX_COMPARE_BYTES
  );
  assertExactAttemptCreateDiff(
    comparison,
    initialHeadCommitSha,
    attemptCommitSha,
    target.path,
    attemptBlobSha
  );
  const closingHead = await readHead(dependencies, target, "closing-head");
  if (closingHead !== openingHead) {
    throw new Error("The public-mutation history head changed during observation.");
  }
  return createElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
    target: {
      repository: `${target.owner}/${target.repo}`,
      ref: target.ref,
      repositoryPolicy: target.repositoryPolicy
    },
    path: target.path,
    initialHeadCommitSha,
    attemptCommitSha,
    attemptTreeSha: attemptCommit.treeSha,
    attemptBlobSha,
    currentObservation,
    pathHistory: {
      reachableFromHeadCommitSha: openingHead,
      commitSha: attemptCommitSha,
      resultCount: 1,
      nextPage: false
    },
    observedAt
  });
}

async function readHead(dependencies, target, stage) {
  const reference = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/ref/heads/${target.ref.split("/")
      .map(encodeURIComponent).join("/")}`,
    stage
  );
  if (!isObject(reference) || reference.ref !== `refs/heads/${target.ref}` ||
      !isObject(reference.object) || reference.object.type !== "commit" ||
      !isObjectSha(reference.object.sha)) {
    throw new Error(`The public-mutation history ${stage} reference is malformed.`);
  }
  return reference.object.sha;
}

async function readCommit(dependencies, target, sha, stage) {
  const value = await readJson(
    dependencies,
    `${repositoryUrl(target)}/git/commits/${sha}`,
    stage
  );
  if (!isObject(value) || value.sha !== sha || !isObject(value.tree) ||
      !isObjectSha(value.tree.sha) || !Array.isArray(value.parents) ||
      value.parents.length !== 1 || !isObject(value.parents[0]) ||
      !isObjectSha(value.parents[0].sha)) {
    throw new Error(`The public-mutation history ${stage} commit is not linear.`);
  }
  return Object.freeze({
    treeSha: value.tree.sha,
    parentCommitSha: value.parents[0].sha
  });
}

function assertExactAttemptCreateDiff(value, initialHead, attemptCommit,
  attemptPath, attemptBlobSha) {
  if (!isObject(value) || value.status !== "ahead" || value.ahead_by !== 1 ||
      value.behind_by !== 0 || value.total_commits !== 1 ||
      !isObject(value.base_commit) || value.base_commit.sha !== initialHead ||
      !isObject(value.merge_base_commit) ||
      value.merge_base_commit.sha !== initialHead ||
      !Array.isArray(value.commits) || value.commits.length !== 1 ||
      !isObject(value.commits[0]) || value.commits[0].sha !== attemptCommit ||
      !Array.isArray(value.files) || value.files.length !== 1) {
    throw new Error("The public-mutation create comparison is not one exact commit.");
  }
  const file = value.files[0];
  if (!isObject(file) || file.filename !== attemptPath ||
      file.status !== "added" || file.sha !== attemptBlobSha) {
    throw new Error(
      "The public-mutation create commit changed a foreign path or blob."
    );
  }
}

function assertExpectedObservation(value) {
  assertExactKeys(value, ["headCommitSha", "parentCommitShas", "treeSha"],
    "publication recovery public-mutation history expected observation");
  if (!Array.isArray(value.parentCommitShas) ||
      value.parentCommitShas.length !== 1) {
    throw new Error("The public-mutation history expected head must be linear.");
  }
  return Object.freeze({
    headCommitSha: requiredCommitSha(value.headCommitSha,
      "public-mutation history expected head SHA"),
    treeSha: requiredCommitSha(value.treeSha,
      "public-mutation history expected tree SHA"),
    parentCommitShas: [requiredCommitSha(value.parentCommitShas[0],
      "public-mutation history expected parent SHA")]
  });
}

async function readJson(
  dependencies,
  url,
  stage,
  maximumBytes = MAX_METADATA_BYTES
) {
  return (await readJsonResponse(
    dependencies,
    url,
    stage,
    maximumBytes
  )).value;
}

async function readJsonResponse(dependencies, url, stage, maximumBytes) {
  let response;
  try {
    response = await dependencies.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${dependencies.token}`,
        "User-Agent": "rion-studio-recovery-public-mutation-history",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      redirect: "error"
    });
  } catch (error) {
    throw new Error(`Recovery public-mutation history ${stage} transport failed.`, {
      cause: error
    });
  }
  if (!response || response.status !== 200) {
    await cancelResponse(response);
    throw new Error(
      `Recovery public-mutation history ${stage} was not acknowledged.`
    );
  }
  const link = response.headers?.get?.("link") ?? null;
  const value = await readBoundedJson(response, stage, maximumBytes);
  return Object.freeze({ value, link });
}

async function readBoundedJson(response, stage, maximumBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined &&
      (!/^\d+$/u.test(declaredLength) ||
       Number(declaredLength) > maximumBytes)) {
    await cancelResponse(response);
    throw new Error(
      `Recovery public-mutation history ${stage} exceeds its byte bound.`
    );
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`Recovery public-mutation history ${stage} body is unavailable.`);
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
    throw new Error(
      `Recovery public-mutation history ${stage} body is malformed.`,
      { cause: error }
    );
  }
}

function hasNextPage(link) {
  if (link === null) return false;
  if (typeof link !== "string" || link.length > 8192) {
    throw new Error("The public-mutation history pagination header is invalid.");
  }
  return /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*(?:,|$))/u.test(link);
}

async function cancelResponse(response) {
  try {
    await response?.body?.getReader?.().cancel();
  } catch {
    // A rejected response body is intentionally discarded.
  }
}

function assertRepositoryPolicy(value, target) {
  if (!isObject(value) || value.full_name !== `${target.owner}/${target.repo}` ||
      value.private !== true || value.visibility !== "private" ||
      value.default_branch !== target.repositoryPolicy.defaultBranch) {
    throw new Error("The public-mutation history repository policy does not match.");
  }
}

function assertDependencies(fetchImpl, token) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A public-mutation history fetch implementation is required.");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 ||
      /\s/u.test(token)) {
    throw new Error("A bounded public-mutation history token is required.");
  }
  return Object.freeze({ fetchImpl, token });
}

function repositoryUrl(target) {
  return `${API_ROOT}/repos/${target.owner}/${target.repo}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}
