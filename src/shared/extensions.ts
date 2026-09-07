import type { ExtensionCommand } from "./generated";

export type ExtensionUserCommand = Extract<ExtensionCommand, {
  type: "snapshot" | "prepare" | "cancel" | "install" | "configure" | "remove";
}>;

export interface ExtensionStoreState {
  url: string;
  extensionId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  failed: boolean;
}

export interface ExtensionStoreRequest {
  action: "show" | "hide" | "back" | "forward" | "reload";
  bounds?: { x: number; y: number; width: number; height: number };
}

export function chromeStoreExtensionId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.origin !== "https://chromewebstore.google.com" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 && parts.length <= 3 && parts[0] === "detail" &&
      /^[a-p]{32}$/u.test(parts.at(-1) ?? "") ? parts.at(-1)! : null;
  } catch { return null; }
}
