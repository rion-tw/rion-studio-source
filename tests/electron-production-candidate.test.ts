import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assembleElectronProductionCandidate,
  createMacosPackageBindingEvidence,
  ELECTRON_CANDIDATE_RECEIPT_NAME,
  ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
  ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
  ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
  ELECTRON_PRODUCTION_ENVIRONMENT,
  normalizeUpdaterPublicKey,
  stageElectronProductionPlatformCandidate,
  validateElectronProductionCandidateInputs,
  verifyPackagedBlackBoxReport,
  verifyMinisignArtifact
} from "../scripts/electronProductionCandidate.mjs";
import { verifyElectronProductionCandidateBundle } from
  "../scripts/electronProductionCandidateVerifier.mjs";
import {
  assertCandidateAssetDigestsMatchPlatformReceipts,
  assertCopiedPlatformAssetsMatchReceipts
} from "../scripts/electronProductionCandidateAssetBinding.mjs";
import {
  serializePackagedElectronBlackBoxReport,
  type PackagedElectronBlackBoxReport
} from "../scripts/packagedElectronBlackBoxReportContract.mjs";
import {
  capturePackagedElectronPackageManifest,
  createPortablePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest
} from "../scripts/packagedElectronPackageManifest.mjs";
import { serializeElectronProductionPlatformReceipt } from
  "../scripts/electronProductionPlatformReceiptContract.mjs";
