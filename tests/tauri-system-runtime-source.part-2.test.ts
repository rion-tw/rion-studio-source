import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("Tauri System WebView runtime source", () => {
it("keeps production popup, download, recovery, lifecycle, and platform input native", async () => {
    const [runtime, shell, macInput, platformProbe, powerLifecycle] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../crates/rion-platform/src/system_webview.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/power_lifecycle.rs", import.meta.url),
        "utf8"
      )
    ]);

    expect(runtime).toContain("NewWindowResponse::Create");
    expect(runtime).toContain("window_features(features)");
    expect(runtime).toContain("data_directory(popup_webview2_data_directory.clone())");
    expect(runtime).toContain("data_store_identifier(popup_webkit_data_store_identifier)");
    expect(runtime).toContain("on_download");
    expect(runtime).not.toContain("proxy_url");
    expect(runtime).toContain("add_ProcessFailed");
    expect(runtime).toContain("add_BrowserProcessExited");
    expect(runtime).toContain("controller_identity");
    expect(runtime).toContain("controller.Close()");
    expect(runtime).toContain("webview.close().map_err(RuntimeError::tauri)?");
    expect(runtime).toContain("mark_native_surface_released");
    expect(runtime).toContain("fn add_child_bounded(");
    expect(runtime).toContain("fn create_window_bounded(");
    expect(runtime).toContain("surface_host_initialization_requires_visible_parent");
    expect(runtime).toContain("set_windows_surface_host_initialization_visibility");
    const windowsSurfaceHostVisibility = runtime.slice(
      runtime.indexOf("fn set_windows_surface_host_initialization_visibility("),
      runtime.indexOf("struct SessionPaths")
    );
    expect(windowsSurfaceHostVisibility).toContain(".run_on_main_thread");
    expect(windowsSurfaceHostVisibility).toContain("ShowWindow(hwnd, command)");
    expect(windowsSurfaceHostVisibility).toContain("SW_SHOWNOACTIVATE");
    expect(windowsSurfaceHostVisibility).toContain("SW_HIDE");
    expect(windowsSurfaceHostVisibility).not.toContain("callback_window.show()");
    expect(windowsSurfaceHostVisibility).not.toContain("callback_window.set_focus()");
    expect(runtime).not.toContain("surface-host-main-thread-flush");
    expect(runtime).toContain("WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT");
    const displayHost = runtime.slice(
      runtime.indexOf("fn ensure_display_host("),
      runtime.indexOf("fn register_runtime_launcher_window(")
    );
    const windowsTabStripBuilder = displayHost.slice(
      displayHost.indexOf('runtime_label("game-tab-strip"'),
      displayHost.indexOf("let mut state = self.state()?")
    );
    expect(windowsTabStripBuilder).toContain(".disable_drag_drop_handler()");
    const windowsReveal = runtime.slice(
      runtime.indexOf("fn prepare_windows_tab_chrome_presentation("),
      runtime.indexOf("fn schedule_windows_tab_chrome_reveal_fallback(")
    );
    expect(windowsReveal).toContain("request_presentation(");
    expect(windowsReveal).toContain("focus_sequence");
    expect(windowsReveal).toContain("run_on_main_thread");
    expect(windowsReveal).toContain("set_windows_runtime_window_cloaked");
    expect(windowsReveal).toContain("register_windows_runtime_window_with_taskbar");
    expect(windowsReveal).toContain("reveal_windows_runtime_window_with_focus");
    expect(windowsReveal.indexOf("reveal_windows_runtime_window_with_focus")).toBeLessThan(
      windowsReveal.indexOf("register_windows_runtime_window_with_taskbar")
    );
    const windowsRevealForeground = windowsReveal.slice(
      windowsReveal.indexOf("fn reveal_windows_runtime_window_with_focus("),
      windowsReveal.indexOf("fn display_records_for_tab_chrome(")
    );
    expect(windowsRevealForeground.indexOf("prepare_platform_window_foreground")).toBeLessThan(
      windowsRevealForeground.indexOf("set_windows_runtime_window_cloaked")
    );
    expect(windowsRevealForeground.indexOf("set_windows_runtime_window_cloaked")).toBeLessThan(
      windowsRevealForeground.indexOf("request_platform_window_show_foreground")
    );
    const windowsForegroundStart = runtime.indexOf("fn prepare_platform_window_foreground(");
    const windowsForeground = runtime.slice(
      windowsForegroundStart,
      runtime.indexOf("fn request_platform_webview_window_show(", windowsForegroundStart)
    );
    expect(windowsForeground).toContain("Some(HWND_TOP)");
    expect(windowsForeground).toContain("SWP_NOACTIVATE");
    expect(windowsForeground).toContain("SetForegroundWindow(hwnd)");
    expect(windowsForeground).toContain("ShowWindowAsync(hwnd, command)");
    expect(windowsForeground).toContain("SW_RESTORE");
    expect(windowsForeground).toContain("SW_SHOW");
    expect(windowsForeground).not.toContain("HWND_TOPMOST");
    expect(runtime).toContain("set_appkit_window_interaction(window, false, true)");
    const windowsTaskbarRegistration = runtime.slice(
      runtime.indexOf("fn register_windows_runtime_window_with_taskbar("),
      runtime.indexOf("fn set_windows_surface_host_initialization_visibility(")
    );
    expect(windowsTaskbarRegistration).toContain("CoCreateInstance");
    expect(windowsTaskbarRegistration).toContain("taskbar.AddTab(hwnd)");
    const nativePresentationStart = runtime.indexOf("fn apply_native_presentation_batch(");
    const nativePresentation = runtime.slice(
      nativePresentationStart,
      nativePresentationStart + 30_000
    );
    expect(nativePresentation).toContain("defer_window_focus_until_reveal");
    expect(nativePresentation).toContain("focus_broker.mark_submitted(lease)");
    expect(nativePresentation).toContain("window_focused_after == Some(true)");
    const liveWindowActivation = runtime.slice(
      runtime.indexOf("fn live_window_activation_available("),
      runtime.indexOf("pub(crate) fn reveal_live_runtime_window(")
    );
    expect(liveWindowActivation).toContain("empty_host_available");
    expect(liveWindowActivation).toContain("retiring_window_revisions");
    expect(liveWindowActivation).toContain("quarantined_window_hosts");
    expect(runtime).toContain("run_serial_runtime_work_loop");
    expect(runtime).toContain("SYSTEM_WEBVIEW_CREATION_STALLED");
    expect(runtime).toContain("PermissionRequestedEventHandler");
    expect(runtime).toContain("ServerCertificateErrorDetectedEventHandler");
    expect(runtime).toContain("COREWEBVIEW2_PERMISSION_STATE_DENY");
    expect(runtime).toContain("COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL");
    expect(runtime).toContain("EmbeddedSystemSurfaceFailed");
    expect(runtime).toContain("EmbeddedSystemSurfaceRecovered");
    expect(runtime).toContain("SURFACE_RECOVERY_LIMIT");
    expect(runtime).toContain(
      '#[cfg(target_os = "macos")]\n    pub fn handle_web_content_process_terminated('
    );
    expect(runtime).toContain('internals.invoke("rion_runtime_audio_state", { audible })');
    expect(runtime).toContain("set_webview_audible");
    expect(shell).toContain("rion_runtime_audio_state");
    expect(shell).toContain('"tab.drag-started"');

    const applyRuntime = runtime.slice(
      runtime.indexOf("fn apply_runtime("),
      runtime.indexOf("fn sync_native_tab_metadata(")
    );
    expect(applyRuntime).not.toContain("sync_native_tab_metadata");
    expect(runtime).toContain("struct RuntimeDisplayHost");
    expect(runtime).toContain('runtime_label("game-display"');
    expect(runtime).not.toContain('runtime_label("game-tab", &tab.tab_id)');
    const windowsTabStrip = runtime.slice(
      runtime.indexOf("fn sync_windows_tab_metadata("),
      runtime.indexOf("fn close_surface_and_wait(")
    );
    expect(windowsTabStrip).toContain("__rionUpdateRuntimeTabMetadataBatch");
    expect(windowsTabStrip).not.toContain("__rionApplyRuntimeTabState");
    expect(windowsTabStrip).not.toContain("display_inventory");
    expect(windowsTabStrip).toContain(".presentation_phase(&tab.id)");
    const nativeMacTabs = runtime.slice(
      runtime.indexOf("fn sync_native_tab_metadata("),
      runtime.indexOf("fn sync_windows_tab_metadata(")
    );
    expect(nativeMacTabs).not.toContain("resolved_theme");
    expect(nativeMacTabs).toContain(".update_metadata(");
    expect(nativeMacTabs).not.toContain(".update(");
    expect(applyRuntime).toContain("surface.reparent(&window)");
    expect(applyRuntime).toContain("surface.window_generation = target_window_generation");
    expect(applyRuntime).toContain("synchronize_windows_reparented_surfaces(");
    expect(applyRuntime).toContain('"tab.reparent-synchronized"');
    expect(applyRuntime).toContain('"tab.reparent-sync-failed"');
    expect(applyRuntime.indexOf("surface.reparent(&window)")).toBeLessThan(
      applyRuntime.indexOf("synchronize_windows_reparented_surfaces(")
    );
    expect(applyRuntime.indexOf("synchronize_windows_reparented_surfaces(")).toBeLessThan(
      applyRuntime.indexOf("let moved_registry_surfaces")
    );
    expect(applyRuntime).not.toContain("move_tab_with_activation(");
    expect(applyRuntime).not.toContain("relocate_native_tab_reservation(");
    expect(applyRuntime).toContain("try_ensure_native_tab(");
    expect(applyRuntime).toContain("reorder_native_tabs_for_projection(");
    expect(applyRuntime).toContain("let projected_native_tab_window_ids = snapshot");
    expect(applyRuntime).not.toContain("resolved_runtime_window_selection(");
    expect(applyRuntime).toContain("presentation_after");
    expect(applyRuntime).not.toContain("dispatch_native_presentation(");
    expect(applyRuntime).toContain("request_window_contract_presentation(");
    expect(applyRuntime).toContain("NativePresentationFocus::WindowAndContent");
    expect(applyRuntime).toContain("schedule_tab_surface_move_projection(");
    expect(applyRuntime).not.toContain("SYSTEM_RUNTIME_TOPOLOGY_INVALID");
    expect(applyRuntime).not.toContain("self.presentation.remove(&window_id)");
    expect(applyRuntime).not.toContain("visibility_mutations");
    expect(applyRuntime).not.toContain("webview.set_focus()");
    expect(applyRuntime).not.toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");
    expect(applyRuntime).toContain("runtime_host_should_receive_window_focus(");
    expect(applyRuntime).toContain("self.request_window_contract_presentation(");
    expect(applyRuntime).toContain("NativeWindowMode::from_presentation(");
    expect(applyRuntime).not.toContain("update.window.unminimize()");
    expect(applyRuntime).not.toContain("update.window.set_focus()");
    expect(runtime).toContain("self.record_runtime_stage_failure(");
    expect(runtime).toContain("&setup_stage,");
    expect(runtime).toContain("record_presentation_event_with_error(");
    expect(runtime).toContain("completion.error.as_ref()");
    expect(runtime).toContain('"windowsTabChromeAcknowledged"');
    expect(runtime).toContain('"WINDOWS_TAB_CHROME_ACK_TIMEOUT"');
    expect(runtime).toContain('"WINDOWS_TAB_CHROME_ACK_WORKER_FAILED"');
    expect(runtime).toContain("WINDOWS_REPARENT_SYNC_TIMEOUT");
    expect(runtime).toContain("controller.ParentWindow(&mut controller_parent)");
    expect(runtime).toContain("GetAncestor(controller_parent, GA_ROOT)");
    expect(runtime).toContain("controller.NotifyParentWindowPositionChanged()");
    expect(runtime).not.toContain("controller.SetParentWindow(");
    expect(runtime).not.toContain("rollback_runtime_reparented_surfaces(");
    expect(runtime).not.toContain("runtime_reparent_failure(");
    expect(applyRuntime).toContain("Live tab surface projection remains pending");

    const closeRuntimeWindowStart = runtime.indexOf(
      "pub(crate) fn begin_window_close_requested("
    );
    const closeRuntimeWindow = runtime.slice(
      closeRuntimeWindowStart,
      closeRuntimeWindowStart + 14_000
    );
    expect(closeRuntimeWindow).toContain("allow_window_close_labels.remove(label)");
    expect(closeRuntimeWindow).toContain("window_closes.pending_operation_id(label)");
    expect(closeRuntimeWindow).toContain("accept_window_close_operation");
    expect(closeRuntimeWindow).toContain(
      "with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)"
    );
    expect(closeRuntimeWindow).toContain("RuntimeWindowCloseRequest::Pending");
    expect(closeRuntimeWindow).toContain("RuntimeWindowCloseRequest::Start");
    expect(runtime).toContain("pub(crate) fn complete_window_destroyed");
    expect(runtime).toContain("fn window_close_failure_status(");
    expect(runtime).toContain("request_platform_window_hide(&window)");
    expect(closeRuntimeWindow).not.toContain("window.hide()");
    expect(runtime).toContain("retiring_window_tabs");
    expect(closeRuntimeWindow).not.toContain("window.close()");
    expect(shell).toContain("match state.runtime.begin_window_close_requested(&label)");
    expect(shell).toContain("process_game_window_close_requested(");
    expect(shell).toContain("CoreCommand::BrowserWindowStop");
    expect(shell).toContain("confirm_game_window_close(&app, &window, copy)");
    expect(shell).toContain("runtime.persist_game_window_placement(&label)");
    expect(shell).toContain('"windowLabel": label');
    expect(shell).not.toContain("prune_empty_game_window_records");
    expect(shell).not.toContain("delete_empty_game_window");
    const createGameWindow = shell.slice(
      shell.indexOf('"createGameWindow" =>'),
      shell.indexOf('"showGameWindow" =>')
    );
    expect(createGameWindow).toContain("create_game_window_transaction(&state, input)");
    expect(createGameWindow).not.toContain("CoreCommand::EmbeddedWindowRegister");
    const showGameWindow = shell.slice(
      shell.indexOf('"showGameWindow" =>'),
      shell.indexOf('"updateGameWindow" =>')
    );
    expect(showGameWindow).toContain("game_window_record(&state.core, &window_id)");
    expect(showGameWindow).toContain("saved.tabs.is_empty()");
    expect(showGameWindow).toContain("activate_live_runtime_window(");
    expect(showGameWindow).toContain('"renderer-game-window-list"');
    expect(showGameWindow).toContain('"TAURI_RUNTIME_VISIBILITY_FAILED"');
    expect(showGameWindow).toContain("CoreCommand::EmbeddedWindowRegister");
    expect(showGameWindow).toContain("restore_saved_game_windows(");
    expect(showGameWindow.indexOf("activate_live_runtime_window(")).toBeLessThan(
      showGameWindow.indexOf("restore_saved_game_windows(")
    );
    const restoreSavedWindows = shell.slice(
      shell.indexOf("async fn restore_saved_game_windows("),
      shell.indexOf("fn browser_runtime_snapshot(")
    );
    expect(restoreSavedWindows).toContain("activate_live_runtime_window(");
    expect(restoreSavedWindows).toContain("reveal_live_runtime_window(");
    expect(restoreSavedWindows).toContain('"saved-window-active-surface-attached"');
    expect(restoreSavedWindows).toContain('"saved-window-restore"');
    expect(restoreSavedWindows).toContain('"TAURI_RESTORE_ACTIVATION_FAILED"');
    expect(restoreSavedWindows).not.toContain("CoreCommand::EmbeddedWindowsShow");
    expect(restoreSavedWindows).not.toContain("CoreCommand::GameWindowDelete");
    expect(restoreSavedWindows).not.toContain("game_windows.retain");
    const resizeObserver = runtime.slice(
      runtime.indexOf("pub fn observe_resize_window("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(resizeObserver).toContain("windows_live_resize_observe");
    expect(resizeObserver).toContain("record_windows_live_resize_counters");
    expect(resizeObserver).not.toContain("windows_resize_snapshot_is_unchanged");
    expect(runtime).toContain("#[cfg(not(windows))]\nconst WINDOW_RESIZE_FRAME_INTERVAL");
    expect(runtime).toContain("#[cfg(not(windows))]\nconst WINDOW_PLACEMENT_PERSIST_DEBOUNCE");
    expect(runtime).toContain("commit_windows_geometry_receipt");
    const geometryReceiptCommit = runtime.slice(
      runtime.indexOf("fn commit_windows_geometry_receipt("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(geometryReceiptCommit.indexOf("window.is_fullscreen()")).toBeLessThan(
      geometryReceiptCommit.indexOf("let target = self.state.lock()")
    );
    expect(geometryReceiptCommit).toContain("persist_game_window_placement");
    const resizeLayoutStart = runtime.indexOf("fn layout_runtime_tab_inner_with_metrics(");
    const resizeLayout = runtime.slice(
      resizeLayoutStart,
      runtime.indexOf("fn schedule_layout_surface_recovery(", resizeLayoutStart)
    );
    const windowsResizeMetricsStart = resizeLayout.indexOf(
      "let metrics = match metrics_override"
    );
    const windowsResizeMetrics = resizeLayout.slice(
      windowsResizeMetricsStart,
      resizeLayout.indexOf("#[cfg(not(windows))]", windowsResizeMetricsStart)
    );
    expect(windowsResizeMetrics.indexOf("Some(metrics)")).toBeLessThan(
      windowsResizeMetrics.indexOf("self.windows_tab_strip_height")
    );
    expect(resizeLayout).toContain("windows_live_resize_publish_plan");
    expect(resizeLayout).toContain("apply_resize_layout_mutations(&window, mutations)");
    const windowsResizeSubmission = runtime.slice(
      runtime.indexOf("#[cfg(windows)]\nfn apply_resize_layout_mutations("),
      runtime.indexOf("#[cfg(not(windows))]\nfn apply_resize_layout_mutations(")
    );
    expect(windowsResizeSubmission).toContain("submit_native_layout_mutations(&mutations)");
    expect(windowsResizeSubmission).not.toContain("run_on_main_thread");
    expect(windowsResizeSubmission).not.toContain("recv_timeout");
    const liveResizeProcStart = runtime.indexOf(
      'unsafe extern "system" fn windows_live_resize_subclass_proc('
    );
    const liveResizeProc = runtime.slice(
      liveResizeProcStart,
      runtime.indexOf("fn windows_live_resize_notify_parent_position_changed(", liveResizeProcStart)
    );
    expect(runtime).toContain("SetWindowSubclass");
    expect(runtime).toContain("WM_SIZE");
    expect(runtime).toContain("SIZE_MINIMIZED");
    expect(runtime).toContain("WM_RION_GEOMETRY_FLUSH");
    expect(runtime).toContain("PostMessageW");
    expect(runtime).toContain("BeginDeferWindowPos");
    expect(runtime).toContain("surface.controller.SetBounds");
    expect(runtime).not.toContain("windows_live_resize_surface_bounds_match");
    expect(runtime).not.toContain("MapWindowPoints");
    expect(runtime).not.toContain("controller.Bounds(&mut");
    expect(runtime).toContain("native_frame_unchanged");
    expect(runtime).toContain("WINDOWS_LIVE_RESIZE_REGISTRY");
    expect(runtime).toContain(
      "background_color(tauri::utils::config::Color(0, 0, 0, 0))"
    );
    expect(runtime).not.toContain(
      "background_color(tauri::utils::config::Color(0, 0, 0, 255))"
    );
    expect(liveResizeProc).not.toContain("self.state");
    expect(liveResizeProc).not.toContain("AppCore");
    expect(liveResizeProc).not.toContain("LogsCapture");
    expect(runtime).toContain("windows_live_resize_queue_current_frame(hwnd, false)");
    expect(runtime).toContain("windows_geometry_submission_is_current");
    expect(runtime).not.toContain("last_resize_key");
    expect(runtime).toContain("#[cfg(not(windows))]\n    Bounds {");
    expect(runtime).toContain(".set_bounds(tauri::Rect {");
    expect(runtime).not.toContain("WindowsTabChromeRevealSignal::GeometryReady");
    expect(runtime).toContain("wait_for_windows_tab_chrome_content(");
    expect(runtime).toContain("WINDOWS_TAB_CHROME_BOOTSTRAP_TIMEOUT");
    expect(runtime).toContain("retiring_native_window_hosts");
    const createTabStart = runtime.indexOf("fn create_tab(");
    const createTab = runtime.slice(createTabStart, createTabStart + 45_000);
    expect(createTab.indexOf("wait_for_windows_tab_chrome_content(")).toBeLessThan(
      createTab.indexOf("for role in &tab.roles")
    );
    const ensureDisplayHost = runtime.slice(
      runtime.indexOf("fn ensure_display_host("),
      runtime.indexOf("fn register_runtime_launcher_window(")
    );
    expect(ensureDisplayHost.indexOf("windows_live_resize_install_host(")).toBeLessThan(
      ensureDisplayHost.indexOf("self.begin_surface_host_initialization(")
    );
    const displayHostStateStart = ensureDisplayHost.indexOf(
      "let mut state = self.state()?;",
      ensureDisplayHost.indexOf("windows_live_resize_register_webview(&tab_strip)")
    );
    const displayHostStateCommit = ensureDisplayHost.slice(
      displayHostStateStart,
      ensureDisplayHost.indexOf("drop(state);", displayHostStateStart)
    );
    expect(displayHostStateCommit).not.toContain("window.inner_size()");
    expect(displayHostStateCommit).not.toContain("window.is_minimized()");
    expect(displayHostStateCommit).not.toContain("window.scale_factor()");
    const tabPresentation = runtime.slice(
      runtime.indexOf("fn request_tab_presentation_with_window_visibility("),
      runtime.indexOf("pub(crate) fn preview_adjacent_tab_activation(")
    );
    expect(tabPresentation.indexOf("self.layout_runtime_tab(tab_id)")).toBeLessThan(
      tabPresentation.lastIndexOf("self.dispatch_native_presentation(")
    );
    expect(runtime).toContain('document.addEventListener("DOMContentLoaded", publish, { once: true })');
    expect(runtime).not.toContain('  publish();\n})();\n"#;');

    const roleLoading = runtime.slice(
      runtime.indexOf("fn start_role_loads("),
      runtime.indexOf("fn install_overlays(")
    );
    expect(roleLoading).toContain("let mut pending_navigations");
    expect(roleLoading.indexOf("begin_controlled_navigation")).toBeLessThan(
      roleLoading.indexOf("surface.navigate")
    );
    expect(roleLoading.indexOf("pending_navigations.push")).toBeGreaterThan(
      roleLoading.indexOf("surface.navigate")
    );
    expect(roleLoading.indexOf("fn load_roles(")).toBeGreaterThan(
      roleLoading.indexOf("pending_navigations.push")
    );
    const compatibilityWait = roleLoading.slice(roleLoading.indexOf("fn load_roles("));
    expect(compatibilityWait.indexOf("finish_controlled_navigations")).toBeGreaterThan(
      compatibilityWait.indexOf("wait_operation(operation)")
    );
    expect(runtime).toContain("wait_role_navigation_for_lifecycle");
    expect(runtime).toContain(".wait_operation_async(operation.clone())");
    expect(runtime).toContain("application_lifecycle_epoch_matches");

    const reloadTab = runtime.slice(
      runtime.indexOf("pub fn reload_tab("),
      runtime.indexOf("pub fn set_tab_audio_muted(")
    );
    expect(reloadTab).toContain("reload_tab_contract");
    const reloadContract = runtime.slice(
      runtime.indexOf("fn reload_tab_contract("),
      runtime.indexOf("async fn wait_reload_input_ready(")
    );
    expect(reloadContract).toMatch(/tab\s*\.roles/);
    expect(reloadContract).toContain("webview.reload()");
    expect(reloadContract).toContain("begin_navigation_input_fence");
    expect(reloadContract).toContain("NavigationInputFenceSource::ControlledReload");
    expect(reloadContract).not.toContain("popup_roles");
    expect(runtime).toContain("begin_controlled_navigation_scope(");
    expect(runtime).toContain("finish_controlled_navigation_scope(");

    const shutdownContract = runtime.slice(
      runtime.indexOf("pub fn close_all("),
      runtime.indexOf("fn shutdown_role_ids(")
    );
    expect(shutdownContract).toContain("RuntimeShutdownState::Draining");
    expect(shutdownContract).toContain("native_creation_slots.wait_for_idle(deadline)");
    expect(shutdownContract).toContain("native_window_mutations.wait_for_idle(deadline)");
    expect(shutdownContract.indexOf("clear_role_keys(role_id)")).toBeLessThan(
      shutdownContract.indexOf("native_creation_slots.wait_for_idle(deadline)")
    );
    expect(shutdownContract.indexOf("wait_for_idle(deadline)")).toBeLessThan(
      shutdownContract.indexOf("shutdown_surface_snapshot()")
    );

    const exitRequested = shell.slice(
      shell.indexOf("tauri::RunEvent::ExitRequested"),
      shell.indexOf("tauri::RunEvent::WindowEvent")
    );
    expect(exitRequested).toContain("api.prevent_exit()");
    expect(exitRequested).toContain("spawn_blocking(move ||");
    expect(exitRequested).toContain("runtime.close_all()");
    expect(exitRequested).toContain("app.exit(0)");
    const updateExit = shell.slice(
      shell.indexOf("fn prepare_application_update_exit("),
      shell.indexOf("fn prepare_application_update_install(")
    );
    expect(updateExit).toContain("application_shutdown_started");
    expect(updateExit).toContain(".store(true, Ordering::Release)");

    expect(runtime).not.toContain("CompatibilitySurface");
    expect(runtime).not.toContain("create_compatibility_surface");
    expect(runtime).not.toContain("compatibility_session_paths");
    expect(runtime).toContain("role_bounds_for_content");
    expect(runtime).toContain("logical_window_content_metrics");
    expect(runtime).toContain('type === "beforeunload"');
    expect(runtime).toContain("__rionPrepareForNativeClose");
    expect(runtime).toContain("globalThis.frames[index].postMessage");
    const dividerPointer = runtime.slice(
      runtime.indexOf("pub fn handle_divider_pointer("),
      runtime.indexOf("fn send_divider_indicators(")
    );
    expect(dividerPointer).toContain("persist_runtime_tab_role_views");
    expect(dividerPointer).toContain("previous_active_resize");
    expect(dividerPointer).toContain("state_rolled_back");
    expect(dividerPointer).not.toContain("persist_restore_session(false)");
    expect(runtime).toContain("pub fn restore_tab_role_slots(");

    expect(shell).toContain("on_web_content_process_terminate");
    expect(powerLifecycle).toContain("WM_DISPLAYCHANGE");
    expect(powerLifecycle).toContain("request_display_topology_refresh");
    expect(shell).not.toContain("rion-tauri-display-watcher");
    expect(shell).not.toContain("CoreCommand::EmbeddedDisplayRemove");
    expect(shell).not.toContain("CoreCommand::WorkspaceReconcileDisplays");
    expect(shell).toContain('"rion://display-topology"');
    expect(shell).toContain('"restoreSavedGameWindows"');
    expect(shell).toContain('"autoRestoreSavedGameWindows"');

    expect(macInput).toContain("NSEventTypeFlagsChanged");
    expect(macInput).toContain("[responder keyDown:event]");
    expect(macInput).toContain("[responder keyUp:event]");
    expect(macInput).toContain("rion_wk_install_security_policy");
    expect(macInput).toContain("RionWKSurfaceLease");
    expect(macInput).toContain("rion_wk_track_surface");
    expect(macInput).toContain("rion_wk_quiesce_surface");
    expect(macInput).toContain("evaluateJavaScript:");
    expect(macInput).toContain("RionWKNavigationDelegateProxy");
    expect(macInput).toContain("WKNavigation *blankNavigation");
    expect(macInput).toContain("navigation != _blankNavigation");
    expect(macInput).toContain("didFinishNavigation:");
    expect(macInput).toContain("didFailNavigation:");
    expect(macInput).toContain("didFailProvisionalNavigation:");
    expect(macInput).toContain("webViewWebContentProcessDidTerminate:");
    expect(macInput).toContain("__rionPrepareForNativeClose");
    expect(macInput).toContain("rion_wk_release_surface");
    expect(macInput).toContain("[webView removeFromSuperview]");
    expect(macInput).not.toContain("addObserver:");
    expect(macInput).not.toContain("observeValueForKeyPath:");
    expect(macInput).not.toContain("rion_wk_surface_quiesced");
    expect(macInput).not.toContain("rion_wk_surface_released");
    expect(macInput).not.toContain("webView.loading");
    expect(macInput).not.toContain("webView.URL");
    expect(macInput).toContain("rion_wk_surface_lifecycle_self_test");
    const nativeQuiesce = macInput.slice(
      macInput.indexOf("static bool RionWKQuiesceSurfaceOnMain("),
      macInput.indexOf("bool rion_wk_quiesce_surface(")
    );
    expect(nativeQuiesce).toContain("completionHandler:nil");
    expect(nativeQuiesce.indexOf("[webView stopLoading]")).toBeGreaterThan(
      nativeQuiesce.indexOf("evaluateJavaScript:")
    );
    expect(nativeQuiesce).not.toContain("weakWebView");
    expect(macInput).toContain("rion_wk_window_content_layout_metrics");
    expect(macInput).toContain("window.contentLayoutRect");
    expect(macInput).not.toContain("[window makeFirstResponder:webView]");
    expect(macInput).toContain("RionWKContentView(webView)");
    expect(macInput).toContain("RionResponderBelongsToView(candidate, webView)");
    expect(macInput).toContain("RionRestoreFirstResponder(");
    expect(macInput).toContain("(id<RionFirstResponderHost>)window");
    expect(macInput).toContain("rion_wk_background_input_focus_self_test");
    expect(macInput).not.toContain("CGEventPost");

    expect(runtime).toContain("MACOS_KEY_DISPATCH_STATE");
    expect(runtime).toContain("MACOS_KEY_DISPATCH_SETTLE_INTERVAL");
    expect(runtime).toContain("macos_key_dispatch_needs_settle");
    expect(runtime).toContain('b"_setPageMuted:\\0"');
    expect(runtime).not.toContain('b"_setMuted:\\0"');
    const surfaceLogging = runtime.slice(
      runtime.indexOf("fn record_surface_event("),
      runtime.indexOf("pub(crate) fn tab_drag_window_snapshot(")
    );
    expect(surfaceLogging).toContain('"instanceId"');
    expect(surfaceLogging).toContain('"generation"');
    expect(surfaceLogging).toContain('"roleId"');
    expect(surfaceLogging).not.toContain('"url"');
    expect(surfaceLogging).not.toMatch(/cookie|session/i);
    expect(platformProbe).toContain('has_instance_selector(webview, "_setPageMuted:")');
    expect(platformProbe).not.toContain('has_instance_selector(webview, "_setMuted:")');
    expect(platformProbe).toContain("macro_input_available");
    expect(platformProbe).toContain("GetAvailableCoreWebView2BrowserVersionString");
    expect(platformProbe).toContain("classify_windows_runtime_version");
    expect(platformProbe).not.toContain("LoadLibraryW");
    expect(platformProbe).not.toContain("WebView2Loader.dll");

    for (const source of [runtime, shell, macInput]) {
      expect(source).not.toMatch(/attestation/i);
      expect(source).not.toContain("RION_STUDIO_INPUT_ATTESTATION");
    }
  });

it("keeps macro overlay refresh, app activation, pending routing, and navigation release wired", async () => {
    const [runtime, shell, app] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8")
    ]);

    const refresh = runtime.slice(
      runtime.indexOf("pub fn refresh_macro_overlays("),
      runtime.indexOf("pub fn role_id_for_webview(")
    );
    expect(refresh).toContain("should_refresh_macro_overlay(role_ids, role_id)");
    expect(refresh).toMatch(/state\s*\.popup_roles/);
    expect(refresh).toContain("self.app.get_webview(&label)");
    expect(refresh).toContain("refresh_macro_overlay_handles(webviews");
    expect(refresh).toContain("webview.eval(MACRO_OVERLAY_REFRESH_SOURCE)");
    expect(refresh.indexOf("refresh_macro_overlay_handles(webviews")).toBeGreaterThan(
      refresh.indexOf("(webviews, popup_labels)")
    );
    expect(shell).toContain("CoreEvent::OverlayChanged { role_ids } => {");
    expect(shell).toContain("effect_runtime.refresh_macro_overlays(&role_ids);");
    expect(shell).toContain("renderer_events.push(CoreEvent::OverlayChanged { role_ids });");

    const overlayRequest = shell.slice(
      shell.indexOf("async fn rion_overlay_request("),
      shell.indexOf("async fn rion_runtime_audio_state(")
    );
    expect(overlayRequest).toContain("overlay_request_activates_webview(&payload)");
    expect(overlayRequest).toContain("focus_selected_overlay_webview(&webview, &role_id)");
    expect(overlayRequest).not.toContain("webview.set_focus()");
    expect(overlayRequest).toContain("authorize_overlay_request(webview.label(), &capability)");
    expect(overlayRequest).toContain('"OVERLAY_REQUEST_UNAUTHORIZED"');
    expect(overlayRequest.indexOf("authorize_overlay_request(webview.label(), &capability)"))
      .toBeLessThan(overlayRequest.indexOf("focus_selected_overlay_webview"));

    const openMacroPage = runtime.slice(
      runtime.indexOf("CoreEffectAction::OverlayOpenMacroPage { role_id } => {"),
      runtime.indexOf("CoreEffectAction::OverlayCopyCoordinate")
    );
    expect(openMacroPage.indexOf("pending_macro_page_request = Some(request.clone())"))
      .toBeLessThan(openMacroPage.indexOf("run_on_main_thread"));
    expect(openMacroPage).toContain('show_main_window(true, "overlay-open-macro-page")');
    expect(openMacroPage).not.toContain("window.set_focus()");
    expect(openMacroPage.indexOf("show_main_window(true"))
      .toBeLessThan(openMacroPage.indexOf('emit("rion://macro-page-request", request)'));

    const mainNavigation = runtime.slice(
      runtime.indexOf(".on_navigation(move |url| {"),
      runtime.indexOf(".on_new_window(move |url, features|")
    );
    expect(mainNavigation).toContain("allow_main_frame_navigation_after_input_fence(");
    expect(runtime).toContain('matches!(url.scheme(), "http" | "https")');

    const navigationPolicy = runtime.slice(
      runtime.indexOf("fn allow_main_frame_navigation_after_input_fence("),
      runtime.indexOf("fn update_main_frame_navigation_input_fences(")
    );
    expect(navigationPolicy).toContain("begin_navigation_input_fence(");
    expect(navigationPolicy).toContain("NavigationInputFenceSource::MainFrame");
    expect(navigationPolicy).toContain("accept_navigation_input_operation(");
    expect(navigationPolicy.indexOf("accept_navigation_input_operation(")).toBeLessThan(
      navigationPolicy.indexOf("CoreCommand::MacroInputFence {")
    );
    expect(navigationPolicy).toContain(
      "fn finish_navigation_input_drain(&self, role_id: &str, input_epoch: u64)"
    );
    expect(navigationPolicy).toContain("CoreCommand::MacroInputFence {");
    expect(navigationPolicy).toContain(".invoke_async(CoreCommand::MacroInputDrain");
    expect(navigationPolicy).toContain("CoreCommand::MacroInputResume {");
    expect(navigationPolicy).toContain("schedule_input_fence_recovery(");
    expect(navigationPolicy).not.toContain("CoreCommand::MacroReleaseRole");
    expect(navigationPolicy).not.toContain("webview.navigate(url)");
    expect(navigationPolicy).not.toContain('"url"');
    expect(runtime.match(/begin_navigation_input_fence\(/g)).toHaveLength(3);
    expect(runtime).toContain('"operationId": operation_id');

    for (const forbiddenDocumentRequestNavigationToken of [
      "WebResourceRequestedEventHandler",
      "AddWebResourceRequestedFilter",
      "COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT",
      "WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS",
      "register_windows_document_navigation_handler(",
      "install_document_navigation_macro_release_handler(",
      "current_navigation_input_epoch(",
      "SYSTEM_NAVIGATION_DEFERRAL"
    ]) {
      expect(runtime).not.toContain(forbiddenDocumentRequestNavigationToken);
    }
    const windowsRoleSetup = runtime.slice(
      runtime.indexOf('#[cfg(windows)]\nfn install_windows_role_surface_handlers('),
      runtime.indexOf('#[cfg(windows)]\nfn windows_role_setup_error(')
    );
    expect(windowsRoleSetup.match(/\.with_webview\(/g)).toHaveLength(1);
    expect(windowsRoleSetup).not.toContain("navigation-handler");

    const popupNavigation = runtime.slice(
      runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("),
      runtime.indexOf(".on_download(move |_webview, event|", runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("))
    );
    expect(popupNavigation).toContain("allow_main_frame_navigation_after_input_fence(");

    const pendingRoute = app.slice(
      app.indexOf("const consumePendingPageRequest"),
      app.indexOf("const consumePendingLaunchRequest")
    );
    expect(pendingRoute).toContain("consumePendingMacroPageRequest()");
    expect(pendingRoute.indexOf("openListForRole(request.roleId)"))
      .toBeLessThan(pendingRoute.indexOf("navigateToMacros()"));
  });

  it("keeps surface close and main focus completion strictly event-bound", async () => {
    const [surfaceClose, mainWindow, windowsLifecycle, macLifecycle] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_26_sync_native_tab_metadata.rs",
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
    expect(focusContinuation).toContain("MainWindowApplyResult::FocusSubmitted");
    expect(focusContinuation).toContain(".recv()");
    expect(focusContinuation).not.toContain("is_focused");
    expect(focusContinuation.indexOf("if command.requests_focus()"))
      .toBeLessThan(focusContinuation.indexOf("MainWindowStateProjection::capture(window)"));
    expect(windowsIsolation).toContain("add_NavigationStarting");
    expect(windowsIsolation).toContain("add_NavigationCompleted");
    expect(windowsIsolation).toContain("windows_surface_navigation_completion");
    expect(macLifecycle).not.toContain("addObserver:");
    expect(macLifecycle).not.toContain("webView.loading");
    expect(macLifecycle).not.toContain("webView.URL");
  });
});
