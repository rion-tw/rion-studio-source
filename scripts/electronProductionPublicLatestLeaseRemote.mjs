import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import {
  acquireElectronProductionPublicLatestLease,
  assertElectronProductionPublicLatestLease,
  assertElectronProductionPublicLatestLeaseHeldObservation,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY =
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF = "main";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH =
  "releases/electron-production-public-latest-lease.json";

const API_ROOT = "https://api.github.com";
const CONTENT_URL = `${API_ROOT}/repos/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY}/contents/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH}`;
const REPOSITORY_URL =
  `${API_ROOT}/repos/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY}`;
const REF_URL = `${REPOSITORY_URL}/git/ref/heads/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF}`;
const MAX_LEASE_BYTES = 1024 * 1024;
const MAX_BASE64_SOURCE_LENGTH = (2 * MAX_LEASE_BYTES) + 16;
const MAX_CONTENT_RESPONSE_BYTES = (2 * MAX_LEASE_BYTES) + (128 * 1024);
const MAX_METADATA_RESPONSE_BYTES = 256 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function readElectronProductionPublicLatestLeaseRemote(input) {
  assertExactKeys(input, ["fetchImpl", "token"], "remote lease read input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  return readRemoteLease(dependencies);
}

export async function acquireElectronProductionPublicLatestLeaseRemote(input) {
  assertExactKeys(input, ["acquisition", "fetchImpl", "token"],
    "remote lease acquisition input");
  assertExactKeys(input.acquisition, [
    "holder",
    "leaseId",
    "purpose",
    "recordedAt",
    "source",
    "target",
    "transactionId"
  ], "remote lease acquisition request");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const genesis = acquireElectronProductionPublicLatestLease({
    ...input.acquisition,
    previous: null,
    vacantGeneration: 0
  });
  const current = await readRemoteLease(dependencies);
  if (current.outcome === "indeterminate" || current.outcome === "rejected") {
    return current;
  }
  if (current.outcome === "present" && current.lease.status === "held") {
    return rejected("held", 200);
  }
  const next = current.outcome === "vacant"
    ? genesis
    : acquireElectronProductionPublicLatestLease({
      ...input.acquisition,
      previous: current.lease,
      vacantGeneration: current.lease.generation
    });
  return putAndVerifyRemoteLease({
    ...dependencies,
    currentBlobSha: current.outcome === "present" ? current.blobSha : null,
    expected: next
  });
}

export async function observeElectronProductionPublicLatestLeaseRemote(input) {
  assertExactKeys(input, ["expected", "fetchImpl", "token"],
    "remote held lease observation input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const expected = assertElectronProductionPublicLatestLease(input.expected);
  assertElectronProductionPublicLatestLeaseHeldObservation({
    expected,
    observed: expected
  });
  const current = await readRemoteLease(dependencies);
  if (current.outcome === "indeterminate" || current.outcome === "rejected") {
    return current;
  }
  if (current.outcome === "vacant") return rejected("conflict", 404);
  try {
    assertElectronProductionPublicLatestLeaseHeldObservation({
      expected,
      observed: current.lease
    });
  } catch {
    return rejected("conflict", 200);
  }
  return Object.freeze({
    outcome: "observed",
    blobSha: current.blobSha,
    bytes: current.bytes,
    lease: current.lease
  });
}

export async function releaseElectronProductionPublicLatestLeaseRemote(input) {
  assertExactKeys(input, ["expected", "fetchImpl", "release", "token"],
    "remote lease release input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const expected = assertElectronProductionPublicLatestLease(input.expected);
  const next = releaseElectronProductionPublicLatestLease(expected, input.release);
  const current = await readRemoteLease(dependencies);
  if (current.outcome === "indeterminate" || current.outcome === "rejected") {
    return current;
  }
  if (current.outcome === "vacant") return rejected("conflict", 404);
  try {
    assertElectronProductionPublicLatestLeaseHeldObservation({
      expected,
      observed: current.lease
    });
  } catch {
    return rejected("conflict", 200);
  }
  return putAndVerifyRemoteLease({
    ...dependencies,
    currentBlobSha: current.blobSha,
    expected: next
  });
}

export async function observeElectronProductionPublicLatestLeaseReleasedRemote(
  input
) {
  assertExactKeys(input, ["expected", "fetchImpl", "release", "token"],
    "remote released lease observation input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const expected = assertElectronProductionPublicLatestLease(input.expected);
  assertElectronProductionPublicLatestLeaseHeldObservation({
    expected,
    observed: expected
  });
  const released = releaseElectronProductionPublicLatestLease(
    expected,
    input.release
  );
  const current = await readRemoteLease(dependencies);
  if (current.outcome === "indeterminate" || current.outcome === "rejected") {
    return current;
  }
  if (current.outcome === "vacant") return rejected("conflict", 404);
  if (!isDeepStrictEqual(current.lease, released)) {
    return rejected("conflict", 200);
  }
  return Object.freeze({
    outcome: "observed",
    blobSha: current.blobSha,
    bytes: current.bytes,
    lease: current.lease
  });
}

export async function observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote(
  input
) {
  assertExactKeys(input, ["expected", "fetchImpl", "token"],
    "remote released lease successor observation input");
  const dependencies = assertDependencies(input.fetchImpl, input.token);
  const expected = assertElectronProductionPublicLatestLease(input.expected);
  assertElectronProductionPublicLatestLeaseHeldObservation({
    expected,
    observed: expected
  });
  const current = await readRemoteLease(dependencies);
  if (current.outcome === "indeterminate" || current.outcome === "rejected") {
    return current;
  }
  if (current.outcome === "vacant") return rejected("conflict", 404);
  if (isDeepStrictEqual(current.lease, expected)) return rejected("held", 200);
  if (current.lease.status !== "released") return rejected("conflict", 200);
  let released;
  try {
    released = releaseElectronProductionPublicLatestLease(expected, {
      transactionId: expected.transactionId,
      leaseId: expected.leaseId,
      generation: expected.generation,
      sourceStateSha256: expected.source.stateSha256,
      targetStateSha256: expected.target.stateSha256,
      recordedAt: current.lease.recordedAt
    });
  } catch {
    return rejected("conflict", 200);
  }
  if (!isDeepStrictEqual(current.lease, released)) {
    return rejected("conflict", 200);
  }
  return Object.freeze({
    outcome: "observed",
    blobSha: current.blobSha,
    bytes: current.bytes,
    lease: current.lease
  });
}

async function readRemoteLease(dependencies) {
  const request = await fetchOnce(
    dependencies,
    `${CONTENT_URL}?ref=${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF}`,
    { method: "GET" }
  );
  if (request.outcome === "transport-error") {
    return indeterminate("transport", null);
  }
  const { response } = request;
  if (response.status === 404) {
    return verifyAuthoritativeAbsence(dependencies);
  }
  if (response.status === 409 || response.status === 422) {
    return rejected("conflict", response.status);
  }
  if (response.status >= 500) {
    return indeterminate("server-error", response.status);
  }
  if (response.status !== 200) {
    return response.status >= 400 && response.status < 500
      ? rejected("github-rejected", response.status)
      : indeterminate("unexpected-response", response.status);
  }
  try {
    return await presentLeaseFromResponse(response);
  } catch {
    return rejected("malformed-record", 200);
  }
}

async function verifyAuthoritativeAbsence(dependencies) {
  const repositoryRequest = await fetchOnce(dependencies, REPOSITORY_URL, {
    method: "GET"
  });
  if (repositoryRequest.outcome === "transport-error") {
    return indeterminate("unauthoritative-absence", null);
  }
  if (repositoryRequest.response.status !== 200) {
    return indeterminate(
      "unauthoritative-absence",
      repositoryRequest.response.status
    );
  }
  let repository;
  try {
    repository = await readBoundedJson(
      repositoryRequest.response,
      MAX_METADATA_RESPONSE_BYTES
    );
  } catch {
    return indeterminate("unauthoritative-absence", 200);
  }
  if (
    !isObject(repository) ||
    repository.full_name !== ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY ||
    repository.visibility !== "public" ||
    repository.private !== false ||
    repository.default_branch !== ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF
  ) {
    return indeterminate("unauthoritative-absence", 200);
  }
  const refRequest = await fetchOnce(dependencies, REF_URL, { method: "GET" });
  if (refRequest.outcome === "transport-error") {
    return indeterminate("unauthoritative-absence", null);
  }
  if (refRequest.response.status !== 200) {
    return indeterminate("unauthoritative-absence", refRequest.response.status);
  }
  let reference;
  try {
    reference = await readBoundedJson(
      refRequest.response,
      MAX_METADATA_RESPONSE_BYTES
    );
  } catch {
    return indeterminate("unauthoritative-absence", 200);
  }
  if (
    !isObject(reference) ||
    reference.ref !== `refs/heads/${ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF}` ||
    !isObject(reference.object) ||
    reference.object.type !== "commit" ||
    !isCommitSha(reference.object.sha)
  ) {
    return indeterminate("unauthoritative-absence", 200);
  }
  return Object.freeze({
    outcome: "vacant",
    headSha: reference.object.sha
  });
}

async function presentLeaseFromResponse(response) {
  const body = await readBoundedJson(response, MAX_CONTENT_RESPONSE_BYTES);
  if (
    !isObject(body) ||
    body.type !== "file" ||
    body.name !== "electron-production-public-latest-lease.json" ||
    body.path !== ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH ||
    body.encoding !== "base64" ||
    !Number.isSafeInteger(body.size) ||
    body.size <= 0 ||
    body.size > MAX_LEASE_BYTES ||
    !isCommitSha(body.sha) ||
    typeof body.content !== "string"
  ) {
    throw new Error("The remote public-latest lease blob metadata is invalid.");
  }
  const source = decodeStrictBase64(body.content);
  if (source.length !== body.size) {
    throw new Error("The remote public-latest lease blob size does not match.");
  }
  if (gitBlobSha(source) !== body.sha) {
    throw new Error("The remote public-latest lease Git blob SHA does not match.");
  }
  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(source));
  } catch (error) {
    throw new Error("The remote public-latest lease is invalid JSON.", {
      cause: error
    });
  }
  const lease = assertElectronProductionPublicLatestLease(value);
  if (!source.equals(serializeElectronProductionPublicLatestLease(lease))) {
    throw new Error("The remote public-latest lease is not canonical JSON.");
  }
  return Object.freeze({
    outcome: "present",
    blobSha: body.sha,
    bytes: source.length,
    lease
  });
}

async function putAndVerifyRemoteLease(input) {
  const source = serializeElectronProductionPublicLatestLease(input.expected);
  const body = {
    message: `ci: ${input.expected.status} public-latest lease generation ${input.expected.generation}`,
    content: source.toString("base64"),
    branch: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
    ...(input.currentBlobSha === null ? {} : { sha: input.currentBlobSha })
  };
  const request = await fetchOnce(input, CONTENT_URL, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (request.outcome === "transport-error") {
    return reconcileAmbiguousPut(input, null);
  }
  const { response } = request;
  if (response.status === 409 || response.status === 422) {
    return rejected("conflict", response.status);
  }
  if (response.status >= 500) {
    return reconcileAmbiguousPut(input, response.status);
  }
  const expectedStatus = input.currentBlobSha === null ? 201 : 200;
  if (response.status !== expectedStatus) {
    return response.status >= 400 && response.status < 500
      ? rejected("github-rejected", response.status)
      : reconcileAmbiguousPut(input, response.status);
  }
  try {
    await readBoundedJson(response, MAX_METADATA_RESPONSE_BYTES);
  } catch {
    return reconcileAmbiguousPut(input, response.status);
  }
  const reread = await readRemoteLease(input);
  if (reread.outcome === "indeterminate" || reread.outcome === "rejected") {
    return indeterminate("verification-failed", reread.status);
  }
  if (reread.outcome !== "present" ||
      !isDeepStrictEqual(reread.lease, input.expected)) {
    return indeterminate("unknown-acknowledgement", response.status);
  }
  return Object.freeze({
    outcome: "applied",
    blobSha: reread.blobSha,
    bytes: reread.bytes,
    lease: reread.lease
  });
}

async function reconcileAmbiguousPut(input, acknowledgementStatus) {
  const reread = await readRemoteLease(input);
  if (
    reread.outcome === "present" &&
    isDeepStrictEqual(reread.lease, input.expected)
  ) {
    return Object.freeze({
      outcome: "applied",
      blobSha: reread.blobSha,
      bytes: reread.bytes,
      lease: reread.lease
    });
  }
  if (reread.outcome === "indeterminate" || reread.outcome === "rejected") {
    return indeterminate("verification-failed", reread.status);
  }
  return indeterminate("unknown-acknowledgement", acknowledgementStatus);
}

async function fetchOnce(dependencies, url, init) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${dependencies.token}`,
    "User-Agent": "rion-studio-public-latest-lease",
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

function decodeStrictBase64(value) {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_SOURCE_LENGTH ||
    /[^A-Za-z0-9+/=\r\n]/u.test(value)
  ) {
    throw new Error("The remote public-latest lease base64 is invalid.");
  }
  const normalized = value.replace(/[\r\n]/gu, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(normalized)
  ) {
    throw new Error("The remote public-latest lease base64 is invalid.");
  }
  const source = Buffer.from(normalized, "base64");
  if (source.toString("base64") !== normalized || source.length > MAX_LEASE_BYTES) {
    throw new Error("The remote public-latest lease base64 is not canonical.");
  }
  return source;
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function assertDependencies(fetchImpl, token) {
  if (typeof fetchImpl !== "function") {
    throw new Error("The remote public-latest lease fetch implementation is required.");
  }
  if (typeof token !== "string" || token.length === 0 || /\s/u.test(token)) {
    throw new Error("The remote public-latest lease token is invalid.");
  }
  return Object.freeze({ fetchImpl, token });
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCommitSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function rejected(reason, status) {
  return Object.freeze({ outcome: "rejected", reason, status });
}

function indeterminate(reason, status) {
  return Object.freeze({ outcome: "indeterminate", reason, status });
}
