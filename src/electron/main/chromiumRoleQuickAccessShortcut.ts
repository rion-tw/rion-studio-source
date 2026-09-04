import type {
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceInputEvent
} from "./chromiumRoleSurfacePorts";

export interface ChromiumRoleQuickAccessShortcutPort {
  readonly platform: "darwin" | "win32";
  readonly request: (tabId: string) => void;
  readonly requestFullscreen?: (tabId: string) => void;
  readonly onError: (error: unknown) => void;
}

export function isChromiumRoleFullscreenShortcut(
  input: ChromiumRoleSurfaceInputEvent,
  platform: "darwin" | "win32"
): boolean {
  return platform === "win32" &&
    (input.code === "F11" || input.key === "F11") &&
    !input.alt && !input.control && !input.meta && !input.shift;
}

export function isChromiumRoleQuickAccessShortcut(
  input: ChromiumRoleSurfaceInputEvent,
  platform: "darwin" | "win32"
): boolean {
  const isK = input.code === "KeyK" || input.key.toLowerCase() === "k";
  if (!isK || input.alt || input.shift) return false;
  return platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
}

export function interceptChromiumRoleQuickAccessShortcut(input: Readonly<{
  event: ChromiumRoleSurfaceEvent;
  inputEvent: ChromiumRoleSurfaceInputEvent;
  port: ChromiumRoleQuickAccessShortcutPort | null;
  tabId: string;
}>): void {
  const { port } = input;
  if (!port) return;
  if (isChromiumRoleFullscreenShortcut(input.inputEvent, port.platform)) {
    input.event.preventDefault();
    if (
      input.inputEvent.type !== "keyDown" || input.inputEvent.isAutoRepeat ||
      !port.requestFullscreen
    ) {
      return;
    }
    try {
      port.requestFullscreen(input.tabId);
    } catch (error) {
      port.onError(error);
    }
    return;
  }
  if (!isChromiumRoleQuickAccessShortcut(input.inputEvent, port.platform)) return;
  // The application shortcut is owned above page content. Prevent both halves
  // of KeyK so the managed game never observes the reserved key.
  input.event.preventDefault();
  if (input.inputEvent.type !== "keyDown" || input.inputEvent.isAutoRepeat) return;
  try {
    port.request(input.tabId);
  } catch (error) {
    port.onError(error);
  }
}
