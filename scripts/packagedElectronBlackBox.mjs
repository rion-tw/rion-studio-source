import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { extractFile } from "@electron/asar";

import { runEncodedPowerShellJson } from "./encodedPowerShell.mjs";

const execFileAsync = promisify(execFile);
const UI_ACTION_DEADLINE_MS = 35_000;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MACOS_RETAINED_APPKIT_HANDLERS = String.raw`
on rionAccessibilityIdentifier(targetElement)
  tell application "System Events"
    try
      return (value of attribute "AXIdentifier" of targetElement) as text
    on error
      return ""
    end try
  end tell
end rionAccessibilityIdentifier

on rionIsRetainedAppKitRoleWindow(appWindow, roleName)
  tell application "System Events"
    if not ((my rionAccessibilityIdentifier(appWindow)) starts with ¬
        "com.rionstudio.runtime.appkit-window.v1:") then return false
    repeat with candidate in entire contents of appWindow
      try
        if role of candidate is "AXRadioButton" and ¬
            description of candidate is roleName and ¬
            (my rionAccessibilityIdentifier(candidate)) starts with ¬
              "com.rionstudio.runtime.appkit-tab.v1:" then
          set tabGroup to value of attribute "AXParent" of candidate
          if role of tabGroup is "AXTabGroup" and ¬
              (my rionAccessibilityIdentifier(tabGroup)) is ¬
                "com.rionstudio.runtime.appkit-tab-group.v1" then
            set appKitRoot to value of attribute "AXParent" of tabGroup
            if role of appKitRoot is "AXGroup" and ¬
                (my rionAccessibilityIdentifier(appKitRoot)) is ¬
                  "com.rionstudio.runtime.appkit-root.v1" then return true
          end if
        end if
      end try
    end repeat
  end tell
  return false
end rionIsRetainedAppKitRoleWindow
`;
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? (0xedb88320 ^ (value >>> 1))
      : (value >>> 1);
  }
  return value >>> 0;
});

export async function seedPackagedElectronRole(input) {
  const addonPath = join(input.resourcesPath, "native", "rion-core.node");
  const packageJson = JSON.parse(extractFile(
    join(input.resourcesPath, "app.asar"),
    "package.json",
    false
  ).toString("utf8"));
  if (
    typeof packageJson.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)
  ) {
    throw new Error("The packaged application does not contain a semantic version.");
  }
  const addon = createRequire(import.meta.url)(addonPath);
  if (typeof addon.createAppCore !== "function") {
    throw new Error("The packaged Rust addon does not expose createAppCore.");
  }
  const core = await addon.createAppCore({
    appVersion: packageJson.version,
    packaged: true,
    platform: input.platform,
    runtimeContractVersion: 23,
    userDataDir: input.userDataDirectory
  });
  const invoke = async (command) => JSON.parse(await core.invoke(JSON.stringify(command)));
  return runPackagedCoreOperation(core, async () => {
    const legal = await invoke({ type: "legalAcceptanceStatus" });
    const versions = legal?.currentVersions;
    if (
      typeof versions?.fairUse !== "string" ||
      typeof versions?.privacy !== "string" ||
      typeof versions?.terms !== "string"
    ) {
      throw new Error("The packaged Core omitted legal document versions.");
    }
    await invoke({
      type: "legalAcceptanceAccept",
      input: {
        fairUseVersion: versions.fairUse,
        privacyVersion: versions.privacy,
        termsVersion: versions.terms
      }
    });
    const game = await invoke({
      type: "gameCreate",
      input: {
        defaultLaunchUrl: input.launchUrl,
        name: input.gameName
      }
    });
    if (typeof game?.id !== "string" || game.id.length === 0) {
      throw new Error("The packaged Core did not create the black-box game.");
    }
    const role = await invoke({
      type: "roleCreate",
      input: {
        gameId: game.id,
        launchUrl: input.launchUrl,
        name: input.roleName
      }
    });
    if (typeof role?.id !== "string" || role.id.length === 0) {
      throw new Error("The packaged Core did not create the black-box role.");
    }
    return Object.freeze({
      appVersion: packageJson.version,
      gameId: game.id,
      roleId: role.id
    });
  });
}

