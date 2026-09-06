import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { link, mkdtemp, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

const executeFile = promisify(execFile);

const FIXTURE_FILE_NAME = "rion-e2e.txt";
const FIXTURE_SOURCE = "Rion Studio Chromium visible file-upload parity fixture.\n";
const EVIDENCE_FILE_NAME = "electron-workspace-web-file-upload.json";
const WINDOWS_FAILURE_FILE_NAME = "windows-native-file-dialog-failure.json";

export interface NativeFileUploadFixture {
  readonly bytes: number;
  readonly fileName: string;
  readonly path: string;
  readonly sha256: string;
}

export interface VisibleFileUploadEvidenceInput {
  readonly fixture: NativeFileUploadFixture;
  readonly observed: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly platform: "macos" | "windows";
  readonly processId: number;
}

export interface VisibleNativeUploadSelection {
  cleanup(): Promise<void>;
}

function artifactDirectory(): string {
  const value = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error("An exact absolute desktop-E2E artifact directory is required");
  }
  return value;
}

/** Creates one bounded upload fixture inside the exact isolated phase directory. */
export async function prepareNativeFileUploadFixture(): Promise<
  NativeFileUploadFixture
> {
  const path = resolve(artifactDirectory(), FIXTURE_FILE_NAME);
  const payload = Buffer.from(FIXTURE_SOURCE, "utf8");
  await writeFile(path, payload);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== payload.byteLength) {
    throw new Error("The exact file-upload fixture was not materialized");
  }
  return Object.freeze({
    bytes: payload.byteLength,
    fileName: FIXTURE_FILE_NAME,
    path,
    sha256: createHash("sha256").update(payload).digest("hex")
  });
}

function validateSelectionInput(
  fixturePath: string,
  processId: number
): void {
  if (
    !Number.isSafeInteger(processId) || processId <= 0 ||
    !isAbsolute(fixturePath) || resolve(fixturePath) !== fixturePath ||
    basename(fixturePath) !== FIXTURE_FILE_NAME
  ) {
    throw new Error("The native file chooser requires one exact app PID and fixture path");
  }
}

function boundedPowerShellFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown failure";
  const failure = error as Readonly<{
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  }>;
  const fields = [
    `code=${String(failure.code ?? "unknown")}`,
    `killed=${String(failure.killed ?? false)}`,
    `signal=${String(failure.signal ?? "none")}`
  ];
  const output = [failure.stderr, failure.stdout]
    .filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    .join("\n")
    .trim();
  if (output.length > 0) fields.push(`output=${JSON.stringify(output.slice(-2_000))}`);
  return fields.join(", ");
}

