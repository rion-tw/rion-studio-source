import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let source = "";
let nativeFocus = "";
let windowsNativeDialogDeclarations = "";

beforeAll(async () => {
  source = await readFile(
    "e2e/desktop/support/native-application-actions.ts",
    "utf8"
  );
  nativeFocus = await readFile("e2e/desktop/support/macos-native-focus.swift", "utf8");
  windowsNativeDialogDeclarations = await readFile(
    "e2e/desktop/support/windows-native-dialog.ts", "utf8"
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
  it("uses exact owned native dialog controls for Windows save cancellation", () => {
    const cancel = sourceBetween("async function cancelWindowsNativeSaveDialog", "/** Cancels the unique");
    expect(cancel).toContain("OwnedWindows($targetPid, $true)");
    expect(cancel).toContain("ExactDialogControls($dialog, 2, 'Button')");
    expect(cancel).toContain("$cancelButtons.Count -ne 1");
    expect(windowsNativeDialogDeclarations).toContain("GetForegroundWindow() != dialog");
    expect(windowsNativeDialogDeclarations).toContain("!IsChild(dialog, control)");
    expect(windowsNativeDialogDeclarations).toContain("native file control is occluded at its click point");
  });

  it("fences macOS cancellation to the exact attached native panel and Cancel control", async () => {
    const panel = await readFile("e2e/desktop/support/macos-native-file-panel.swift", "utf8");
    const cancel = sourceBetween("async function cancelMacosNativeSaveDialog", "async function cancelWindowsNativeSaveDialog");
    expect(cancel).toContain('String(processId), "cancel"');
    expect(panel).toContain('AXUIElementCreateApplication(targetPid)');
    expect(panel).toContain('com.apple.appkit.xpc.openAndSavePanelService');
    expect(panel).toContain('if role == "AXWebArea" { return }');
    expect(panel).toContain('CFEqual(currentPanels[0], panel)');
    expect(panel).toContain('text($0, "AXRole") == "AXButton" && text($0, "AXTitle") == "Cancel"');
    expect(panel).toContain('AXUIElementPerformAction(buttons[0], kAXPressAction');
    expect(panel).toContain('awaitCondition("cancelled panel closure") { panels().isEmpty }');
  });

  it("keeps launcher as the default on both native platforms", () => {
    expect(source).toContain(
      "export type VisibleApplicationShortcutTargetMode ="
    );
    expect(source.match(/input\.targetMode \?\? "launcher"/gu)).toHaveLength(2);
  });

  it("fences macOS launcher input to its exact main AXWindow and NSMenu item", () => {
    const launcherBranch = sourceBetween(
      'if targetMode is "launcher" then',
      'else\n      error "unsupported macOS application shortcut target mode"'
    );
    expect(launcherBranch).toContain("appKitWindowPrefix");
    expect(launcherBranch).toContain(
      "launcherWindowCount is greater than 1"
    );
    expect(launcherBranch).toContain(
      "exact Rion launcher AXWindow unavailable after activation"
    );
    expect(launcherBranch).toContain('attribute "AXMain" of launcherWindow');
    expect(launcherBranch).toContain('perform action "AXRaise" of launcherWindow');
    expect(launcherBranch).toContain(
      'menu bar items of menu bar 1 of targetProcess whose name is "File"'
    );
    expect(launcherBranch).toContain(
      'menu items of menu 1 of fileMenu whose name is "New Game Window"'
    );
    expect(launcherBranch).toContain("enabled of newWindowItem");
    expect(source).toContain("key code 45 using command down");
    expect(source).not.toContain('keystroke "n" using command down');
  });

  it("validates the exact frontmost macOS AX window without activating another window", () => {
    expect(nativeFocus).toContain('object(application, "AXFocusedWindow")');
    expect(nativeFocus).toContain('object(application, "AXMainWindow")');
    expect(nativeFocus).toContain('boolean(focusedWindow, "AXMain")');
    expect(nativeFocus).toContain("mainWindowIdentifier == focusedWindowIdentifier");
    expect(nativeFocus).toContain('text(owner, "AXIdentifier") == focusedWindowIdentifier');
    expect(nativeFocus).toContain('text($0, "AXRole") == "AXRadioButton"');
    expect(nativeFocus).toContain('text($0, "AXDescription") == runtimeTabName');
    expect(nativeFocus).toContain('tabs.count <= 1');
    expect(nativeFocus).toContain('if let tab = tabs.first, let owner = object(tab, "AXWindow")');
    expect(nativeFocus).toContain('mode == "focus", let target');
    expect(nativeFocus).toContain('mode == "shortcut" ? 0 : 10');
    expect(nativeFocus).toContain('text($0, "AXTitle") == "Toggle Full Screen"');
    expect(nativeFocus).toContain('items.count == 1, boolean(items[0], "AXEnabled")');
    expect(nativeFocus).toContain('case "toggleFullscreen": key = 3; flags = [.maskCommand, .maskControl]');
    expect(nativeFocus).toContain('case "quickAccess": key = 40; flags = [.maskCommand]');
    expect(nativeFocus).toContain('NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid');
    expect(nativeFocus).toContain('AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == targetPid');
    expect(nativeFocus).toContain('AXIsProcessTrusted()');
    expect(nativeFocus).toContain('down.post(tap: .cghidEventTap)');
    expect(nativeFocus).toContain('up.post(tap: .cghidEventTap)');
    expect(nativeFocus).toContain('PresentationOnly:');
    expect(nativeFocus).toContain('exact Core/AppKit terminal presentation event');
    expect(nativeFocus).toContain('usleep(2_000_000)');
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