export async function runPackagedCoreOperation(core, operation) {
  let operationFailed = false;
  let operationFailure;
  let result;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  let shutdownFailed = false;
  let shutdownFailure;
  try {
    await core.shutdown();
  } catch (error) {
    shutdownFailed = true;
    shutdownFailure = error;
  }
  if (operationFailed && shutdownFailed) {
    throw new AggregateError(
      [operationFailure, shutdownFailure],
      "The packaged Core operation and shutdown both failed.",
      { cause: operationFailure }
    );
  }
  if (operationFailed) throw operationFailure;
  if (shutdownFailed) throw shutdownFailure;
  return result;
}

export async function launchRoleThroughNativeInput(input) {
  if (input.platform === "darwin") {
    await runAppleScript(`
on run argv
  set targetPid to (item 1 of argv) as integer
  set roleName to item 2 of argv
  tell application "System Events"
    repeat 300 times
      set matchingProcesses to application processes whose unix id is targetPid
      if (count of matchingProcesses) is 1 then
        set targetProcess to item 1 of matchingProcesses
        set dashboardCount to 0
        repeat with appWindow in windows of targetProcess
          repeat with candidate in entire contents of appWindow
            try
              if role of candidate is "AXButton" and name of candidate is "Dashboard" then set dashboardCount to dashboardCount + 1
            end try
          end repeat
        end repeat
        if dashboardCount is 1 then
          set frontmost of targetProcess to true
          keystroke "k" using command down
          delay 0.2
          keystroke roleName
          key code 36
          return
        end if
      end if
      delay 0.1
    end repeat
    error "packaged dashboard did not become accessible"
  end tell
end run`, String(input.processId), input.roleName);
    return;
  }
  await runPowerShell(windowsLaunchRoleScript, {
    processId: input.processId,
    roleName: input.roleName
  });
}

export async function pressPackagedRoleContent(input) {
  if (input.platform === "darwin") {
    const output = await runAppleScript(`${MACOS_RETAINED_APPKIT_HANDLERS}
on run argv
  set targetPid to (item 1 of argv) as integer
  set roleName to item 2 of argv
  set buttonName to item 3 of argv
  tell application "System Events"
    repeat 300 times
      set matchingProcesses to application processes whose unix id is targetPid
      if (count of matchingProcesses) is 1 then
        set targetProcess to item 1 of matchingProcesses
        set matchingWindow to missing value
        set matchingButton to missing value
        set matchCount to 0
        repeat with appWindow in windows of targetProcess
          set candidateButton to missing value
          repeat with candidate in entire contents of appWindow
            try
              if role of candidate is "AXButton" and (name of candidate is buttonName or description of candidate is buttonName) then set candidateButton to candidate
            end try
          end repeat
          if (my rionIsRetainedAppKitRoleWindow(appWindow, roleName)) and candidateButton is not missing value then
            set matchingWindow to appWindow
            set matchingButton to candidateButton
            set matchCount to matchCount + 1
          end if
        end repeat
        if matchCount is 1 then
          perform action "AXPress" of matchingButton
          return "appkit-chromium"
        end if
        if matchCount > 1 then error "ambiguous retained AppKit role window"
      end if
      delay 0.1
    end repeat
    error "retained AppKit role content did not become accessible"
  end tell
end run`, String(input.processId), input.roleName, input.buttonName);
    if (output !== "appkit-chromium") {
      throw new Error(`Unexpected AppKit black-box identity ${output}.`);
    }
    return output;
  }
  const output = await runPowerShell(
    windowsPressRoleContentScript,
    {
      buttonName: input.buttonName,
      processId: input.processId,
      roleName: input.roleName
    }
  );
  if (output !== "bundled-chromium") {
    throw new Error(`Unexpected Windows black-box identity ${output}.`);
  }
  return output;
}

