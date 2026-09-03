import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageVerificationMock = vi.hoisted(() => vi.fn());
const signerMock = vi.hoisted(() => vi.fn());
const manifestMock = vi.hoisted(() => vi.fn());

vi.mock("../scripts/electronUpdaterMacosPackageVerification.mjs", async (
  importOriginal
) => {
  const actual = await importOriginal<typeof import(
    "../scripts/electronUpdaterMacosPackageVerification.mjs"
  )>();
  return {
    ...actual,
    verifyElectronUpdaterMacosPackage: packageVerificationMock
  };
});

vi.mock("../scripts/updaterSignerEnvironment.mjs", () => ({
  signUpdaterArtifact: signerMock
}));

vi.mock("../scripts/createUpdaterManifest.mjs", () => ({
  createUpdaterManifest: manifestMock
}));

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  prepareElectronUpdaterProbeInput,
  readElectronUpdaterPreparedProbeInput
} from "../scripts/electronUpdaterPreparedProbeInput.mjs";
import { prepareElectronUpdaterTransactionProbeInput } from
  "../scripts/prepareElectronUpdaterTransactionProbeInput.mjs";

const VERSION = "23.4.0";
const temporaryRoots: string[] = [];

beforeEach(() => {
  packageVerificationMock.mockReset();
  signerMock.mockReset();
  manifestMock.mockReset();
  packageVerificationMock.mockImplementation(async (input: {
    expectedArtifact: Readonly<{ bytes: number; sha256: string }>;
    expectedVersion: string;
  }) => packageVerification(input.expectedArtifact, input.expectedVersion));
  signerMock.mockImplementation(async (input: { artifactPath: string }) => {
    await writeFile(`${input.artifactPath}.sig`, "updater signature\n");
  });
  manifestMock.mockImplementation(async (argumentsList: string[]) => {
    const outputIndex = argumentsList.indexOf("--output");
    await writeFile(argumentsList[outputIndex + 1]!, '{"fixture":true}\n');
  });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("Electron updater prepared probe input", () => {
  it("writes and rereads schema-v2 macOS package verification evidence", async () => {
    const fixture = await createFixture("darwin");
    const result = await prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath,
      "--app", fixture.applicationPath
    ], fixture.environment, { arch: "arm64", platform: "darwin" });

    expect(result.receipt).toMatchObject({
      architecture: "arm64",
      macosPackageVerification: {
        artifact: {
          bytes: result.receipt.artifact.bytes,
          sha256: result.receipt.artifact.sha256
        },
        expectedVersion: VERSION
      },
      platform: "darwin",
      schemaVersion: 2
    });
    expect(packageVerificationMock).toHaveBeenCalledOnce();
    expect(packageVerificationMock).toHaveBeenCalledWith({
      artifactPath: result.artifact,
      expectedArtifact: result.receipt.artifact,
      expectedVersion: VERSION,
      referenceApplicationPath: fixture.applicationPath
    });

    const readInput = {
      architecture: "arm64" as const,
      artifactPath: result.artifact,
      environment: {},
      fixtureRoot: fixture.preparedRoot,
      platform: "darwin" as const,
      receiptPath: result.receiptPath,
      version: VERSION
    };
    const reread = await readElectronUpdaterPreparedProbeInput(readInput);
    expect(reread.receipt.macosPackageVerification).toEqual(
      result.receipt.macosPackageVerification
    );
    expect(Object.isFrozen(reread.receipt.macosPackageVerification)).toBe(true);

    const original = JSON.parse(await readFile(result.receiptPath, "utf8"));
    await writeFile(result.receiptPath, serializeCanonicalJson({
      ...original,
      macosPackageVerification: {
        ...original.macosPackageVerification,
        expectedVersion: "23.4.1"
      }
    }));
    await expect(readElectronUpdaterPreparedProbeInput(readInput)).rejects.toThrow(
      "package verification contract is invalid"
    );

    await writeFile(result.receiptPath, serializeCanonicalJson({
      ...original,
      macosPackageVerification: {
        ...original.macosPackageVerification,
        artifact: {
          ...original.macosPackageVerification.artifact,
          sha256: "0".repeat(64)
        }
      }
    }));
    await expect(readElectronUpdaterPreparedProbeInput(readInput)).rejects.toThrow(
      "artifact does not match the prepared input"
    );
  });

  it("writes null verification on Windows and forbids --app", async () => {
    const fixture = await createFixture("win32");
    const result = await prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath
    ], fixture.environment, { arch: "x64", platform: "win32" });

    expect(result.receipt).toMatchObject({
      architecture: "x64",
      macosPackageVerification: null,
      platform: "win32",
      schemaVersion: 2
    });
    expect(packageVerificationMock).not.toHaveBeenCalled();
    await expect(readElectronUpdaterPreparedProbeInput({
      architecture: "x64",
      artifactPath: result.artifact,
      environment: {},
      fixtureRoot: fixture.preparedRoot,
      platform: "win32",
      receiptPath: result.receiptPath,
      version: VERSION
    })).resolves.toMatchObject({
      receipt: { macosPackageVerification: null }
    });

    const windowsReceipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    await writeFile(result.receiptPath, serializeCanonicalJson({
      ...windowsReceipt,
      macosPackageVerification: packageVerification(
        windowsReceipt.artifact,
        windowsReceipt.version
      )
    }));
    await expect(readElectronUpdaterPreparedProbeInput({
      architecture: "x64",
      artifactPath: result.artifact,
      environment: {},
      fixtureRoot: fixture.preparedRoot,
      platform: "win32",
      receiptPath: result.receiptPath,
      version: VERSION
    })).rejects.toThrow("macOS package verification must be null");

    await expect(prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath,
      "--app", fixture.applicationPath
    ], fixture.environment, { arch: "x64", platform: "win32" })).rejects.toThrow(
      "--app is forbidden on Windows"
    );
    await expect(prepareElectronUpdaterProbeInput({
      architecture: "x64",
      artifactPath: fixture.artifactPath,
      environment: fixture.environment,
      fixtureRoot: fixture.preparedRoot,
      platform: "win32",
      referenceApplicationPath: fixture.applicationPath,
      version: VERSION
    })).rejects.toThrow("must not specify a macOS application");
  });

  it("requires one absolute Rion Studio.app path for Darwin preparation", async () => {
    const fixture = await createFixture("darwin");
    const runtime = { arch: "arm64" as const, platform: "darwin" as const };
    await expect(prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath
    ], fixture.environment, runtime)).rejects.toThrow(
      "--app must be an absolute path"
    );
    await expect(prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath,
      "--app", "Rion Studio.app"
    ], fixture.environment, runtime)).rejects.toThrow(
      "--app must be an absolute path"
    );
    await expect(prepareElectronUpdaterTransactionProbeInput([
      "--artifact", fixture.artifactPath,
      "--app", path.join(fixture.root, "Another.app")
    ], fixture.environment, runtime)).rejects.toThrow(
      "--app must be an absolute Rion Studio.app path"
    );
  });
});

