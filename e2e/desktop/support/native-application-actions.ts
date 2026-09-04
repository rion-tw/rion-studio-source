import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe } from "./electron-driver";

const executeFile = promisify(execFile);

function validProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function cancelMacosNativeSaveDialog(processId: number): Promise<void> {
  const script = String.raw`
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
  set expiry to (current date) + 10
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set frontmost of targetProcess to true
    repeat
      set panels to my filePanels(targetProcess)
      if (count of panels) is 1 then exit repeat
      if (count of panels) is greater than 1 then error "multiple exact AppKit file panels"
      if (current date) is greater than expiry then error "exact AppKit save panel unavailable"
      delay 0.05
    end repeat
    key code 53
    repeat
      if (count of my filePanels(targetProcess)) is 0 then exit repeat
      if (current date) is greater than expiry then error "AppKit save panel did not close"
      delay 0.05
    end repeat
  end tell
end run`;
  await executeFile("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    String(processId)
  ], { encoding: "utf8", timeout: 15_000 });
}

async function cancelWindowsNativeSaveDialog(processId: number): Promise<void> {
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetPid = [int]$payload.processId
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
    $windowCondition, $classCondition))
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  $dialogs = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $dialogCondition)
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) { throw 'multiple exact-PID Windows save dialogs' }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'exact-PID Windows save dialog unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
$dialog = $dialogs[0]
$cancelCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '2')))
$cancelButtons = $dialog.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants, $cancelCondition)
if ($cancelButtons.Count -ne 1) { throw 'exact Windows Cancel control unavailable' }
$invoke = $cancelButtons[0].GetCurrentPattern(
  [System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
do {
  $dialogs = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $dialogCondition)
  if ($dialogs.Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'Windows save dialog did not close' }
  Start-Sleep -Milliseconds 50
} while ($true)
`;
  await runEncodedPowerShellJson(script, { processId }, {
    timeoutMilliseconds: 15_000
  });
}

/** Cancels the unique native diagnostics save panel owned by the exact app PID. */
export async function cancelVisibleNativeDiagnosticsSaveDialog(input: Readonly<{
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  if (!validProcessId(input.processId)) {
    throw new Error("The diagnostics save dialog requires one exact app PID");
  }
  if (input.platform === "macos") {
    await cancelMacosNativeSaveDialog(input.processId);
  } else {
    await cancelWindowsNativeSaveDialog(input.processId);
  }
}

export type VisibleWindowsApplicationShortcut =
  | "escape"
  | "newGameWindow"
  | "toggleFullscreen"
  | "zoomIn"
  | "zoomReset";

export type VisibleMacosApplicationShortcut =
  | "escape"
  | "newGameWindow"
  | "quickAccess"
  | "toggleFullscreen"
  | "zoomIn"
  | "zoomReset";

export type VisibleApplicationShortcutTargetMode =
  | "focused-runtime"
  | "launcher";

/** Sends one native accelerator to the selected exact-PID macOS window mode. */
export async function pressVisibleMacosApplicationShortcut(input: Readonly<{
  command: VisibleMacosApplicationShortcut;
  processId: number;
  runtimeTabName?: string;
  targetMode?: VisibleApplicationShortcutTargetMode;
}>): Promise<void> {
  if (process.platform !== "darwin" || !validProcessId(input.processId)) {
    throw new Error("The native macOS shortcut requires one exact app PID");
  }
  if (
    input.targetMode === "focused-runtime" &&
    (!input.runtimeTabName || input.runtimeTabName.trim() !== input.runtimeTabName)
  ) {
    throw new Error("The focused macOS runtime shortcut requires one exact AppKit tab");
  }
  const script = String.raw`
on run argv
  set targetPid to (item 1 of argv) as integer
  set commandName to item 2 of argv
  set targetMode to item 3 of argv
  set runtimeTabName to item 4 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    if targetMode is "launcher" then
      set frontmost of targetProcess to true
      -- Process activation and AXFocusedWindow publication are separate AppKit
      -- events. Fence the exact native terminal state before reading NSMenu.
      set activationExpiry to (current date) + 10
      repeat
        set launcherWindow to missing value
        set launcherMainWindow to missing value
        try
          set launcherWindow to value of attribute "AXFocusedWindow" of targetProcess
          set launcherMainWindow to value of attribute "AXMainWindow" of targetProcess
        end try
        if frontmost of targetProcess is true and launcherWindow is not missing value and launcherMainWindow is not missing value then exit repeat
        if (current date) is greater than activationExpiry then error "exact Rion launcher AXWindow unavailable after activation"
        delay 0.05
      end repeat
      if value of attribute "AXRole" of launcherWindow is not "AXWindow" then error "focused Rion launcher owner is not an AXWindow"
      if value of attribute "AXMain" of launcherWindow is not true then error "exact Rion launcher AXWindow is not main"
      if launcherMainWindow is not launcherWindow then error "focused Rion launcher AXWindow is not the exact main AXWindow"
      set fileMenuItems to menu bar items of menu bar 1 of targetProcess whose name is "File"
      if (count of fileMenuItems) is not 1 then error "exact Rion File NSMenu unavailable"
      set newWindowItems to menu items of menu 1 of item 1 of fileMenuItems whose name is "New Game Window"
      if (count of newWindowItems) is not 1 then error "exact Rion New Game Window NSMenu item unavailable"
      if enabled of item 1 of newWindowItems is not true then error "exact Rion New Game Window NSMenu item is disabled"
    else if targetMode is "focused-runtime" then
      if frontmost of targetProcess is not true then error "exact Rion runtime process is not frontmost"
      set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
      if focusedWindow is missing value then error "exact Rion focused runtime window unavailable"
      if value of attribute "AXRole" of focusedWindow is not "AXWindow" then error "focused Rion runtime owner is not an AXWindow"
      -- AXFocusedWindow is the authoritative window-level owner. Once the
      -- Chromium child owns keyboard focus, AXFocused belongs to that child,
      -- so requiring AXFocused=true on the AXWindow would reject valid focus.
      if value of attribute "AXMain" of focusedWindow is not true then error "exact Rion runtime AXWindow is not main"
      set mainWindow to value of attribute "AXMainWindow" of targetProcess
      if mainWindow is missing value then error "exact Rion main AXWindow unavailable"
      if mainWindow is not focusedWindow then error "focused Rion runtime AXWindow is not the exact main AXWindow"
      set focusedWindowFullscreen to false
      try
        set focusedWindowFullscreen to (value of attribute "AXFullScreen" of focusedWindow is true)
      end try
      set fullscreenRestoreOwner to false
      if commandName is "toggleFullscreen" then
        if focusedWindowFullscreen is true then set fullscreenRestoreOwner to true
      end if
      if fullscreenRestoreOwner is false then
        set runtimeTab to missing value
        set runtimeTabCount to 0
        set runtimeRadioCount to 0
        set runtimeRoleReadErrorCount to 0
        -- The entire-contents expression is an AppleScript object specifier. Materialize it
        -- before iteration or per-element AX attribute reads fail lazily and an
        -- empty try block can make a populated process look like it has no tabs.
        -- Scope the accessibility walk to the already-fenced focused window.
        -- Enumerating the whole Electron process also walks every Chromium
        -- document and can exceed the bounded native-action transaction.
        set runtimeElements to get entire contents of focusedWindow
        repeat with candidateReference in runtimeElements
          set candidate to contents of candidateReference
          try
            if value of attribute "AXRole" of candidate is "AXRadioButton" then
              set runtimeRadioCount to runtimeRadioCount + 1
              if value of attribute "AXDescription" of candidate is runtimeTabName then
                set runtimeTab to candidate
                set runtimeTabCount to runtimeTabCount + 1
              end if
            end if
          on error
            set runtimeRoleReadErrorCount to runtimeRoleReadErrorCount + 1
          end try
        end repeat
        if runtimeTabCount is not 1 then error "focused Rion AXWindow is not the exact AppKit runtime owner (markers " & runtimeTabCount & ", radios " & runtimeRadioCount & ", unreadable " & runtimeRoleReadErrorCount & ")"
        set runtimeTabWindow to value of attribute "AXWindow" of runtimeTab
        if runtimeTabWindow is missing value then error "exact AppKit runtime tab has no AXWindow owner"
        if value of attribute "AXRole" of runtimeTabWindow is not "AXWindow" then error "exact AppKit runtime tab owner is not an AXWindow"
        if runtimeTabWindow is not focusedWindow then error "exact AppKit runtime tab does not belong to the focused AXWindow"
      end if
      if commandName is "toggleFullscreen" then
        set viewMenuItems to menu bar items of menu bar 1 of targetProcess whose name is "View"
        if (count of viewMenuItems) is not 1 then error "exact Rion View NSMenu unavailable"
        set fullscreenItems to menu items of menu 1 of item 1 of viewMenuItems whose name is "Toggle Full Screen"
        if (count of fullscreenItems) is not 1 then error "exact Rion Toggle Full Screen NSMenu item unavailable"
        if enabled of item 1 of fullscreenItems is not true then error "exact Rion Toggle Full Screen NSMenu item is disabled"
      end if
    else
      error "unsupported macOS application shortcut target mode"
    end if
    if frontmost of targetProcess is not true then error "exact Rion process lost foreground before shortcut"
    if commandName is "escape" then
      -- Exact focus and AppKit ownership are validated above. Escape is posted
      -- directly to the validated PID after this accessibility transaction.
      set escapeValidated to true
    else if commandName is "newGameWindow" then
      -- Physical ANSI N is stable across active macOS input sources while
      -- still exercising the installed Command+N native menu accelerator.
      key code 45 using command down
    else if commandName is "quickAccess" then
      -- Physical ANSI K exercises the managed Chromium before-input owner
      -- after the exact focused AppKit runtime tab was validated above.
      key code 40 using command down
    else if commandName is "toggleFullscreen" then
      -- Physical ANSI F preserves Control+Command+F under non-Latin input
      -- sources while still exercising the installed native accelerator.
      key code 3 using {control down, command down}
      -- AXFullScreen is the authoritative native presentation readback. Do not
      -- return the input transaction while AppKit is still transferring the
      -- window between Spaces: a Chromium driver request issued in that gap can
      -- lose its callback even though the native transition completes.
      set expectedFullscreen to not focusedWindowFullscreen
      set transitionExpiry to (current date) + 10
      repeat
        set currentFullscreen to false
        set currentFullscreenRead to false
        set currentFocusedWindow to missing value
        set currentMainWindow to missing value
        try
          -- AppKit republishes AXWindow proxy objects across Space changes, so
          -- reacquire the exact current main/focused owner instead of comparing
          -- the new accessibility proxy with the pre-transition object.
          set currentFocusedWindow to value of attribute "AXFocusedWindow" of targetProcess
          set currentMainWindow to value of attribute "AXMainWindow" of targetProcess
          if currentFocusedWindow is not missing value and currentMainWindow is currentFocusedWindow then
            if value of attribute "AXRole" of currentFocusedWindow is "AXWindow" and value of attribute "AXMain" of currentFocusedWindow is true then
              set currentFullscreen to (value of attribute "AXFullScreen" of currentFocusedWindow is true)
              set currentFullscreenRead to true
            end if
          end if
        end try
        if currentFullscreenRead is true and currentFullscreen is expectedFullscreen and frontmost of targetProcess is true then exit repeat
        if (current date) is greater than transitionExpiry then error "exact AppKit fullscreen transition did not reach its native terminal state"
        delay 0.05
      end repeat
    else if commandName is "zoomIn" then
      keystroke "+" using command down
    else if commandName is "zoomReset" then
      keystroke "0" using command down
    else
      error "unsupported macOS application shortcut"
    end if
  end tell
end run`;
  await executeFile("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    String(input.processId),
    input.command,
    input.targetMode ?? "launcher",
    input.runtimeTabName ?? ""
  ], { encoding: "utf8", timeout: 15_000 });
  if (input.command === "escape") {
    const swift = `
import CoreGraphics
import Foundation
import AppKit
let targetPid = pid_t(${input.processId})
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid
else { fatalError("exact Rion process lost foreground before native Escape") }
guard let source = CGEventSource(stateID: .hidSystemState),
      let down = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false)
