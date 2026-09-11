import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { electronDesktopE2eProbe } from "./electron-driver";
import { windowsNativeDialogDeclarations } from "./windows-native-dialog";
import { captureNativeProcessAttribution } from "./native-process-attribution";

const executeFile = promisify(execFile);
const nativeFocusScript = fileURLToPath(new URL("./macos-native-focus.swift", import.meta.url));

function validProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
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

async function cancelMacosNativeSaveDialog(processId: number): Promise<void> {
  await executeFile("/usr/bin/xcrun", [
    "swift",
    fileURLToPath(new URL("./macos-native-file-panel.swift", import.meta.url)),
    String(processId), "cancel"
  ], { encoding: "utf8", timeout: 15_000 });
}

async function cancelWindowsNativeSaveDialog(processId: number): Promise<void> {
  const script = String.raw`
Add-Type -TypeDefinition @'
${windowsNativeDialogDeclarations}
'@
$targetPid = [int]$payload.processId
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  $dialogs = @([RionFileDialogOwnership]::OwnedWindows($targetPid, $true))
  if ($dialogs.Count -eq 1) { break }
  if ($dialogs.Count -gt 1) { throw 'multiple exact-PID Windows save dialogs' }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'exact-PID Windows save dialog unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
$dialog = $dialogs[0]
$cancelButtons = @([RionFileDialogOwnership]::ExactDialogControls($dialog, 2, 'Button'))
if ($cancelButtons.Count -ne 1) { throw 'exact Windows Cancel control unavailable' }
[RionFileDialogOwnership]::ClickVisibleControl($dialog, $cancelButtons[0], $targetPid)
do {
  $dialogs = @([RionFileDialogOwnership]::OwnedWindows($targetPid, $true))
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
  | "quickAccess"
  | "newGameWindow"
  | "toggleFullscreen"
  | "zoomIn"
  | "zoomReset";

export type VisibleMacosApplicationShortcut =
  | "escape"
  | "nextTab"
  | "newGameWindow"
  | "quickAccess"
  | "toggleFullscreen"
  | "zoomIn"
  | "zoomReset";

export type VisibleApplicationShortcutTargetMode =
  | "focused-runtime"
  | "launcher";

async function settleMacosAppKitRuntimeFocus(input: Readonly<{
  activate: boolean;
  processId: number;
  requireActiveTab?: boolean;
  runtimeTabName?: string;
  windowId: string;
}>): Promise<void> {
  if (
    process.platform !== "darwin" || !validProcessId(input.processId) ||
    input.windowId.trim() !== input.windowId || input.windowId.length === 0 ||
    (input.runtimeTabName !== undefined &&
      (input.runtimeTabName.trim() !== input.runtimeTabName ||
        input.runtimeTabName.length === 0))
  ) {
    throw new Error("The AppKit runtime focus fence is invalid");
  }
  const expectedWindowIdentifier =
    `com.rionstudio.runtime.appkit-window.v1:${input.windowId}`;
  await executeFile("/usr/bin/xcrun", [
    "swift", nativeFocusScript, String(input.processId), expectedWindowIdentifier,
    input.runtimeTabName ?? "", input.activate ? "focus" : "observe",
    input.requireActiveTab ? "active" : ""
  ], { encoding: "utf8", timeout: 15_000 });
}

/** Observes Quick Access' exact AppKit focus result without touching the launcher. */
export function waitForFocusedMacosAppKitRuntime(input: Readonly<{
  processId: number;
  runtimeTabName?: string;
  windowId: string;
}>): Promise<void> {
  return settleMacosAppKitRuntimeFocus({
    ...input,
    activate: false,
    requireActiveTab: input.runtimeTabName !== undefined
  });
}

/** Restores the exact visible AppKit host after a diagnostic launcher read. */
export function focusVisibleMacosAppKitRuntime(input: Readonly<{
  processId: number;
  runtimeTabName?: string;
  windowId: string;
}>): Promise<void> {
  return settleMacosAppKitRuntimeFocus({ ...input, activate: true });
}

/** Sends one native accelerator to the selected exact-PID macOS window mode. */
export async function pressVisibleMacosApplicationShortcut(input: Readonly<{
  command: VisibleMacosApplicationShortcut;
  processId: number;
  runtimeTabName?: string;
  runtimeWindowId?: string;
  targetMode?: VisibleApplicationShortcutTargetMode;
}>): Promise<void> {
  if (process.platform !== "darwin" || !validProcessId(input.processId)) {
    throw new Error("The native macOS shortcut requires one exact app PID");
  }
  if (
    input.targetMode === "focused-runtime" &&
    ((!input.runtimeTabName && !input.runtimeWindowId) ||
      (input.runtimeTabName !== undefined &&
        input.runtimeTabName.trim() !== input.runtimeTabName) ||
      (input.runtimeWindowId !== undefined &&
        (input.runtimeWindowId.length === 0 ||
          input.runtimeWindowId.trim() !== input.runtimeWindowId)))
  ) {
    throw new Error("The focused macOS runtime shortcut requires one exact AppKit tab or window");
  }
  if (input.targetMode === "focused-runtime") {
    const expectedWindowIdentifier = input.runtimeWindowId
      ? `com.rionstudio.runtime.appkit-window.v1:${input.runtimeWindowId}`
      : "";
    await executeFile("/usr/bin/xcrun", [
      "swift", nativeFocusScript, String(input.processId), expectedWindowIdentifier,
      input.runtimeTabName ?? "", "shortcut", input.command
    ], { encoding: "utf8", timeout: 15_000 });
    return;
  }
  const script = String.raw`
on run argv
  set targetPid to (item 1 of argv) as integer
  set commandName to item 2 of argv
  set targetMode to item 3 of argv
  set runtimeTabName to item 4 of argv
  set appKitWindowPrefix to "com.rionstudio.runtime.appkit-window.v1:"
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    if targetMode is "launcher" then
      set frontmost of targetProcess to true
      -- Chromium can leave the process-level AXFocusedWindow and AXMainWindow
      -- proxies unpublished while its child owns focus. Fence the one
      -- non-AppKit AXWindow and its AXMain state before native accelerator input.
      set activationExpiry to (current date) + 10
      repeat
        set launcherWindow to missing value
        set launcherWindowCount to 0
        repeat with appWindow in windows of targetProcess
          set appWindowIdentifier to ""
          try
            set appWindowIdentifier to value of attribute "AXIdentifier" of appWindow as text
          end try
          if appWindowIdentifier does not start with appKitWindowPrefix then
            if value of attribute "AXRole" of appWindow is "AXWindow" then
              set launcherWindow to appWindow
              set launcherWindowCount to launcherWindowCount + 1
            end if
          end if
        end repeat
        if launcherWindowCount is greater than 1 then error "ambiguous exact Rion launcher AXWindow"
        if launcherWindowCount is 1 then
          perform action "AXRaise" of launcherWindow
          try
            if frontmost of targetProcess is true and value of attribute "AXMain" of launcherWindow is true then exit repeat
          end try
        end if
        if (current date) is greater than activationExpiry then error "exact Rion launcher AXWindow unavailable after activation"
        delay 0.05
      end repeat
      if value of attribute "AXRole" of launcherWindow is not "AXWindow" then error "focused Rion launcher owner is not an AXWindow"
      if value of attribute "AXMain" of launcherWindow is not true then error "exact Rion launcher AXWindow is not main"
      set fileMenuItems to menu bar items of menu bar 1 of targetProcess whose name is "File"
      if (count of fileMenuItems) is not 1 then error "exact Rion File NSMenu unavailable"
      set fileMenu to a reference to (menu bar item "File" of menu bar 1 of targetProcess)
      set newWindowItems to menu items of menu 1 of fileMenu whose name is "New Game Window"
      if (count of newWindowItems) is not 1 then
        set menuItemNames to name of every menu item of menu 1 of fileMenu
        error "exact Rion New Game Window NSMenu item unavailable; items=" & menuItemNames
      end if
      set newWindowItem to a reference to (menu item "New Game Window" of menu 1 of fileMenu)
      if enabled of newWindowItem is not true then error "exact Rion New Game Window NSMenu item is disabled"
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
      -- PresentationOnly: the retained AppKit host does not reliably publish
      -- AXFullScreen or live fullscreen geometry. Keep ChromeDriver outside the
      -- Space animation; the caller separately requires revision-fenced Core
      -- and AppKit presentation events as the authoritative terminal result.
      delay 2
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
  ], { encoding: "utf8", timeout: 15_000 }).catch(async (error: unknown) => {
    await captureNativeProcessAttribution();
    throw error;
  });
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
  nativeWindowHandle?: string;
  targetMode?: VisibleApplicationShortcutTargetMode;
}>): Promise<void> {
  if (process.platform !== "win32" || !validProcessId(input.processId)) {
    throw new Error("The native Windows shortcut requires one exact app PID");
  }
  const script = String.raw`
[Console]::Error.WriteLine('shortcut-stage: compile-native-input')
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RionNativeShortcutInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct GuiThreadInfo {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public int left, top, right, bottom;
  }
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  public static string FocusEvidence(IntPtr hwnd) {
    uint pid;
    uint thread = GetWindowThreadProcessId(hwnd, out pid);
    var info = new GuiThreadInfo { size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
    bool available = GetGUIThreadInfo(thread, ref info);
    return String.Format("thread={0}; available={1}; active={2}; focus={3}; focusRoot={4}; flags={5}; error={6}",
      thread, available, info.active.ToInt64(), info.focus.ToInt64(),
      available ? GetAncestor(info.focus, 2).ToInt64() : 0, info.flags,
      available ? 0 : Marshal.GetLastWin32Error());
  }

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
[Console]::Error.WriteLine('shortcut-stage: select-exact-window')
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
if ($payload.nativeWindowHandle -and
    [string][int64]$foregroundWindow -ne [string]$payload.nativeWindowHandle) {
  throw 'the exact runtime HWND lost foreground before shortcut'
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
  'quickAccess' { $key = [byte]0x4B }
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
[Console]::WriteLine([RionNativeShortcutInput]::FocusEvidence($foregroundWindow))
[Console]::Error.WriteLine('shortcut-stage: submit-native-chord')
if (-not [RionNativeShortcutInput]::SendScanChord($scanCodes.ToArray())) {
  throw 'Windows shortcut scan-code chord injection failed'
}
[Console]::Error.WriteLine('shortcut-stage: native-chord-submitted')
`;
  try {
    const focusEvidence = await runEncodedPowerShellJson(script, {
      command: input.command,
      processId: input.processId,
      nativeWindowHandle: input.nativeWindowHandle ?? "",
      targetMode: input.targetMode ?? "launcher"
    }, {
      // DeadlineBound: Windows PowerShell may cold-start Add-Type while the CI
      // runner is also linking the native runtime. Input submission itself is
      // still terminalized synchronously by SendInput's exact inserted count.
      timeoutMilliseconds: 30_000
    });
    console.info(`Windows native shortcut ${input.command}: ${focusEvidence.slice(0, 512)}`);
  } catch (error) {
    // Avoid forwarding the rejected process message because it contains the
    // entire encoded command; retain bounded native stdout/stderr instead.
    const diagnostic = boundedPowerShellFailure(error);
    if (error instanceof Error) {
      error.message = diagnostic;
      error.stack = `${error.name}: ${diagnostic}`;
    }
    throw new Error(`Windows native shortcut helper failed: ${diagnostic}`, {
      cause: error
    });
  }
}