async function selectMacosFile(
  fixturePath: string,
  processId: number
): Promise<VisibleNativeUploadSelection> {
  const stagingDirectory = await mkdtemp(
    resolve(homedir(), "RionE2E-")
  );
  const stagedFixturePath = resolve(stagingDirectory, FIXTURE_FILE_NAME);
  try {
    await link(fixturePath, stagedFixturePath);
  } catch (error) {
    await rmdir(stagingDirectory);
    throw error;
  }
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await unlink(stagedFixturePath);
    await rmdir(stagingDirectory);
  };
  const panelScript = String.raw`
using terms from application "System Events"
on filePanels(targetProcess)
  set matches to {}
  repeat with appWindow in windows of targetProcess
    try
      if subrole of appWindow is "AXDialog" then set end of matches to appWindow
    end try
    try
      repeat with appSheet in sheets of appWindow
        if role of appSheet is "AXSheet" then set end of matches to appSheet
      end repeat
    end try
  end repeat
  return matches
end filePanels

on run argv
  set targetPid to (item 1 of argv) as integer
  set expectedState to item 2 of argv
  set expiry to (current date) + 10
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set frontmost of targetProcess to true

    repeat
      set panels to my filePanels(targetProcess)
      if expectedState is "open" and (count of panels) is 1 then
        try
          perform action "AXRaise" of item 1 of panels
        end try
        exit repeat
      end if
      if expectedState is "closed" and (count of panels) is 0 then exit repeat
      if (current date) is greater than expiry then error "exact AppKit file panel state unavailable"
      delay 0.05
    end repeat
  end tell
end run
end using terms from`;
  const inputScript = String.raw`
import ApplicationServices
import Foundation

let environment = ProcessInfo.processInfo.environment
guard let processText = environment["RION_DESKTOP_E2E_NATIVE_UPLOAD_PID"],
      let processId = Int32(processText),
      let homeName = environment["RION_DESKTOP_E2E_NATIVE_UPLOAD_HOME_NAME"],
      let stagingName = environment["RION_DESKTOP_E2E_NATIVE_UPLOAD_STAGING_NAME"],
      let fixtureName = environment["RION_DESKTOP_E2E_NATIVE_UPLOAD_FILE_NAME"] else {
  fatalError("exact native upload input unavailable")
}

func copyAttribute(
  _ element: AXUIElement,
  _ attribute: CFString
) -> CFTypeRef? {
  var result: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute, &result)
  return error == .success ? result : nil
}

func attributeText(_ element: AXUIElement, _ attribute: CFString) -> String {
  guard let value = copyAttribute(element, attribute) else { return "?" }
  return String(describing: value)
}

func matchesItemName(_ element: AXUIElement, expected: String) -> Bool {
  let attributes = [
    kAXValueAttribute,
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXURLAttribute
  ]
  for attribute in attributes {
    guard let value = copyAttribute(element, attribute as CFString) else {
      continue
    }
    let text = String(describing: value)
    let decoded = text.removingPercentEncoding ?? text
    if decoded == expected ||
        decoded.hasSuffix("/" + expected) ||
        decoded.hasSuffix("/" + expected + "/") {
      return true
    }
  }
  return false
}

func directChildren(_ element: AXUIElement) -> [AXUIElement] {
  copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func relatedChildren(_ element: AXUIElement) -> [AXUIElement] {
  let attributes = [
    kAXChildrenAttribute,
    kAXVisibleChildrenAttribute,
    kAXRowsAttribute,
    kAXColumnsAttribute,
    kAXContentsAttribute
  ]
  return attributes.flatMap { attribute in
    copyAttribute(element, attribute as CFString) as? [AXUIElement] ?? []
  }
}

func findPanel(
  _ element: AXUIElement,
  depth: Int,
  inspectedNodes: inout Int
) -> AXUIElement? {
  guard depth <= 10, inspectedNodes < 600 else { return nil }
  inspectedNodes += 1
  let role = attributeText(element, kAXRoleAttribute as CFString)
  let subrole = attributeText(element, kAXSubroleAttribute as CFString)
  if role == (kAXSheetRole as String) || subrole == (kAXDialogSubrole as String) {
    return element
  }
  if role == "AXWebArea" { return nil }
  for child in directChildren(element) {
    if let panel = findPanel(
      child,
      depth: depth + 1,
      inspectedNodes: &inspectedNodes
    ) { return panel }
  }
  return nil
}

func findRole(
  _ element: AXUIElement,
  role: String,
  depth: Int
) -> AXUIElement? {
  guard depth <= 12 else { return nil }
  if attributeText(element, kAXRoleAttribute as CFString) == role {
    return element
  }
  for child in directChildren(element) {
    if let match = findRole(child, role: role, depth: depth + 1) {
      return match
    }
  }
  return nil
}

func actionNames(_ element: AXUIElement) -> [String] {
  var result: CFArray?
  guard AXUIElementCopyActionNames(element, &result) == .success,
        let actions = result as? [String] else { return [] }
  return actions
}

func currentPanel(_ application: AXUIElement) -> AXUIElement? {
  let windows =
    copyAttribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  for window in windows {
    var inspectedNodes = 0
    if let panel = findPanel(
      window,
      depth: 0,
      inspectedNodes: &inspectedNodes
    ) { return panel }
  }
  return nil
}

func findText(
  _ element: AXUIElement,
  value: String,
  depth: Int,
  inspectedNodes: inout Int
) -> AXUIElement? {
  guard depth <= 18, inspectedNodes < 5000 else { return nil }
  inspectedNodes += 1
  if matchesItemName(element, expected: value) {
    return element
  }
  for child in relatedChildren(element) {
    if let match = findText(
      child,
      value: value,
      depth: depth + 1,
      inspectedNodes: &inspectedNodes
    ) { return match }
  }
  return nil
}

func openTarget(_ element: AXUIElement) -> AXUIElement? {
  var candidate: AXUIElement? = element
  for _ in 0..<8 {
    guard let current = candidate else { return nil }
    if actionNames(current).contains("AXOpen") { return current }
    candidate = copyAttribute(
      current,
      kAXParentAttribute as CFString
    ) as! AXUIElement?
  }
  return nil
}

func recordSelectionFailure(_ application: AXUIElement, stage: String) {
  guard let output = environment["RION_DESKTOP_E2E_NATIVE_UPLOAD_DIAGNOSTIC_PATH"] else { return }
  var nodes: [[String: String]] = []
  func visit(_ element: AXUIElement, depth: Int) {
    guard depth <= 12, nodes.count < 300 else { return }
    let role = attributeText(element, kAXRoleAttribute as CFString)
    if role == "AXWebArea" { return }
    nodes.append([
      "role": role,
      "subrole": attributeText(element, kAXSubroleAttribute as CFString),
      "title": String(attributeText(element, kAXTitleAttribute as CFString).prefix(160)),
      "description": String(attributeText(element, kAXDescriptionAttribute as CFString).prefix(160)),
      "value": String(attributeText(element, kAXValueAttribute as CFString).prefix(160)),
      "actions": actionNames(element).joined(separator: ",")
    ])
    for child in directChildren(element) { visit(child, depth: depth + 1) }
  }
  if let panel = currentPanel(application) { visit(panel, depth: 0) }
  let report: [String: Any] = ["stage": stage, "processId": processId, "nodes": nodes]
  if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
    try? data.write(to: URL(fileURLWithPath: output))
  }
}

func waitAndOpen(
  _ value: String,
  application: AXUIElement,
  browserOnly: Bool
) {
  let expiry = Date().addingTimeInterval(10)
  repeat {
    if let panel = currentPanel(application) {
      var inspectedNodes = 0
      let searchRoot = browserOnly
        ? findRole(panel, role: "AXBrowser", depth: 0)
        : panel
      if let root = searchRoot, let text = findText(
        root,
        value: value,
        depth: 0,
        inspectedNodes: &inspectedNodes
      ), let target = openTarget(text) {
        _ = AXUIElementPerformAction(target, "AXOpen" as CFString)
        return
      }
    }
    Thread.sleep(forTimeInterval: 0.05)
  } while Date() <= expiry
  recordSelectionFailure(application, stage: value)
  FileHandle.standardError.write(Data(("exact native upload item unavailable: " + value + "\n").utf8))
  exit(1)
}

let application = AXUIElementCreateApplication(processId)
waitAndOpen(homeName, application: application, browserOnly: false)
waitAndOpen(stagingName, application: application, browserOnly: true)
waitAndOpen(fixtureName, application: application, browserOnly: true)
`;
  try {
    await executeFile("/usr/bin/osascript", [
      "-e",
      panelScript,
      "--",
      String(processId),
      "open"
    ], { encoding: "utf8", timeout: 15_000 });
    await executeFile("/usr/bin/swift", ["-e", inputScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        RION_DESKTOP_E2E_NATIVE_UPLOAD_DIAGNOSTIC_PATH: resolve(
          artifactDirectory(), "macos-native-file-dialog-failure.json"
        ),
        RION_DESKTOP_E2E_NATIVE_UPLOAD_FILE_NAME: FIXTURE_FILE_NAME,
        RION_DESKTOP_E2E_NATIVE_UPLOAD_HOME_NAME: basename(homedir()),
        RION_DESKTOP_E2E_NATIVE_UPLOAD_PID: String(processId),
        RION_DESKTOP_E2E_NATIVE_UPLOAD_STAGING_NAME: basename(stagingDirectory)
      },
      timeout: 15_000
    });
    await executeFile("/usr/bin/osascript", [
      "-e",
      panelScript,
      "--",
      String(processId),
      "closed"
    ], { encoding: "utf8", timeout: 15_000 });
    return Object.freeze({ cleanup });
  } catch (error) {
    await executeFile("/usr/sbin/screencapture", [
      "-x",
      resolve(artifactDirectory(), "native-file-panel-failure.png")
    ]);
    await cleanup();
    throw error;
  }
}