else { fatalError("native Escape CGEvent unavailable") }
down.post(tap: .cghidEventTap)
usleep(20_000)
up.post(tap: .cghidEventTap)
`;
    await executeFile("/usr/bin/xcrun", ["swift", "-e", swift], {
      encoding: "utf8",
      timeout: 30_000
    });
  }
}

/** Sends one key chord to the selected exact-PID Windows native window mode. */
export async function pressVisibleWindowsApplicationShortcut(input: Readonly<{
  command: VisibleWindowsApplicationShortcut;
  processId: number;
  targetMode?: VisibleApplicationShortcutTargetMode;
}>): Promise<void> {
  if (process.platform !== "win32" || !validProcessId(input.processId)) {
    throw new Error("The native Windows shortcut requires one exact app PID");
  }
  const script = String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RionNativeShortcutInput {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr value);
  [StructLayout(LayoutKind.Sequential)]
  public struct MouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KeyboardInput {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HardwareInput {
    public uint message;
    public ushort low;
    public ushort high;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MouseInput mouse;
    [FieldOffset(0)] public KeyboardInput keyboard;
    [FieldOffset(0)] public HardwareInput hardware;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Input {
    public uint type;
    public InputUnion value;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint count, Input[] inputs, int size);
  private static Input ScanCodeInput(ushort scanCode, bool keyUp) {
    const uint Keyboard = 1;
    const uint KeyUp = 0x0002;
    const uint ScanCode = 0x0008;
    return new Input {
      type = Keyboard,
      value = new InputUnion {
        keyboard = new KeyboardInput {
          virtualKey = 0,
          scanCode = scanCode,
          flags = ScanCode | (keyUp ? KeyUp : 0),
          time = 0,
          extra = UIntPtr.Zero
        }
      }
    };
  }
  public static bool SendScanChord(ushort[] scanCodes) {
    if (scanCodes == null || scanCodes.Length == 0) return false;
    Input[] inputs = new Input[scanCodes.Length * 2];
    for (int index = 0; index < scanCodes.Length; index++) {
      inputs[index] = ScanCodeInput(scanCodes[index], false);
      inputs[inputs.Length - index - 1] = ScanCodeInput(scanCodes[index], true);
    }
    return SendInput(
      (uint)inputs.Length,
      inputs,
      Marshal.SizeOf(typeof(Input))
    ) == (uint)inputs.Length;
  }
}
'@
$targetPid = [uint32]$payload.processId
$command = [string]$payload.command
$targetMode = [string]$payload.targetMode
$inputWindow = [IntPtr]::Zero
if ($targetMode -eq 'launcher') {
  $matches = New-Object System.Collections.Generic.List[System.IntPtr]
  [RionNativeShortcutInput]::EnumWindows({
    param($hwnd, $value)
    $candidateProcessId = [uint32]0
    [RionNativeShortcutInput]::GetWindowThreadProcessId($hwnd, [ref]$candidateProcessId) | Out-Null
    if ($candidateProcessId -eq $targetPid -and [RionNativeShortcutInput]::IsWindowVisible($hwnd)) {
      $matches.Add($hwnd)
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($matches.Count -ne 1) { throw 'exact visible Rion main window unavailable' }
  $inputWindow = $matches[0]
  if (-not [RionNativeShortcutInput]::SetForegroundWindow($inputWindow)) {
    throw 'Rion main window could not become foreground'
  }
} elseif ($targetMode -eq 'focused-runtime') {
  $inputWindow = [RionNativeShortcutInput]::GetForegroundWindow()
  if ($inputWindow -eq [IntPtr]::Zero) {
    throw 'focused Rion runtime window unavailable'
  }
} else {
  throw 'unsupported Windows application shortcut target mode'
}
$foregroundWindow = [RionNativeShortcutInput]::GetForegroundWindow()
if ($foregroundWindow -ne $inputWindow) {
  throw 'exact Rion window lost foreground before shortcut'
}
$foregroundPid = [uint32]0
[RionNativeShortcutInput]::GetWindowThreadProcessId(
  $foregroundWindow, [ref]$foregroundPid) | Out-Null
if ($foregroundPid -ne $targetPid) {
  throw 'foreground window does not belong to the exact Rion PID'
}
if (-not [RionNativeShortcutInput]::IsWindowVisible($foregroundWindow)) {
  throw 'exact Rion foreground window is not visible'
}
$CTRL = [byte]0x11
$SHIFT = [byte]0x10
$modifier = $true
$shiftModifier = $false
switch ($command) {
  'escape' { $key = [byte]0x1B; $modifier = $false }
  'newGameWindow' { $key = [byte]0x4E }
  'toggleFullscreen' { $key = [byte]0x7A; $modifier = $false }
  'zoomIn' { $key = [byte]0xBB; $shiftModifier = $true }
  'zoomReset' { $key = [byte]0x30 }
  default { throw 'unsupported Windows application shortcut' }
}
$keyScan = [uint16][RionNativeShortcutInput]::MapVirtualKey($key, 0)
$ctrlScan = [uint16][RionNativeShortcutInput]::MapVirtualKey($CTRL, 0)
$shiftScan = [uint16][RionNativeShortcutInput]::MapVirtualKey($SHIFT, 0)
if ($keyScan -eq 0) { throw 'Windows shortcut has no physical scan code' }
if ($modifier -and $ctrlScan -eq 0) { throw 'Windows Control has no physical scan code' }
if ($shiftModifier -and $shiftScan -eq 0) { throw 'Windows Shift has no physical scan code' }
$scanCodes = [System.Collections.Generic.List[System.UInt16]]::new()
if ($modifier) { $scanCodes.Add($ctrlScan) }
if ($shiftModifier) { $scanCodes.Add($shiftScan) }
$scanCodes.Add($keyScan)
if (-not [RionNativeShortcutInput]::SendScanChord($scanCodes.ToArray())) {
  throw 'Windows shortcut scan-code chord injection failed'
}
`;
  await runEncodedPowerShellJson(script, {
    command: input.command,
    processId: input.processId,
    targetMode: input.targetMode ?? "launcher"
  }, { timeoutMilliseconds: 10_000 });
}

