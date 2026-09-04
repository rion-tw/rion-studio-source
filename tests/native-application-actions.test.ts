import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let source = "";

beforeAll(async () => {
  source = await readFile(
    "e2e/desktop/support/native-application-actions.ts",
    "utf8"
  );
});

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThan(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("native application shortcut target modes", () => {
  it("keeps launcher as the default on both native platforms", () => {
    expect(source).toContain(
      "export type VisibleApplicationShortcutTargetMode ="
    );
    expect(source.match(/input\.targetMode \?\? "launcher"/gu)).toHaveLength(2);
  });

  it("fences macOS launcher input to its exact main AXWindow and NSMenu item", () => {
    const launcherBranch = sourceBetween(
      'if targetMode is "launcher" then',
      'else if targetMode is "focused-runtime" then'
    );
    expect(launcherBranch).toContain('attribute "AXFocusedWindow"');
    expect(launcherBranch).toContain('attribute "AXMainWindow"');
    expect(launcherBranch).toContain(
      "launcherWindow is not missing value and launcherMainWindow is not missing value"
    );
    expect(launcherBranch).toContain(
      "exact Rion launcher AXWindow unavailable after activation"
    );
    expect(launcherBranch).toContain("launcherMainWindow is not launcherWindow");
    expect(launcherBranch).toContain(
      'menu bar items of menu bar 1 of targetProcess whose name is "File"'
    );
    expect(launcherBranch).toContain(
      'menu items of menu 1 of item 1 of fileMenuItems whose name is "New Game Window"'
    );
    expect(launcherBranch).toContain("enabled of item 1 of newWindowItems");
    expect(source).toContain("key code 45 using command down");
    expect(source).not.toContain('keystroke "n" using command down');
  });

  it("validates the exact frontmost macOS AX window without activating another window", () => {
    const focusedBranch = sourceBetween(
      'else if targetMode is "focused-runtime" then',
      'else\n      error "unsupported macOS application shortcut target mode"'
    );
    expect(focusedBranch).toContain('attribute "AXFocusedWindow"');
    expect(focusedBranch).not.toContain('attribute "AXFocused" of focusedWindow');
    expect(focusedBranch).toContain('attribute "AXMain"');
    expect(focusedBranch).toContain('attribute "AXMainWindow"');
    expect(focusedBranch).toContain("mainWindow is not focusedWindow");
    expect(focusedBranch).toContain('attribute "AXFullScreen" of focusedWindow');
    expect(focusedBranch).toContain("fullscreenRestoreOwner is false");
    expect(focusedBranch).toContain(
      "set runtimeElements to get entire contents of focusedWindow"
    );
    expect(focusedBranch).not.toContain("entire contents of targetProcess");
    expect(focusedBranch).toContain(
      "set candidate to contents of candidateReference"
    );
    expect(focusedBranch).toContain("runtimeRoleReadErrorCount");
    expect(focusedBranch).toContain(
      'attribute "AXRole" of candidate is "AXRadioButton"'
    );
    expect(focusedBranch).toContain(
      'attribute "AXDescription" of candidate is runtimeTabName'
    );
    expect(focusedBranch).toContain("runtimeTabCount is not 1");
    expect(focusedBranch).toContain('attribute "AXWindow" of runtimeTab');
    expect(focusedBranch).toContain("runtimeTabWindow is not focusedWindow");
    expect(focusedBranch).toContain(
      'menu bar items of menu bar 1 of targetProcess whose name is "View"'
    );
    expect(focusedBranch).toContain(
      'menu items of menu 1 of item 1 of viewMenuItems whose name is "Toggle Full Screen"'
    );
    expect(focusedBranch).toContain("enabled of item 1 of fullscreenItems");
    expect(focusedBranch).not.toContain("set frontmost of targetProcess");
    expect(source).toContain(
      "key code 3 using {control down, command down}"
    );
    expect(source).toContain("set expectedFullscreen to not focusedWindowFullscreen");
    expect(source).toContain(
      'value of attribute "AXFullScreen" of focusedWindow is true'
    );
    expect(source).toContain(
      "currentFullscreenRead is true and currentFullscreen is expectedFullscreen"
    );
    expect(source).toContain(
      'attribute "AXFullScreen" of currentMainWindow is true'
    );
    expect(source).not.toContain(
      "currentMainWindow is currentFocusedWindow"
    );
    expect(source).toContain(
      "currentFullscreen is expectedFullscreen and frontmost of targetProcess is true"
    );
    expect(source).toContain(
      "exact AppKit fullscreen transition did not reach its native terminal state"
    );
    expect(source).toContain("key code 40 using command down");
    expect(source).toContain(
      "NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid"
    );
    expect(source).toContain("down.post(tap: .cghidEventTap)");
    expect(source).toContain("up.post(tap: .cghidEventTap)");
    expect(source).not.toContain(
      'if commandName is "escape" then\n      key code 53'
    );
    expect(source).not.toContain(
      'keystroke "f" using {control down, command down}'
    );
  });

  it("uses the existing exact foreground HWND on Windows without enumeration or activation", () => {
    const focusedBranch = sourceBetween(
      "elseif ($targetMode -eq 'focused-runtime') {",
      "} else {\n  throw 'unsupported Windows application shortcut target mode'"
    );
    expect(focusedBranch).toContain("GetForegroundWindow()");
    expect(focusedBranch).not.toContain("EnumWindows(");
    expect(focusedBranch).not.toContain("SetForegroundWindow(");
    expect(source).toContain("foregroundPid -ne $targetPid");
  });

  it("sends the physical Windows plus chord with its required Shift modifier", () => {
    expect(source).toContain(
      "'zoomIn' { $key = [byte]0xBB; $shiftModifier = $true }"
    );
    expect(source).toContain(
      "if ($shiftModifier) { $scanCodes.Add($shiftScan) }"
    );
    expect(source).toContain(
      "inputs[inputs.Length - index - 1] = ScanCodeInput(scanCodes[index], true);"
    );
  });

  it("maps Windows virtual keys into SendInput physical scan-code events", () => {
    expect(source).toContain(
      "public static extern uint MapVirtualKey(uint code, uint mapType);"
    );
    expect(source).toContain(
      "$keyScan = [uint16][RionNativeShortcutInput]::MapVirtualKey($key, 0)"
    );
    expect(source).toContain(
      "public static extern uint SendInput(uint count, Input[] inputs, int size);"
    );
    expect(source).toContain(
      "const uint ScanCode = 0x0008;"
    );
    expect(source).toContain(
      "virtualKey = 0"
    );
    expect(source).toContain(
      "[RionNativeShortcutInput]::SendScanChord($scanCodes.ToArray())"
    );
    expect(source).toContain(
      "if ($keyScan -eq 0) { throw 'Windows shortcut has no physical scan code' }"
    );
    expect(source).toContain("timeoutMilliseconds: 30_000");
    expect(source).toContain("boundedPowerShellFailure(error)");
    expect(source).toContain("output.slice(-2_000)");
  });
});