import {
  buildWindowsElectronInstallerPayloadProof,
  captureStableRegularFileArtifact
} from "../scripts/windowsElectronInstallerPayloadProof.mjs";
import {
  serializeWindowsElectronInstallerPayloadProof,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
  WINDOWS_ELECTRON_UNINSTALLER_PATH,
  type WindowsElectronInstallerPayloadProof
} from "../scripts/windowsElectronInstallerPayloadProofContract.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "23.4.5";
const PUBLISHED_AT = "2026-08-31T10:30:00Z";
const UPDATER_BASE_URL = "https://updates.example.test/rion/v23";
const PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIGNATURE = [
  "untrusted comment: signature from minisign secret key",
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
  "trusted comment: timestamp:1633700835\tfile:test\tprehashed",
  "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==",
  ""
].join("\n");
const SCREENSHOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production candidate trust", () => {
  it("rejects copied assets that diverge from their verified platform receipts", async () => {
    const outputDirectory = await temporaryDirectory();
    const macReceipt = {
      artifact: candidateArtifactIdentity(
        "Rion.Studio-mac.app.tar.gz",
        "mac-artifact",
        "mac-signature"
      ),
      distribution: candidateFileIdentity("Rion.Studio-mac.dmg", "mac-distribution")
    };
    const windowsReceipt = {
      artifact: candidateArtifactIdentity(
        "Rion.Studio-win.exe",
        "windows-artifact",
        "windows-signature"
      )
    };
    await Promise.all([
      writeFile(join(outputDirectory, macReceipt.artifact.fileName), "mac-artifact"),
      writeFile(join(outputDirectory, macReceipt.artifact.signatureFileName), "mac-signature"),
      writeFile(join(outputDirectory, macReceipt.distribution.fileName), "mac-distribution"),
      writeFile(join(outputDirectory, windowsReceipt.artifact.fileName), "swapped-artifact"),
      writeFile(
        join(outputDirectory, windowsReceipt.artifact.signatureFileName),
        "windows-signature"
      )
    ]);

    await expect(assertCopiedPlatformAssetsMatchReceipts(
      outputDirectory,
      macReceipt,
      windowsReceipt
    )).rejects.toThrow(
      "windows-x86_64 copied updater artifact does not match its verified platform receipt"
    );

    await writeFile(
      join(outputDirectory, windowsReceipt.artifact.fileName),
      "windows-artifact"
    );
    await expect(assertCopiedPlatformAssetsMatchReceipts(
      outputDirectory,
      macReceipt,
      windowsReceipt
    )).resolves.toBeUndefined();

    const extraLink = join(outputDirectory, "linked-windows-artifact");
    await link(join(outputDirectory, windowsReceipt.artifact.fileName), extraLink);
    await expect(assertCopiedPlatformAssetsMatchReceipts(
      outputDirectory,
      macReceipt,
      windowsReceipt
    )).rejects.toThrow("exclusively linked regular file");
    await unlink(extraLink);

    expect(() => assertCandidateAssetDigestsMatchPlatformReceipts({
      [macReceipt.artifact.fileName]: macReceipt.artifact.sha256,
      [macReceipt.artifact.signatureFileName]: macReceipt.artifact.signatureSha256,
      [macReceipt.distribution.fileName]: "0".repeat(64),
      [windowsReceipt.artifact.fileName]: windowsReceipt.artifact.sha256,
      [windowsReceipt.artifact.signatureFileName]:
        windowsReceipt.artifact.signatureSha256
    }, macReceipt, windowsReceipt)).toThrow(
      "Rion.Studio-mac.dmg does not match its verified platform receipt"
    );
  });

  it("keeps the version-one black-box report byte encoding stable", () => {
    const report = {
      schemaVersion: 1,
      kind: "rion-packaged-electron-black-box-smoke",
      verdict: "passed",
      appVersion: "23.4.5",
      application: { path: "/Applications/Rion Studio.app" },
      executable: { path: "/Applications/Rion Studio.app/Rion", sha256: "1".repeat(64) },
      appAsar: { path: "/Applications/Rion Studio.app/app.asar", sha256: "2".repeat(64) },
      nativeAddon: { path: "/Applications/Rion Studio.app/rion-core.node", sha256: "3".repeat(64) },
      exitCode: 0,
      fixtureInteraction: "visible-os-accessibility-click",
      gameId: "10000000-0000-4000-8000-000000000001",
      isolationKind: "fixed-macos-home",
      nativeHostKind: "appkit-chromium",
      packageManifest: {
        directoryCount: 1,
        entryCount: 3,
        regularFileBytes: 42,
        regularFileCount: 1,
        schemaVersion: 1,
        sha256: "4".repeat(64),
        symlinkCount: 1
      },
      platform: "darwin",
      remoteDebugging: false,
      roleId: "10000000-0000-4000-8000-000000000002",
      runtimeHomeDirectory: "/private/tmp/rion-home",
      runtimeTarget: "chromium-v23-macos-appkit",
      screenshot: {
        byteLength: 1234,
        path: "/private/tmp/packaged-role-native-host.png",
        sha256: "5".repeat(64)
      },
      userDataDirectory: "/private/tmp/rion-home/Rion Studio"
    } satisfies PackagedElectronBlackBoxReport;

    const source = serializePackagedElectronBlackBoxReport(report);
    expect(source.at(-1)).toBe(10);
    expect(sha256(source)).toBe(
      "f4383929984532a0b905f10a2f566530c56c75c295ab65f8339ffdee4e18cea3"
    );
  });

  it("normalizes exact owner inputs and derives the direct manifest endpoint", () => {
    const keyDocument = `untrusted comment: production key\n${PUBLIC_KEY}`;
    const outerEncodedKey = Buffer.from(keyDocument, "utf8").toString("base64");
    const validated = validateElectronProductionCandidateInputs({
      ...candidateInput(),
      publicKey: outerEncodedKey
    });

    expect(validated).toEqual({
      baseUrl: "https://updates.example.test/rion/v23/",
      publicKeySha256: normalizeUpdaterPublicKey(PUBLIC_KEY).sha256,
      publishedAt: PUBLISHED_AT,
      sourceSha: SOURCE_SHA,
      updaterEndpoint: "https://updates.example.test/rion/v23/latest.json",
      version: VERSION
    });
    expect(() => validateElectronProductionCandidateInputs({
      ...candidateInput(),
      ownerApproval: "yes"
    })).toThrow("Owner approval");
    expect(() => validateElectronProductionCandidateInputs({
      ...candidateInput(),
      sourceSha: SOURCE_SHA.toUpperCase()
    })).toThrow("40 lowercase");
    expect(() => validateElectronProductionCandidateInputs({
      ...candidateInput(),
      updaterBaseUrl: `${UPDATER_BASE_URL}?channel=latest`
    })).toThrow("public HTTPS");
    expect(validateElectronProductionCandidateInputs({
      ...candidateInput(),
      publishedAt: "2024-02-29T23:59:59.123+14:00"
    }).publishedAt).toBe("2024-02-29T23:59:59.123+14:00");
    for (const publishedAt of [
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00+08:60"
    ]) {
      expect(() => validateElectronProductionCandidateInputs({
        ...candidateInput(),
        publishedAt
      })).toThrow("RFC 3339");
    }
  });

  it("accepts only the supported strict semantic-version range", () => {
    expect(validateElectronProductionCandidateInputs({
      ...candidateInput(),
      version: "0.0.0-alpha.1"
    }).version).toBe("0.0.0-alpha.1");

    for (const version of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
      "1.2.3-alpha..1",
      "1.2.3-alpha.",
      "1.2.3+build.1"
    ]) {
      expect(() => validateElectronProductionCandidateInputs({
        ...candidateInput(),
        version
      })).toThrow("semantic without a leading v");
    }
  });

  it("cryptographically verifies prehashed Minisign payload and trusted-comment signatures", async () => {
    const directory = await temporaryDirectory();
    const artifactPath = join(directory, "artifact");
    const signaturePath = `${artifactPath}.sig`;
    await Promise.all([
      writeFile(artifactPath, "test"),
      writeFile(signaturePath, SIGNATURE)
    ]);

    await expect(verifyMinisignArtifact(
      artifactPath,
      signaturePath,
      PUBLIC_KEY
    )).resolves.toMatchObject({
      artifactBytes: 4,
      artifactSha256: sha256("test"),
      publicKeySha256: normalizeUpdaterPublicKey(PUBLIC_KEY).sha256
    });

    await writeFile(artifactPath, "Test");
    await expect(verifyMinisignArtifact(
      artifactPath,
      signaturePath,
      PUBLIC_KEY
    )).rejects.toThrow("signature is invalid");
    await writeFile(artifactPath, "test");
    const wrongKey = Buffer.from(PUBLIC_KEY, "base64");
    wrongKey[2] ^= 1;
    await expect(verifyMinisignArtifact(
      artifactPath,
      signaturePath,
      wrongKey.toString("base64")
    )).rejects.toThrow("key ID does not match");
  });

  it("verifies signatures emitted by the pinned Tauri signer", async () => {
    const directory = await temporaryDirectory();
    const artifactPath = join(directory, "artifact.bin");
    const privateKeyPath = join(directory, "updater.key");
    const password = "candidate-test-password";
    await writeFile(artifactPath, "production-candidate-fixture");
    runTauriSigner([
      "generate",
      "--ci",
      "--password", password,
      "--write-keys", privateKeyPath
    ]);
    runTauriSigner(["sign", artifactPath], {
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      TAURI_SIGNING_PRIVATE_KEY_PATH: privateKeyPath
    });
    const publicKeyFile = await readFile(`${privateKeyPath}.pub`, "utf8");

    await expect(verifyMinisignArtifact(
      artifactPath,
      `${artifactPath}.sig`,
      publicKeyFile
    )).resolves.toMatchObject({
      artifactBytes: 28,
      artifactSha256: sha256("production-candidate-fixture")
    });
  });

  it("fails closed unless the packaged black-box report binds the exact package", async () => {
    const root = await temporaryDirectory();
    const fixture = await writeBlackBoxFixture(root, "darwin-aarch64");

    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).resolves.toMatchObject({
      evidence: {
        appVersion: VERSION,
        isolationKind: "fixed-macos-home",
        nativeHostKind: "appkit-chromium",
        remoteDebugging: false,
        runtimeTarget: "chromium-v23-macos-appkit",
        screenshot: {
          bytes: SCREENSHOT_PNG.length,
          fileName: ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
          sha256: sha256(SCREENSHOT_PNG)
        },
        verdict: "passed"
      }
    });

    const reportHardLinkPath = join(root, "packaged-smoke-report-hard-link.json");
    await link(fixture.reportPath, reportHardLinkPath);
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("exclusively linked regular file");
    await unlink(reportHardLinkPath);

    await writeCanonicalBlackBoxReportSource(fixture.reportPath, JSON.stringify({
      ...fixture.report,
      verdict: "failed"
    }));
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("verdict does not match");

    await writeCanonicalBlackBoxReportSource(fixture.reportPath, JSON.stringify({
      ...fixture.report,
      isolationKind: "temporary-local-windows-user-profile-v1"
    }));
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("profile isolation kind does not match");

    await writeCanonicalBlackBoxReportSource(fixture.reportPath, JSON.stringify({
      ...fixture.report,
      screenshot: {
        ...fixture.report.screenshot,
        path: join(root, "not-the-report-sibling.png")
      }
    }));
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("screenshot is not the exact report sibling");

    await writeFile(
      fixture.reportPath,
      `${JSON.stringify({ ...fixture.report, unexpected: true }, null, 2)}\n`
    );
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("unexpected schema");

    await writeFile(
      fixture.reportPath,
      `${JSON.stringify({
        ...fixture.report,
        screenshot: {
          ...fixture.report.screenshot,
          unexpected: true
        }
      }, null, 2)}\n`
    );
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("screenshot has an unexpected schema");

    const canonicalReport = serializePackagedElectronBlackBoxReport(
      fixture.report
    ).toString("utf8");
    const duplicateKeyReport = canonicalReport.replace(
      '  "verdict": "passed",',
      '  "verdict": "passed",\n  "verdict": "passed",'
    );
    expect(duplicateKeyReport).not.toBe(canonicalReport);
    await writeFile(fixture.reportPath, duplicateKeyReport);
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("not canonical JSON");

    const screenshotShaLine =
      `    "sha256": "${fixture.report.screenshot.sha256}"`;
    const duplicateNestedKeyReport = canonicalReport.replace(
      screenshotShaLine,
      `${screenshotShaLine},\n${screenshotShaLine}`
    );
    expect(duplicateNestedKeyReport).not.toBe(canonicalReport);
    await writeFile(fixture.reportPath, duplicateNestedKeyReport);
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("not canonical JSON");

    await writeCanonicalBlackBoxReportSource(fixture.reportPath, JSON.stringify({
      ...fixture.report,
      screenshot: {
        ...fixture.report.screenshot,
        sha256: "0".repeat(64)
      }
    }));
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("screenshot does not match its report");

    await writeCanonicalBlackBoxReportSource(
      fixture.reportPath,
      JSON.stringify(fixture.report)
    );
    await writeFile(
      fixture.screenshotPath,
      Buffer.concat([SCREENSHOT_PNG, Buffer.from([0])])
    );
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("invalid PNG terminator");

    await writeFile(fixture.screenshotPath, SCREENSHOT_PNG);
    await writeCanonicalBlackBoxReportSource(
      fixture.reportPath,
      JSON.stringify(fixture.report)
    );
    await writeCanonicalBlackBoxReportSource(fixture.reportPath, JSON.stringify({
      ...fixture.report,
      packageManifest: {
        ...fixture.report.packageManifest,
        sha256: "0".repeat(64)
      }
    }));
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("package manifest does not match");

    await writeCanonicalBlackBoxReportSource(
      fixture.reportPath,
      JSON.stringify(fixture.report)
    );
    const unexpectedPackageFile = join(fixture.applicationPath, "unexpected.bin");
    await writeFile(unexpectedPackageFile, "unexpected package content");
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("package manifest does not match");
    await rm(unexpectedPackageFile);

    await writeFile(fixture.nativeAddonPath, "tampered-native-addon");
    await expect(verifyPackagedBlackBoxReport({
      applicationPath: fixture.applicationPath,
      platform: fixture.platform,
      reportPath: fixture.reportPath,
      version: VERSION
    })).rejects.toThrow("native addon SHA-256 does not match");
  });

  it("requires a Windows installer payload proof and refuses one for macOS", async () => {
    const root = await temporaryDirectory();
    const windowsSource = join(root, "proof-required-windows-source");
    const macSource = join(root, "proof-refused-mac-source");
    await Promise.all([mkdir(windowsSource), mkdir(macSource)]);
    const windowsArtifact = join(windowsSource, "Rion.Studio-win.exe");
    const macArtifact = join(macSource, "Rion.Studio-mac.app.tar.gz");
    const macDmg = join(macSource, "Rion.Studio-mac.dmg");
    const [windowsBlackBox, macBlackBox] = await Promise.all([
      writeBlackBoxFixture(root, "windows-x86_64", "proof-required-windows"),
      writeBlackBoxFixture(root, "darwin-aarch64", "proof-refused-mac")
    ]);
    await Promise.all([
      writeFile(windowsArtifact, "test"),
      writeFile(`${windowsArtifact}.sig`, SIGNATURE),
      writeFile(macArtifact, "test"),
      writeFile(`${macArtifact}.sig`, SIGNATURE),
      writeFile(macDmg, "mac-dmg")
    ]);
    const windowsPayloadProof = await writeWindowsInstallerPayloadProofFixture({
      applicationPath: windowsBlackBox.applicationPath,
      installerPath: windowsArtifact,
      outputDirectory: windowsSource
    });

    await expect(stageElectronProductionPlatformCandidate({
      ...candidateInput(),
      applicationPath: windowsBlackBox.applicationPath,
      artifactPath: windowsArtifact,
      blackBoxReportPath: windowsBlackBox.reportPath,
      outputDirectory: join(root, "missing-proof-candidate"),
      platform: "windows-x86_64"
    })).rejects.toThrow("Windows installer payload proof path is required");

    await expect(stageElectronProductionPlatformCandidate({
      ...candidateInput(),
      applicationPath: macBlackBox.applicationPath,
      artifactPath: macArtifact,
      blackBoxReportPath: macBlackBox.reportPath,
      distributionPath: macDmg,
      outputDirectory: join(root, "mac-with-windows-proof-candidate"),
      platform: "darwin-aarch64",
      windowsInstallerPayloadProofPath: windowsPayloadProof.path
    })).rejects.toThrow("macOS candidate must not provide a Windows installer payload proof");
  });

  it("requires a macOS package binding for the signed tar, mounted DMG, and black-box package", async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, "macos-binding-source");
    await mkdir(sourceDirectory);
    const artifactPath = join(sourceDirectory, "Rion.Studio-mac.app.tar.gz");
    const distributionPath = join(sourceDirectory, "Rion.Studio-mac.dmg");
    const blackBox = await writeBlackBoxFixture(
      root,
      "darwin-aarch64",
      "macos-binding-black-box"
    );
    await Promise.all([
      writeFile(artifactPath, "test"),
      writeFile(`${artifactPath}.sig`, SIGNATURE),
      writeFile(distributionPath, "mac-dmg")
    ]);
    const stageInput = {
      ...candidateInput(),
      applicationPath: blackBox.applicationPath,
      artifactPath,
      blackBoxReportPath: blackBox.reportPath,
      distributionPath,
      platform: "darwin-aarch64" as const
    };

    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      outputDirectory: join(root, "missing-macos-binding")
    })).rejects.toThrow("macOS package binding is required");

    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      macosPackageBinding: createMacosPackageBindingFixture(
        blackBox.report.packageManifest,
        "swapped-tar",
        "mac-dmg"
      ),
      outputDirectory: join(root, "swapped-tar-binding")
    })).rejects.toThrow("package binding updater archive does not match the signed artifact");

    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      macosPackageBinding: createMacosPackageBindingFixture(
        blackBox.report.packageManifest,
        "test",
        "swapped-dmg"
      ),
      outputDirectory: join(root, "swapped-dmg-binding")
    })).rejects.toThrow("package binding distribution does not match the staged DMG");

    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      macosPackageBinding: createMacosPackageBindingFixture(
        {
          ...blackBox.report.packageManifest,
          sha256: "0".repeat(64)
        },
        "test",
        "mac-dmg"
      ),
      outputDirectory: join(root, "cross-package-binding")
    })).rejects.toThrow("package binding manifest does not match the black-box package");
  });

  it("rejects noncanonical proof bytes and cross-binds the exact installer and source", async () => {
    const root = await temporaryDirectory();
    const windowsSource = join(root, "proof-binding-source");
    await mkdir(windowsSource);
    const windowsArtifact = join(windowsSource, "Rion.Studio-win.exe");
    const windowsBlackBox = await writeBlackBoxFixture(
      root,
      "windows-x86_64",
      "proof-binding-black-box"
    );
    await Promise.all([
      writeFile(windowsArtifact, "test"),
      writeFile(`${windowsArtifact}.sig`, SIGNATURE)
    ]);
    const windowsPayloadProof = await writeWindowsInstallerPayloadProofFixture({
      applicationPath: windowsBlackBox.applicationPath,
      installerPath: windowsArtifact,
      outputDirectory: windowsSource
    });
    const stageInput = {
      ...candidateInput(),
      applicationPath: windowsBlackBox.applicationPath,
      artifactPath: windowsArtifact,
      blackBoxReportPath: windowsBlackBox.reportPath,
      platform: "windows-x86_64" as const,
      windowsInstallerPayloadProofPath: windowsPayloadProof.path
    };

    await writeFile(
      windowsPayloadProof.path,
      Buffer.concat([windowsPayloadProof.source, Buffer.from("\n")])
    );
    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      outputDirectory: join(root, "noncanonical-proof-candidate")
    })).rejects.toThrow("Windows installer payload proof is not canonical JSON");

    await writeFile(windowsPayloadProof.path, windowsPayloadProof.source);
    await writeFile(windowsArtifact, "tampered-installer");
    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      outputDirectory: join(root, "tampered-installer-candidate")
    })).rejects.toThrow("proof does not match the current installer");

    await writeFile(windowsArtifact, "test");
    await writeFile(
      windowsPayloadProof.path,
      serializeWindowsElectronInstallerPayloadProof({
        ...windowsPayloadProof.proof,
        sourceSha: "b".repeat(40)
      })
    );
    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      outputDirectory: join(root, "cross-source-sha-candidate")
    })).rejects.toThrow("proof source SHA does not match");

    const alternateApplication = await writeBlackBoxFixture(
      root,
      "windows-x86_64",
      "proof-from-other-application"
    );
    await writeFile(alternateApplication.nativeAddonPath, "other-native-addon");
    const alternateProofDirectory = join(root, "proof-from-other-application-source");
    await mkdir(alternateProofDirectory);
    const alternatePayloadProof = await writeWindowsInstallerPayloadProofFixture({
      applicationPath: alternateApplication.applicationPath,
      installerPath: windowsArtifact,
      outputDirectory: alternateProofDirectory
    });
    await expect(stageElectronProductionPlatformCandidate({
      ...stageInput,
      outputDirectory: join(root, "cross-package-candidate"),
      windowsInstallerPayloadProofPath: alternatePayloadProof.path
    })).rejects.toThrow("source package does not match the current application");
  });

  it("assembles only matching macOS and Windows receipts into immutable signed assets", async () => {
    const root = await temporaryDirectory();
    const macSource = join(root, "mac-source");
    const windowsSource = join(root, "windows-source");
    const macCandidate = join(root, "mac-candidate");
    const windowsCandidate = join(root, "windows-candidate");
    const candidate = join(root, "candidate");
    const receiptPath = join(root, ELECTRON_CANDIDATE_RECEIPT_NAME);
    await Promise.all([mkdir(macSource), mkdir(windowsSource)]);
    const macArtifact = join(macSource, "Rion.Studio-mac.app.tar.gz");
    const windowsArtifact = join(windowsSource, "Rion.Studio-win.exe");
    const macDmg = join(macSource, "Rion.Studio-mac.dmg");
    const [macBlackBox, windowsBlackBox] = await Promise.all([
      writeBlackBoxFixture(root, "darwin-aarch64"),
      writeBlackBoxFixture(root, "windows-x86_64")
    ]);
    await Promise.all([
      writeFile(macArtifact, "test"),
      writeFile(`${macArtifact}.sig`, SIGNATURE),
      writeFile(macDmg, "mac-dmg"),
      writeFile(windowsArtifact, "test"),
      writeFile(`${windowsArtifact}.sig`, SIGNATURE)
    ]);
    const windowsPayloadProof = await writeWindowsInstallerPayloadProofFixture({
      applicationPath: windowsBlackBox.applicationPath,
      installerPath: windowsArtifact,
      outputDirectory: windowsSource
    });
    const macosPackageBinding = createMacosPackageBindingFixture(
      macBlackBox.report.packageManifest,
      "test",
      "mac-dmg"
    );
    await Promise.all([
      stageElectronProductionPlatformCandidate({
        ...candidateInput(),
        applicationPath: macBlackBox.applicationPath,
        artifactPath: macArtifact,
        blackBoxReportPath: macBlackBox.reportPath,
        distributionPath: macDmg,
        macosPackageBinding,
        outputDirectory: macCandidate,
        platform: "darwin-aarch64"
      }),
      stageElectronProductionPlatformCandidate({
        ...candidateInput(),
        applicationPath: windowsBlackBox.applicationPath,
        artifactPath: windowsArtifact,
        blackBoxReportPath: windowsBlackBox.reportPath,
        outputDirectory: windowsCandidate,
        platform: "windows-x86_64",
        windowsInstallerPayloadProofPath: windowsPayloadProof.path
      })
    ]);

    const receipt = await assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: candidate,
      receiptPath,
      windowsDirectory: windowsCandidate
    });
    const manifest = JSON.parse(await readFile(join(candidate, "latest.json"), "utf8"));
    const checksums = await readFile(join(candidate, "SHA256SUMS.txt"), "utf8");

    expect(receipt).toMatchObject({
      compatibility: {
        stableTauriReleasePath: "preserved",
        tauriV22CutoverEvidence: "separate-required-gate"
      },
      ownerGate: {
        approval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
        environment: ELECTRON_PRODUCTION_ENVIRONMENT
      },
      publication: {
        allowedByThisWorkflow: false,
        status: "candidate-only"
      },
      publicKeySha256: normalizeUpdaterPublicKey(PUBLIC_KEY).sha256,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      platforms: {
        "darwin-aarch64": {
          blackBox: {
            nativeHostKind: "appkit-chromium",
            remoteDebugging: false,
            screenshot: {
              bytes: SCREENSHOT_PNG.length,
              fileName: ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
              sha256: sha256(SCREENSHOT_PNG)
            },
            verdict: "passed"
          },
          macosPackageBinding: {
            applicationBundle: "Rion Studio.app",
            artifact: {
              bytes: 4,
              fileName: "Rion.Studio-mac.app.tar.gz",
              sha256: sha256("test")
            },
            distribution: {
              bytes: Buffer.byteLength("mac-dmg"),
              fileName: "Rion.Studio-mac.dmg",
              sha256: sha256("mac-dmg")
            },
            kind: "rion-electron-macos-package-binding",
            verificationKind: "safe-tar-extraction-and-read-only-dmg-mount-v2"
          }
        },
        "windows-x86_64": {
          blackBox: {
            nativeHostKind: "bundled-chromium",
            remoteDebugging: false,
            screenshot: {
              bytes: SCREENSHOT_PNG.length,
              fileName: ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
              sha256: sha256(SCREENSHOT_PNG)
            },
            verdict: "passed"
          },
          windowsInstallerPayloadProof: {
            bytes: windowsPayloadProof.source.length,
            fileName: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
            sha256: sha256(windowsPayloadProof.source)
          }
        }
      }
    });
    expect(manifest.platforms["darwin-aarch64"]).toMatchObject({
      sha256: sha256("test"),
      url: "https://updates.example.test/rion/v23/Rion.Studio-mac.app.tar.gz"
    });
    expect(manifest.platforms["windows-x86_64"]).toMatchObject({
      sha256: sha256("test"),
      url: "https://updates.example.test/rion/v23/Rion.Studio-win.exe"
    });
    expect(checksums).toContain(`${sha256("test")}  Rion.Studio-win.exe`);
    expect(await readFile(receiptPath, "utf8")).toContain("verified-not-published");
    expect(await readFile(
      join(macCandidate, ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME),
      "utf8"
    )).toContain("rion-packaged-electron-black-box-smoke");

    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).resolves.toMatchObject({
      receiptSha256: sha256(await readFile(receiptPath)),
      sourceSha: SOURCE_SHA,
      version: VERSION
    });

    const candidateReceiptSource = await readFile(receiptPath, "utf8");
    const candidateReceipt = JSON.parse(candidateReceiptSource);
    expect(candidateReceipt.assets["Rion.Studio-mac.app.tar.gz"]).toBe(
      candidateReceipt.platforms["darwin-aarch64"].artifact.sha256
    );
    expect(candidateReceipt.assets["Rion.Studio-mac.app.tar.gz.sig"]).toBe(
      candidateReceipt.platforms["darwin-aarch64"].artifact.signatureSha256
    );
    expect(candidateReceipt.assets["Rion.Studio-mac.dmg"]).toBe(
      candidateReceipt.platforms["darwin-aarch64"].distribution.sha256
    );
    expect(candidateReceipt.assets["Rion.Studio-win.exe"]).toBe(
      candidateReceipt.platforms["windows-x86_64"].artifact.sha256
    );
    expect(candidateReceipt.assets["Rion.Studio-win.exe.sig"]).toBe(
      candidateReceipt.platforms["windows-x86_64"].artifact.signatureSha256
    );

    await writeFile(receiptPath, `${JSON.stringify({
      ...candidateReceipt,
      platforms: {
        ...candidateReceipt.platforms,
        "darwin-aarch64": {
          ...candidateReceipt.platforms["darwin-aarch64"],
          artifact: {
            ...candidateReceipt.platforms["darwin-aarch64"].artifact,
            sha256: "0".repeat(64)
          }
        }
      }
    }, null, 2)}\n`);
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("darwin-aarch64 macOS package binding does not match its updater archive");
    await writeFile(receiptPath, candidateReceiptSource);

    const macPlatformReceiptPath = join(macCandidate, "platform-receipt.json");
    const macPlatformReceiptSource = await readFile(macPlatformReceiptPath, "utf8");
    const macPlatformReceipt = JSON.parse(macPlatformReceiptSource);
    await writeFile(macPlatformReceiptPath, serializeElectronProductionPlatformReceipt({
      ...macPlatformReceipt,
      artifact: {
        ...macPlatformReceipt.artifact,
        unexpected: true
      }
    }));
    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: join(root, "nested-artifact-schema-candidate"),
      receiptPath: join(root, "nested-artifact-schema-receipt.json"),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("platform receipt artifact has an unexpected schema");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    await writeFile(macPlatformReceiptPath, serializeElectronProductionPlatformReceipt({
      ...macPlatformReceipt,
      distribution: {
        ...macPlatformReceipt.distribution,
        unexpected: true
      }
    }));
    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: join(root, "nested-distribution-schema-candidate"),
      receiptPath: join(root, "nested-distribution-schema-receipt.json"),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("platform receipt distribution has an unexpected schema");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    await writeFile(macPlatformReceiptPath, serializeElectronProductionPlatformReceipt({
      ...macPlatformReceipt,
      macosPackageBinding: {
        ...macPlatformReceipt.macosPackageBinding,
        artifact: {
          ...macPlatformReceipt.macosPackageBinding.artifact,
          sha256: "0".repeat(64)
        }
      }
    }));
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("macOS package binding");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    const stagedWindowsProofPath = join(
      windowsCandidate,
      WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
    );
    expect(await readFile(stagedWindowsProofPath)).toEqual(windowsPayloadProof.source);
    const windowsPlatformReceiptPath = join(
      windowsCandidate,
      "platform-receipt.json"
    );
    const windowsPlatformReceiptSource = await readFile(
      windowsPlatformReceiptPath,
      "utf8"
    );
    const windowsPlatformReceipt = JSON.parse(windowsPlatformReceiptSource);
    await writeFile(
      windowsPlatformReceiptPath,
      serializeElectronProductionPlatformReceipt({
        ...windowsPlatformReceipt,
        windowsInstallerPayloadProof: {
          ...windowsPlatformReceipt.windowsInstallerPayloadProof,
          sha256: "0".repeat(64)
        }
      })
    );
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("installer payload proof identity does not match its proof");
    await writeFile(windowsPlatformReceiptPath, windowsPlatformReceiptSource);

    await unlink(stagedWindowsProofPath);
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("windows-x86_64 platform candidate inventory must be exactly");
    await writeFile(stagedWindowsProofPath, windowsPayloadProof.source);

    const stagedMacScreenshotPath = join(
      macCandidate,
      ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME
    );
    expect(await readFile(stagedMacScreenshotPath)).toEqual(SCREENSHOT_PNG);
    await writeFile(
      stagedMacScreenshotPath,
      Buffer.concat([SCREENSHOT_PNG, Buffer.from([0])])
    );
    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: join(root, "screenshot-tampered-candidate"),
      receiptPath: join(root, "screenshot-tampered-receipt.json"),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("invalid PNG terminator");
    await writeFile(stagedMacScreenshotPath, SCREENSHOT_PNG);

    await writeFile(macPlatformReceiptPath, serializeElectronProductionPlatformReceipt({
      ...macPlatformReceipt,
      blackBox: {
        ...macPlatformReceipt.blackBox,
        screenshot: {
          ...macPlatformReceipt.blackBox.screenshot,
          sha256: "0".repeat(64)
        }
      }
    }));
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("black-box evidence does not match its report");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    await writeFile(macPlatformReceiptPath, JSON.stringify({
      ...macPlatformReceipt,
      unexpected: true
    }));
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("platform receipt has an unexpected schema");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    const duplicatePlatformReceipt = macPlatformReceiptSource.replace(
      '  "status": "verified-not-published",',
      '  "status": "verified-not-published",\n' +
      '  "status": "verified-not-published",'
    );
    expect(duplicatePlatformReceipt).not.toBe(macPlatformReceiptSource);
    await writeFile(macPlatformReceiptPath, duplicatePlatformReceipt);
    await expect(verifyElectronProductionCandidateBundle({
      candidateDirectory: candidate,
      candidateReceiptPath: receiptPath,
      candidateReceiptSha256: sha256(await readFile(receiptPath)),
      macDirectory: macCandidate,
      publicKey: PUBLIC_KEY,
      sourceSha: SOURCE_SHA,
      version: VERSION,
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("platform receipt is not canonical JSON");
    await writeFile(macPlatformReceiptPath, macPlatformReceiptSource);

    const nestedCandidate = join(root, "nested-candidate");
    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: nestedCandidate,
      receiptPath: join(nestedCandidate, "receipts", ELECTRON_CANDIDATE_RECEIPT_NAME),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("must remain outside the immutable release asset directory");

    const stagedMacReportPath = join(
      macCandidate,
      ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME
    );
    await writeFile(
      stagedMacReportPath,
      `${await readFile(stagedMacReportPath, "utf8")}\n`
    );
    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: join(root, "tampered-candidate"),
      receiptPath: join(root, "tampered-receipt.json"),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("black-box report is not canonical JSON");
  });

  it("rejects a platform receipt from a different exact source", async () => {
    const root = await temporaryDirectory();
    const macSource = join(root, "mac-source");
    const windowsSource = join(root, "windows-source");
    const macCandidate = join(root, "mac-candidate");
    const windowsCandidate = join(root, "windows-candidate");
    await Promise.all([mkdir(macSource), mkdir(windowsSource)]);
    const macArtifact = join(macSource, "Rion.Studio-mac.app.tar.gz");
    const windowsArtifact = join(windowsSource, "Rion.Studio-win.exe");
    const macDmg = join(macSource, "Rion.Studio-mac.dmg");
    const [macBlackBox, windowsBlackBox] = await Promise.all([
      writeBlackBoxFixture(root, "darwin-aarch64", "different-source-mac"),
      writeBlackBoxFixture(root, "windows-x86_64", "different-source-windows")
    ]);
    await Promise.all([
      writeFile(macArtifact, "test"),
      writeFile(`${macArtifact}.sig`, SIGNATURE),
      writeFile(macDmg, "mac-dmg"),
      writeFile(windowsArtifact, "test"),
      writeFile(`${windowsArtifact}.sig`, SIGNATURE)
    ]);
    const windowsPayloadProof = await writeWindowsInstallerPayloadProofFixture({
      applicationPath: windowsBlackBox.applicationPath,
      installerPath: windowsArtifact,
      outputDirectory: windowsSource,
      sourceSha: "b".repeat(40)
    });
    const macosPackageBinding = createMacosPackageBindingFixture(
      macBlackBox.report.packageManifest,
      "test",
      "mac-dmg"
    );
    await Promise.all([
      stageElectronProductionPlatformCandidate({
        ...candidateInput(),
        applicationPath: macBlackBox.applicationPath,
        artifactPath: macArtifact,
        blackBoxReportPath: macBlackBox.reportPath,
        distributionPath: macDmg,
        macosPackageBinding,
        outputDirectory: macCandidate,
        platform: "darwin-aarch64"
      }),
      stageElectronProductionPlatformCandidate({
        ...candidateInput(),
        applicationPath: windowsBlackBox.applicationPath,
        artifactPath: windowsArtifact,
        blackBoxReportPath: windowsBlackBox.reportPath,
        outputDirectory: windowsCandidate,
        platform: "windows-x86_64",
        sourceSha: "b".repeat(40),
        windowsInstallerPayloadProofPath: windowsPayloadProof.path
      })
    ]);

    await expect(assembleElectronProductionCandidate({
      ...candidateInput(),
      macDirectory: macCandidate,
      outputDirectory: join(root, "candidate"),
      receiptPath: join(root, ELECTRON_CANDIDATE_RECEIPT_NAME),
      windowsDirectory: windowsCandidate
    })).rejects.toThrow("source SHA does not match");
  });
});

