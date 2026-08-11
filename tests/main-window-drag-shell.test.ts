import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("main window chrome shell", () => {
  it("keeps minimize and maximize ordered in the focus-neutral actor without custom drag", async () => {
    const [shell, runtime, windowsLifecycle, nativePresentation] = await Promise.all([
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_04_main_window_actor.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/platform/windows/lifecycle.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_05_is_surface_close_effect.rs", "utf8")
    ]);
    const start = shell.indexOf("async fn rion_shell_invoke(");
    const end = shell.indexOf("\nfn string_argument(", start);
    const shellInvoke = shell.slice(start, end);
    const closeStart = shellInvoke.indexOf('"requestCurrentWindowClose"');
    const minimizeStart = shellInvoke.indexOf('"minimizeCurrentWindow"', closeStart);
    const closeBranch = shellInvoke.slice(closeStart, minimizeStart);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(shellInvoke).toContain('"minimizeCurrentWindow"');
    expect(shellInvoke).toContain('minimize_main_window("renderer-minimize-requested")');
    expect(closeStart).toBeGreaterThanOrEqual(0);
    expect(minimizeStart).toBeGreaterThan(closeStart);
    expect(closeBranch).toContain("app.exit(0)");
    expect(closeBranch).not.toContain("main_window_hide");
    expect(shellInvoke).not.toContain('"startCurrentWindowDrag"');
    expect(shellInvoke).not.toContain(".start_main_window_drag()");
    expect(shellInvoke).toContain('"toggleCurrentWindowMaximize"');
    expect(shellInvoke).toContain(".toggle_main_window_maximized()");
    expect(runtime).toContain("struct MainWindowActor {");
    expect(runtime).toContain("MAIN_WINDOW_ACTOR_CAPACITY");
    expect(runtime).not.toContain("window.start_dragging()");
    expect(runtime).toContain("window.minimize()");
    expect(runtime).toContain("pending_maximize");
    expect(runtime).not.toContain("window.set_focus()");
    expect(runtime).toContain("request_platform_webview_window_toggle_maximized(window)");
    expect(runtime).toContain("request_platform_webview_window_set_fullscreen(");
    expect(runtime).toContain("main_window_readback_matches(");
    expect(windowsLifecycle).toContain("WM_SYSCOMMAND");
    expect(windowsLifecycle).toContain("PostMessageW");
    expect(windowsLifecycle).toContain("SC_MAXIMIZE");
    expect(windowsLifecycle).toContain("SC_RESTORE");
    const fullscreen = windowsLifecycle.slice(
      windowsLifecycle.indexOf("fn request_platform_window_set_fullscreen("),
      windowsLifecycle.indexOf("fn request_platform_window_toggle_fullscreen(")
    );
    expect(fullscreen).toContain(".set_fullscreen(fullscreen)");
    expect(fullscreen).toContain("request_platform_window_show(window)");
    expect(fullscreen).toContain("WS_VISIBLE");
    expect(nativePresentation).toContain("request_platform_window_set_fullscreen(&window, true)");
    expect(nativePresentation).toContain("request_platform_window_toggle_fullscreen(&window)");
    expect(nativePresentation).not.toContain("window.set_fullscreen(!fullscreen)");
  });
});