async function createFixture(platform: "darwin" | "win32") {
  const root = await mkdtemp(path.join(tmpdir(), "rion-prepared-probe-v2-"));
  temporaryRoots.push(root);
  const preparedRoot = path.join(root, "prepared");
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const applicationPath = path.join(sourceRoot, "Rion Studio.app");
  await Promise.all([
    mkdir(preparedRoot),
    mkdir(runtimeRoot),
    mkdir(applicationPath, { recursive: true })
  ]);
  const artifactName = platform === "darwin"
    ? "Rion.Studio-mac.app.tar.gz"
    : "Rion.Studio-win.exe";
  const artifactPath = path.join(sourceRoot, artifactName);
  await writeFile(artifactPath, `${platform} updater artifact\n`);
  return {
    applicationPath,
    artifactPath,
    environment: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      PATH: process.env.PATH,
      RION_STUDIO_ELECTRON_PACKAGE_VERSION: VERSION,
      RION_UPDATER_CI_FIXTURE_ROOT: runtimeRoot,
      RION_UPDATER_PREPARED_INPUT_ROOT: preparedRoot,
      TAURI_SIGNING_PRIVATE_KEY: "fixture private key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "fixture password"
    },
    preparedRoot,
    root
  };
}

function packageVerification(
  artifact: Readonly<{ bytes: number; sha256: string }>,
  version: string
) {
  return Object.freeze({
    applicationBundle: "Rion Studio.app",
    artifact: Object.freeze({
      bytes: artifact.bytes,
      fileName: "Rion.Studio-mac.app.tar.gz",
      sha256: artifact.sha256
    }),
    expectedVersion: version,
    kind: "rion-electron-updater-macos-package-verification",
    packageManifest: Object.freeze({
      directoryCount: 1,
      entryCount: 2,
      regularFileBytes: 42,
      regularFileCount: 1,
      schemaVersion: 1,
      sha256: createHash("sha256").update("package manifest").digest("hex"),
      symlinkCount: 0
    }),
    schemaVersion: 1,
    verificationKind: "safe-tar-extraction-production-electron-package-v1"
  });
}
