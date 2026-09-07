import { browser } from "@wdio/globals";

import { runEncodedPowerShellJson } from "../../../scripts/encodedPowerShell.mjs";
import { focusMainApplicationWindow, probe } from "./control";

/** Use native pointer movement for the WebView2 hover journey. */
export async function moveWindowsMindMapPointer(nodeId?: string): Promise<void> {
  if (process.platform !== "win32" || !browser.tauri) {
    throw new Error("Native mind map pointer input requires Windows Tauri");
  }
  await focusMainApplicationWindow();
  const { pid } = await probe();
  const geometry = await browser.tauri.execute(async ({ core }) => {
    const [origin, size, scale] = await Promise.all([
      core.invoke("plugin:window|inner_position", { label: "main" }),
      core.invoke("plugin:window|inner_size", { label: "main" }),
      core.invoke("plugin:window|scale_factor", { label: "main" })
    ]) as [{ x: number; y: number }, { width: number; height: number }, number];
    return { origin, size, scale };
  });
  const point = await browser.execute((id) => {
    const element = document.querySelector<HTMLElement>(id
      ? `[data-macro-mind-map] .react-flow__node[data-id='${CSS.escape(id)}']`
      : ".app-main-sidebar");
    if (!element) throw new Error("Visible mind map pointer target is missing");
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (!element.contains(document.elementFromPoint(x, y))) {
      throw new Error("Mind map pointer target is obscured");
    }
    return { x, y };
  }, nodeId);
  const target = {
    processId: pid, originX: geometry.origin.x, originY: geometry.origin.y,
    width: geometry.size.width, height: geometry.size.height,
    x: Math.round(point.x * geometry.scale), y: Math.round(point.y * geometry.scale)
  };
  if (!Number.isSafeInteger(pid) || pid <= 1 ||
      !Object.values(target).every(Number.isSafeInteger) ||
      target.x < 0 || target.y < 0 || target.x >= target.width || target.y >= target.height) {
    throw new Error("Native mind map pointer identity or coordinates are invalid");
  }
  await runEncodedPowerShellJson(String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RionMindMapPointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  public static void Move(uint expectedPid, int originX, int originY, int width, int height, int x, int y) {
    var hwnd = GetForegroundWindow();
    uint pid; Rect rect; var origin = new Point();
    GetWindowThreadProcessId(hwnd, out pid);
    if (hwnd == IntPtr.Zero || pid != expectedPid || !GetClientRect(hwnd, out rect) ||
        !ClientToScreen(hwnd, ref origin) || origin.x != originX || origin.y != originY ||
        rect.right - rect.left != width || rect.bottom - rect.top != height)
      throw new InvalidOperationException("Exact focused main-window geometry changed before native hover");
    var point = new Point { x = originX + x, y = originY + y };
    if (GetAncestor(WindowFromPoint(point), 2) != hwnd)
      throw new InvalidOperationException("Native mind map pointer target is occluded");
    Point actual;
    if (!SetCursorPos(point.x, point.y) || !GetCursorPos(out actual) ||
        actual.x != point.x || actual.y != point.y || GetForegroundWindow() != hwnd ||
        GetAncestor(WindowFromPoint(actual), 2) != hwnd)
      throw new InvalidOperationException("Native mind map pointer move was not acknowledged");
  }
}
'@
$priorDpi = [RionMindMapPointer]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($priorDpi -eq [IntPtr]::Zero) { throw 'Native hover DPI context unavailable' }
try {
  [RionMindMapPointer]::Move([uint32]$payload.processId, [int]$payload.originX, [int]$payload.originY,
    [int]$payload.width, [int]$payload.height, [int]$payload.x, [int]$payload.y)
} finally {
  [RionMindMapPointer]::SetThreadDpiAwarenessContext($priorDpi) | Out-Null
}
`, target, { timeoutMilliseconds: 30_000 });
}
