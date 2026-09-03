import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_KIND =
  "rion-production-updater-endpoint-observation";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND =
  "rion-production-updater-endpoint-observation-prebinding";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND =
  "rion-production-updater-endpoint-observation-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE =
  "endpoint-observation.json";

const TAURI_V22_UPDATER_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAURI_RELEASE_ASSET_HOST = "release-assets.githubusercontent.com";
const MAX_OBSERVATION_BYTES = 1024 * 1024;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const MAX_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const PLATFORM_TARGETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    signatureName: "Rion.Studio-win.exe.sig"
  })
});

export async function observeElectronProductionUpdaterEvidenceEndpoint(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, ["bindings", "outputPath", "signal"],
    "updater evidence endpoint observation input");
  const bindings = assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
    input.bindings
  );
  const signal = requiredAbortSignal(input.signal);
  if (signal.aborted) throw cancelledObservation(signal.reason);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE,
    "updater evidence endpoint observation output"
  );
  const dependencies = resolveDependencies(dependencyOverrides);
  const result = await observeEndpoint(bindings, signal, dependencies.fetchImpl);
  const observedAt = requiredCurrentDate(dependencies.now()).toISOString();
  const observation = assertElectronProductionUpdaterEvidenceEndpointObservation({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
    attemptPlanSha256: bindings.attemptPlanSha256,
    ...bindings.context,
    endpoint: {
      artifactName: bindings.endpoint.artifactName,
      artifactSha256: bindings.endpoint.artifactSha256,
      final: result.final,
      manifestName: "latest.json",
      redirectCount: result.redirects.length,
      redirects: result.redirects,
      requestEndpoint: bindings.endpoint.requestEndpoint,
      servedManifestSha256: result.bodySha256,
      signatureName: bindings.endpoint.signatureName,
      signatureSha256: bindings.endpoint.signatureSha256,
      status: 200,
      targetEmbeddedUpdaterEndpoint:
        bindings.endpoint.targetEmbeddedUpdaterEndpoint,
      updaterPublicKeySha256: bindings.endpoint.updaterPublicKeySha256
    },
    observedAt
  }, bindings);
  await writeExclusive(outputPath, serializeCanonicalJson(observation));
  return readElectronProductionUpdaterEvidenceEndpointObservation({
    bindings,
    observationPath: outputPath
  });
}

export async function readElectronProductionUpdaterEvidenceEndpointObservation(input) {
  const expectedKeys = input?.expectedSha256 === undefined
    ? ["bindings", "observationPath"]
    : ["bindings", "expectedSha256", "observationPath"];
  assertExactKeys(input, expectedKeys, "updater evidence endpoint observation read input");
  const bindings = assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
    input.bindings
  );
  const observationPath = requiredAbsolutePath(
    input.observationPath,
    "updater evidence endpoint observation"
  );
  assertEqual(
    path.basename(observationPath),
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE,
    "updater evidence endpoint observation filename"
  );
  const file = await readCanonicalJsonFile(
    observationPath,
    MAX_OBSERVATION_BYTES,
    "updater evidence endpoint observation"
  );
  if (input.expectedSha256 !== undefined) {
    assertEqual(
      file.sha256,
      requiredDigest(
        input.expectedSha256,
        "updater evidence endpoint observation SHA-256"
      ),
      "updater evidence endpoint observation SHA-256"
    );
  }
  return deepFreeze({
    observation: assertElectronProductionUpdaterEvidenceEndpointObservation(
      file.value,
      bindings
    ),
    observationIdentity: publicIdentity(observationPath, file),
    observationPath
  });
}

export async function readElectronProductionUpdaterEvidenceEndpointObservationBindings(
  bindingsPath
) {
  const file = await readCanonicalJsonFile(
    bindingsPath,
    MAX_BINDINGS_BYTES,
    "updater evidence endpoint observation bindings"
  );
  return deepFreeze({
    bindings: assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
      file.value
    ),
    bindingsIdentity: publicIdentity(bindingsPath, file),
    bindingsPath: requiredAbsolutePath(
      bindingsPath,
      "updater evidence endpoint observation bindings"
    )
  });
}

