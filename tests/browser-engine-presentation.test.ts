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
    expect(getResolvedBrowserEngineLabel("chromium", t)).toBe("Chromium");
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
      "WKWebView reported a runtime issue: the browser runtime is not available in this release or could not start."
    );
  });

  it("explains the fail-closed Chromium session migration gate", () => {
    const status: RoleStatus = {
      roleId: "role-v22",
      state: "launching",
      runtimeMode: "embedded",
      resolvedEngine: "chromium",
      hostKind: "bundled-chromium",
      issueReason: "session-migration-required"
    };

    expect(getBrowserEngineStatusTitle(status, t)).toBe(
      "Chromium reported a runtime issue: this role must finish session migration or be explicitly reset before Chromium can launch."
    );
  });
});
