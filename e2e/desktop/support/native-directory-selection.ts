import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { windowsNativeDialogDeclarations } from "./windows-native-dialog";
import { captureNativeProcessAttribution } from "./native-process-attribution";

const execute = promisify(execFile);

/** Operates the actual chooser opened by the visible consent action. */
export async function selectNativeChromeImportDirectory(input: Readonly<{
  path: string;
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  if (!isAbsolute(input.path) || !input.path.endsWith("chrome-import-source") ||
      !Number.isSafeInteger(input.processId) || input.processId <= 0) {
    throw new Error("The directory chooser requires the exact fixture and application PID");
  }
  if (input.platform === "windows") {
    await runEncodedPowerShellJson(String.raw`
Add-Type -TypeDefinition @'
${windowsNativeDialogDeclarations}
'@
$targetPid = [int]$payload.processId
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  $dialogs = @([RionFileDialogOwnership]::OwnedWindows($targetPid, $true))
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) { throw 'multiple exact-owner folder dialogs' }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'exact-owner folder dialog unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
$dialog = $dialogs[0]
$edits = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1152, 'Edit'))
if ($edits.Count -ne 1) { throw 'exact native folder-name edit unavailable' }
$buttons = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 1, 'Button'))
if ($buttons.Count -ne 1) { throw 'exact native Select Folder button unavailable' }
[RionFileDialogOwnership]::SetForegroundWindow($dialog) | Out-Null
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $edits[0], $targetPid)
[RionFileDialogOwnership]::SetExactFileName($dialog, $edits[0], [string]$payload.path)
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $buttons[0], $targetPid)
do {
  if (@([RionFileDialogOwnership]::OwnedWindows($targetPid, $true)).Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'native folder dialog did not close' }
  Start-Sleep -Milliseconds 50
} while ($true)
`, input, { timeoutMilliseconds: 15_000 });
    return;
  }
  await execute("/usr/bin/xcrun", [
    "swift", fileURLToPath(new URL("./macos-native-directory.swift", import.meta.url)),
    String(input.processId), input.path
  ], {
    timeout: 15_000,
    encoding: "utf8"
  }).catch(async (error: unknown) => {
    await captureNativeProcessAttribution();
    throw error;
  });
}