describe("Electron production candidate workflow", () => {
  it("is manual, owner-gated, production-keyed, cross-platform, and candidate-only", async () => {
    const [
      workflow,
      stableTauriWorkflow,
      versionScript,
      electronBuilderConfiguration,
      candidateScript,
      blackBoxReportContractScript,
      macosPackageBindingScript
    ] = await Promise.all([
      readFile(".github/workflows/electron-production-candidate.yml", "utf8"),
      readFile(".github/workflows/tauri-release-candidate.yml", "utf8"),
      readFile("scripts/applyReleaseVersion.mjs", "utf8"),
      readFile("electron-builder.config.mjs", "utf8"),
      readFile("scripts/electronProductionCandidate.mjs", "utf8"),
      readFile("scripts/packagedElectronBlackBoxReportContract.mjs", "utf8"),
      readFile("scripts/electronProductionMacosPackageBinding.mjs", "utf8")
    ]);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("workflow_call:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toMatch(/^\s{2}release:/mu);
    expect(workflow).toContain(`environment: ${ELECTRON_PRODUCTION_ENVIRONMENT}`);
    expect(workflow.match(/uses: actions\/setup-node@/gu)).toHaveLength(5);
    expect(workflow).toContain(ELECTRON_PRODUCTION_CANDIDATE_APPROVAL);
    expect(workflow).toContain("test \"$(git rev-parse HEAD)\" = \"${SOURCE_SHA}\"");
    expect(workflow).toContain("uses: ./.github/workflows/ci.yml");
    expect(workflow).toContain("RION_STUDIO_UPDATER_PUBLIC_KEY");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(workflow).toContain("--max-redirs 0");
    expect(workflow).toContain('test "${status}" = "200"');
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("platform: darwin-aarch64");
    expect(workflow).toContain("platform: windows-x86_64");
    expect(workflow).toContain("pnpm run verify:electron-runtime");
    expect(workflow).toContain(
      "Run exact macOS production candidate packaged Chromium black-box"
    );
    expect(workflow).toContain(
      "Run exact Windows production candidate packaged Chromium black-box"
    );
    expect(workflow).toContain(
      "pnpm run test:e2e:desktop:electron:packaged"
    );
    expect(workflow).toContain("Upload exact production candidate black-box evidence");
    expect(workflow).toContain("runWindowsIsolatedProfile.ps1");
    expect(workflow).toContain("runWindowsElectronInstallerPayloadProof.ps1");
    expect(workflow).toContain(
      "windows-installer-payload-proof.json"
    );
    expect(workflow).toContain("runner.environment == 'github-hosted'");
    expect(workflow.indexOf("production_candidate_black_box")).toBeLessThan(
      workflow.indexOf("electronProductionCandidate.mjs sign-platform")
    );
    expect(workflow.indexOf("runWindowsElectronInstallerPayloadProof.ps1")).toBeLessThan(
      workflow.indexOf("electronProductionCandidate.mjs sign-platform")
    );
    const buildJob = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  attest-signing-input:")
    );
    const signJob = workflow.slice(
      workflow.indexOf("  sign:"),
      workflow.indexOf("  assemble:")
    );
    const buildJobEnvironment = buildJob.slice(
      buildJob.indexOf("    env:"),
      buildJob.indexOf("    steps:")
    );
    const signerStep = signJob.slice(
      signJob.indexOf("- name: Sign updater payload"),
      signJob.indexOf("- name: Upload exact verified platform candidate")
    );
    expect(buildJobEnvironment).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(buildJob).not.toContain("secrets.");
    expect(signerStep).toContain("TAURI_SIGNING_PRIVATE_KEY:");
    expect(signerStep).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD:");
    expect(buildJob).toContain("RION_STUDIO_E2E_ARTIFACT_ROOT:");
    expect(signJob).toContain("gh attestation verify");
    expect(signJob).toContain("verify-signing-input");
    expect(signerStep).toContain(
      '--black-box-report "${RION_STUDIO_SIGNING_BLACK_BOX_REPORT}"'
    );
    expect(signerStep).toContain(
      '"${RION_STUDIO_SIGNING_WINDOWS_PAYLOAD_PROOF}"'
    );
    expect(workflow).toContain("electronProductionCandidate.mjs sign-platform");
    expect(workflow).toContain("electronProductionCandidate.mjs assemble");
    expect(workflow).not.toContain("prepare:electron-updater:ci");
    expect(workflow).not.toContain("signer generate");
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("contents: write");
    expect(electronBuilderConfiguration).toContain('identity: "-"');
    expect(electronBuilderConfiguration).toContain("notarize: false");
    expect(electronBuilderConfiguration).toContain("signExecutable: false");
    expect(electronBuilderConfiguration).toContain('artifactName: "Rion.Studio-win.${ext}"');
    expect(candidateScript).toContain("verifyMacosUpdaterArchive");
    const signPlatformSource = candidateScript.slice(
      candidateScript.indexOf("async function signPlatformCommand"),
      candidateScript.indexOf("async function windowsAuthenticodeStatus")
    );
    const updaterSignerIndex = signPlatformSource.indexOf(
      "await signUpdaterArtifact({"
    );
    expect(updaterSignerIndex).toBeGreaterThan(-1);
    expect(signPlatformSource).not.toContain(
      "], environment);"
    );
    expect(signPlatformSource.indexOf("await verifyMacosUpdaterArchive")).toBeLessThan(
      updaterSignerIndex
    );
    expect(signPlatformSource.indexOf("await verifyMacosDistributionPackage")).toBeLessThan(
      updaterSignerIndex
    );
    expect(signPlatformSource.indexOf("await createVerifiedMacosPackageBinding")).toBeGreaterThan(
      updaterSignerIndex
    );
    expect(macosPackageBindingScript).toContain('"attach"');
    expect(macosPackageBindingScript).toContain('"-readonly"');
    expect(macosPackageBindingScript).toContain('"detach"');
    expect(macosPackageBindingScript).toContain(
      "The macOS distribution package manifest does not match the black-box package."
    );
    expect(candidateScript).toContain("assertPackagedApplicationVersion");
    expect(candidateScript).toContain("PACKAGED_ELECTRON_BLACK_BOX_REPORT_NAME");
    expect(blackBoxReportContractScript).toContain(
      ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME
    );
    expect(candidateScript).toContain("verifyPackagedBlackBoxReport");
    expect(candidateScript).toContain("verifyEd25519(null, blake2b512");
    expect(candidateScript).toContain("verifyEd25519(null, globalMessage");
    expect(stableTauriWorkflow).toContain("name: Tauri Release Candidate");
    expect(stableTauriWorkflow).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    for (const packageName of [
      "rion-appkit",
      "rion-core",
      "rion-node",
      "rion-platform",
      "rion-tauri",
      "rion-updater"
    ]) {
      expect(versionScript).toContain(`"${packageName}"`);
    }
  });
});