export async function closePackagedRoleWindow(input) {
  if (input.platform === "darwin") {
    await runAppleScript(`${MACOS_RETAINED_APPKIT_HANDLERS}
on run argv
  set targetPid to (item 1 of argv) as integer
  set roleName to item 2 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set matchingWindow to missing value
    set matchCount to 0
    repeat with appWindow in windows of item 1 of matchingProcesses
      if my rionIsRetainedAppKitRoleWindow(appWindow, roleName) then
        set matchingWindow to appWindow
        set matchCount to matchCount + 1
      end if
    end repeat
    if matchCount is not 1 then error "exact retained AppKit role window unavailable"
    set closeButtons to buttons of matchingWindow whose subrole is "AXCloseButton"
    if (count of closeButtons) is not 1 then error "retained AppKit close button unavailable"
    perform action "AXPress" of item 1 of closeButtons
    repeat 300 times
      set remainingCount to 0
      repeat with appWindow in windows of item 1 of matchingProcesses
        if my rionIsRetainedAppKitRoleWindow(appWindow, roleName) then set remainingCount to remainingCount + 1
      end repeat
      if remainingCount is 0 then return
      delay 0.1
    end repeat
    error "retained AppKit role window did not close"
  end tell
end run`, String(input.processId), input.roleName);
    return;
  }
  await runPowerShell(
    windowsCloseRoleWindowScript,
    {
      buttonName: input.buttonName,
      processId: input.processId,
      roleName: input.roleName
    }
  );
}

export async function quitPackagedApplication(input) {
  if (input.platform === "darwin") {
    await runAppleScript(`
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set frontmost of targetProcess to true
    keystroke "q" using command down
  end tell
end run`, String(input.processId));
    return;
  }
  await runPowerShell(windowsQuitApplicationScript, {
    processId: input.processId
  });
}

export async function capturePackagedScreen(input) {
  if (input.platform === "darwin") {
    const rectangle = await runAppleScript(`${MACOS_RETAINED_APPKIT_HANDLERS}
on run argv
  set targetPid to (item 1 of argv) as integer
  set roleName to item 2 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set matchingWindow to missing value
    set matchCount to 0
    repeat with appWindow in windows of targetProcess
      if my rionIsRetainedAppKitRoleWindow(appWindow, roleName) then
        set matchingWindow to appWindow
        set matchCount to matchCount + 1
      end if
    end repeat
    if matchCount is not 1 then error "exact retained AppKit role window unavailable"
    set frontmost of targetProcess to true
    set {screenX, screenY} to position of matchingWindow
    set {screenWidth, screenHeight} to size of matchingWindow
    return ((screenX as integer) as text) & "," & ¬
      ((screenY as integer) as text) & "," & ¬
      ((screenWidth as integer) as text) & "," & ¬
      ((screenHeight as integer) as text)
  end tell
end run`, String(input.processId), input.roleName);
    const region = parsePackagedScreenRectangle(rectangle);
    await execFileAsync("/usr/sbin/screencapture", ["-x", `-R${region}`, input.outputPath], {
      timeout: UI_ACTION_DEADLINE_MS
    });
    return validatePackagedPngArtifact(input.outputPath);
  }
  await runPowerShell(
    windowsCaptureScreenScript,
    {
      buttonName: input.buttonName,
      outputPath: input.outputPath,
      processId: input.processId,
      roleName: input.roleName
    }
  );
  return validatePackagedPngArtifact(input.outputPath);
}

