import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE,
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE,
  finalizeElectronProductionUpdaterDataPreservation,
  prepareElectronProductionUpdaterDataPreservation,
  readElectronProductionUpdaterDataPreservationBefore,
  readElectronProductionUpdaterDataPreservationObservation,
  type ElectronProductionUpdaterDataPreservationContext,
  type ElectronProductionUpdaterDataPreservationPlatform,
  type ElectronProductionUpdaterDataPreservationTransition
} from "../scripts/electronProductionUpdaterDataPreservationObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterDataPreservationObserverCli
} from "../scripts/electronProductionUpdaterDataPreservationObserverCli.mjs";

const EVIDENCE_ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "10000000-0000-4000-8000-000000000002";
const ELECTRON_SOURCE_ATTEMPT_ID =
  "update-install-abcdef12-3456-4789-8abc-def012345678";
const OBSERVED_AT = "2026-09-02T04:00:00.000Z";
const NONCE = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater data-preservation observer", () => {
  it.each([
    ["tauri-v22-to-electron-v23", "darwin-aarch64", "update-install-7"],
    ["tauri-v22-to-electron-v23", "windows-x86_64", "update-install-8"],
    ["electron-v23-to-electron-v23", "darwin-aarch64", ELECTRON_SOURCE_ATTEMPT_ID],
    ["electron-v23-to-electron-v23", "windows-x86_64", ELECTRON_SOURCE_ATTEMPT_ID]
  ] as const)("prepares and finalizes %s on %s", async (
    transitionKind,
    platform,
    sourceInstallAttemptId
  ) => {
    const fixture = await createFixture({
      platform,
      sourceInstallAttemptId,
      transitionKind
    });

    const prepared = await prepareFixture(fixture);
    expect(prepared.before).toMatchObject({
      challengeNonceSha256: fixture.challengeSha256,
      sentinel: {
        bytes: 32,
        fileName: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE,
        sha256: fixture.challengeSha256
      }
    });
    expect(await readFile(fixture.sentinelPath)).toEqual(NONCE);
    expect(await readFile(fixture.beforeReceiptPath)).toEqual(
      serializeCanonicalJson(prepared.before)
    );

    const finalized = await finalizeFixture(fixture, prepared.beforeIdentity.sha256);
    expect(finalized.observation).toMatchObject({
      challenge: fixture.context.challenge,
      evidenceAttemptId: EVIDENCE_ATTEMPT_ID,
      observedAt: OBSERVED_AT,
      platform,
      preservation: {
        afterChallengeSha256: fixture.challengeSha256,
        beforeChallengeSha256: fixture.challengeSha256,
        preserved: true
      },
      sourceInstallAttemptId,
      target: fixture.context.target,
      transitionKind
    });
    expect(finalized.observation.preservation.userDataIdentitySha256).toBe(
      sha256(serializeCanonicalJson(prepared.before.userDataDirectoryIdentity))
    );
    expect(await readFile(fixture.observationPath)).toEqual(
      serializeCanonicalJson(finalized.observation)
    );
    expect((await readFile(fixture.observationPath, "utf8")))
      .not.toContain(fixture.userDataDirectory);
    expect(await readFile(fixture.sentinelPath)).toEqual(NONCE);
    await expect(readElectronProductionUpdaterDataPreservationBefore({
      beforeReceiptPath: fixture.beforeReceiptPath,
      expectedBeforeReceiptSha256: prepared.beforeIdentity.sha256
    })).resolves.toEqual(expect.objectContaining({ before: prepared.before }));
    await expect(readElectronProductionUpdaterDataPreservationObservation({
      expectedObservationSha256: finalized.observationIdentity.sha256,
      observationPath: fixture.observationPath
    })).resolves.toEqual(finalized);
  });

  it("CLI exposes closed file-based prepare/finalize commands and canonical stdout", async () => {
    const fixture = await createFixture();
    let stdout = Buffer.alloc(0);
    const prepared = await runElectronProductionUpdaterDataPreservationObserverCli([
      "prepare",
      "--challenge-nonce", fixture.challengeNoncePath,
      "--expected-challenge-sha256", fixture.challengeSha256,
      "--user-data-directory", fixture.userDataDirectory,
      "--output", fixture.beforeReceiptPath
    ], {
      writeStdout: (source) => { stdout = Buffer.from(source); }
    });
    expect(prepared).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_CLI_SUMMARY_KIND,
      command: "prepare",
      status: "prepared",
      sentinel: { bytes: 32, sha256: fixture.challengeSha256 }
    });
    expect(stdout).toEqual(serializeCanonicalJson(prepared));
    if (prepared.command !== "prepare") throw new Error("Expected prepare summary.");

    stdout = Buffer.alloc(0);
    const finalized = await runElectronProductionUpdaterDataPreservationObserverCli([
      "finalize",
      "--before-receipt", fixture.beforeReceiptPath,
      "--expected-before-receipt-sha256", prepared.artifact.sha256,
      "--context", fixture.contextPath,
      "--expected-context-sha256", fixture.contextSha256,
      "--user-data-directory", fixture.userDataDirectory,
      "--output", fixture.observationPath
    ], {
      now: () => new Date(OBSERVED_AT),
      writeStdout: (source) => { stdout = Buffer.from(source); }
    });
    expect(finalized).toMatchObject({
      command: "finalize",
      status: "observed",
      artifact: {
        fileName: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE
      }
    });
    expect(stdout).toEqual(serializeCanonicalJson(finalized));

    await expect(runElectronProductionUpdaterDataPreservationObserverCli([
      "prepare", "--output", fixture.beforeReceiptPath,
      "--output", fixture.beforeReceiptPath
    ])).rejects.toThrow("Duplicate");
    await expect(runElectronProductionUpdaterDataPreservationObserverCli([
      "finalize", "--fallback", "prior-attempt"
    ])).rejects.toThrow("Unknown finalize");
  });

  it("rejects malformed challenge material before creating a sentinel", async () => {
    const shortFixture = await createFixture();
    await writeFile(shortFixture.challengeNoncePath, NONCE.subarray(0, 31));
    await expect(prepareFixture(shortFixture)).rejects.toThrow("exactly 32 bytes");
    await expect(readFile(shortFixture.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });

    const wrongDigestFixture = await createFixture();
    wrongDigestFixture.challengeSha256 = "f".repeat(64);
    await expect(prepareFixture(wrongDigestFixture)).rejects.toThrow("nonce SHA-256");
    await expect(readFile(wrongDigestFixture.sentinelPath))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked or hardlinked challenge inputs and user-data symlinks", async () => {
    const hardlinkFixture = await createFixture();
    await link(
      hardlinkFixture.challengeNoncePath,
      `${hardlinkFixture.challengeNoncePath}.hardlink`
    );
    await expect(prepareFixture(hardlinkFixture)).rejects.toThrow(
      "single-link regular file"
    );

    const symlinkFixture = await createFixture();
    const nonceSymlink = path.join(symlinkFixture.root, "nonce-symlink.bin");
    await symlink(symlinkFixture.challengeNoncePath, nonceSymlink);
    symlinkFixture.challengeNoncePath = nonceSymlink;
    await expect(prepareFixture(symlinkFixture)).rejects.toThrow(
      "single-link regular file"
    );

    const directoryFixture = await createFixture();
    const directorySymlink = path.join(directoryFixture.root, "user-data-symlink");
    await symlink(directoryFixture.userDataDirectory, directorySymlink);
    directoryFixture.userDataDirectory = directorySymlink;
    directoryFixture.sentinelPath = path.join(
      directorySymlink,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE
    );
    await expect(prepareFixture(directoryFixture)).rejects.toThrow("real directory");
  });

  it("rejects unknown context fields and cross-transition attempt IDs", async () => {
    const unknownFixture = await createFixture();
    const prepared = await prepareFixture(unknownFixture);
    await rewriteContext(unknownFixture, {
      ...unknownFixture.context,
      producerApplied: false
    });
    await expect(finalizeFixture(
      unknownFixture,
      prepared.beforeIdentity.sha256
    )).rejects.toThrow("unexpected schema");
    await expect(readFile(unknownFixture.observationPath))
      .rejects.toMatchObject({ code: "ENOENT" });

    const crossTransitionFixture = await createFixture();
    const crossPrepared = await prepareFixture(crossTransitionFixture);
    await rewriteContext(crossTransitionFixture, {
      ...crossTransitionFixture.context,
      sourceInstallAttemptId: ELECTRON_SOURCE_ATTEMPT_ID
    });
    await expect(finalizeFixture(
      crossTransitionFixture,
      crossPrepared.beforeIdentity.sha256
    )).rejects.toThrow("Tauri v22 data-preservation attempt ID");
  });

  it("rejects before receipts and sentinels that are hardlinked or symlinked", async () => {
    const beforeHardlinkFixture = await createFixture();
    const beforeHardlinkPrepared = await prepareFixture(beforeHardlinkFixture);
    await link(
      beforeHardlinkFixture.beforeReceiptPath,
      `${beforeHardlinkFixture.beforeReceiptPath}.hardlink`
    );
    await expect(finalizeFixture(
      beforeHardlinkFixture,
      beforeHardlinkPrepared.beforeIdentity.sha256
    )).rejects.toThrow("single-link regular file");

    const beforeSymlinkFixture = await createFixture();
    const beforeSymlinkPrepared = await prepareFixture(beforeSymlinkFixture);
    const symlinkRoot = path.join(beforeSymlinkFixture.root, "before-symlink");
    await mkdir(symlinkRoot);
    const beforeSymlinkPath = path.join(
      symlinkRoot,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE
    );
    await symlink(beforeSymlinkFixture.beforeReceiptPath, beforeSymlinkPath);
    beforeSymlinkFixture.beforeReceiptPath = beforeSymlinkPath;
    await expect(finalizeFixture(
      beforeSymlinkFixture,
      beforeSymlinkPrepared.beforeIdentity.sha256
    )).rejects.toThrow("single-link regular file");

    const sentinelHardlinkFixture = await createFixture();
    const sentinelHardlinkPrepared = await prepareFixture(sentinelHardlinkFixture);
    await link(
      sentinelHardlinkFixture.sentinelPath,
      `${sentinelHardlinkFixture.sentinelPath}.hardlink`
    );
    await expect(finalizeFixture(
      sentinelHardlinkFixture,
      sentinelHardlinkPrepared.beforeIdentity.sha256
    )).rejects.toThrow("single-link regular file");

    const sentinelSymlinkFixture = await createFixture();
    const sentinelSymlinkPrepared = await prepareFixture(sentinelSymlinkFixture);
    const displaced = `${sentinelSymlinkFixture.sentinelPath}.displaced`;
    await rename(sentinelSymlinkFixture.sentinelPath, displaced);
    await symlink(displaced, sentinelSymlinkFixture.sentinelPath);
    await expect(finalizeFixture(
      sentinelSymlinkFixture,
      sentinelSymlinkPrepared.beforeIdentity.sha256
    )).rejects.toThrow("single-link regular file");
  });

  it("rejects byte-identical sentinel replacement and user-data directory replacement", async () => {
    const sentinelFixture = await createFixture();
    const sentinelPrepared = await prepareFixture(sentinelFixture);
    await rename(sentinelFixture.sentinelPath, `${sentinelFixture.sentinelPath}.original`);
    await writeFile(sentinelFixture.sentinelPath, NONCE);
    await expect(finalizeFixture(
      sentinelFixture,
      sentinelPrepared.beforeIdentity.sha256
    )).rejects.toThrow("sentinel inode");

    const directoryFixture = await createFixture();
    const directoryPrepared = await prepareFixture(directoryFixture);
    const displacedDirectory = `${directoryFixture.userDataDirectory}.original`;
    await rename(directoryFixture.userDataDirectory, displacedDirectory);
    await mkdir(directoryFixture.userDataDirectory);
    await writeFile(directoryFixture.sentinelPath, NONCE);
    await expect(finalizeFixture(
      directoryFixture,
      directoryPrepared.beforeIdentity.sha256
    )).rejects.toThrow("directory identity");
  });

  it("rejects both phase outputs inside user-data and preserves create-new semantics", async () => {
    const prepareFixtureValue = await createFixture();
    prepareFixtureValue.beforeReceiptPath = path.join(
      prepareFixtureValue.userDataDirectory,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE
    );
    await expect(prepareFixture(prepareFixtureValue)).rejects.toThrow(
      "must stay outside"
    );
    await expect(readFile(prepareFixtureValue.sentinelPath))
      .rejects.toMatchObject({ code: "ENOENT" });

    const finalizeFixtureValue = await createFixture();
    const prepared = await prepareFixture(finalizeFixtureValue);
    finalizeFixtureValue.observationPath = path.join(
      finalizeFixtureValue.userDataDirectory,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE
    );
    await expect(finalizeFixture(
      finalizeFixtureValue,
      prepared.beforeIdentity.sha256
    )).rejects.toThrow("must stay outside");
    expect(await readFile(finalizeFixtureValue.sentinelPath)).toEqual(NONCE);

    const createNewFixture = await createFixture();
    await prepareFixture(createNewFixture);
    await expect(prepareFixture(createNewFixture)).rejects.toThrow("create-new");
  });
});

