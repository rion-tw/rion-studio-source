import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
  observeElectronProductionUpdaterEvidenceEndpoint,
  readElectronProductionUpdaterEvidenceEndpointObservation,
  type ElectronProductionUpdaterEvidenceEndpointObservationBindings,
  type ElectronProductionUpdaterEvidenceEndpointPlatform,
  type ElectronProductionUpdaterEvidenceEndpointTransition
} from "../scripts/electronProductionUpdaterEvidenceEndpointObservation.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterEvidenceEndpointObservationCli
} from "../scripts/electronProductionUpdaterEvidenceEndpointObservationCli.mjs";

const NOW = new Date("2026-09-02T00:12:00.000Z");
const TARGET_VERSION = "8.6.0";
const V23_ENDPOINT = "https://updates.example.test/source/latest.json";
const TARGET_ENDPOINT = "https://updates.example.test/future/latest.json";
const TAURI_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAGGED_ENDPOINT =
  `https://github.com/rion-tw/rion-studio/releases/download/v${TARGET_VERSION}/latest.json`;
const MANIFEST = Buffer.from('{"version":"8.6.0"}\n', "utf8");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("Electron production updater endpoint observation", () => {
  it.each(["darwin-aarch64", "windows-x86_64"] as const)(
    "observes and verifies a direct Electron v23 HTTPS 200 response for %s",
    async (platform) => {
    const fixture = await createFixture("electron-v23-to-electron-v23", platform);
    const calls: FetchCall[] = [];
    const stdout: Buffer[] = [];
    const controller = new AbortController();
    const fetchImpl = queuedFetch([
      httpResponse(200, V23_ENDPOINT, MANIFEST)
    ], calls);

    const summary =
      await runElectronProductionUpdaterEvidenceEndpointObservationCli([
        "observe",
        "--bindings", fixture.bindingsPath,
        "--output", fixture.outputPath
      ], {
        fetchImpl,
        now: () => new Date(NOW),
        signal: controller.signal,
        writeStdout: (source) => { stdout.push(source); }
      });

    expect(summary).toEqual({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_CLI_SUMMARY_KIND,
      command: "observe",
      status: "prebound",
      attemptPlanSha256: fixture.bindings.attemptPlanSha256,
      cell: {
        evidenceAttemptId: fixture.bindings.context.evidenceAttemptId,
        platform: fixture.bindings.context.platform,
        transitionKind: fixture.bindings.context.transitionKind
      },
      artifact: {
        bytes: expect.any(Number),
        fileName: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: V23_ENDPOINT,
      init: {
        cache: "no-store",
        method: "GET",
        redirect: "manual",
        signal: controller.signal
      }
    });
    const verified = await readElectronProductionUpdaterEvidenceEndpointObservation({
      bindings: fixture.bindings,
      expectedSha256: summary.artifact.sha256,
      observationPath: fixture.outputPath
    });
    expect(verified.observation).toEqual({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_PREBINDING_KIND,
      attemptPlanSha256: fixture.bindings.attemptPlanSha256,
      ...fixture.bindings.context,
      endpoint: {
        artifactName: fixture.bindings.endpoint.artifactName,
        artifactSha256: fixture.bindings.endpoint.artifactSha256,
        final: {
          host: "updates.example.test",
          scheme: "https:",
          status: 200,
          urlSha256: sha256(V23_ENDPOINT)
        },
        manifestName: "latest.json",
        redirectCount: 0,
        redirects: [],
        requestEndpoint: V23_ENDPOINT,
        servedManifestSha256: sha256(MANIFEST),
        signatureName: fixture.bindings.endpoint.signatureName,
        signatureSha256: fixture.bindings.endpoint.signatureSha256,
        status: 200,
        targetEmbeddedUpdaterEndpoint: TARGET_ENDPOINT,
        updaterPublicKeySha256:
          fixture.bindings.endpoint.updaterPublicKeySha256
      },
      observedAt: NOW.toISOString()
    });
    expect(verified.observation).not.toHaveProperty("sourceInstallAttemptId");
    expect(await readFile(fixture.outputPath)).toEqual(
      serializeCanonicalJson(verified.observation)
    );
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(summary);

    const verifySummary =
      await runElectronProductionUpdaterEvidenceEndpointObservationCli([
        "verify",
        "--bindings", fixture.bindingsPath,
        "--observation", fixture.outputPath,
        "--expected-sha256", summary.artifact.sha256
      ], { writeStdout: () => undefined });
    expect(verifySummary).toMatchObject({
      command: "verify",
      status: "verified",
      artifact: summary.artifact
    });
    }
  );

  it.each([1, 2, 3])(
    "records a bounded ordered Tauri v22 redirect chain with %i hop(s)",
    async (hopCount) => {
      const fixture = await createFixture("tauri-v22-to-electron-v23");
      const chain = tauriResponses(hopCount);
      const controller = new AbortController();
      const observed = await observeElectronProductionUpdaterEvidenceEndpoint({
        bindings: fixture.bindings,
        outputPath: fixture.outputPath,
        signal: controller.signal
      }, {
        fetchImpl: queuedFetch(chain.responses),
        now: () => new Date(NOW)
      });

      expect(observed.observation.endpoint.redirectCount).toBe(hopCount);
      expect(observed.observation.endpoint.redirects[0]).toMatchObject({
        fromHost: "github.com",
        fromUrlSha256: sha256(TAURI_ENDPOINT),
        locationUrlSha256: sha256(TAGGED_ENDPOINT),
        sequence: 1,
        status: 302,
        toHost: "github.com"
      });
      expect(observed.observation.endpoint.final).toEqual({
        host: new URL(chain.finalUrl).hostname,
        scheme: "https:",
        status: 200,
        urlSha256: sha256(chain.finalUrl)
      });
      const persisted = await readFile(fixture.outputPath, "utf8");
      expect(persisted).not.toContain("signed-secret");
      expect(persisted).not.toContain(chain.finalUrl);
      expect(persisted).not.toContain("?");
    }
  );

  it("rejects any redirect from an Electron v23 source endpoint", async () => {
    const fixture = await createFixture("electron-v23-to-electron-v23");
    const controller = new AbortController();
    await expect(observeElectronProductionUpdaterEvidenceEndpoint({
      bindings: fixture.bindings,
      outputPath: fixture.outputPath,
      signal: controller.signal
    }, {
      fetchImpl: queuedFetch([
        httpResponse(302, V23_ENDPOINT, undefined, {
          location: "https://updates.example.test/redirect/latest.json"
        })
      ]),
      now: () => new Date(NOW)
    })).rejects.toThrow("must not redirect");
    await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects wrong target-tag, foreign asset-host, fragment, and excess redirects", async () => {
    const wrongTag = await createFixture("tauri-v22-to-electron-v23");
    await expect(observe(wrongTag, [
      httpResponse(302, TAURI_ENDPOINT, undefined, {
        location:
          "https://github.com/rion-tw/rion-studio/releases/download/v8.6.1/latest.json"
      })
    ])).rejects.toThrow("exact target-tag redirect does not match");

    const foreignHost = await createFixture("tauri-v22-to-electron-v23");
    await expect(observe(foreignHost, [
      httpResponse(302, TAURI_ENDPOINT, undefined, { location: TAGGED_ENDPOINT }),
      httpResponse(302, TAGGED_ENDPOINT, undefined, {
        location: "https://evil.example.test/asset?token=signed-secret"
      })
    ])).rejects.toThrow("release-asset redirect host does not match");

    const fragment = await createFixture("tauri-v22-to-electron-v23");
    await expect(observe(fragment, [
      httpResponse(302, TAURI_ENDPOINT, undefined, { location: TAGGED_ENDPOINT }),
      httpResponse(302, TAGGED_ENDPOINT, undefined, {
        location:
          "https://release-assets.githubusercontent.com/asset?token=signed-secret#fragment"
      })
    ])).rejects.toThrow("credential-free HTTPS URL");

    const tooMany = await createFixture("tauri-v22-to-electron-v23");
    const asset1 = "https://release-assets.githubusercontent.com/asset-1?token=one";
    const asset2 = "https://release-assets.githubusercontent.com/asset-2?token=two";
    const asset3 = "https://release-assets.githubusercontent.com/asset-3?token=three";
    await expect(observe(tooMany, [
      httpResponse(302, TAURI_ENDPOINT, undefined, { location: TAGGED_ENDPOINT }),
      httpResponse(302, TAGGED_ENDPOINT, undefined, { location: asset1 }),
      httpResponse(302, asset1, undefined, { location: asset2 }),
      httpResponse(302, asset2, undefined, { location: asset3 })
    ])).rejects.toThrow("exceeded three redirects");
  });

  it("rejects credentialed inputs, non-200 terminal responses, and body mismatch", async () => {
    const credentialed = await createFixture("electron-v23-to-electron-v23");
    await rewriteCanonical(credentialed.bindingsPath, (value) => {
      const endpoint = value.endpoint as Record<string, unknown>;
      endpoint.requestEndpoint =
        "https://user:password@updates.example.test/source/latest.json";
    });
    await expect(runObserveCli(credentialed, queuedFetch([]))).rejects.toThrow(
      "credential-free HTTPS URL"
    );

    const non200 = await createFixture("electron-v23-to-electron-v23");
    await expect(observe(non200, [
      httpResponse(503, V23_ENDPOINT)
    ])).rejects.toThrow("must be HTTP 200");

    const mismatch = await createFixture("electron-v23-to-electron-v23");
    await expect(observe(mismatch, [
      httpResponse(200, V23_ENDPOINT, Buffer.from("different"))
    ])).rejects.toThrow("served updater manifest SHA-256 does not match");

    const oversized = await createFixture("electron-v23-to-electron-v23");
    await expect(observe(oversized, [
      httpResponse(200, V23_ENDPOINT, MANIFEST, {
        "content-length": String(1024 * 1024 + 1)
      })
    ])).rejects.toThrow("exceeds its byte bound");
  });

  it("requires caller-owned cancellation and never terminalizes abort as success", async () => {
    const fixture = await createFixture("electron-v23-to-electron-v23");
    const controller = new AbortController();
    controller.abort(new Error("external liveness ended"));
    let fetchCalled = false;
    await expect(observeElectronProductionUpdaterEvidenceEndpoint({
      bindings: fixture.bindings,
      outputPath: fixture.outputPath,
      signal: controller.signal
    }, {
      fetchImpl: (async () => {
        fetchCalled = true;
        return httpResponse(200, V23_ENDPOINT, MANIFEST) as unknown as Response;
      }) as typeof fetch,
      now: () => new Date(NOW)
    })).rejects.toThrow("external liveness ended");
    expect(fetchCalled).toBe(false);
    await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(runElectronProductionUpdaterEvidenceEndpointObservationCli([
      "observe",
      "--bindings", fixture.bindingsPath,
      "--output", fixture.outputPath
    ], {
      fetchImpl: queuedFetch([httpResponse(200, V23_ENDPOINT, MANIFEST)]),
      now: () => new Date(NOW),
      writeStdout: () => undefined
    })).rejects.toThrow("caller must provide an AbortSignal");
  });

  it("enforces canonical exact single-link files, expected SHA, and exact CLI options", async () => {
    const noncanonicalBindings =
      await createFixture("electron-v23-to-electron-v23");
    await writeFile(
      noncanonicalBindings.bindingsPath,
      JSON.stringify(noncanonicalBindings.bindings)
    );
    await expect(runObserveCli(noncanonicalBindings, queuedFetch([]))).rejects.toThrow(
      "not canonical JSON"
    );

    const unknownBindings = await createFixture("electron-v23-to-electron-v23");
    await rewriteCanonical(unknownBindings.bindingsPath, (value) => {
      value.timeoutMilliseconds = 30_000;
    });
    await expect(runObserveCli(unknownBindings, queuedFetch([]))).rejects.toThrow(
      "unexpected schema"
    );

    const selfReportedAttempt =
      await createFixture("electron-v23-to-electron-v23");
    await rewriteCanonical(selfReportedAttempt.bindingsPath, (value) => {
      const context = value.context as Record<string, unknown>;
      context.sourceInstallAttemptId =
        "update-install-10000000-0000-4000-8000-000000000003";
    });
    await expect(runObserveCli(selfReportedAttempt, queuedFetch([]))).rejects.toThrow(
      "unexpected schema"
    );

    const fixture = await createFixture("electron-v23-to-electron-v23");
    const observed = await observe(fixture, [httpResponse(200, V23_ENDPOINT, MANIFEST)]);
    await expect(readElectronProductionUpdaterEvidenceEndpointObservation({
      bindings: fixture.bindings,
      expectedSha256: "0".repeat(64),
      observationPath: fixture.outputPath
    })).rejects.toThrow("SHA-256 does not match");
    expect(observed.observationIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const unknown = await createFixture("electron-v23-to-electron-v23");
    await observe(unknown, [httpResponse(200, V23_ENDPOINT, MANIFEST)]);
    await rewriteCanonical(unknown.outputPath, (value) => { value.timeoutPassed = true; });
    await expect(readElectronProductionUpdaterEvidenceEndpointObservation({
      bindings: unknown.bindings,
      observationPath: unknown.outputPath
    })).rejects.toThrow("unexpected schema");

    const wrongPlan = await createFixture("electron-v23-to-electron-v23");
    await observe(wrongPlan, [httpResponse(200, V23_ENDPOINT, MANIFEST)]);
    await rewriteCanonical(wrongPlan.outputPath, (value) => {
      value.attemptPlanSha256 = sha256("different-attempt-plan");
    });
    await expect(readElectronProductionUpdaterEvidenceEndpointObservation({
      bindings: wrongPlan.bindings,
      observationPath: wrongPlan.outputPath
    })).rejects.toThrow("attempt-plan SHA-256 does not match");

    const linked = await createFixture("electron-v23-to-electron-v23");
    await observe(linked, [httpResponse(200, V23_ENDPOINT, MANIFEST)]);
    await link(linked.outputPath, `${linked.outputPath}.link`);
    await expect(readElectronProductionUpdaterEvidenceEndpointObservation({
      bindings: linked.bindings,
      observationPath: linked.outputPath
    })).rejects.toThrow("bounded, nonempty, single-link regular file");

    await expect(runElectronProductionUpdaterEvidenceEndpointObservationCli([
      "verify",
      "--bindings", fixture.bindingsPath,
      "--observation", fixture.outputPath,
      "--observation", fixture.outputPath
    ], { writeStdout: () => undefined })).rejects.toThrow(
      "Duplicate verify option --observation"
    );
    await expect(runElectronProductionUpdaterEvidenceEndpointObservationCli([
      "verify",
      "--bindings", fixture.bindingsPath,
      "--observation", fixture.outputPath,
      "--timeout", "1000"
    ], { writeStdout: () => undefined })).rejects.toThrow(
      "Unknown verify option --timeout"
    );
  });
});

async function createFixture(
  transitionKind: ElectronProductionUpdaterEvidenceEndpointTransition,
  platform: ElectronProductionUpdaterEvidenceEndpointPlatform = "darwin-aarch64"
) {
  const root = await mkdtemp(join(tmpdir(), "rion-endpoint-observation-"));
  temporaryDirectories.push(root);
  const bindings = createBindings(transitionKind, platform);
  const bindingsPath = join(root, "endpoint-observation-bindings.json");
  const outputPath = join(
    root,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_FILE
  );
  await writeFile(bindingsPath, serializeCanonicalJson(bindings));
  return { bindings, bindingsPath, outputPath, root };
}

function createBindings(
  transitionKind: ElectronProductionUpdaterEvidenceEndpointTransition,
  platform: ElectronProductionUpdaterEvidenceEndpointPlatform
): ElectronProductionUpdaterEvidenceEndpointObservationBindings {
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  const isDarwin = platform === "darwin-aarch64";
  return {
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ENDPOINT_OBSERVATION_BINDINGS_KIND,
    attemptPlanSha256: sha256("attempt-plan"),
    context: {
      challenge: {
        expiresAt: "2026-09-02T12:00:00Z",
        id: "10000000-0000-4000-8000-000000000001",
        issuedAt: "2026-09-02T00:00:00Z",
        nonceSha256: sha256("challenge-nonce")
      },
      evidenceAttemptId: "10000000-0000-4000-8000-000000000002",
      platform,
      transitionKind
    },
    endpoint: {
      artifactName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz"
        : "Rion.Studio-win.exe",
      artifactSha256: sha256("target-artifact"),
      manifestName: "latest.json",
      requestEndpoint: isTauri ? TAURI_ENDPOINT : V23_ENDPOINT,
      servedManifestSha256: sha256(MANIFEST),
      signatureName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz.sig"
        : "Rion.Studio-win.exe.sig",
      signatureSha256: sha256("target-signature"),
      targetEmbeddedUpdaterEndpoint: TARGET_ENDPOINT,
      targetVersion: TARGET_VERSION,
      updaterPublicKeySha256: sha256("production-updater-public-key")
    }
  };
}

function tauriResponses(hopCount: number) {
  const responses: FakeResponse[] = [
    httpResponse(302, TAURI_ENDPOINT, undefined, { location: TAGGED_ENDPOINT })
  ];
  let current = TAGGED_ENDPOINT;
  for (let index = 1; index < hopCount; index += 1) {
    const next =
      `https://release-assets.githubusercontent.com/asset-${index}` +
      `?token=signed-secret-${index}`;
    responses.push(httpResponse(302, current, undefined, { location: next }));
    current = next;
  }
  responses.push(httpResponse(200, current, MANIFEST));
  return { finalUrl: current, responses };
}

async function observe(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  responses: readonly FakeResponse[]
) {
  const controller = new AbortController();
  return observeElectronProductionUpdaterEvidenceEndpoint({
    bindings: fixture.bindings,
    outputPath: fixture.outputPath,
    signal: controller.signal
  }, {
    fetchImpl: queuedFetch(responses),
    now: () => new Date(NOW)
  });
}

async function runObserveCli(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  fetchImpl: typeof fetch
) {
  const controller = new AbortController();
  return runElectronProductionUpdaterEvidenceEndpointObservationCli([
    "observe",
    "--bindings", fixture.bindingsPath,
    "--output", fixture.outputPath
  ], {
    fetchImpl,
    now: () => new Date(NOW),
    signal: controller.signal,
    writeStdout: () => undefined
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface FakeResponse {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
  readonly redirected: false;
  readonly status: number;
  readonly url: string;
}

function queuedFetch(
  responses: readonly FakeResponse[],
  calls: FetchCall[] = []
): typeof fetch {
  const remaining = [...responses];
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = remaining.shift();
    if (!response) throw new Error("unexpected fetch");
    return response as unknown as Response;
  }) as typeof fetch;
}

function httpResponse(
  status: number,
  url: string,
  body?: Uint8Array,
  headers: Record<string, string> = {}
): FakeResponse {
  const source = body === undefined ? null : Buffer.from(body);
  return {
    body: source === null ? null : new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source);
        controller.close();
      }
    }),
    headers: new Headers(headers),
    redirected: false,
    status,
    url
  };
}

async function rewriteCanonical(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void
) {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(filePath, serializeCanonicalJson(value));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
