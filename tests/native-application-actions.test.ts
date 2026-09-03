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
    expect(focusedBranch).toContain("entire contents of targetProcess");
    expect(focusedBranch).toContain(
      "set runtimeElements to get entire contents of targetProcess"
    );
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
});