export function parsePackagedScreenRectangle(value) {
  const match = /^(-?\d+),(-?\d+),(\d+),(\d+)$/u.exec(value);
  if (!match) throw new Error("Packaged role window returned an invalid screen rectangle.");
  const values = match.slice(1).map(Number);
  if (
    values.some((entry) => !Number.isSafeInteger(entry)) ||
    Math.abs(values[0]) > 131_072 || Math.abs(values[1]) > 131_072 ||
    values[2] <= 0 || values[2] > 16_384 ||
    values[3] <= 0 || values[3] > 16_384 ||
    values[2] * values[3] > 64 * 1024 * 1024
  ) {
    throw new Error("Packaged role window returned an unsafe screen rectangle.");
  }
  return values.join(",");
}

export async function validatePackagedPngArtifact(outputPath) {
  if (
    typeof outputPath !== "string" || outputPath.length === 0 ||
    outputPath.includes("\0")
  ) {
    throw new Error("Packaged screenshot requires an exact output path.");
  }
  const pathMetadata = await lstat(outputPath, { bigint: true });
  assertBoundedRegularScreenshot(pathMetadata);
  const noFollow = typeof fileConstants.O_NOFOLLOW === "number"
    ? fileConstants.O_NOFOLLOW
    : 0;
  const handle = await open(
    outputPath,
    fileConstants.O_RDONLY | noFollow
  );
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameScreenshotFile(pathMetadata, openedMetadata);
    assertBoundedRegularScreenshot(openedMetadata);
    const bytes = await readExactScreenshotBytes(handle, openedMetadata.size);
    const completedMetadata = await handle.stat({ bigint: true });
    assertSameScreenshotFile(openedMetadata, completedMetadata);
    const completedPathMetadata = await lstat(outputPath, { bigint: true });
    assertSameScreenshotFile(completedMetadata, completedPathMetadata);
    assertPngBytes(bytes);
    return Object.freeze({
      byteLength: bytes.length,
      path: resolve(outputPath),
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    await handle.close();
  }
}

async function readExactScreenshotBytes(handle, expectedSize) {
  const length = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, offset);
    if (result.bytesRead === 0) {
      throw new Error("Packaged screenshot changed while it was being read.");
    }
    offset += result.bytesRead;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const result = await handle.read(sentinel, 0, 1, length);
  if (result.bytesRead !== 0) {
    throw new Error("Packaged screenshot exceeded its bound while being read.");
  }
  return bytes;
}

function assertBoundedRegularScreenshot(metadata) {
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    throw new Error(
      "Packaged screenshot is not an exclusively linked regular file."
    );
  }
  if (
    metadata.size <= 0n || metadata.size > BigInt(MAX_SCREENSHOT_BYTES)
  ) {
    throw new Error("Packaged screenshot exceeds its safe byte bound.");
  }
}

function assertSameScreenshotFile(expected, observed) {
  if (
    !observed.isFile() ||
    expected.dev !== observed.dev || expected.ino !== observed.ino ||
    expected.size !== observed.size || expected.mtimeNs !== observed.mtimeNs ||
    expected.ctimeNs !== observed.ctimeNs
  ) {
    throw new Error("Packaged screenshot identity changed before validation.");
  }
}

function assertPngBytes(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Packaged screenshot is not a PNG image.");
  }
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let idatBytes = 0;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("Packaged screenshot contains a truncated PNG chunk.");
    }
    const dataLength = bytes.readUInt32BE(offset);
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.length) {
      throw new Error("Packaged screenshot contains an unsafe PNG chunk.");
    }
    const type = bytes.toString("ascii", offset + 4, dataOffset);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new Error("Packaged screenshot contains an invalid PNG chunk type.");
    }
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const observedCrc = pngCrc32(bytes, offset + 4, crcOffset);
    if (expectedCrc !== observedCrc) {
      throw new Error("Packaged screenshot contains a corrupt PNG chunk.");
    }
    if (chunkIndex === 0) assertPngHeader(bytes, type, dataOffset, dataLength);
    else if (type === "IHDR") {
      throw new Error("Packaged screenshot contains a duplicate PNG header.");
    }
    if (type === "IDAT") idatBytes += dataLength;
    if (type === "IEND") {
      if (dataLength !== 0 || nextOffset !== bytes.length) {
        throw new Error("Packaged screenshot contains an invalid PNG terminator.");
      }
      sawIend = true;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  if (!sawIend || idatBytes === 0) {
    throw new Error("Packaged screenshot contains an incomplete PNG image.");
  }
}

