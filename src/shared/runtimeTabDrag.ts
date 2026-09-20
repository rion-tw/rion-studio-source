import type { LayoutBounds } from "./generated";
export type RuntimeTabDragGeometry = Readonly<{
  type: "tabDragGeometry";
  windowId: string;
  projectionRevision: number;
  row: LayoutBounds;
  tabs: readonly Readonly<{ tabId: string; bounds: LayoutBounds }>[];
}>;
export type RuntimeTabDragStartCommand = Readonly<{
  type: "tabDragStart";
  windowGeneration: number;
  windowId: string;
  projectionRevision: number;
  sessionId: string;
  tabId: string;
  ratio: Readonly<{ x: number; y: number }>;
}>;
export function isRuntimeTabDragCommand(value: Record<string, unknown>): boolean {
  const bounds = (v: unknown): v is LayoutBounds => {
    if (!v || typeof v !== "object") return false;
    const r = v as LayoutBounds;
    return Object.keys(r).length === 4 && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 0 && r.height >= 0;
  };
  if (value.type === "tabDragGeometry") {
    return Object.keys(value).length === 5 && bounds(value.row) && Array.isArray(value.tabs) && value.tabs.length <= 256 &&
      value.tabs.every(t => t && typeof t.tabId === "string" && t.tabId.length > 0 && Object.keys(t).length === 2 && bounds(t.bounds)) &&
      new Set(value.tabs.map(t => t.tabId)).size === value.tabs.length;
  }
  const r = value.ratio as { x?: unknown; y?: unknown } | undefined;
  return value.type === "tabDragStart" && Object.keys(value).length === 7 &&
    Number.isSafeInteger(value.windowGeneration) && (value.windowGeneration as number) > 0 &&
    typeof value.sessionId === "string" && /^[\da-f-]{36}$/iu.test(value.sessionId) &&
    typeof value.tabId === "string" && value.tabId.length > 0 && !!r && Object.keys(r).length === 2 &&
    [r.x, r.y].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
}
