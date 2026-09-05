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
  fatalError("exact native upload item unavailable: " + value)
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
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetPid = [int]$payload.processId
$fixturePath = [string]$payload.fixturePath
$processCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$windowCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$classCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$dialogCondition = New-Object System.Windows.Automation.AndCondition(
  $processCondition,
  (New-Object System.Windows.Automation.AndCondition(
    $windowCondition, $classCondition)))
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  $dialogs = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $dialogCondition)
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) { throw 'multiple exact-PID Windows file dialogs' }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'exact-PID Windows file dialog unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
$dialog = $dialogs[0]
$editCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')))
$edits = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants, $editCondition)
if ($edits.Count -ne 1) { throw 'exact Windows file-name control unavailable' }
$value = $edits[0].GetCurrentPattern(
  [System.Windows.Automation.ValuePattern]::Pattern)
$value.SetValue($fixturePath)
$openCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')))
$openButtons = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants, $openCondition)
if ($openButtons.Count -ne 1) { throw 'exact Windows Open control unavailable' }
$invoke = $openButtons[0].GetCurrentPattern(
  [System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
do {
  $dialogs = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $dialogCondition)
  if ($dialogs.Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'Windows file dialog did not close' }
  Start-Sleep -Milliseconds 50
} while ($true)
`;
  await runEncodedPowerShellJson(script, { fixturePath, processId }, {
    timeoutMilliseconds: 15_000
  });
}

/**
 * Selects the isolated fixture through the unique OS-native dialog owned by the
 * exact Electron app PID. The deadline is an external-liveness failure only;
 * success requires the dialog's native close event/state.
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
      dialogOwnership: "exact-app-process",
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