async function activateVisibleMacosDockQuickMenu(processId: number): Promise<void> {
  const script = String.raw`
on firstMatchingLabel(itemNames, candidates)
  repeat with candidate in candidates
    if itemNames contains (candidate as text) then return candidate as text
  end repeat
  error "localized Rion Quick Menu label unavailable; items=" & itemNames
end firstMatchingLabel

on run argv
  set targetPid to (item 1 of argv) as integer
  set openLabels to {"Open Rion Studio", "開啟 Rion Studio", "打开 Rion Studio", "Rion Studio を開く"}
  set roleLabels to {"Roles", "角色", "ロール"}
  set workspaceLabels to {"Workspaces", "工作區", "工作区", "ワークスペース"}
  set windowLabels to {"Windows", "視窗", "窗口", "ウインドウ"}
  set appKitWindowPrefix to "com.rionstudio.runtime.appkit-window.v1:"
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set launcherWindows to {}
    repeat with appWindow in windows of targetProcess
      set appWindowIdentifier to ""
      try
        set appWindowIdentifier to value of attribute "AXIdentifier" of appWindow as text
      end try
      if appWindowIdentifier does not start with appKitWindowPrefix then
        if value of attribute "AXRole" of appWindow is "AXWindow" then
          set end of launcherWindows to appWindow
        end if
      end if
    end repeat
    if (count of launcherWindows) is not 1 then error "exact Rion launcher AXWindow unavailable"
    set launcherWindow to item 1 of launcherWindows
    set frontmost of targetProcess to true

    tell process "Dock"
      set rionDockItemCount to 0
      set electronDockItemCount to 0
      set rionDockItemIndex to 0
      set electronDockItemIndex to 0
      set dockItemCount to count of UI elements of list 1
      repeat with dockItemIndex from 1 to dockItemCount
        set candidate to UI element dockItemIndex of list 1
        if role description of candidate is "application dock item" then
          if name of candidate is "Rion Studio" or name of candidate is "Rion Studio Dev" then
            set rionDockItemCount to rionDockItemCount + 1
            set rionDockItemIndex to dockItemIndex
          else if name of candidate is "Electron" then
            set electronDockItemCount to electronDockItemCount + 1
            set electronDockItemIndex to dockItemIndex
          end if
        end if
      end repeat
      if rionDockItemCount is 1 then
        set targetDockItemIndex to rionDockItemIndex
      else if rionDockItemCount is 0 and electronDockItemCount is 1 then
        set targetDockItemIndex to electronDockItemIndex
      else
        error "Rion Dock isolation unavailable; Rion=" & rionDockItemCount & "; Electron=" & electronDockItemCount
      end if
      set dockItem to UI element targetDockItemIndex of list 1
      perform action "AXShowMenu" of dockItem
      set menuExpiry to (current date) + 10
      set shownMenu to missing value
      repeat while shownMenu is missing value
        try
          set shownMenu to value of attribute "AXShownMenuUIElement" of dockItem
        end try
        if (current date) is greater than menuExpiry then error "Rion Dock Quick Menu unavailable"
        delay 0.05
      end repeat
      set itemNames to name of every menu item of shownMenu
      set openLabel to my firstMatchingLabel(itemNames, openLabels)
      my firstMatchingLabel(itemNames, roleLabels)
      my firstMatchingLabel(itemNames, workspaceLabels)
      my firstMatchingLabel(itemNames, windowLabels)
      click menu item openLabel of shownMenu
    end tell
  end tell
end run`;
  await executeFile("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    String(processId)
  ], { encoding: "utf8", timeout: 20_000 });
}