function candidateInput() {
  return {
    ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    publicKey: PUBLIC_KEY,
    publishedAt: PUBLISHED_AT,
    sourceSha: SOURCE_SHA,
    updaterBaseUrl: UPDATER_BASE_URL,
    version: VERSION
  };
}

async function writeBlackBoxFixture(
  root: string,
  platform: "darwin-aarch64" | "windows-x86_64",
  label: string = platform
) {
  const fixtureRoot = join(root, label);
  const applicationPath = platform === "darwin-aarch64"
    ? join(fixtureRoot, "Rion Studio.app")
    : join(fixtureRoot, "win-unpacked");
  const resourcesPath = platform === "darwin-aarch64"
    ? join(applicationPath, "Contents", "Resources")
    : join(applicationPath, "resources");
  const executablePath = platform === "darwin-aarch64"
    ? join(applicationPath, "Contents", "MacOS", "Rion Studio")
    : join(applicationPath, "Rion Studio.exe");
  const appAsarPath = join(resourcesPath, "app.asar");
  const nativeAddonPath = join(resourcesPath, "native", "rion-core.node");
  const screenshotPath = join(
    fixtureRoot,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME
  );
  await Promise.all([
    mkdir(dirname(executablePath), { recursive: true }),
    mkdir(dirname(nativeAddonPath), { recursive: true })
  ]);
  const executable = `${platform}-executable`;
  const appAsar = `${platform}-app-asar`;
  const nativeAddon = `${platform}-native-addon`;
  await Promise.all([
    writeFile(executablePath, executable),
    writeFile(appAsarPath, appAsar),
    writeFile(nativeAddonPath, nativeAddon),
    writeFile(screenshotPath, SCREENSHOT_PNG)
  ]);
  const packageManifest = summarizePackagedElectronPackageManifest(
    await capturePackagedElectronPackageManifest(applicationPath)
  );
  const report = {
    schemaVersion: 1,
    kind: "rion-packaged-electron-black-box-smoke",
    verdict: "passed",
    appVersion: VERSION,
    application: { path: applicationPath },
    executable: { path: executablePath, sha256: sha256(executable) },
    appAsar: { path: appAsarPath, sha256: sha256(appAsar) },
    nativeAddon: { path: nativeAddonPath, sha256: sha256(nativeAddon) },
    exitCode: 0,
    fixtureInteraction: "visible-os-accessibility-click",
    gameId: "10000000-0000-4000-8000-000000000001",
    isolationKind: platform === "darwin-aarch64"
      ? "fixed-macos-home"
      : "temporary-local-windows-user-profile-v1",
    nativeHostKind: platform === "darwin-aarch64"
      ? "appkit-chromium"
      : "bundled-chromium",
    packageManifest,
    platform: platform === "darwin-aarch64" ? "darwin" : "win32",
    remoteDebugging: false,
    roleId: "10000000-0000-4000-8000-000000000002",
    runtimeHomeDirectory: join(fixtureRoot, "runtime-home"),
    runtimeTarget: platform === "darwin-aarch64"
      ? "chromium-v23-macos-appkit"
      : "chromium-v23-windows",
    screenshot: {
      byteLength: SCREENSHOT_PNG.length,
      path: screenshotPath,
      sha256: sha256(SCREENSHOT_PNG)
    },
    userDataDirectory: join(fixtureRoot, "runtime-home", "Rion Studio")
  } satisfies PackagedElectronBlackBoxReport;
  const reportPath = join(fixtureRoot, "packaged-smoke-report.json");
  await writeFile(reportPath, serializePackagedElectronBlackBoxReport(report));
  return {
    applicationPath,
    nativeAddonPath,
    platform,
    report,
    reportPath,
    screenshotPath
  };
}

