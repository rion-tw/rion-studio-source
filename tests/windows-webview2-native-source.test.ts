import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Windows WebView2 native source", () => {
  it("keeps the wrapper and verifier on the native protocol version", async () => {
    const [native, wrapper, verifier] = await Promise.all([
      readFile("native/windows/webview2/addon.cc", "utf8"),
      readFile("src/main/browser/WindowsWebView2Surface.ts", "utf8"),
      readFile("scripts/verifyWindowsWebView2.mjs", "utf8")
    ]);

    expect(native).toContain("kProtocolVersion = 9");
    expect(wrapper).toContain("NATIVE_PROTOCOL_VERSION = 9");
    expect(verifier).toContain("addon.protocolVersion !== 9");
    expect(verifier).not.toContain("configureWebView2RequestRewrites");
  });

  it("keeps custom proxy and browser integration in the native adapter", async () => {
    const source = await readFile(
      new URL("../native/windows/webview2/addon.cc", import.meta.url),
      "utf8"
    );

    expect(source).toContain("put_AdditionalBrowserArguments");
    expect(source).toContain("additionalBrowserArguments");
    expect(source).toContain("additional_browser_arguments_");
    expect(source).toContain("--proxy-server=");
    expect(source).not.toContain("configureWebView2RequestRewrites");
    expect(source).toContain("CreateCoreWebView2Controller");
    expect(source).toContain("put_NewWindow");
    expect(source).toContain("popupCreated");
    expect(source).toContain("add_DownloadStarting");
    expect(source).toContain("add_PermissionRequested");
    expect(source).toContain("COREWEBVIEW2_PERMISSION_STATE_DENY");
  });
});
