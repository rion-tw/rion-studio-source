import type { ExtensionCommand } from "./generated";
import type { AppLanguage } from "./types";

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
  language?: AppLanguage;
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

/** Keep the store document and unrelated search parameters when the app language changes. */
export function chromeStoreUrl(language: AppLanguage, currentUrl?: string): string {
  let url = new URL("https://chromewebstore.google.com/category/extensions");
  if (currentUrl) {
    try {
      const current = new URL(currentUrl);
      if (current.origin === url.origin && !current.username && !current.password) url = current;
    } catch { /* A not-yet-loaded document uses the category entry. */ }
  }
  url.searchParams.set("hl", language === "zh-CN" ? "zh" : language);
  return url.href;
}
