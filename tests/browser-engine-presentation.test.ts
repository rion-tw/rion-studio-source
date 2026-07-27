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
  });

  it("makes the system engine and native runtime failure visible", () => {
    const status: RoleStatus = {
      roleId: "role-1",
      state: "running",
      runtimeMode: "embedded",
      resolvedEngine: "wkwebview",
      hostKind: "system-native",
      issueReason: "runtime-creation-failed"
    };

    expect(getBrowserEngineStatusTitle(status, t)).toBe(
      "WKWebView reported a runtime issue: the System runtime is not available in this release or could not start."
    );
  });
});
