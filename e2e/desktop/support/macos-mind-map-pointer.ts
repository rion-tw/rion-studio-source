import { browser } from "@wdio/globals";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { focusMainApplicationWindow, probe } from "./control";

const executeFile = promisify(execFile);

/** The WKWebView driver dispatches mousemove without native hover enter/leave. */
export async function moveMacosMindMapPointer(nodeId?: string): Promise<void> {
  if (process.platform !== "darwin" || !browser.tauri) {
    throw new Error("Native mind map pointer input requires macOS Tauri");
  }
  await focusMainApplicationWindow();
  const { pid } = await probe();
  const origin = await browser.tauri.execute(async ({ core }) => {
    const [position, scale] = await Promise.all([
      core.invoke("plugin:window|inner_position", { label: "main" }),
      core.invoke("plugin:window|scale_factor", { label: "main" })
    ]) as [{ x: number; y: number }, number];
    return { x: position.x / scale, y: position.y / scale };
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
  const x = origin.x + point.x;
  const y = origin.y + point.y;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Native mind map pointer identity or coordinates are invalid");
  }
  await executeFile("/usr/bin/xcrun", ["swift", "-e", `
import AppKit
import CoreGraphics
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(${pid}),
      let source = CGEventSource(stateID: .hidSystemState),
      let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
        mouseCursorPosition: CGPoint(x: ${x}, y: ${y}), mouseButton: .left)
else { fatalError("Exact Rion main window or pointer source unavailable") }
event.post(tap: .cghidEventTap)
`], { encoding: "utf8", timeout: 30_000 });
}
