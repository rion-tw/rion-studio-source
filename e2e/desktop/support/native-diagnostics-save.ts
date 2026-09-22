import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { windowsNativeDialogDeclarations } from "./windows-native-dialog";
import { windowsNativeTextInputDeclarations } from "./windows-native-text-input";

export async function saveVisibleDiagnostics(input: { platform: "macos" | "windows"; processId: number; path: string }): Promise<void> {
  if (!isAbsolute(input.path) || !input.path.endsWith("partial-diagnostics.zip") || !Number.isSafeInteger(input.processId) || input.processId < 1) {
    throw new Error("Diagnostics save requires its exact artifact path and application PID");
  }
  if (input.platform === "macos") {
    await promisify(execFile)("/usr/bin/xcrun", ["swift", fileURLToPath(new URL("./macos-native-file-panel.swift", import.meta.url)),
      String(input.processId), "save-file", input.path], { encoding: "utf8", timeout: 20_000 });
    return;
  }
  await runEncodedPowerShellJson(String.raw`
Add-Type -TypeDefinition @'
${windowsNativeDialogDeclarations}
${windowsNativeTextInputDeclarations}
'@
$targetPid = [int]$payload.processId
$expiry = [DateTime]::UtcNow.AddSeconds(15)
do {
  $dialogs = @([RionFileDialogOwnership]::OwnedWindows($targetPid, $true))
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) { throw 'ambiguous exact-PID save dialog' }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'save dialog unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
$dialog = $dialogs[0]
# Electron's modern Save dialog uses the filename ComboBox's Edit (1001).
# The legacy Open dialog filename ID (1148) is not present in this surface.
$edits = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1001, 'Edit'))
$buttons = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1, 'Button'))
if ($edits.Count -ne 1 -or $buttons.Count -ne 1) {
  $snapshot = [RionFileDialogOwnership]::DialogControlSnapshot($dialog) | ConvertTo-Json -Depth 5 -Compress
  throw "exact Save controls unavailable: $snapshot"
}
[RionFileDialogOwnership]::SetForegroundWindow($dialog) | Out-Null
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $edits[0], $targetPid)
# WM_SETTEXT changes this Edit's text without updating the modern shell's
# selected filename. Type through its visible input path, then verify readback.
[RionFileNameKeyboard]::Replace([string]$payload.path)
do {
  $actual = [RionFileDialogOwnership]::ReadExactFileName($dialog, $edits[0], $payload.path.Length + 2)
  if ($actual -ceq [string]$payload.path) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw "native filename input was not acknowledged: $actual" }
  Start-Sleep -Milliseconds 20
} while ($true)
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $buttons[0], $targetPid)
do {
  if (@([RionFileDialogOwnership]::OwnedWindows($targetPid, $true)).Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'Save dialog did not close' }
  Start-Sleep -Milliseconds 50
} while ($true)
`, input, { timeoutMilliseconds: 20_000 });
}