async function selectWindowsFile(
  fixturePath: string,
  processId: number
): Promise<void> {
  const script = String.raw`
function Write-Progress([string]$phase) {
  # Persist before native calls: UIA can stall before the failure snapshot runs.
  [IO.File]::WriteAllText([string]$payload.progressPath, (
    [ordered]@{ phase = $phase; processId = [int]$payload.processId } |
      ConvertTo-Json -Compress))
}
Write-Progress 'loading-automation'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RionFileDialogOwnership {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
Write-Progress 'reading-root'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetPid = [int]$payload.processId
$fixturePath = [string]$payload.fixturePath
$diagnosticPath = [string]$payload.diagnosticPath
$processCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$windowCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$classCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$commonDialogCondition = New-Object System.Windows.Automation.AndCondition(
  $windowCondition, $classCondition)
$directDialogCondition = New-Object System.Windows.Automation.AndCondition(
  $processCondition,
  $commonDialogCondition)
$editCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit')),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')))
$openCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Button')),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')))
$observedWindows = [ordered]@{}
$targetWindowHandles = @{}
Write-Progress 'reading-application-windows'
$targetWindows = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  (New-Object System.Windows.Automation.AndCondition(
    $processCondition, $windowCondition)))
foreach ($targetWindow in $targetWindows) {
  $targetHandle = [int64]$targetWindow.Current.NativeWindowHandle
  if ($targetHandle -gt 0) { $targetWindowHandles[[string]$targetHandle] = $true }
}

function Get-OwnerNativeWindowHandle($candidate) {
  $handle = [int64]$candidate.Current.NativeWindowHandle
  if ($handle -eq 0) { return [int64]0 }
  return [int64][RionFileDialogOwnership]::GetWindow([IntPtr]$handle, 4)
}

function Get-NativeWindowProcessId([int64]$handle) {
  if ($handle -eq 0) { return 0 }
  $windowProcessId = [uint32]0
  [RionFileDialogOwnership]::GetWindowThreadProcessId(
    [IntPtr]$handle, [ref]$windowProcessId) | Out-Null
  return [int]$windowProcessId
}

function Get-OwnerProcessId($candidate) {
  $ownerHandle = Get-OwnerNativeWindowHandle $candidate
  return Get-NativeWindowProcessId $ownerHandle
}

function Test-ExactFileDialogControls($candidate) {
  Write-Progress 'reading-dialog-controls'
  $edits = $candidate.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants, $editCondition)
  if ($edits.Count -ne 1) { return $false }
  $openButtons = $candidate.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants, $openCondition)
  return $openButtons.Count -eq 1
}

function Click-VisibleControl($control) {
  $point = $control.GetClickablePoint()
  if (![RionFileDialogOwnership]::SetCursorPos([int]$point.X, [int]$point.Y)) {
    throw 'Windows rejected the exact file control pointer location'
  }
  [RionFileDialogOwnership]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [RionFileDialogOwnership]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-LiteralKeys([string]$value) {
  $escaped = [Regex]::Replace($value, '([+^%~(){}\[\]])', '{$1}')
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
}

function Read-ExactDialogs {
  Write-Progress 'reading-direct-dialogs'
  $directDialogs = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $directDialogCondition)
  $matches = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  $matchedHandles = @{}
  foreach ($candidate in $directDialogs) {
    if (!(Test-ExactFileDialogControls $candidate)) { continue }
    $handle = [int64]$candidate.Current.NativeWindowHandle
    $matches.Add($candidate)
    $matchedHandles[[string]$handle] = $true
  }
  # The Windows common-item dialog can be absent from RootElement's direct
  # children even while its HWND is the active foreground window. Resolve that
  # exact HWND through UIA, then retain the same owner and semantic-control
  # fences used for enumerated candidates.
  Write-Progress 'reading-foreground-dialog'
  $foregroundHandle = [RionFileDialogOwnership]::GetForegroundWindow()
  if ($foregroundHandle -ne [IntPtr]::Zero) {
    try {
      $candidate =
        [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHandle)
      $current = $candidate.Current
      $handle = [int64]$current.NativeWindowHandle
      $ownerHandle = Get-OwnerNativeWindowHandle $candidate
      if (
        $handle -gt 0 -and
        !$matchedHandles.ContainsKey([string]$handle) -and
        $current.ClassName -eq '#32770' -and
        $targetWindowHandles.ContainsKey([string]$ownerHandle) -and
        (Test-ExactFileDialogControls $candidate)
      ) {
        $matches.Add($candidate)
        $matchedHandles[[string]$handle] = $true
      }
    } catch {}
  }
  Write-Progress 'reading-window-candidates'
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $windowCondition)
  foreach ($candidate in $windows) {
    $handle = [int64]$candidate.Current.NativeWindowHandle
    if ($handle -eq 0 -or $matchedHandles.ContainsKey([string]$handle)) { continue }
    $ownerHandle = Get-OwnerNativeWindowHandle $candidate
    if (!$targetWindowHandles.ContainsKey([string]$ownerHandle)) { continue }
    if (!(Test-ExactFileDialogControls $candidate)) { continue }
    $matches.Add($candidate)
    $matchedHandles[[string]$handle] = $true
  }
  return $matches
}

function Capture-WindowSnapshot {
  Write-Progress 'capturing-window-snapshot'
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $windowCondition)
  foreach ($candidate in $windows) {
    try {
      $current = $candidate.Current
      $handle = [int64]$current.NativeWindowHandle
      $ownerHandle = Get-OwnerNativeWindowHandle $candidate
      $ownerProcessId = Get-OwnerProcessId $candidate
      if (
        $current.ProcessId -ne $targetPid -and
        $current.ClassName -ne '#32770' -and
        $ownerProcessId -ne $targetPid
      ) { continue }
      $key = "$($current.ProcessId)|$handle|$($current.ClassName)|$($current.Name)"
      $observedWindows[$key] = [ordered]@{
        automationId = $current.AutomationId
        className = $current.ClassName
        controlType = $current.ControlType.ProgrammaticName
        isOffscreen = $current.IsOffscreen
        name = $current.Name
        nativeWindowHandle = $handle
        ownerNativeWindowHandle = $ownerHandle
        ownerProcessId = $ownerProcessId
        processId = $current.ProcessId
      }
    } catch {}
  }
}

function Write-FailureSnapshot {
  Capture-WindowSnapshot
  Write-Progress 'capturing-failure-snapshot'
  $foregroundHandle = [RionFileDialogOwnership]::GetForegroundWindow()
  $foregroundAutomationError = ''
  $foregroundProcessId = [uint32]0
  $foregroundOwnerHandle = [int64]0
  $foregroundOwnerProcessId = 0
  $foregroundClassName = ''
  $foregroundName = ''
  $foregroundExactEditCount = -1
  $foregroundExactOpenButtonCount = -1
  $foregroundControlCount = -1
  $foregroundControls = New-Object System.Collections.Generic.List[object]
  if ($foregroundHandle -ne [IntPtr]::Zero) {
    [RionFileDialogOwnership]::GetWindowThreadProcessId(
      $foregroundHandle, [ref]$foregroundProcessId) | Out-Null
    $foregroundOwnerHandle = [int64][RionFileDialogOwnership]::GetWindow(
      $foregroundHandle, 4)
    $foregroundOwnerProcessId = Get-NativeWindowProcessId $foregroundOwnerHandle
    try {
      $foregroundElement =
        [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHandle)
      $foregroundClassName = $foregroundElement.Current.ClassName
      $foregroundName = $foregroundElement.Current.Name
      $foregroundExactEditCount = $foregroundElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants, $editCondition).Count
      $foregroundExactOpenButtonCount = $foregroundElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants, $openCondition).Count
      $allForegroundControls = $foregroundElement.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
      $foregroundControlCount = $allForegroundControls.Count
      foreach ($control in $allForegroundControls) {
        if ($foregroundControls.Count -ge 160) { break }
        try {
          $controlCurrent = $control.Current
          $foregroundControls.Add([ordered]@{
            automationId = $controlCurrent.AutomationId
            className = $controlCurrent.ClassName
            controlType = $controlCurrent.ControlType.ProgrammaticName
            isOffscreen = $controlCurrent.IsOffscreen
            name = $controlCurrent.Name
            nativeWindowHandle = [int64]$controlCurrent.NativeWindowHandle
            processId = $controlCurrent.ProcessId
          })
        } catch {}
      }
    } catch {
      $foregroundAutomationError = $_.Exception.ToString()
    }
  }
  $snapshot = [ordered]@{
    foregroundAutomationError = $foregroundAutomationError
    foregroundClassName = $foregroundClassName
    foregroundControlCount = $foregroundControlCount
    foregroundControls = $foregroundControls.ToArray()
    foregroundExactEditCount = $foregroundExactEditCount
    foregroundExactOpenButtonCount = $foregroundExactOpenButtonCount
    foregroundNativeWindowHandle = [int64]$foregroundHandle
    foregroundName = $foregroundName
    foregroundOwnerNativeWindowHandle = $foregroundOwnerHandle
    foregroundOwnerProcessId = $foregroundOwnerProcessId
    foregroundProcessId = [int]$foregroundProcessId
    observedWindows = @($observedWindows.Values)
    targetProcessId = $targetPid
  }
  [IO.File]::WriteAllText(
    $diagnosticPath, ($snapshot | ConvertTo-Json -Depth 5))
}

$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  Capture-WindowSnapshot
  # PowerShell enumerates a one-item List returned from a function into the
  # element itself. Re-wrap every read so StrictMode always sees an array and
  # the exact-cardinality fence remains valid for zero, one, or many dialogs.
  $dialogs = @(Read-ExactDialogs)
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) {
    Write-FailureSnapshot
    throw 'multiple exact-owner Windows file dialogs'
  }
  if ([DateTime]::UtcNow -gt $expiry) {
    Write-FailureSnapshot
    throw 'exact-owner Windows file dialog unavailable'
  }
  Start-Sleep -Milliseconds 50
} while ($true)
Write-Progress 'dialog-matched'
$dialog = $dialogs[0]
$edits = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants, $editCondition)
if ($edits.Count -ne 1) { throw 'exact Windows file-name control unavailable' }
$openButtons = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants, $openCondition)
if ($openButtons.Count -ne 1) { throw 'exact Windows Open control unavailable' }
if ($edits[0].Current.IsOffscreen -or !$edits[0].Current.IsEnabled -or
    $openButtons[0].Current.IsOffscreen -or !$openButtons[0].Current.IsEnabled) {
  throw 'exact Windows file dialog controls are not visibly actionable'
}
Write-Progress 'focusing-dialog'
# Native file controls can reject UIA SetFocus. Click the exact visible
# file-name control and require its dialog to own foreground before typing.
$dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
[RionFileDialogOwnership]::SetForegroundWindow($dialogHandle) | Out-Null
Click-VisibleControl $edits[0]
if ([RionFileDialogOwnership]::GetForegroundWindow() -ne $dialogHandle) {
  throw 'exact Windows file dialog is not foreground for input'
}
Write-Progress 'entering-file-name'
[System.Windows.Forms.SendKeys]::SendWait('^a')
Send-LiteralKeys $fixturePath
Write-Progress 'submitting-open'
Click-VisibleControl $openButtons[0]
do {
  $dialogs = @(Read-ExactDialogs)
  if ($dialogs.Count -eq 0) { Write-Progress 'dialog-closed'; break }
  if ([DateTime]::UtcNow -gt $expiry) {
    Write-FailureSnapshot
    throw 'Windows file dialog did not close'
  }
  Start-Sleep -Milliseconds 50
} while ($true)
`;
  try {
    await runEncodedPowerShellJson(script, {
      diagnosticPath: resolve(artifactDirectory(), WINDOWS_FAILURE_FILE_NAME),
      progressPath: resolve(artifactDirectory(), "windows-native-file-dialog-progress.json"),
      fixturePath,
      processId
    }, {
      timeoutMilliseconds: 15_000
    });
  } catch (error) {
    const diagnostic = boundedPowerShellFailure(error);
    throw new Error(`Windows native file chooser helper failed: ${diagnostic}`, {
      cause: error
    });
  }
}

