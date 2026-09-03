import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runEncodedPowerShellJson } from "./encodedPowerShell.mjs";

const execFileAsync = promisify(execFile);
const UI_ACTION_DEADLINE_MS = 45_000;
const CONTROLS = Object.freeze({
  check: "Check updates",
  install: "Restart and update",
  settings: "Settings",
  updates: "App update"
});

export async function openVisibleProductionUpdaterSettings(
  input,
  dependencyOverrides = {}
) {
  const validated = validateInput(input);
  const receipts = [];
  for (const control of ["settings", "updates"]) {
    receipts.push(await pressVisibleControl(validated, control, dependencyOverrides));
  }
  return deepFreeze({
    schemaVersion: 1,
    interaction: "visible-os-accessibility-press",
    platform: validated.platform,
    processId: validated.processId,
    remoteDebugging: false,
    controls: receipts
  });
}

export function pressVisibleProductionUpdaterCheck(input, dependencyOverrides = {}) {
  return pressVisibleControl(validateInput(input), "check", dependencyOverrides);
}

export function pressVisibleProductionUpdaterInstall(input, dependencyOverrides = {}) {
  return pressVisibleControl(validateInput(input), "install", dependencyOverrides);
}

async function pressVisibleControl(input, control, dependencyOverrides) {
  const label = CONTROLS[control];
  const now = dependencyOverrides.now ?? (() => new Date());
  const invokedAt = requiredNow(now(), "visible updater action invocation");
  if (input.platform === "darwin") {
    const runMacos = dependencyOverrides.runMacos ?? runMacosAccessibility;
    await runMacos(input.processId, label);
  } else {
    const runWindows = dependencyOverrides.runWindows ?? runWindowsAccessibility;
    await runWindows(input.processId, label);
  }
  const completedAt = requiredNow(now(), "visible updater action completion");
  if (Date.parse(completedAt) < Date.parse(invokedAt)) {
    throw new Error("The visible updater action completion cannot precede invocation.");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: "rion-production-updater-visible-ui-action",
    action: control,
    controlName: label,
    interaction: "visible-os-accessibility-press",
    invokedAt,
    completedAt,
    platform: input.platform,
    processId: input.processId,
    remoteDebugging: false
  });
}

function validateInput(input) {
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    !Object.is(Object.getPrototypeOf(input), Object.prototype) ||
    JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(["platform", "processId"])
  ) throw new Error("The visible updater action input schema is not exact.");
  if (input.platform !== "darwin" && input.platform !== "win32") {
    throw new Error("The visible updater action platform must be darwin or win32.");
  }
  if (!Number.isSafeInteger(input.processId) || input.processId <= 1) {
    throw new Error("The visible updater action requires one exact process ID.");
  }
  return Object.freeze({ platform: input.platform, processId: input.processId });
}

async function runMacosAccessibility(processId, controlName) {
  if (process.platform !== "darwin") {
    throw new Error("The macOS visible updater action requires a macOS host.");
  }
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    macosPressExactButtonScript,
    "--",
    String(processId),
    controlName
  ], { encoding: "utf8", timeout: UI_ACTION_DEADLINE_MS });
}

async function runWindowsAccessibility(processId, controlName) {
  if (process.platform !== "win32") {
    throw new Error("The Windows visible updater action requires a Windows host.");
  }
  await runEncodedPowerShellJson(windowsPressExactButtonScript, {
    controlName,
    processId
  }, { timeoutMilliseconds: UI_ACTION_DEADLINE_MS });
}

function requiredNow(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`The ${label} must be a valid Date.`);
  }
  return value.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

const macosPressExactButtonScript = String.raw`
on run argv
  set targetPid to (item 1 of argv) as integer
  set controlName to item 2 of argv
  if targetPid <= 1 then error "invalid exact Rion process ID"
  tell application "System Events"
    repeat 450 times
      set matchingProcesses to application processes whose unix id is targetPid
      if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
      set targetProcess to item 1 of matchingProcesses
      set matchingButton to missing value
      set matchCount to 0
      repeat with appWindow in windows of targetProcess
        repeat with candidateReference in entire contents of appWindow
          set candidate to contents of candidateReference
          try
            if role of candidate is "AXButton" and ¬
                (name of candidate is controlName or description of candidate is controlName) then
              set matchingButton to candidate
              set matchCount to matchCount + 1
            end if
          end try
        end repeat
      end repeat
      if matchCount > 1 then error "ambiguous exact Rion updater control"
      if matchCount is 1 then
        if enabled of matchingButton is true then
          set frontmost of targetProcess to true
          perform action "AXPress" of matchingButton
          return
        end if
      end if
      delay 0.1
    end repeat
    error "exact enabled Rion updater control did not become accessible"
  end tell
end run`;

const windowsPressExactButtonScript = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetPid = [int]$payload.processId
$controlName = [string]$payload.controlName
if ($targetPid -le 1 -or [String]::IsNullOrWhiteSpace($controlName)) {
  throw "invalid exact Rion updater control identity"
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$processCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$nameCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $controlName)
for ($attempt = 0; $attempt -lt 450; $attempt++) {
  $windows = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $processCondition))
  $matches = @()
  foreach ($window in $windows) {
    foreach ($candidate in @($window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants, $nameCondition))) {
      if ($candidate.Current.ControlType -eq
          [System.Windows.Automation.ControlType]::Button) {
        $matches += $candidate
      }
    }
  }
  if ($matches.Count -gt 1) { throw "ambiguous exact Rion updater control" }
  if ($matches.Count -eq 1 -and $matches[0].Current.IsEnabled) {
    $window = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($matches[0])
    $matches[0].SetFocus()
    $invoke = $matches[0].GetCurrentPattern(
      [System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw "exact enabled Rion updater control did not become accessible"`;
