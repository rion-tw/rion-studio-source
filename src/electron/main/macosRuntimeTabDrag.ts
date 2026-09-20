import type { RuntimeTabDragInput } from "./runtimeTabDragController";

export function forwardMacosRuntimeTabDrag(action: Readonly<Record<string, unknown>>,
  receive: (input: RuntimeTabDragInput) => void): boolean {
  const type = action.type;
  if (!["tabDragStart", "tabDragMove", "tabDragHover", "tabDragDrop", "tabDragEnd"].includes(String(type))) return false;
  const sessionId = action.sessionId;
  const { screenX: x, screenY: y } = action;
  if (typeof sessionId !== "string" || !sessionId || typeof x !== "number" || !Number.isFinite(x) ||
      typeof y !== "number" || !Number.isFinite(y)) throw new Error("Malformed native tab drag event.");
  const point = { x, y };
  if (type === "tabDragStart") {
    const { tabId, sourceWindowId, grabRatioX, grabRatioY } = action;
    if (typeof tabId !== "string" || typeof sourceWindowId !== "string" ||
        typeof grabRatioX !== "number" || typeof grabRatioY !== "number" ||
        ![grabRatioX, grabRatioY].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new Error("Malformed native tab drag start.");
    }
    receive({ phase: "start", sessionId, tabId, sourceWindowId, point, ratio: { x: grabRatioX, y: grabRatioY } });
  } else {
    receive({ sessionId, point, phase: type === "tabDragDrop" ? "end" : type === "tabDragEnd"
      ? (action.cancelled === true ? "cancel" : "end") : "move" });
  }
  return true;
}
