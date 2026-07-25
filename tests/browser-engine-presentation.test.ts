import { describe, expect, it } from "vitest";

import {
  getBrowserEngineStatusTitle,
  getResolvedBrowserEngineLabel
} from "../src/renderer/src/app/browserEnginePresentation";
import { createTranslator } from "../src/renderer/src/i18n";
import type { RoleStatus } from "../src/shared/types";

describe("browser engine presentation", () => {
  const t = createTranslator("en");

  it("labels every resolved runtime engine", () => {
    expect(getResolvedBrowserEngineLabel("webview2", t)).toBe("WebView2");
    expect(getResolvedBrowserEngineLabel("wkwebview", t)).toBe("WKWebView");
    expect(getResolvedBrowserEngineLabel("electron", t)).toBe("Electron");
    expect(getResolvedBrowserEngineLabel("external-chrome", t)).toBe("External Chrome");
  });

  it("makes the preferred engine, actual engine, and fallback reason visible", () => {
    const status: RoleStatus = {
      roleId: "role-1",
      state: "running",
      runtimeMode: "embedded",
      preferredEngine: "system",
      resolvedEngine: "electron",
      hostKind: "electron",
      fallbackReason: "runtime-creation-failed"
    };

    expect(getBrowserEngineStatusTitle(status, t)).toBe(
      "Preferred System WebView; running with Electron. Reason: the System runtime is not available in this release or could not start."
    );
  });
});