async function activateVisibleWindowsTrayQuickMenu(processId: number): Promise<void> {
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionQuickMenuInput {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void RightClick(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("tray pointer placement failed");
    mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
  }
  public static void LeftClick(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("menu pointer placement failed");
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
function Find-NamedElement([string[]]$names, [System.Windows.Automation.ControlType]$type) {
  $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $type
    )
  )
  foreach ($element in $all) {
    if ($names -contains $element.Current.Name -and -not $element.Current.IsOffscreen) {
      return $element
    }
  }
  return $null
}
function Find-NotificationChevron {
  $buttons = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  $names = @(
    'Notification Chevron',
    'Show hidden icons',
    '顯示隱藏的圖示',
    '显示隐藏的图标'
  )
  $sharedIdCandidates = [System.Collections.Generic.List[object]]::new()
  foreach ($button in $buttons) {
    if ($button.Current.IsOffscreen) { continue }
    if ($names -contains $button.Current.Name) { return $button }
    if ($button.Current.AutomationId -eq 'SystemTrayIcon') {
      $bounds = $button.Current.BoundingRectangle
      if (-not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
        $sharedIdCandidates.Add($button)
      }
    }
  }
  # Windows 11/Server 2025 shares SystemTrayIcon across the notification-area
  # buttons. The overflow chevron is the leftmost member of that exact row.
  return $sharedIdCandidates |
    Sort-Object { $_.Current.BoundingRectangle.Left } |
    Select-Object -First 1
}
function Click-Center($element, [bool]$right) {
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) {
    throw 'native Quick Menu element has no visible bounds'
  }
  $x = [int][Math]::Round($bounds.Left + ($bounds.Width / 2))
  $y = [int][Math]::Round($bounds.Top + ($bounds.Height / 2))
  if ($right) { [RionQuickMenuInput]::RightClick($x, $y) }
  else { [RionQuickMenuInput]::LeftClick($x, $y) }
}
$targetPid = [uint32]$payload.processId
$matches = [System.Collections.Generic.List[System.IntPtr]]::new()
[RionQuickMenuInput]::EnumWindows({
  param($hwnd, $value)
  $candidatePid = [uint32]0
  [RionQuickMenuInput]::GetWindowThreadProcessId($hwnd, [ref]$candidatePid) | Out-Null
  if ($candidatePid -eq $targetPid -and [RionQuickMenuInput]::IsWindowVisible($hwnd)) {
    $matches.Add($hwnd)
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($matches.Count -ne 1) { throw 'exact visible Rion launcher HWND unavailable' }
[RionQuickMenuInput]::ShowWindowAsync($matches[0], 6) | Out-Null

$trayIcon = Find-NamedElement @('Rion Studio') ([System.Windows.Automation.ControlType]::Button)
if (-not $trayIcon) {
  $chevron = Find-NotificationChevron
  if (-not $chevron) { throw 'Windows notification-area overflow chevron unavailable' }
  Click-Center $chevron $false
  $expiry = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $trayIcon = Find-NamedElement @('Rion Studio') ([System.Windows.Automation.ControlType]::Button)
    if ($trayIcon) { break }
    if ([DateTime]::UtcNow -gt $expiry) { throw 'Rion Studio notification-area icon unavailable' }
    Start-Sleep -Milliseconds 50
  } while ($true)
}
Click-Center $trayIcon $true

$openLabels = @('Open Rion Studio', '開啟 Rion Studio', '打开 Rion Studio', 'Rion Studio を開く')
$roleLabels = @('Roles', '角色', 'ロール')
$workspaceLabels = @('Workspaces', '工作區', '工作区', 'ワークスペース')
$windowLabels = @('Windows', '視窗', '窗口', 'ウインドウ')
$expiry = [DateTime]::UtcNow.AddSeconds(10)
do {
  $openItem = Find-NamedElement $openLabels ([System.Windows.Automation.ControlType]::MenuItem)
  $roleItem = Find-NamedElement $roleLabels ([System.Windows.Automation.ControlType]::MenuItem)
  $workspaceItem = Find-NamedElement $workspaceLabels ([System.Windows.Automation.ControlType]::MenuItem)
  $windowItem = Find-NamedElement $windowLabels ([System.Windows.Automation.ControlType]::MenuItem)
  if ($openItem -and $roleItem -and $workspaceItem -and $windowItem) { break }
  if ([DateTime]::UtcNow -gt $expiry) { throw 'complete Rion Studio Tray Quick Menu unavailable' }
  Start-Sleep -Milliseconds 50
} while ($true)
Click-Center $openItem $false
`;
  await runEncodedPowerShellJson(script, { processId }, {
    timeoutMilliseconds: 30_000
  });
}

/** Opens the real Dock/notification-area menu and invokes its visible Open item. */
export async function activateVisibleNativeQuickMenu(input: Readonly<{
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  if (!validProcessId(input.processId)) {
    throw new Error("The native Quick Menu requires one exact app PID");
  }
  if (input.platform === "macos") {
    if (process.platform !== "darwin") {
      throw new Error("The macOS Dock Quick Menu requires a macOS host");
    }
    await activateVisibleMacosDockQuickMenu(input.processId);
    return;
  }
  if (process.platform !== "win32") {
    throw new Error("The Windows Tray Quick Menu requires a Windows host");
  }
  await activateVisibleWindowsTrayQuickMenu(input.processId);
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
  set appKitWindowPrefix to "com.rionstudio.runtime.appkit-window.v1:"
  set expiry to (current date) + 10
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact Rion process unavailable"
    set targetProcess to a reference to (first application process whose unix id is targetPid)
    set frontmost of targetProcess to true
    repeat
      set launcherWindow to missing value
      set launcherWindowCount to 0
      repeat with appWindow in windows of targetProcess
        set appWindowIdentifier to ""
        try
          set appWindowIdentifier to value of attribute "AXIdentifier" of appWindow as text
        end try
        if appWindowIdentifier does not start with appKitWindowPrefix then
          if value of attribute "AXRole" of appWindow is "AXWindow" then
            set launcherWindow to appWindow
            set launcherWindowCount to launcherWindowCount + 1
          end if
        end if
      end repeat
      if launcherWindowCount is greater than 1 then error "ambiguous exact Rion launcher AXWindow"
      if launcherWindowCount is 1 then
        perform action "AXRaise" of launcherWindow
        try
          if frontmost of targetProcess is true and value of attribute "AXMain" of launcherWindow is true then exit repeat
        end try
      end if
      if (current date) is greater than expiry then error "exact Rion launcher AXWindow unavailable before quit"
      delay 0.05
    end repeat
    if frontmost of targetProcess is not true then error "exact Rion process lost foreground before quit"
    -- Physical ANSI Q remains stable across active macOS input sources while
    -- exercising the installed Command+Q application accelerator.
    key code 12 using command down
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