async function writeWindowsInstallerPayloadProofFixture(input: {
  applicationPath: string;
  installerPath: string;
  outputDirectory: string;
  sourceSha?: string;
  version?: string;
}): Promise<{
  path: string;
  proof: WindowsElectronInstallerPayloadProof;
  source: Buffer;
}> {
  const [capturedSourceManifest, installer] = await Promise.all([
    capturePackagedElectronPackageManifest(input.applicationPath),
    captureStableRegularFileArtifact(input.installerPath)
  ]);
  const sourceManifest = createPortablePackagedElectronPackageManifest(
    capturedSourceManifest.entries,
    capturedSourceManifest.rootMode
  );
  const uninstallerSource = "unsigned-nsis-uninstaller";
  const installedManifest = createPortablePackagedElectronPackageManifest([
    ...sourceManifest.entries,
    {
      bytes: Buffer.byteLength(uninstallerSource),
      mode: 0o755,
      path: WINDOWS_ELECTRON_UNINSTALLER_PATH,
      sha256: sha256(uninstallerSource),
      type: "regular-file" as const
    }
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))),
  sourceManifest.rootMode);
  const version = input.version ?? VERSION;
  const proof = buildWindowsElectronInstallerPayloadProof({
    installedAppVersion: version,
    installedManifest,
    installer,
    installerAuthenticodeStatus: "NotSigned",
    isolationResult: successfulWindowsIsolationResult(installer),
    mainAuthenticodeStatus: "NotSigned",
    sourceAppVersion: version,
    sourceManifest,
    sourceSha: input.sourceSha ?? SOURCE_SHA,
    uninstallerAuthenticodeStatus: "NotSigned",
    version
  });
  const source = serializeWindowsElectronInstallerPayloadProof(proof);
  const proofPath = join(
    input.outputDirectory,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
  );
  await writeFile(proofPath, source);
  return { path: proofPath, proof, source };
}