export function assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
  value
) {
  assertExactKeys(value, [
    "attemptPlanSha256",
    "context",
    "endpoint",
    "kind",
    "schemaVersion"
  ],
    "updater evidence endpoint observation bindings");
  assertEqual(value.schemaVersion, 1,
    "updater evidence endpoint observation bindings schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
    "updater evidence endpoint observation bindings kind"
  );
  const context = assertContext(value.context);
  const endpoint = assertEndpointBindings(value.endpoint, context);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
    attemptPlanSha256: requiredDigest(
      value.attemptPlanSha256,
      "updater evidence endpoint observation attempt-plan SHA-256"
    ),
    context,
    endpoint
  });
}

export function assertElectronProductionUpdaterEvidenceEndpointObservation(
  value,
  bindingsValue
) {
  const bindings = assertElectronProductionUpdaterEvidenceEndpointObservationBindings(
    bindingsValue
  );
  assertExactKeys(value, [
    "attemptPlanSha256",
    "challenge",
    "endpoint",
    "evidenceAttemptId",
    "kind",
    "observedAt",
    "platform",
    "schemaVersion",
    "transitionKind"
  ], "updater evidence endpoint observation");
  assertEqual(value.schemaVersion, 1,
    "updater evidence endpoint observation schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
    "updater evidence endpoint observation prebinding kind");
  const attemptPlanSha256 = requiredDigest(
    value.attemptPlanSha256,
    "updater evidence endpoint observation attempt-plan SHA-256"
  );
  assertEqual(
    attemptPlanSha256,
    bindings.attemptPlanSha256,
    "updater evidence endpoint observation attempt-plan SHA-256"
  );
  const context = assertContext({
    challenge: value.challenge,
    evidenceAttemptId: value.evidenceAttemptId,
    platform: value.platform,
    transitionKind: value.transitionKind
  });
  assertDeepEqual(context, bindings.context, "endpoint observation context");
  const endpoint = assertEndpointResult(
    value.endpoint,
    context,
    bindings.endpoint
  );
  const observedAt = requiredRfc3339(
    value.observedAt,
    "updater evidence endpoint observation time"
  );
  assertWithinChallenge(observedAt, context.challenge);
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
    attemptPlanSha256,
    ...context,
    endpoint,
    observedAt
  });
}

async function observeEndpoint(bindings, signal, fetchImpl) {
  const isTauri =
    bindings.context.transitionKind === "tauri-v22-to-electron-v23";
  let current = requiredHttpsUrl(
    bindings.endpoint.requestEndpoint,
    "source updater request endpoint",
    { allowQuery: false, requireLatestJson: true }
  );
  const redirects = [];
  while (true) {
    if (signal.aborted) throw cancelledObservation(signal.reason);
    const response = await fetchOnce(fetchImpl, current.href, signal);
    assertResponseUrl(response, current);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!isTauri) {
        await cancelResponse(response);
        throw new Error("The Electron v23 updater endpoint must not redirect.");
      }
      if (redirects.length >= 3) {
        await cancelResponse(response);
        throw new Error("The Tauri v22 updater endpoint exceeded three redirects.");
      }
      let next;
      try {
        next = redirectTarget(response, current, redirects.length, bindings);
      } finally {
        await cancelResponse(response);
      }
      redirects.push(Object.freeze({
        fromHost: current.hostname,
        fromScheme: current.protocol,
        fromUrlSha256: sha256(current.href),
        locationUrlSha256: sha256(next.href),
        sequence: redirects.length + 1,
        status: response.status,
        toHost: next.hostname,
        toScheme: next.protocol
      }));
      current = next;
      continue;
    }
    if (response.status !== 200) {
      await cancelResponse(response);
      throw new Error("The updater endpoint final response must be HTTP 200.");
    }
    if (isTauri && redirects.length === 0) {
      await cancelResponse(response);
      throw new Error("The Tauri v22 latest endpoint must redirect to the target tag.");
    }
    const body = await readBoundedBody(response, signal);
    if (signal.aborted) throw cancelledObservation(signal.reason);
    const bodySha256 = sha256(body);
    assertEqual(
      bodySha256,
      bindings.endpoint.servedManifestSha256,
      "served updater manifest SHA-256"
    );
    return deepFreeze({
      bodySha256,
      final: {
        host: current.hostname,
        scheme: current.protocol,
        status: 200,
        urlSha256: sha256(current.href)
      },
      redirects
    });
  }
}