interface Fixture {
  root: string;
  challengeNoncePath: string;
  challengeSha256: string;
  userDataDirectory: string;
  sentinelPath: string;
  beforeReceiptPath: string;
  observationPath: string;
  contextPath: string;
  context: ElectronProductionUpdaterDataPreservationContext;
  contextSha256: string;
}

async function createFixture(options: Readonly<{
  platform?: ElectronProductionUpdaterDataPreservationPlatform;
  sourceInstallAttemptId?: string;
  transitionKind?: ElectronProductionUpdaterDataPreservationTransition;
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "rion-data-preservation-observer-"));
  temporaryDirectories.push(root);
  const userDataDirectory = path.join(root, "user-data");
  const evidenceDirectory = path.join(root, "evidence");
  await Promise.all([mkdir(userDataDirectory), mkdir(evidenceDirectory)]);
  const challengeNoncePath = path.join(root, "challenge-nonce.bin");
  await writeFile(challengeNoncePath, NONCE);
  const challengeSha256 = sha256(NONCE);
  const transitionKind = options.transitionKind ?? "tauri-v22-to-electron-v23";
  const platform = options.platform ?? "darwin-aarch64";
  const context = contextValue({
    challengeSha256,
    platform,
    sourceInstallAttemptId: options.sourceInstallAttemptId ?? (
      transitionKind === "tauri-v22-to-electron-v23"
        ? "update-install-7"
        : ELECTRON_SOURCE_ATTEMPT_ID
    ),
    transitionKind
  });
  const contextPath = path.join(root, "data-preservation-context.json");
  const contextSource = serializeCanonicalJson(context);
  await writeFile(contextPath, contextSource);
  return {
    root,
    challengeNoncePath,
    challengeSha256,
    userDataDirectory,
    sentinelPath: path.join(
      userDataDirectory,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE
    ),
    beforeReceiptPath: path.join(
      evidenceDirectory,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE
    ),
    observationPath: path.join(
      evidenceDirectory,
      ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE
    ),
    contextPath,
    context,
    contextSha256: sha256(contextSource)
  };
}

