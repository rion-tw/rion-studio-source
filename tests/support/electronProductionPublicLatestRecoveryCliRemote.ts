import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLease
} from "../../scripts/electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteFetch,
  ElectronProductionPublicLatestLeaseRemoteRequestInit,
  ElectronProductionPublicLatestLeaseRemoteResponse
} from "../../scripts/electronProductionPublicLatestLeaseRemote.mjs";
import type {
  ElectronProductionPublicLatestRecoveryFetch,
  ElectronProductionPublicLatestRecoveryRequestInit,
  ElectronProductionPublicLatestRecoveryResponse
} from "../../scripts/electronProductionPublicLatestRecoveryRemote.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "../../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  writeElectronProductionPublicLatestSnapshot
} from "../../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  githubRelease,
  githubTagReference
} from "./electronProductionPublicLatestRecoveryFixture";
import {
  createLeaseReleaseAuthorizationFixture
} from "./electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";
import {
  createOutcomeDiscoveryFixture
} from "./electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

export async function createPublicLatestRecoveryCliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-public-recovery-cli-"));
  const fixture = await createOutcomeDiscoveryFixture(root);
  const sourcePath = path.join(root, "source-snapshot.json");
  const targetPath = path.join(root, "target-snapshot.json");
  const leasePath = path.join(root, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE);
  const source = await writeElectronProductionPublicLatestSnapshot({
    outputPath: sourcePath,
    snapshot: fixture.source
  });
  const target = await writeElectronProductionPublicLatestSnapshot({
    outputPath: targetPath,
    snapshot: fixture.target
  });
  const lease = await writeElectronProductionPublicLatestLease({
    outputPath: leasePath,
    lease: fixture.heldLease
  });
  const authority = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:03:00Z",
    fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:02:30Z",
    suffix: "initial",
    verifiedAt: "2026-09-01T00:04:00Z"
  });
  return {
    ...fixture,
    authorization: authority.authorization,
    authorizationFile: authority.authorizationFile,
    releaseIntent: authority.intent,
    root,
    leaseFile: { path: lease.leasePath, sha256: lease.leaseIdentity.sha256 },
    sourceFile: { path: sourcePath, sha256: source.file.sha256 },
    targetFile: { path: targetPath, sha256: target.file.sha256 }
  };
}

export function repositoryResponse() {
  return jsonResponse({
    full_name: "rion-tw/rion-studio",
    private: false,
    visibility: "public",
    default_branch: "main"
  });
}

export function assetResponses(
  snapshot: ElectronProductionPublicLatestSnapshot,
  sources: Readonly<Record<string, Buffer>>
) {
  return [
    ...snapshot.assets.map((asset) => binaryResponse(sources[asset.name]!)),
    jsonResponse(githubRelease(snapshot, sources)),
    jsonResponse(githubTagReference(snapshot))
  ];
}

export function jsonResponse(value: unknown, status = 200) {
  return response(Buffer.from(JSON.stringify(value)), status, "application/json");
}

function binaryResponse(value: Buffer, status = 200) {
  return response(value, status, "application/octet-stream");
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

export function sequenceFetch(
  ...steps: Array<ElectronProductionPublicLatestRecoveryResponse | Error>
) {
  const calls: Array<{
    url: string;
    init: ElectronProductionPublicLatestRecoveryRequestInit;
  }> = [];
  const fetchImpl: ElectronProductionPublicLatestRecoveryFetch = async (
    url,
    init
  ) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) throw new Error(`Unexpected recovery request ${url}.`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchImpl };
}

export function sequenceLeaseFetch(
  ...steps: Array<ElectronProductionPublicLatestLeaseRemoteResponse | Error>
) {
  const calls: Array<{
    url: string;
    init: ElectronProductionPublicLatestLeaseRemoteRequestInit;
  }> = [];
  const fetchImpl: ElectronProductionPublicLatestLeaseRemoteFetch = async (
    url,
    init
  ) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) throw new Error(`Unexpected lease request ${url}.`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchImpl };
}

export function leaseJsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

export function leaseContentResponse(
  lease: ElectronProductionPublicLatestLease
) {
  const source = serializeElectronProductionPublicLatestLease(lease);
  return leaseJsonResponse({
    type: "file",
    name: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
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
