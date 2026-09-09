import { isGraphicsSettings } from "../../shared/graphicsSettings";
import type { GraphicsSettingsRecord, GraphicsSettingsSnapshotRecord } from "../../shared/generated";

export interface GraphicsStartupPort {
  isReady(): boolean;
  disableHardwareAcceleration(): void;
  commandLine: { appendSwitch(name: string): void; removeSwitch(name: string): void };
}

export function applyGraphicsStartup(
  app: GraphicsStartupPort,
  read: () => string,
  platform: "darwin" | "win32"
): GraphicsSettingsRecord {
  if (app.isReady()) throw new Error("Graphics settings must be applied before Electron ready.");
  if (platform !== "darwin" && platform !== "win32") throw new Error("Unsupported graphics platform.");
  const value: unknown = JSON.parse(read());
  const snapshot = value as GraphicsSettingsSnapshotRecord | null;
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !isGraphicsSettings(snapshot.settings)) throw new Error("Invalid Rust graphics settings snapshot.");
  const settings = snapshot.settings;
  for (const name of ["enable-gpu-rasterization", "disable-gpu-rasterization", "disable-accelerated-video-decode"]) {
    app.commandLine.removeSwitch(name);
  }
  if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();
  if (settings.hardwareAcceleration && settings.rasterization !== "auto") {
    app.commandLine.appendSwitch(settings.rasterization === "enabled"
      ? "enable-gpu-rasterization" : "disable-gpu-rasterization");
  }
  if (settings.hardwareAcceleration && settings.videoDecode === "disabled") {
    app.commandLine.appendSwitch("disable-accelerated-video-decode");
  }
  return { ...settings };
}
