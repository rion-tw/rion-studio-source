import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("main window chrome shell", () => {
  it("handles renderer minimize, drag, and maximize requests on the current Tauri window", async () => {
    const [shell, runtime] = await Promise.all([
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8")
    ]);
    const start = shell.indexOf("async fn rion_shell_invoke(");
    const end = shell.indexOf("\nfn string_argument(", start);
    const shellInvoke = shell.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(shellInvoke).toContain('"minimizeCurrentWindow"');
    expect(shellInvoke).toContain('hide_main_window("renderer-minimize-requested")');
    expect(shellInvoke).toContain('"startCurrentWindowDrag"');
    expect(shellInvoke).toContain(".start_main_window_drag()");
    expect(shellInvoke).toContain('"toggleCurrentWindowMaximize"');
    expect(shellInvoke).toContain(".toggle_main_window_maximized()");
    expect(runtime).toContain("struct MainWindowActor {");
    expect(runtime).toContain("MAIN_WINDOW_ACTOR_CAPACITY");
    expect(runtime).toContain("window.start_dragging()");
    expect(runtime).toContain("window.is_maximized()");
    expect(runtime).toContain("window.unmaximize()");
    expect(runtime).toContain("window.maximize()");
    expect(runtime).toContain("main_window_readback_matches(");
  });
});
