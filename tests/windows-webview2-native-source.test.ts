import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Windows WebView2 native source", () => {
  it("keeps custom proxy and the eight-rule interception path in the native adapter", async () => {
    const source = await readFile(
      new URL("../native/windows/webview2/addon.cc", import.meta.url),
      "utf8"
    );

    expect(source).toContain("put_AdditionalBrowserArguments");
    expect(source).toContain("--proxy-server=");
    expect(source).toContain("AddWebResourceRequestedFilter");
    expect(source).toContain("add_WebResourceRequested");
    expect(source).toContain("put_Uri");
    expect(source).toContain("configureWebView2RequestRewrites");
    expect(source).toContain("CreateCoreWebView2Controller");
    expect(source).toContain("put_NewWindow");
    expect(source).toContain("popupCreated");
    expect(source).toContain("add_DownloadStarting");
    expect(source).toContain("add_PermissionRequested");
    expect(source).toContain("COREWEBVIEW2_PERMISSION_STATE_DENY");
  });
});
