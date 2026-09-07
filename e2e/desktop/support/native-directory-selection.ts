import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

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
  const script = String.raw`
on run argv
  set targetPid to (item 1 of argv) as integer
  set fixturePath to item 2 of argv
  set expiry to (current date) + 10
  tell application "System Events"
    set matches to application processes whose unix id is targetPid
    if (count of matches) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matches
    set frontmost of targetProcess to true
    tell targetProcess
      repeat
        set panels to {}
        repeat with appWindow in windows
          if subrole of appWindow is "AXDialog" then set end of panels to appWindow
          repeat with appSheet in sheets of appWindow
            set end of panels to appSheet
          end repeat
        end repeat
        if (count of panels) is 1 then exit repeat
        if (count of panels) > 1 then error "multiple exact-owner folder panels"
        if (current date) > expiry then error "exact folder panel unavailable"
        delay 0.05
      end repeat
      set panel to item 1 of panels
      keystroke "g" using {command down, shift down}
      repeat until (count of sheets of panel) is 1
        if (current date) > expiry then error "Go to Folder sheet unavailable"
        delay 0.05
      end repeat
      set pathSheet to sheet 1 of panel
      set fields to text fields of pathSheet
      if (count of fields) is not 1 then error "exact folder path field unavailable"
      set value of item 1 of fields to fixturePath
      key code 36
      repeat while (count of sheets of panel) is not 0
        if (current date) > expiry then error "Go to Folder did not complete"
        delay 0.05
      end repeat
      set openButtons to buttons of panel whose name is "Open"
      if (count of openButtons) is not 1 then error "exact folder Open button unavailable"
      click item 1 of openButtons
    end tell
  end tell
end run`;
  await execute("/usr/bin/osascript", ["-e", script, "--", String(input.processId), input.path], {
    timeout: 15_000,
    encoding: "utf8"
  }).catch(async (error: unknown) => {
    await captureNativeProcessAttribution();
    throw error;
  });
}
