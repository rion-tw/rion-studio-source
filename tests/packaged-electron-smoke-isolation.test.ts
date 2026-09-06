import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  truncate,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  MACOS_RETAINED_APPKIT_HANDLERS,
  parsePackagedScreenRectangle,
  runPackagedCoreOperation,
  validatePackagedPngArtifact
} from "../scripts/packagedElectronBlackBox.mjs";
import { resolvePackagedElectronSmokeIsolation } from
  "../scripts/packagedElectronSmokeIsolation.mjs";
import { createPackagedElectronRuntimeEnvironment } from
  "../scripts/runtimeEnvironmentPolicy.mjs";

const executeFile = promisify(execFile);

describe("packaged Electron smoke isolation", () => {
  it("preserves the Core operation failure when shutdown also fails", async () => {
    const primary = new Error("seed invoke failed");
    const shutdown = new Error("Core shutdown failed");
    let shutdownCalls = 0;
    const core = {
      shutdown: async () => {
        shutdownCalls += 1;
        throw shutdown;
      }
    };

    let observed: unknown;
    try {
      await runPackagedCoreOperation(core, async () => {
        throw primary;
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).cause).toBe(primary);
    expect((observed as AggregateError).errors).toEqual([primary, shutdown]);
    expect(shutdownCalls).toBe(1);
  });

  it("validates and hashes only a bounded regular PNG artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-packaged-png-"));
    const path = join(directory, "role-window.png");
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    try {
      await writeFile(path, validPng);
      const artifact = await validatePackagedPngArtifact(path);
      expect(artifact).toEqual({
        byteLength: validPng.length,
        path: resolve(path),
        sha256: createHash("sha256").update(validPng).digest("hex")
      });
      expect(Object.isFrozen(artifact)).toBe(true);

      const hardLinkPath = join(directory, "role-window-hard-link.png");
      await link(path, hardLinkPath);
      await expect(validatePackagedPngArtifact(path)).rejects
        .toThrow("exclusively linked regular file");
      await unlink(hardLinkPath);

      const corruptPng = Buffer.from(validPng);
      corruptPng[corruptPng.length - 1] ^= 0xff;
      await writeFile(path, corruptPng);
      await expect(validatePackagedPngArtifact(path)).rejects
        .toThrow("corrupt PNG chunk");

      await writeFile(path, "not a PNG");
      await expect(validatePackagedPngArtifact(path)).rejects
        .toThrow("not a PNG image");

      await truncate(path, 64 * 1024 * 1024 + 1);
      await expect(validatePackagedPngArtifact(path)).rejects
        .toThrow("safe byte bound");

      await expect(validatePackagedPngArtifact(directory)).rejects
        .toThrow("not an exclusively linked regular file");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts only a bounded target-window capture rectangle", () => {
    expect(parsePackagedScreenRectangle("-1920,24,1280,720"))
      .toBe("-1920,24,1280,720");
    for (const unsafe of [
      "0,0,0,720",
      "0,0,1280,0",
      "0,0,-1280,720",
      "0,0,1280.5,720",
      "0,0,16385,720",
      "0,0,16384,16384",
      "131073,0,1280,720",
      "all-screens"
    ]) {
      expect(() => parsePackagedScreenRectangle(unsafe)).toThrow();
    }
  });

  const macosIt = process.platform === "darwin" ? it : it.skip;
  macosIt("compiles the retained AppKit accessibility identity probe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-appkit-probe-"));
    try {
      await executeFile("/usr/bin/osacompile", [
        "-e",
        `${MACOS_RETAINED_APPKIT_HANDLERS}\non run argv\nreturn true\nend run`,
        "-o",
        join(directory, "probe.scpt")
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  macosIt("skips a retired native AX reference without claiming a button match", async () => {
    const { stdout } = await executeFile("/usr/bin/osascript", ["-e", `
${MACOS_RETAINED_APPKIT_HANDLERS}
on run
  tell application "System Events"
    set staleElement to a reference to group 99999 of application process "Finder"
  end tell
  set foundElements to my rionDescendants(staleElement)
  set foundButton to my rionFindButton(staleElement, "Absent")
  return ((count of foundElements) is 0 and foundButton is missing value)
end run`]);
    expect(stdout.trim()).toBe("true");
  });

  it("uses CFFIXED_USER_HOME without weakening the packaged product override policy", () => {
    expect(resolvePackagedElectronSmokeIsolation(
      "/tmp/rion-artifacts",
      "darwin"
    )).toEqual({
      environment: {
        CFFIXED_USER_HOME: "/tmp/rion-artifacts/runtime-home"
      },
      isolationKind: "fixed-macos-home",
      runtimeHomeDirectory: "/tmp/rion-artifacts/runtime-home",
      userDataDirectory:
        "/tmp/rion-artifacts/runtime-home/Library/Application Support/Rion Studio"
    });
  });

  it("uses the loaded temporary Windows user Known Folders without path overrides", () => {
    expect(resolvePackagedElectronSmokeIsolation(
      "C:\\rion-artifacts",
      "win32",
      windowsProfileEnvironment()
    )).toEqual({
      environment: {},
      isolationKind: "temporary-local-windows-user-profile-v1",
      runtimeHomeDirectory: "C:\\Users\\rionci-a1b2c3d4e5",
      userDataDirectory:
        "C:\\Users\\rionci-a1b2c3d4e5\\AppData\\Roaming\\Rion Studio"
    });
  });

  it("fails closed when Windows has only spoofed AppData environment paths", () => {
    expect(() => resolvePackagedElectronSmokeIsolation(
      "C:\\rion-artifacts",
      "win32",
      {
        APPDATA: "C:\\rion-artifacts\\runtime-home\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\rion-artifacts\\runtime-home\\AppData\\Local"
      }
    )).toThrow("temporary-user profile runner");
  });

  it("rejects relative, non-canonical, and unsupported isolation targets", () => {
    expect(() => resolvePackagedElectronSmokeIsolation("relative", "darwin"))
      .toThrow("canonical platform-absolute");
    expect(() => resolvePackagedElectronSmokeIsolation(
      "/tmp/../tmp/rion-artifacts",
      "darwin"
    )).toThrow("canonical platform-absolute");
    expect(() => resolvePackagedElectronSmokeIsolation(
      "/tmp/rion-artifacts",
      "linux" as "darwin"
    )).toThrow("canonical platform-absolute");
  });

  it("drives the exact production package without a Chromium debug transport", async () => {
    const [
      runner,
      blackBox,
      commandPolicy,
      processCleanup,
      profileRunner,
      jobRunner,
      desktopAccess,
      reportContract
    ] = await Promise.all([
      readFile("scripts/runPackagedElectronSmoke.mjs", "utf8"),
      readFile("scripts/packagedElectronBlackBox.mjs", "utf8"),
      readFile("src/electron/main/chromiumCommandLinePolicy.ts", "utf8"),
      readFile("scripts/packagedElectronProcessCleanup.mjs", "utf8"),
      readFile("scripts/runWindowsIsolatedProfile.ps1", "utf8"),
      readFile("scripts/windowsJobObjectRunner.cs", "utf8"),
      readFile("scripts/windowsInteractiveDesktopAccess.cs", "utf8"),
      readFile("scripts/packagedElectronBlackBoxReportContract.mjs", "utf8")
    ]);

    expect(runner).not.toContain("wdio");
    expect(runner).not.toContain("remote-debugging");
    expect(runner).not.toContain("RION_STUDIO_E2E_SESSION_TOKEN:");
    expect(runner).toContain("createPackagedElectronRuntimeEnvironment");
    expect(runner).toContain("seedPackagedElectronRole");
    expect(runner).toContain('["--force-renderer-accessibility"]');
    expect(runner).toContain("launchRoleThroughNativeInput");
    expect(runner).toContain("pressPackagedRoleContent");
    expect(runner).toContain("packagedElectronSpawnOptions");
    expect(runner).toContain("createPackagedElectronProcessOwner");
    expect(runner).toContain("buildDarwinPackagedProcessInventory");
    expect(runner).toContain("waitForPackagedElectronProcessOwnership");
    expect(runner).toContain("terminatePackagedElectronProcessTree");
    expect(runner).toContain("assertPackagedElectronProcessTreeGone");
    expect(runner).toContain("assertPackagedRuntimeUnchanged");
    expect(runner).toContain("capturePackagedElectronPackageManifest");
    expect(runner).toContain("assertPackagedElectronPackageManifestUnchanged");
    expect(runner).toContain(".packaged-smoke-report.pending");
    expect(runner).toContain("rename(pendingPath, reportPath)");
    expect(runner).not.toContain("child.kill(");
    expect(runner).toContain("kind: PACKAGED_ELECTRON_BLACK_BOX_KIND");
    expect(runner).toContain("serializePackagedElectronBlackBoxReport");
    expect(runner).toContain("PACKAGED_ELECTRON_BLACK_BOX_SOURCE_REPORT_NAME");
    expect(reportContract).toContain('"packaged-smoke-report.json"');
    expect(runner).toContain('verdict: "passed"');
    expect(runner).toContain("appAsar:");
    expect(runner).toContain("nativeAddon:");
    expect(runner).toContain("packageManifest:");
    expect(runner).toContain("screenshot,");
    expect(runner).toContain("randomUUID()");
    expect(runner).toContain("remoteDebugging: false");
    expect(runner.lastIndexOf("await assertPackagedElectronProcessTreeGone"))
      .toBeLessThan(runner.indexOf("await writePassedReport"));
    expect(runner.lastIndexOf("await assertPackagedRuntimeUnchanged"))
      .toBeLessThan(runner.indexOf("await writePassedReport"));
    expect(blackBox).toContain("key code 40 using command down");
    expect(blackBox).toContain("set value of quickAccessCombo to roleName");
    expect(blackBox).toContain("key code 36");
    expect(blackBox).toContain("key code 12 using command down");
    expect(blackBox).toContain("roleWindowCount is 1 then return");
    expect(blackBox).toContain('perform action "AXRaise" of appWindow');
    expect(blackBox).toContain("rionDescendants(appWindow)");
    expect(blackBox).toContain("candidateDescription ends with roleName");
    expect(blackBox).not.toContain("entire contents of appWindow");
    expect(blackBox).toContain("System.Windows.Automation.InvokePattern");
    expect(blackBox).toContain("runEncodedPowerShellJson");
    expect(blackBox).not.toContain('"-Command"');
    expect(blackBox).not.toContain("$args[");
    expect(blackBox).toContain(
      '$roleControlName = [String]::Concat("Activate ", $roleName)'
    );
    expect(blackBox).toContain("Rion-ButtonByName $window $roleControlName");
    expect(blackBox).toContain("Rion-ButtonByName $window $buttonName");
    expect(blackBox).toContain("Rion-SendKeysLiteral $roleName");
    expect(blackBox.match(
      /Rion-ExactRoleContentWindows \$targetPid \$roleName \$buttonName/gu
    )).toHaveLength(3);
    expect(blackBox).toContain('return "appkit-chromium"');
    expect(blackBox).toContain("com.rionstudio.runtime.appkit-window.v1:");
    expect(blackBox).toContain("com.rionstudio.runtime.appkit-tab.v1:");
    expect(blackBox).toContain("com.rionstudio.runtime.appkit-tab-group.v1");
    expect(blackBox).toContain('role of tabScrollArea is "AXScrollArea"');
    expect(blackBox).toContain("com.rionstudio.runtime.appkit-root.v1");
    expect(blackBox.match(/rionIsRetainedAppKitRoleWindow\(/gu))
      .toHaveLength(5);
    expect(blackBox).toContain('Write-Output "bundled-chromium"');
    expect(blackBox).toContain("parsePackagedScreenRectangle");
    expect(blackBox).toContain("Current.BoundingRectangle");
    expect(blackBox).toContain("validatePackagedPngArtifact");
    expect(blackBox).not.toContain("SystemInformation]::VirtualScreen");
    expect(blackBox).not.toContain('["-x", input.outputPath]');
    expect(processCleanup).toContain("runEncodedPowerShellJson");
    expect(processCleanup).not.toContain('"-Command"');
    expect(processCleanup).not.toContain("$args[");
    expect(processCleanup).toContain("rootCreationMilliseconds");
    expect(commandPolicy).toContain("if (input.isPackaged");
    expect(profileRunner).not.toContain("Add-Type -TypeDefinition @'");
    expect(profileRunner).toContain("scripts\\windowsJobObjectRunner.cs");
    expect(profileRunner).toContain("scripts\\windowsInteractiveDesktopAccess.cs");
    expect(jobRunner).toContain("CreateProcessWithLogonW");
    expect(jobRunner).toContain("CreateSuspended");
    expect(jobRunner).toContain("public uint TotalProcesses { get; set; }");
    expect(jobRunner).toContain("startup.lpDesktop = null");
    expect(jobRunner).not.toContain('startup.lpDesktop = "winsta0\\\\default"');
    expect(jobRunner.indexOf("if (!AssignProcessToJobObject(job, process.hProcess))"))
      .toBeLessThan(jobRunner.indexOf("ResumeThread(process.hThread)"));
    expect(jobRunner).toContain("JobObjectLimitKillOnJobClose");
    expect(jobRunner.indexOf("WaitForSingleObject(process.hProcess"))
      .toBeLessThan(jobRunner.indexOf("uint activeProcessesAfterRootExit"));
    expect(jobRunner).toContain("QueryActiveProcesses(");
    expect(jobRunner).toContain("uint totalProcesses = QueryTotalProcesses(");
    expect(jobRunner).toContain("TotalProcesses = totalProcesses");
    expect(jobRunner).toContain(").TotalProcesses;");
    expect(jobRunner).toContain("WaitForJobToDrain(");
    expect(jobRunner).toContain("activeProcessesAfterRootExit != 0");
    expect(jobRunner).toContain("TerminateJobObject(job, 1)");
    expect(jobRunner).toContain("childCreated && !childAssigned");
    expect(jobRunner).toContain("EnsureStandaloneProcessStopped(process.hProcess)");
    expect(jobRunner).toContain("EnsureJobStopped(job, accountingBuffer, accountingSize)");
    expect(jobRunner).toContain("did not reach authoritative active-zero");
    expect(jobRunner).toContain("primaryFailure");
    expect(jobRunner).toContain("cleanupFailure");
    expect(jobRunner).toContain("cleanup-safe deadline");
    expect(jobRunner).toContain("ProfileBoundEnvironmentNames");
    expect(jobRunner).toContain("SensitiveEnvironmentNames");
    expect(jobRunner).toContain('name.StartsWith("TAURI_SIGNING_"');
    expect(jobRunner).toContain('"RION_STUDIO_UPDATER_PRIVATE_"');
    expect(jobRunner).toContain('"ACTIONS_RUNTIME_TOKEN"');
    expect(jobRunner).toContain("ZeroAndFreeEnvironmentBlock");
    expect(jobRunner).not.toContain("ZeroFreeGlobalAllocUnicode");
    expect(profileRunner).toContain("[int] $ExpectedTotalProcesses = 0");
    expect(profileRunner).toContain(
      "$totalProcesses = [int] $jobResult.TotalProcesses"
    );
    expect(profileRunner).toContain("$ExpectedTotalProcesses -ne 0");
    expect(profileRunner).toContain("Deny-PathMutationRecursively $commandParent");
    expect(profileRunner).toContain(
      '"Job Object observed $totalProcesses total process(es); expected $ExpectedTotalProcesses"'
    );
    expect(desktopAccess).toContain("GetUserObjectSecurity");
    expect(desktopAccess).toContain("SetUserObjectSecurity");
    expect(desktopAccess).toContain("Interactive desktop ACL restoration failed.");
    expect(desktopAccess).toContain("Desktop access grant and window-station rollback");
    expect(profileRunner).toContain("Remove-LocalUser -Name $userName");
    expect(profileRunner).toContain("Get-CimInstance Win32_UserProfile");
    expect(profileRunner).toContain("profile registration still exists");
    expect(profileRunner).toContain("profile directory still exists");
    expect(profileRunner).toContain("ProfilesDirectory");
    expect(profileRunner).toContain("ProfileImagePath");
    expect(profileRunner).toContain("account still exists");
    expect(profileRunner).toContain("run root still exists");
    expect(profileRunner).toContain("$primaryError = $_");
    expect(profileRunner).toContain("primary command:");
    expect(profileRunner).toContain("cleanup:");
    expect(profileRunner).toContain("$CommandTimeoutSeconds * 1000");
    expect(profileRunner).toContain(
      "Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction Stop"
    );
    expect(profileRunner).not.toMatch(
      /Remove-Item[^\n]+runRoot[^\n]+SilentlyContinue/u
    );
  });

  it("removes build controls and updater signing material from the packaged process", () => {
    const source = {
      PATH: "/usr/bin",
      RION_STUDIO_DESKTOP_E2E_BUILD: "1",
      RION_STUDIO_E2E_SESSION_TOKEN: "debug-token",
      RION_STUDIO_ELECTRON_PACKAGE_VERSION: "23.4.5",
      RION_STUDIO_UPDATER_ENDPOINT: "https://updates.example.test/latest.json",
      RION_STUDIO_UPDATER_PUBLIC_KEY: "public-key",
      RION_STUDIO_USER_DATA_DIR: "/tmp/debug-data",
      RION_WINDOWS_ISOLATED_PROFILE_KIND:
        "temporary-local-windows-user-profile-v1",
      RION_UPDATER_PROBE_PUBLIC_KEY: "probe-public-key",
      TAURI_SIGNING_PRIVATE_KEY: "production-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "production-password",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "/tmp/private-key"
    };

    expect(createPackagedElectronRuntimeEnvironment(source, {
      CFFIXED_USER_HOME: "/tmp/runtime-home"
    })).toEqual({
      CFFIXED_USER_HOME: "/tmp/runtime-home",
      PATH: "/usr/bin"
    });
    expect(source.TAURI_SIGNING_PRIVATE_KEY).toBe("production-private-key");
  });
});

function windowsProfileEnvironment(): NodeJS.ProcessEnv {
  const profile = "C:\\Users\\rionci-a1b2c3d4e5";
  const roaming = `${profile}\\AppData\\Roaming`;
  const local = `${profile}\\AppData\\Local`;
  return {
    APPDATA: roaming,
    LOCALAPPDATA: local,
    USERPROFILE: profile,
    RION_WINDOWS_ISOLATED_PROFILE_KIND:
      "temporary-local-windows-user-profile-v1",
    RION_WINDOWS_ISOLATED_PROFILE_SID: "S-1-5-21-1-2-3-1001",
    RION_WINDOWS_ISOLATED_PROFILE_PARENT_SID: "S-1-5-21-1-2-3-1000",
    RION_WINDOWS_ISOLATED_PROFILE_ROOT: profile,
    RION_WINDOWS_ISOLATED_PROFILE_ROAMING_APP_DATA: roaming,
    RION_WINDOWS_ISOLATED_PROFILE_LOCAL_APP_DATA: local,
    RION_WINDOWS_ISOLATED_PROFILE_USER_PROGRAM_FILES: `${local}\\Programs`
  };
}