/**
 * Selects the isolated fixture through the unique OS-native dialog owned by an
 * exact native window of the Electron app PID. The deadline is an
 * external-liveness failure only; success requires the dialog's native close
 * event/state.
 */
export async function selectVisibleNativeUploadFile(input: Readonly<{
  fixturePath: string;
  platform: "macos" | "windows";
  processId: number;
}>): Promise<VisibleNativeUploadSelection> {
  validateSelectionInput(input.fixturePath, input.processId);
  if (input.platform === "macos") {
    return selectMacosFile(input.fixturePath, input.processId);
  }
  await selectWindowsFile(input.fixturePath, input.processId);
  return Object.freeze({ cleanup: async (): Promise<void> => undefined });
}

/** Writes detached evidence only after the visible page reports the selected file. */
export async function writeVisibleFileUploadEvidence(
  input: VisibleFileUploadEvidenceInput
): Promise<void> {
  await writeFile(
    resolve(artifactDirectory(), EVIDENCE_FILE_NAME),
    `${JSON.stringify(Object.freeze({
      dialogOwnership: "exact-application-native-owner",
      fixture: input.fixture,
      nativeDialog: input.platform === "macos"
        ? "appkit-open-panel"
        : "windows-common-item-dialog",
      observed: input.observed,
      platform: input.platform,
      processId: input.processId,
      selector: "#file-upload",
      visibleAction: true
    }), null, 2)}\n`
  );
}