/**
 * Presses the platform's real native application-quit accelerator. The
 * desktop-E2E bridge is used only to identify the exact process that receives
 * the OS input; it does not request or confirm quit.
 */
export async function pressVisibleNativeApplicationQuit(): Promise<void> {
  const probe = await electronDesktopE2eProbe();
  if (probe.platform === "macos") {
    await executeFile("/usr/bin/osascript", [
      "-e",
      `on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set frontmost of targetProcess to true
    keystroke "q" using command down
  end tell
end run`,
      "--",
      String(probe.processId)
    ], { encoding: "utf8", timeout: 10_000 });
    return;
  }

  const script = String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RionNativeQuitInput {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
$targetPid = [uint32]$payload.processId
$matches = New-Object System.Collections.Generic.List[System.IntPtr]
[RionNativeQuitInput]::EnumWindows({
  param($hwnd, $value)
  $candidateProcessId = [uint32]0
  [RionNativeQuitInput]::GetWindowThreadProcessId($hwnd, [ref]$candidateProcessId) | Out-Null
  if ($candidateProcessId -eq $targetPid -and [RionNativeQuitInput]::IsWindowVisible($hwnd)) { $matches.Add($hwnd) }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($matches.Count -ne 1) { throw "exact visible Rion main window unavailable" }
if (-not [RionNativeQuitInput]::SetForegroundWindow($matches[0])) { throw "Rion main window could not become foreground" }
$KEYUP = [uint32]2
[RionNativeQuitInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[RionNativeQuitInput]::keybd_event(0x51, 0, 0, [UIntPtr]::Zero)
[RionNativeQuitInput]::keybd_event(0x51, 0, $KEYUP, [UIntPtr]::Zero)
[RionNativeQuitInput]::keybd_event(0x11, 0, $KEYUP, [UIntPtr]::Zero)
`;
  await runEncodedPowerShellJson(script, { processId: probe.processId }, {
    timeoutMilliseconds: 10_000
  });
}
