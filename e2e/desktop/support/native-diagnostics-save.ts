import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { windowsNativeDialogDeclarations } from "./windows-native-dialog";

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
$edits = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1148, 'Edit'))
$buttons = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1, 'Button'))
if ($edits.Count -ne 1 -or $buttons.Count -ne 1) { throw 'exact Save controls unavailable' }
[RionFileDialogOwnership]::SetForegroundWindow($dialog) | Out-Null
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $edits[0], $targetPid)
[RionFileDialogOwnership]::SetExactFileName($dialog, $edits[0], [string]$payload.path)
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $buttons[0], $targetPid)
do {
  if (@([RionFileDialogOwnership]::OwnedWindows($targetPid, $true)).Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'Save dialog did not close' }
  Start-Sleep -Milliseconds 50
} while ($true)
`, input, { timeoutMilliseconds: 20_000 });
}