async function fetchOnce(fetchImpl, url, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "rion-studio-production-updater-endpoint-observer"
      },
      cache: "no-store",
      redirect: "manual",
      signal
    });
  } catch {
    if (signal.aborted) throw cancelledObservation(signal.reason);
    throw new Error("The updater endpoint HTTP request failed.");
  }
  if (!response || !Number.isInteger(response.status) ||
      !response.headers || typeof response.headers.get !== "function") {
    await cancelResponse(response);
    throw new Error("The updater endpoint returned an invalid HTTP response.");
  }
  return response;
}

function redirectTarget(response, current, redirectIndex, bindings) {
  const location = response.headers.get("location");
  if (typeof location !== "string" || location.length === 0 ||
      location.length > MAX_URL_LENGTH) {
    throw new Error("The updater endpoint redirect Location is invalid.");
  }
  let next;
  try {
    next = new URL(location, current);
  } catch {
    throw new Error("The updater endpoint redirect Location is invalid.");
  }
  requiredSafeHttpsUrl(next, "updater endpoint redirect target", {
    allowQuery: redirectIndex > 0,
    requireLatestJson: false
  });
  if (redirectIndex === 0) {
    const taggedEndpoint =
      `https://github.com/rion-tw/rion-studio/releases/download/` +
      `v${bindings.endpoint.targetVersion}/latest.json`;
    assertEqual(next.href, taggedEndpoint, "Tauri v22 exact target-tag redirect");
  } else {
    assertEqual(next.hostname, TAURI_RELEASE_ASSET_HOST,
      "Tauri v22 release-asset redirect host");
  }
  return next;
}

async function readBoundedBody(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null &&
      (!/^(?:0|[1-9]\d*)$/u.test(declared) ||
       !Number.isSafeInteger(Number(declared)) ||
       Number(declared) > MAX_MANIFEST_BYTES)) {
    await cancelResponse(response);
    throw new Error("The updater endpoint manifest exceeds its byte bound.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("The updater endpoint manifest body is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const event = await reader.read();
      if (event.done) break;
      if (!(event.value instanceof Uint8Array)) {
        throw new Error("The updater endpoint manifest body chunk is invalid.");
      }
      bytes += event.value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) {
        throw new Error("The updater endpoint manifest exceeds its byte bound.");
      }
      chunks.push(Buffer.from(event.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted || error?.name === "AbortError") {
      throw cancelledObservation(signal.reason, error);
    }
    throw error;
  }
  if (bytes === 0) {
    throw new Error("The updater endpoint manifest body must be nonempty.");
  }
  return Buffer.concat(chunks, bytes);
}

function assertEndpointResult(value, context, expected) {
  assertExactKeys(value, [
    "artifactName",
    "artifactSha256",
    "final",
    "manifestName",
    "redirectCount",
    "redirects",
    "requestEndpoint",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "status",
    "targetEmbeddedUpdaterEndpoint",
    "updaterPublicKeySha256"
  ], "updater evidence endpoint observation result");
  for (const field of [
    "artifactName",
    "artifactSha256",
    "manifestName",
    "requestEndpoint",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "targetEmbeddedUpdaterEndpoint",
    "updaterPublicKeySha256"
  ]) assertEqual(value[field], expected[field], `endpoint observation ${field}`);
  assertEqual(value.status, 200, "endpoint observation status");
  const redirects = assertRedirectResult(
    value.redirects,
    value.redirectCount,
    context.transitionKind,
    expected
  );
  assertExactKeys(value.final, ["host", "scheme", "status", "urlSha256"],
    "endpoint observation final response");
  const final = Object.freeze({
    host: requiredHostname(value.final.host, "endpoint final host"),
    scheme: value.final.scheme,
    status: value.final.status,
    urlSha256: requiredDigest(value.final.urlSha256, "endpoint final URL SHA-256")
  });
  assertEqual(final.scheme, "https:", "endpoint final scheme");
  assertEqual(final.status, 200, "endpoint final status");
  const last = redirects.at(-1);
  assertEqual(
    final.host,
    last?.toHost ?? new URL(expected.requestEndpoint).hostname,
    "endpoint final host"
  );
  assertEqual(
    final.urlSha256,
    last?.locationUrlSha256 ?? sha256(expected.requestEndpoint),
    "endpoint final URL SHA-256"
  );
  return deepFreeze({
    artifactName: expected.artifactName,
    artifactSha256: expected.artifactSha256,
    final,
    manifestName: "latest.json",
    redirectCount: redirects.length,
    redirects,
    requestEndpoint: expected.requestEndpoint,
    servedManifestSha256: expected.servedManifestSha256,
    signatureName: expected.signatureName,
    signatureSha256: expected.signatureSha256,
    status: 200,
    targetEmbeddedUpdaterEndpoint: expected.targetEmbeddedUpdaterEndpoint,
    updaterPublicKeySha256: expected.updaterPublicKeySha256
  });
}