function assertPngHeader(bytes, type, dataOffset, dataLength) {
  if (type !== "IHDR" || dataLength !== 13) {
    throw new Error("Packaged screenshot does not begin with a PNG header.");
  }
  const width = bytes.readUInt32BE(dataOffset);
  const height = bytes.readUInt32BE(dataOffset + 4);
  const bitDepth = bytes[dataOffset + 8];
  const colorType = bytes[dataOffset + 9];
  const allowedDepths = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]]
  ]);
  if (
    width === 0 || width > 16_384 || height === 0 || height > 16_384 ||
    width * height > 64 * 1024 * 1024 ||
    !allowedDepths.get(colorType)?.includes(bitDepth) ||
    bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 ||
    ![0, 1].includes(bytes[dataOffset + 12])
  ) {
    throw new Error("Packaged screenshot contains an unsafe PNG header.");
  }
}

function pngCrc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runAppleScript(script, ...argumentsList) {
  const result = await execFileAsync("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    ...argumentsList
  ], { encoding: "utf8", timeout: UI_ACTION_DEADLINE_MS });
  return result.stdout.trim();
}

function runPowerShell(script, payload) {
  return runEncodedPowerShellJson(script, payload, {
    timeoutMilliseconds: UI_ACTION_DEADLINE_MS
  });
}

