import { readSourceTree as readFile } from "./helpers/readSourceTree";
import { describe, expect, it } from "vitest";
import { expectNoMacosLifecycleUrlReconciliation } from "./helpers/assertMacosLifecycleSource";

describe("Tauri native lifecycle source", () => {
  it("keeps surface close and main focus completion strictly event-bound", async () => {
    const [
      surfaceClose,
      roleSetup,
      sessionStorage,
      mainWindow,
      windowsLifecycle,
      macLifecycle,
      windowClose,
      tabMutation
    ] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_26_sync_native_tab_metadata.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_08_runtime_game_window_save_input.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_29_session_storage.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_04_main_window_actor.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/platform/windows/lifecycle.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/native/macos/RionWKWebViewInput/01_surface_lifecycle_security.m",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/lib/section_02_drop.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/lib/section_01_tab_mutation.rs", import.meta.url),
        "utf8"
      )
    ]);
    const surfaceContinuation = surfaceClose.slice(
      surfaceClose.indexOf("async fn close_surface_event_bound("),
      surfaceClose.indexOf("fn close_failed_launch_surface_and_wait(")
    );
    const focusContinuation = mainWindow.slice(
      mainWindow.indexOf("fn apply_main_window_request("),
      mainWindow.indexOf("fn main_window_readback_matches(")
    );
    const windowsIsolation = windowsLifecycle.slice(
      windowsLifecycle.indexOf("fn platform_surface_lifecycle_tracker("),
      windowsLifecycle.indexOf("fn install_process_failure_monitor(")
    );
    const windowCloseTransaction = windowClose.slice(
      windowClose.indexOf("async fn execute_game_window_close_transaction("),
      windowClose.indexOf("fn record_desktop_e2e_window_close_admission", windowClose.indexOf(
        "async fn execute_game_window_close_transaction("
      ))
    );
    const osWindowCloseTransaction = windowClose.slice(
      windowClose.indexOf("async fn process_game_window_close_requested("),
      windowClose.indexOf("async fn process_deferred_windows_close_requested(")
    );
    for (const source of [surfaceContinuation, focusContinuation, windowsIsolation]) {
      for (const forbidden of [
        "polling",
        "watchdog",
        "wait_timeout",
        "recv_timeout",
        "thread::sleep"
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    expect(surfaceContinuation).toContain("wait_for_isolation_event().await");
    expect(surfaceContinuation).toContain("wait_for_native_release_event().await");
    expect(surfaceContinuation.indexOf("persist_role_cookie_checkpoint(webview, role_id)"))
      .toBeLessThan(surfaceContinuation.indexOf("quiesce_platform_surface("));
    expect(focusContinuation).toContain("MainWindowApplyResult::FocusSubmitted");
    expect(focusContinuation).toContain(".recv()");
    expect(focusContinuation).not.toContain("is_focused");
    expect(focusContinuation.indexOf("if command.requests_focus()"))
      .toBeLessThan(focusContinuation.indexOf("MainWindowStateProjection::capture(window)"));
    expect(windowsIsolation).toContain("add_NavigationStarting");
    expect(windowsIsolation).toContain("add_NavigationCompleted");
    expect(windowsIsolation).toContain("windows_surface_navigation_completion");
    expect(windowsIsolation).toContain("GetCookiesCompletedHandler");
    expect(windowsIsolation).toContain("GetCookies(PCWSTR::null(), &preflight)");
    expect(windowsIsolation).toContain(
      "windows_surface_quiesce_completes_at_stop(defer_navigation_to_preflight)"
    );
    expect(windowsIsolation).toContain("callback_lifecycle.mark_isolated(13)");
    expect(windowsIsolation).not.toContain("shutdown-isolation-navigation");
    expect(windowsIsolation).not.toContain("AddOrUpdateCookie");
    const windowsPreflight = windowsIsolation.slice(
      windowsIsolation.indexOf("let preflight = GetCookiesCompletedHandler"),
      windowsIsolation.indexOf("GetCookies(PCWSTR::null(), &preflight)")
    );
    expect(windowsPreflight.indexOf("preflight_core.Stop()"))
      .toBeLessThan(windowsPreflight.indexOf(
        "Navigate(&windows::core::HSTRING::from(\"about:blank\"))"
      ));
    expect(roleSetup.indexOf("platform_role_surface_setup("))
      .toBeLessThan(roleSetup.indexOf("restore_role_cookie_checkpoint(webview, role_id)"));
    expect(sessionStorage).toContain("webview.cookies()");
    expect(sessionStorage).toContain("protect_session_transfer(");
    expect(sessionStorage).toContain("role_browser_directory(user_data_dir, role_id)?.join(\"system\")");
    expect(sessionStorage).toContain("write_private_file(&directory, ROLE_COOKIE_CHECKPOINT_FILE");
    expect(sessionStorage.match(/deduplicate_role_cookie_checkpoint_records\(/g)).toHaveLength(3);
    expect(sessionStorage).toContain("checkpoint_window_close_role_cookies(");
    expect(sessionStorage).toContain("checkpoint_tab_close_role_cookies(");
    expect(sessionStorage).toContain("native_absent_tab_can_skip_window_cookie_checkpoint(");
    expect(sessionStorage).toContain("surface.cookies-checkpointed");
    expect(sessionStorage).toContain("cookies_checkpointed_for_close = true");
    expect(windowCloseTransaction.indexOf("checkpoint_window_close_role_cookies"))
      .toBeLessThan(windowCloseTransaction.indexOf("CoreCommand::BrowserWindowCloseAdmit"));
    expect(osWindowCloseTransaction.indexOf("checkpoint_window_close_role_cookies"))
      .toBeLessThan(osWindowCloseTransaction.indexOf("CoreCommand::BrowserWindowCloseAdmit"));
    expect(tabMutation.indexOf("checkpoint_tab_close_role_cookies"))
      .toBeLessThan(tabMutation.indexOf("preview_tab_close"));
    expect(tabMutation.indexOf("spawn_blocking(move ||"))
      .toBeLessThan(tabMutation.indexOf("checkpoint_tab_close_role_cookies"));
    expect(tabMutation.indexOf("checkpoint_tab_close_role_cookies"))
      .toBeLessThan(tabMutation.indexOf("CoreCommand::EmbeddedTabStop"));
    expect(tabMutation).toContain("tabStopCookieCheckpointFailed");
    expect(tabMutation).toContain("SYSTEM_TAB_CLOSE_COOKIE_CHECKPOINT_INTERRUPTED");
    expect(sessionStorage).not.toContain("ROLE_LOCAL_STORAGE_CHECKPOINT");
    expect(surfaceContinuation).not.toContain("evaluate_system_webview");
    expect(windowCloseTransaction.indexOf("CoreCommand::BrowserWindowCloseAdmit"))
      .toBeLessThan(windowCloseTransaction.indexOf("commit_visible_window_close"));
    expect(sessionStorage.indexOf("set_cookie(cookie.clone())"))
      .toBeLessThan(sessionStorage.indexOf("verify_cookie_readback(&cookies, &readback)"));
    expect(macLifecycle).not.toContain("addObserver:");
    expect(macLifecycle).not.toContain("webView.loading");
    expectNoMacosLifecycleUrlReconciliation(macLifecycle);
  });

});