function assertRedirectResult(value, count, transitionKind, expected) {
  if (!Array.isArray(value)) {
    throw new Error("The endpoint observation redirects must be an array.");
  }
  assertEqual(count, value.length, "endpoint observation redirect count");
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  if ((!isTauri && value.length !== 0) ||
      (isTauri && (value.length < 1 || value.length > 3))) {
    throw new Error("The endpoint observation redirect count is invalid.");
  }
  let previousHost = new URL(expected.requestEndpoint).hostname;
  let previousSha256 = sha256(expected.requestEndpoint);
  return Object.freeze(value.map((redirect, index) => {
    const label = `endpoint observation redirect ${index + 1}`;
    assertExactKeys(redirect, [
      "fromHost",
      "fromScheme",
      "fromUrlSha256",
      "locationUrlSha256",
      "sequence",
      "status",
      "toHost",
      "toScheme"
    ], label);
    assertEqual(redirect.sequence, index + 1, `${label} sequence`);
    assertEqual(redirect.fromScheme, "https:", `${label} source scheme`);
    assertEqual(redirect.toScheme, "https:", `${label} target scheme`);
    assertEqual(redirect.fromHost, previousHost, `${label} source host`);
    assertEqual(redirect.fromUrlSha256, previousSha256, `${label} source URL SHA-256`);
    if (!REDIRECT_STATUSES.has(redirect.status)) {
      throw new Error(`The ${label} status is not an HTTP redirect.`);
    }
    const locationSha256 = requiredDigest(
      redirect.locationUrlSha256,
      `${label} target URL SHA-256`
    );
    const toHost = requiredHostname(redirect.toHost, `${label} target host`);
    if (index === 0) {
      const taggedEndpoint =
        `https://github.com/rion-tw/rion-studio/releases/download/` +
        `v${expected.targetVersion}/latest.json`;
      assertEqual(redirect.fromHost, "github.com", `${label} source host`);
      assertEqual(toHost, "github.com", `${label} target host`);
      assertEqual(locationSha256, sha256(taggedEndpoint),
        `${label} exact target-tag URL SHA-256`);
    } else {
      assertEqual(toHost, TAURI_RELEASE_ASSET_HOST, `${label} target host`);
    }
    previousHost = toHost;
    previousSha256 = locationSha256;
    return Object.freeze({
      fromHost: redirect.fromHost,
      fromScheme: "https:",
      fromUrlSha256: redirect.fromUrlSha256,
      locationUrlSha256: locationSha256,
      sequence: index + 1,
      status: redirect.status,
      toHost,
      toScheme: "https:"
    });
  }));
}

function assertEndpointBindings(value, context) {
  assertExactKeys(value, [
    "artifactName",
    "artifactSha256",
    "manifestName",
    "requestEndpoint",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "targetEmbeddedUpdaterEndpoint",
    "targetVersion",
    "updaterPublicKeySha256"
  ], "updater evidence endpoint bindings");
  const platform = PLATFORM_TARGETS[context.platform];
  assertEqual(value.artifactName, platform.artifactName,
    "updater evidence target artifact name");
  assertEqual(value.signatureName, platform.signatureName,
    "updater evidence target signature name");
  assertEqual(value.manifestName, "latest.json",
    "updater evidence target manifest name");
  const requestEndpoint = requiredHttpsEndpoint(
    value.requestEndpoint,
    "source updater request endpoint"
  );
  if (context.transitionKind === "tauri-v22-to-electron-v23") {
    assertEqual(requestEndpoint, TAURI_V22_UPDATER_ENDPOINT,
      "Tauri v22 updater request endpoint");
  }
  return Object.freeze({
    artifactName: platform.artifactName,
    artifactSha256: requiredDigest(value.artifactSha256,
      "updater evidence target artifact SHA-256"),
    manifestName: "latest.json",
    requestEndpoint,
    servedManifestSha256: requiredDigest(value.servedManifestSha256,
      "served updater manifest SHA-256"),
    signatureName: platform.signatureName,
    signatureSha256: requiredDigest(value.signatureSha256,
      "updater evidence target signature SHA-256"),
    targetEmbeddedUpdaterEndpoint: requiredHttpsEndpoint(
      value.targetEmbeddedUpdaterEndpoint,
      "target embedded updater endpoint"
    ),
    targetVersion: requiredSemanticVersion(value.targetVersion,
      "updater evidence target version"),
    updaterPublicKeySha256: requiredDigest(value.updaterPublicKeySha256,
      "updater evidence public-key SHA-256")
  });
}

