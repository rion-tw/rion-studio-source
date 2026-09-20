import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browser } from "@wdio/globals";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { readMacosVisibleRuntimeTabPoint } from "./macos-appkit-ui";
import { withWindowsRuntimeHost } from "./native-runtime-tabs";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
const execute = promisify(execFile);
export interface NativeDragPoint { x: number; y: number }

export async function nativeTabPoint(input: { platform: "macos" | "windows"; mainWindowHandle: string;
  windowId: string; tabId: string; tabName: string; focus?: boolean }): Promise<NativeDragPoint> {
  if (input.platform === "macos") {
    if (input.focus) await focusVisibleMacosAppKitRuntime({ processId: (await electronDesktopE2eProbe()).processId, windowId: input.windowId });
    return readMacosVisibleRuntimeTabPoint(input);
  }
  return withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const point = await browser.execute(id => {
      const tab = document.querySelector<HTMLElement>(`.runtime-tab[data-tab-id='${id}']`);
      if (!tab) throw new Error("The visible drag tab is unavailable.");
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, input.tabId);
    const toolbar = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
    const processId = (await electronDesktopE2eProbe()).processId;
    const raw = await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class RionTabPoint {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w, ref POINT p);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
}
'@
[RionTabPoint]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$w = [IntPtr]::new([long]$payload.handle)
$owner = [uint32]0
[RionTabPoint]::GetWindowThreadProcessId($w, [ref]$owner) | Out-Null
if ($owner -ne $payload.processId) { throw 'The native drag owner changed' }
if ($payload.focus) { [RionTabPoint]::SetForegroundWindow($w) | Out-Null }
$s = [RionTabPoint]::GetDpiForWindow($w) / 96.0
$p = New-Object RionTabPoint+POINT
$p.X = [int]($payload.x * $s); $p.Y = [int]($payload.y * $s)
if (-not [RionTabPoint]::ClientToScreen($w, [ref]$p)) { throw 'Native tab point unavailable' }
@{x=$p.X;y=$p.Y} | ConvertTo-Json -Compress
`, { ...point, handle: toolbar.nativeWindowHandle, processId, focus: input.focus ?? false }, { timeoutMilliseconds: 15_000 });
    return JSON.parse(raw) as NativeDragPoint;
  });
}

/** Actual desktop input; returning while held lets tests inspect live preview.
 * Callers always send end in finally. Sleeps pace input only, never prove state. */
export async function nativeTabPointer(platform: "macos" | "windows", phase: "start" | "move" | "end" | "cancel",
  from: NativeDragPoint, to: NativeDragPoint): Promise<void> {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error("Invalid native drag path.");
  if (platform === "macos") {
    await execute("/usr/bin/xcrun", ["swift", "-e", `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType, _ x: Double, _ y: Double) {
 CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x:x,y:y), mouseButton:.left)?.post(tap:.cghidEventTap)
}
${phase === "start" ? `post(.mouseMoved, ${from.x}, ${from.y}); post(.leftMouseDown, ${from.x}, ${from.y})` : ""}
for step in 1...16 { let f = Double(step) / 16.0
 post(.leftMouseDragged, ${from.x} + (${to.x} - ${from.x}) * f, ${from.y} + (${to.y} - ${from.y}) * f)
 usleep(25_000)
}
${phase === "cancel" ? "CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true)?.post(tap:.cghidEventTap); CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false)?.post(tap:.cghidEventTap)" : ""}
${phase === "end" || phase === "cancel" ? `post(.leftMouseUp, ${to.x}, ${to.y})` : ""}
`], { timeout: 30_000 });
    return;
  }
  await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class RionDragPointer {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
}
'@
if ($payload.phase -eq 'start') {
 [RionDragPointer]::SetCursorPos($payload.from.x,$payload.from.y) | Out-Null
 [RionDragPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
}
foreach ($step in 1..16) {
 $f = $step / 16.0
 [RionDragPointer]::SetCursorPos([int]($payload.from.x+($payload.to.x-$payload.from.x)*$f),[int]($payload.from.y+($payload.to.y-$payload.from.y)*$f)) | Out-Null
 Start-Sleep -Milliseconds 25
}
if ($payload.phase -eq 'cancel') { [RionDragPointer]::keybd_event(27,0,0,[UIntPtr]::Zero); [RionDragPointer]::keybd_event(27,0,2,[UIntPtr]::Zero) }
if ($payload.phase -in @('end','cancel')) { [RionDragPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
@{ applied=$true } | ConvertTo-Json -Compress
`, { phase, from, to }, { timeoutMilliseconds: 15_000 });
}
