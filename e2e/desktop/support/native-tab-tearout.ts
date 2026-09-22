import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { browser } from "@wdio/globals";
import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { readMacosVisibleRuntimeTabPoint } from "./macos-appkit-ui";
import { withWindowsRuntimeHost } from "./native-runtime-tabs";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";
const execute = promisify(execFile);
export interface NativeDragPoint { x: number; y: number; nativeWindowHandle?: string }

export async function nativeTabPoint(input: { platform: "macos" | "windows"; mainWindowHandle: string;
  windowId: string; tabId: string; tabName: string; focus?: boolean }): Promise<NativeDragPoint> {
  if (input.platform === "macos") {
    if (input.focus) await focusVisibleMacosAppKitRuntime({ processId: (await electronDesktopE2eProbe()).processId, windowId: input.windowId });
    return readMacosVisibleRuntimeTabPoint(input);
  }
  const point = await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () =>
    browser.execute(id => {
      const tab = document.querySelector<HTMLElement>(`.runtime-tab[data-tab-id='${id}']`);
      if (!tab) throw new Error("The visible drag tab is unavailable.");
      const r = tab.querySelector<HTMLElement>(".runtime-tab-activate")!.getBoundingClientRect();
      const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      if (document.elementFromPoint(point.x, point.y)?.closest(".runtime-tab") !== tab) {
        throw new Error("The exact drag tab is occluded.");
      }
      const evidence = window as unknown as { __rionTabPointerEvidence?: unknown[] };
      if (!evidence.__rionTabPointerEvidence) {
        const events: unknown[] = evidence.__rionTabPointerEvidence = [];
        for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
          document.addEventListener(type, event => {
            const pointer = event as PointerEvent;
            if (events.length >= 120 || (type === "pointermove" && pointer.buttons === 0)) return;
            events.push({ type, trusted: pointer.isTrusted, buttons: pointer.buttons,
              x: pointer.clientX, y: pointer.clientY, target: (pointer.target as Element)?.className,
              revision: document.documentElement.dataset.runtimeProjectionRevision });
          }, true);
        }
      }
      return point;
    }, input.tabId), input.windowId);
  // Runtime chrome has no launcher E2E bridge. Read its DOM first, restore the
  // launcher evidence target, then establish native focus for the actual drag.
  const toolbar = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  const processId = (await electronDesktopE2eProbe()).processId;
  if (!toolbar.nativeWindowHandle) throw new Error("The exact native drag host is unavailable.");
  if (input.focus) await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle: toolbar.nativeWindowHandle });
  const raw = await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class RionTabPoint {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w, ref POINT p);
}

'@
[RionTabPoint]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$w = [IntPtr]::new([long]$payload.handle)
$owner = [uint32]0
[RionTabPoint]::GetWindowThreadProcessId($w, [ref]$owner) | Out-Null
if ($owner -ne $payload.processId) { throw 'The native drag owner changed' }
$s = [RionTabPoint]::GetDpiForWindow($w) / 96.0
$p = New-Object RionTabPoint+POINT
$p.X = [int]($payload.x * $s); $p.Y = [int]($payload.y * $s)
if (-not [RionTabPoint]::ClientToScreen($w, [ref]$p)) { throw 'Native tab point unavailable' }
@{x=$p.X;y=$p.Y} | ConvertTo-Json -Compress
`, { ...point, handle: toolbar.nativeWindowHandle, processId }, { timeoutMilliseconds: 15_000 });
  return { ...JSON.parse(raw) as NativeDragPoint, nativeWindowHandle: toolbar.nativeWindowHandle };
}

export async function writeWindowsTabDragEvidence(mainWindowHandle: string, tabId: string): Promise<void> {
  const events = await withWindowsRuntimeHost(mainWindowHandle, tabId, () => browser.execute(() =>
    (window as unknown as { __rionTabPointerEvidence?: unknown[] }).__rionTabPointerEvidence ?? []
  )).catch(error => ({ error: String(error) }));
  await appendFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "native-tab-pointer.jsonl"),
    `${JSON.stringify({ tabId, events })}\n`);
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
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
 public static void Move(int x, int y) {
   int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
   int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
   if (width <= 0 || height <= 0 || x < left || x >= left + width || y < top || y >= top + height)
     throw new InvalidOperationException("Native drag point is outside the virtual desktop");
   // Target the physical pixel center in the normalized absolute input space.
   uint normalizedX = (uint)Math.Floor(((x - left) + 0.5) * 65536.0 / width);
   uint normalizedY = (uint)Math.Floor(((y - top) + 0.5) * 65536.0 / height);
   mouse_event(0xC001, normalizedX, normalizedY, 0, UIntPtr.Zero);
 }
}
'@
if ([RionDragPointer]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero) {
 throw 'Native drag DPI context unavailable'
}
if ($payload.phase -eq 'start') {
 if (-not [RionDragPointer]::SetCursorPos($payload.from.x,$payload.from.y)) { throw 'Native drag cursor move failed' }
 $actual = New-Object RionDragPointer+POINT
 if (-not [RionDragPointer]::GetCursorPos([ref]$actual) -or
     $actual.X -ne [int]$payload.from.x -or $actual.Y -ne [int]$payload.from.y) { throw 'Native drag cursor readback differs' }
 $hit = [RionDragPointer]::GetAncestor([RionDragPointer]::WindowFromPoint($actual), 2)
 $expected = [IntPtr]::new([long]$payload.from.nativeWindowHandle)
 if ($hit -ne $expected -or [RionDragPointer]::GetForegroundWindow() -ne $expected) {
   throw "Native tab drag missed its exact foreground HWND: expected=$expected hit=$hit"
 }
 [RionDragPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
}
foreach ($step in 1..16) {
 $f = $step / 16.0
 [RionDragPointer]::Move([int]($payload.from.x+($payload.to.x-$payload.from.x)*$f),[int]($payload.from.y+($payload.to.y-$payload.from.y)*$f))
 Start-Sleep -Milliseconds 25
}
if ($payload.phase -eq 'cancel') { [RionDragPointer]::keybd_event(27,0,0,[UIntPtr]::Zero); [RionDragPointer]::keybd_event(27,0,2,[UIntPtr]::Zero) }
if ($payload.phase -in @('end','cancel')) { [RionDragPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
@{ applied=$true } | ConvertTo-Json -Compress
`, { phase, from, to }, { timeoutMilliseconds: 15_000 });
}