function assertContext(value) {
  assertExactKeys(value, [
    "challenge",
    "evidenceAttemptId",
    "platform",
    "transitionKind"
  ], "updater evidence endpoint observation context");
  const transitionKind = requiredEnum(value.transitionKind, TRANSITIONS,
    "updater evidence transition kind");
  return deepFreeze({
    challenge: assertChallenge(value.challenge),
    evidenceAttemptId: requiredUuid(value.evidenceAttemptId,
      "updater evidence attempt ID"),
    platform: requiredEnum(value.platform, Object.keys(PLATFORM_TARGETS),
      "updater evidence platform"),
    transitionKind
  });
}

function assertChallenge(value) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "updater evidence challenge");
  const challenge = Object.freeze({
    expiresAt: requiredRfc3339(value.expiresAt, "updater evidence challenge expiry"),
    id: requiredUuid(value.id, "updater evidence challenge ID"),
    issuedAt: requiredRfc3339(value.issuedAt, "updater evidence challenge issue time"),
    nonceSha256: requiredDigest(value.nonceSha256,
      "updater evidence challenge nonce SHA-256")
  });
  const duration = Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt);
  if (duration <= 0 || duration > MAX_CHALLENGE_LIFETIME_MS) {
    throw new Error("The updater evidence challenge lifetime must be positive and at most 24 hours.");
  }
  return challenge;
}

function assertWithinChallenge(observedAt, challenge) {
  const observed = Date.parse(observedAt);
  if (observed < Date.parse(challenge.issuedAt) ||
      observed > Date.parse(challenge.expiresAt)) {
    throw new Error("The endpoint observation falls outside its challenge window.");
  }
}

function requiredHttpsEndpoint(value, label) {
  return requiredHttpsUrl(value, label, {
    allowQuery: false,
    requireLatestJson: true
  }).href;
}

function requiredHttpsUrl(value, label, options) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_URL_LENGTH) {
    throw new Error(`The ${label} must be a bounded HTTPS URL.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${label} must be a bounded HTTPS URL.`);
  }
  requiredSafeHttpsUrl(url, label, options);
  if (url.href !== value) throw new Error(`The ${label} must be canonical.`);
  return url;
}

function requiredSafeHttpsUrl(url, label, options) {
  if (url.href.length > MAX_URL_LENGTH || url.protocol !== "https:" ||
      url.username || url.password || url.port || url.hash ||
      (!options.allowQuery && url.search) ||
      (options.requireLatestJson && !url.pathname.endsWith("/latest.json"))) {
    throw new Error(`The ${label} must be an exact credential-free HTTPS URL.`);
  }
  return url;
}

function assertResponseUrl(response, expected) {
  if (response.redirected !== false ||
      typeof response.url !== "string" || response.url !== expected.href) {
    throw new Error("The updater endpoint response URL does not match its manual request.");
  }
}

function requiredHostname(value, label) {
  if (typeof value !== "string" ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`The ${label} is unsupported.`);
  return value;
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The updater endpoint observer requires an AbortSignal.");
  }
  return value;
}

function requiredCurrentDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The updater endpoint observation clock is invalid.");
  }
  return new Date(value.getTime());
}

function resolveDependencies(overrides) {
  return {
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    now: overrides.now ?? (() => new Date())
  };
}

async function cancelResponse(response) {
  try {
    await response?.body?.getReader?.().cancel();
  } catch {
    // A discarded response is already a non-authoritative path.
  }
}

function cancelledObservation(reason, cause) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(
    `The updater endpoint observation was cancelled${suffix}.`,
    cause === undefined ? undefined : { cause }
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