const windowsUiAutomationPrelude = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
function Rion-Windows([uint32]$processId) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$processId)
  return [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
}
function Rion-DescendantByName($window, [string]$name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Rion-ButtonByName($window, [string]$name) {
  $matches = @()
  foreach ($candidate in @(Rion-DescendantByName $window $name)) {
    if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
      $matches += $candidate
    }
  }
  return $matches
}
function Rion-ExactRoleContentWindows([uint32]$processId, [string]$roleName, [string]$buttonName) {
  $matches = @()
  $roleControlName = [String]::Concat("Activate ", $roleName)
  foreach ($window in @(Rion-Windows $processId)) {
    $roleElements = @(Rion-ButtonByName $window $roleControlName)
    $buttons = @(Rion-ButtonByName $window $buttonName)
    if ($roleElements.Count -eq 1 -and $buttons.Count -eq 1) {
      $matches += $window
    }
  }
  return $matches
}
function Rion-SendKeysLiteral([string]$value) {
  $escaped = [Regex]::Replace($value, '([+^%~(){}\[\]])', '{$1}')
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
}
`;

const windowsLaunchRoleScript = `${windowsUiAutomationPrelude}
$targetPid = [uint32]$payload.processId
$roleName = [string]$payload.roleName
if ($targetPid -eq 0 -or [String]::IsNullOrEmpty($roleName)) {
  throw "invalid packaged role launch identity"
}
for ($attempt = 0; $attempt -lt 300; $attempt++) {
  $dashboardWindows = @()
  foreach ($window in @(Rion-Windows $targetPid)) {
    if ((Rion-DescendantByName $window "Dashboard").Count -eq 1) { $dashboardWindows += $window }
  }
  if ($dashboardWindows.Count -eq 1) {
    $dashboardWindows[0].SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait("^k")
    Start-Sleep -Milliseconds 200
    Rion-SendKeysLiteral $roleName
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw "packaged dashboard did not become accessible"
`;

const windowsPressRoleContentScript = `${windowsUiAutomationPrelude}
$targetPid = [uint32]$payload.processId
$roleName = [string]$payload.roleName
$buttonName = [string]$payload.buttonName
if ($targetPid -eq 0 -or [String]::IsNullOrEmpty($roleName) -or [String]::IsNullOrEmpty($buttonName)) {
  throw "invalid packaged role content identity"
}
for ($attempt = 0; $attempt -lt 300; $attempt++) {
  $matches = @(Rion-ExactRoleContentWindows $targetPid $roleName $buttonName)
  if ($matches.Count -eq 1) {
    $buttons = @(Rion-ButtonByName $matches[0] $buttonName)
    $invoke = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    Write-Output "bundled-chromium"
    exit 0
  }
  if ($matches.Count -gt 1) { throw "ambiguous bundled Chromium role window" }
  Start-Sleep -Milliseconds 100
}
throw "bundled Chromium role content did not become accessible"
`;

const windowsCloseRoleWindowScript = `${windowsUiAutomationPrelude}
$targetPid = [uint32]$payload.processId
$roleName = [string]$payload.roleName
$buttonName = [string]$payload.buttonName
if ($targetPid -eq 0 -or [String]::IsNullOrEmpty($roleName) -or [String]::IsNullOrEmpty($buttonName)) {
  throw "invalid packaged role window identity"
}
$matches = @(Rion-ExactRoleContentWindows $targetPid $roleName $buttonName)
if ($matches.Count -ne 1) { throw "exact bundled Chromium role window unavailable" }
$nativeWindowHandle = [int]$matches[0].Current.NativeWindowHandle
if ($nativeWindowHandle -eq 0) { throw "exact bundled Chromium native window unavailable" }
$pattern = $matches[0].GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
$pattern.Close()
for ($attempt = 0; $attempt -lt 300; $attempt++) {
  $remaining = 0
  foreach ($window in @(Rion-Windows $targetPid)) {
    if ([int]$window.Current.NativeWindowHandle -eq $nativeWindowHandle) { $remaining += 1 }
  }
  if ($remaining -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 100
}
throw "bundled Chromium role window did not close"
`;

const windowsQuitApplicationScript = `${windowsUiAutomationPrelude}
$targetPid = [uint32]$payload.processId
if ($targetPid -eq 0) { throw "invalid packaged application identity" }
$matches = @()
foreach ($window in @(Rion-Windows $targetPid)) {
  if ((Rion-DescendantByName $window "Dashboard").Count -eq 1) { $matches += $window }
}
if ($matches.Count -ne 1) { throw "exact packaged main window unavailable" }
$matches[0].SetFocus()
[System.Windows.Forms.SendKeys]::SendWait("^q")
`;

const windowsCaptureScreenScript = `${windowsUiAutomationPrelude}
Add-Type -AssemblyName System.Drawing
$targetPid = [uint32]$payload.processId
$roleName = [string]$payload.roleName
$buttonName = [string]$payload.buttonName
$outputPath = [string]$payload.outputPath
if ($targetPid -eq 0 -or [String]::IsNullOrEmpty($roleName) -or
    [String]::IsNullOrEmpty($buttonName) -or [String]::IsNullOrEmpty($outputPath)) {
  throw "invalid packaged role capture identity"
}
$matches = @(Rion-ExactRoleContentWindows $targetPid $roleName $buttonName)
if ($matches.Count -ne 1) { throw "exact packaged role window unavailable for capture" }
$matches[0].SetFocus()
$bounds = $matches[0].Current.BoundingRectangle
$left = [int][Math]::Floor($bounds.Left)
$top = [int][Math]::Floor($bounds.Top)
$right = [int][Math]::Ceiling($bounds.Right)
$bottom = [int][Math]::Ceiling($bounds.Bottom)
$width = $right - $left
$height = $bottom - $top
if ($width -le 0 -or $width -gt 16384 -or
    $height -le 0 -or $height -gt 16384 -or
    [Math]::Abs($left) -gt 131072 -or [Math]::Abs($top) -gt 131072 -or
    ([long]$width * [long]$height) -gt 67108864) {
  throw "packaged role window returned unsafe capture bounds"
}
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;