async function prepareFixture(fixture: Fixture) {
  return prepareElectronProductionUpdaterDataPreservation({
    beforeReceiptPath: fixture.beforeReceiptPath,
    challengeNoncePath: fixture.challengeNoncePath,
    expectedChallengeSha256: fixture.challengeSha256,
    userDataDirectory: fixture.userDataDirectory
  });
}

async function finalizeFixture(fixture: Fixture, beforeSha256: string) {
  return finalizeElectronProductionUpdaterDataPreservation({
    beforeReceiptPath: fixture.beforeReceiptPath,
    contextPath: fixture.contextPath,
    expectedBeforeReceiptSha256: beforeSha256,
    expectedContextSha256: fixture.contextSha256,
    observationPath: fixture.observationPath,
    userDataDirectory: fixture.userDataDirectory
  }, { now: () => new Date(OBSERVED_AT) });
}

async function rewriteContext(fixture: Fixture, value: unknown) {
  const source = serializeCanonicalJson(value);
  await writeFile(fixture.contextPath, source);
  fixture.contextSha256 = sha256(source);
}

function contextValue(input: Readonly<{
  challengeSha256: string;
  platform: ElectronProductionUpdaterDataPreservationPlatform;
  sourceInstallAttemptId: string;
  transitionKind: ElectronProductionUpdaterDataPreservationTransition;
}>): ElectronProductionUpdaterDataPreservationContext {
  const isMac = input.platform === "darwin-aarch64";
  const artifactName = isMac
    ? "Rion.Studio-mac.app.tar.gz"
    : "Rion.Studio-win.exe";
  return {
    challenge: {
      expiresAt: "2026-09-02T12:00:00Z",
      id: CHALLENGE_ID,
      issuedAt: "2026-09-02T00:00:00Z",
      nonceSha256: input.challengeSha256
    },
    evidenceAttemptId: EVIDENCE_ATTEMPT_ID,
    platform: input.platform,
    transitionKind: input.transitionKind,
    sourceInstallAttemptId: input.sourceInstallAttemptId,
    target: {
      artifactName,
      artifactSha256: sha256(`${input.platform}:artifact`),
      candidateReceiptSha256: sha256("candidate-receipt"),
      embeddedUpdaterEndpoint: "https://updates.example.test/rion/latest.json",
      manifestName: "latest.json",
      runtime: "electron-v23",
      servedManifestSha256: sha256("served-manifest"),
      signatureName: `${artifactName}.sig`,
      signatureSha256: sha256(`${input.platform}:signature`),
      sourceSha: "a".repeat(40),
      version: "8.6.0"
    }
  };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