function successfulWindowsIsolationResult(installer: {
  bytes: number;
  fileName: string;
  sha256: string;
}) {
  return {
    activeProcessesAfterRootExit: 0,
    attemptNonce: "0123456789abcdef0123456789abcdef",
    attestedInputs: {
      commandExecutable: {
        bytes: 4,
        fileName: "pwsh.exe",
        sha256: sha256("pwsh")
      },
      commandHarness: {
        bytes: 7,
        fileName: "install.ps1",
        sha256: sha256("harness")
      },
      forbiddenSourceList: {
        bytes: 8,
        fileName: "forbidden-source-files.json",
        sha256: sha256("forbidden-source-list")
      },
      installer
    },
    cleanupVerified: true,
    commandExitCode: 0,
    commandInvocationSha256: sha256("command-invocation"),
    expectedTotalProcesses: 3,
    isolationKind: "temporary-local-windows-user-profile-v1",
    kind: "rion-windows-isolated-profile-result",
    schemaVersion: 1,
    totalProcesses: 3
  } as const;
}

function createMacosPackageBindingFixture(
  packageManifest: PackagedElectronBlackBoxReport["packageManifest"],
  artifactSource: string | Buffer,
  distributionSource: string | Buffer
) {
  return createMacosPackageBindingEvidence({
    artifact: candidateFileIdentity(
      "Rion.Studio-mac.app.tar.gz",
      artifactSource
    ),
    distribution: candidateFileIdentity(
      "Rion.Studio-mac.dmg",
      distributionSource
    ),
    packageManifest
  });
}

function candidateFileIdentity(fileName: string, source: string | Buffer) {
  return {
    bytes: Buffer.byteLength(source),
    fileName,
    sha256: sha256(source)
  };
}

function candidateArtifactIdentity(
  fileName: string,
  source: string,
  signatureSource: string
) {
  return {
    ...candidateFileIdentity(fileName, source),
    signatureBytes: Buffer.byteLength(signatureSource),
    signatureFileName: `${fileName}.sig`,
    signatureSha256: sha256(signatureSource)
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rion-electron-production-candidate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeCanonicalBlackBoxReportSource(path: string, source: string) {
  return writeFile(
    path,
    serializePackagedElectronBlackBoxReport(JSON.parse(source))
  );
}

function runTauriSigner(argumentsList: string[], environment: NodeJS.ProcessEnv = {}): void {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, ["exec", "tauri", "signer", ...argumentsList], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true
  });
  expect(result.status, result.stderr).toBe(0);
}
