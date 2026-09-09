import type { GraphicsSettingsRecord, GraphicsStatusRecord } from "./generated";

export const defaultGraphicsSettings: GraphicsSettingsRecord = {
  hardwareAcceleration: true, rasterization: "auto", videoDecode: "auto"
};

export function graphicsSettingsEqual(a: GraphicsSettingsRecord, b: GraphicsSettingsRecord): boolean {
  return a.hardwareAcceleration === b.hardwareAcceleration &&
    a.rasterization === b.rasterization && a.videoDecode === b.videoDecode;
}

export function isGraphicsSettings(value: unknown): value is GraphicsSettingsRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 3 && typeof item.hardwareAcceleration === "boolean" &&
    ["auto", "enabled", "disabled"].includes(String(item.rasterization)) &&
    ["auto", "disabled"].includes(String(item.videoDecode));
}

export function unsupportedGraphicsStatus(): GraphicsStatusRecord {
  return { supported: false, sequence: 0, initialized: false, hardwareAcceleration: null,
    appliedSettings: null, features: {}, devices: [], driver: {}, versions: {},
    problems: [], complete: false, error: null };
}
