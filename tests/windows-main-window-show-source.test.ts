import { describe, expect, it } from "vitest";

import { readSourceTree as readFile } from "./helpers/readSourceTree";

describe("Windows main-window show acknowledgement", () => {
  it("shows synchronously before checking native visibility", async () => {
    const lifecycle = await readFile(
      new URL(
        "../src-tauri/src/system_runtime/platform/windows/lifecycle.rs",
        import.meta.url
      ),
      "utf8"
    );
    const showStart = lifecycle.indexOf(
      "fn request_platform_webview_window_show("
    );
    const show = lifecycle.slice(
      showStart,
      lifecycle.indexOf(
        "fn request_platform_webview_window_show_foreground(",
        showStart
      )
    );

    expect(show).toContain("ShowWindow(hwnd, SW_SHOWNOACTIVATE)");
    expect(show).toContain("IsWindowVisible(hwnd)");
    expect(show).not.toContain("ShowWindowAsync");
  });
});
