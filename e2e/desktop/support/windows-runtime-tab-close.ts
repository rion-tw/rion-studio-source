import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";

export interface WindowsRuntimeTabCloseEvidence {
  readonly controlName: string;
  readonly nativeHandle: string;
  readonly processId: number;
  readonly tabId: string;
  readonly windowId: string;
}

interface NativeClosePort {
  readonly platform: NodeJS.Platform;
  readonly run: typeof runEncodedPowerShellJson;
}

const nativePort = (): NativeClosePort => ({ platform: process.platform, run: runEncodedPowerShellJson });

const accessibility = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetPid = [int]$payload.processId
$controlName = [string]$payload.controlName
$nameCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $controlName)
function FindCloseButton($window) {
  $buttons = @($window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants, $nameCondition) | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      $_.Current.IsEnabled -and -not $_.Current.IsOffscreen
    })
  return $buttons
}
`;

function validateIdentity(input: Readonly<{
  processId: number; tabId: string; windowId: string; controlName: string;
}>, platform: NodeJS.Platform): void {
  if (platform !== "win32" || !Number.isSafeInteger(input.processId) ||
      input.processId <= 1 || !input.tabId || !input.windowId ||
      !input.controlName.startsWith("Stop and close ")) {
    throw new Error("Native tab close requires exact Windows process and control evidence");
  }
}

/** Capture one visible native control before opening a deliberately gated popup. */
export async function readWindowsRuntimeTabCloseEvidence(input: Readonly<{
  processId: number; tabId: string; windowId: string; controlName: string;
}>, port: NativeClosePort = nativePort()): Promise<WindowsRuntimeTabCloseEvidence> {
  validateIdentity(input, port.platform);
  const output = await port.run(accessibility + String.raw`
$processCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$matches = @()
foreach ($window in @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $processCondition))) {
  foreach ($button in @(FindCloseButton $window)) {
    $matches += @{ nativeHandle = [string]$window.Current.NativeWindowHandle; controlName = $button.Current.Name }
  }
}
if ($matches.Count -ne 1) { throw 'The exact visible parent tab close control is not unique' }
$matches[0] | ConvertTo-Json -Compress
`, input, { timeoutMilliseconds: 30_000 });
  const result = JSON.parse(output) as { nativeHandle?: unknown; controlName?: unknown };
  if (typeof result.nativeHandle !== "string" || !/^[1-9]\d*$/u.test(result.nativeHandle) ||
      result.controlName !== input.controlName) {
    throw new Error("Windows returned malformed tab close evidence");
  }
  return Object.freeze({ ...input, nativeHandle: result.nativeHandle });
}

/** Native UI Automation remains usable while ChromeDriver's target list is waiting. */
export async function closeWindowsRuntimeTabFromEvidence(
  evidence: WindowsRuntimeTabCloseEvidence,
  port: NativeClosePort = nativePort()
): Promise<void> {
  validateIdentity(evidence, port.platform);
  if (!/^[1-9]\d*$/u.test(evidence.nativeHandle)) throw new Error("Invalid native close handle");
  await port.run(accessibility + String.raw`
$window = [System.Windows.Automation.AutomationElement]::FromHandle(
  [IntPtr]::new([long]$payload.nativeHandle))
if ($null -eq $window -or $window.Current.ProcessId -ne $targetPid -or $window.Current.IsOffscreen) {
  throw 'The exact parent native window retired or became invisible'
}
$buttons = @(FindCloseButton $window)
if ($buttons.Count -ne 1) { throw 'The exact visible parent tab close control changed' }
$buttons[0].SetFocus()
$invoke = $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
`, { ...evidence }, { timeoutMilliseconds: 30_000 });
}
