import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri System WebView runtime source", () => {
  it("isolates popup renderer failures from role surface recovery", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );

    const popupBuilderStart = runtime.indexOf(".on_new_window(move |url, features|");
    const popupBuilder = runtime.slice(
      popupBuilderStart,
      runtime.indexOf("NewWindowResponse::Create { window }", popupBuilderStart)
    );
    expect(popupBuilder).toContain("SurfaceFailureTarget::Popup");

    const failureRouting = runtime.slice(
      runtime.indexOf("fn surface_failure_action("),
      runtime.indexOf("#[derive(Clone)]\nstruct LocalStorageRuntimeConfig")
    );
    expect(failureRouting).toContain("SurfaceFailureAction::ClosePopup");
    expect(failureRouting).toContain("SurfaceFailureAction::RecoverRole");

    const windowsMonitor = runtime.slice(
      runtime.indexOf("fn install_process_failure_monitor("),
      runtime.indexOf("fn call_system_devtools(")
    );
    expect(windowsMonitor).toContain("handle_surface_process_failure");
    expect(windowsMonitor).toContain("webview2_process_failure_scope(kind)");
    expect(runtime).toContain("fn close_failed_popup(");
  });

  it("keeps recovery provisional until the old native surface is released", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const recovery = runtime.slice(
      runtime.indexOf("fn rebuild_role_surface("),
      runtime.indexOf("fn apply(&self, effect:")
    );

    const navigation = recovery.indexOf(".navigate(current_url.clone())");
    const controlledNavigation = recovery.indexOf("begin_controlled_navigation");
    const nativeLifecycleLane = recovery.indexOf("native_lifecycle_lane");
    const controlledNavigationCleanup = recovery.indexOf("finish_controlled_navigations");
    const swapFence = recovery.indexOf("surface_recovery_swap_is_current(");
    const closeOld = recovery.indexOf(
      "self.close_managed_surface_and_wait(&old_surface_instance_id"
    );
    expect(navigation).toBeGreaterThan(-1);
    expect(nativeLifecycleLane).toBeLessThan(navigation);
    expect(controlledNavigation).toBeLessThan(navigation);
    expect(controlledNavigationCleanup).toBeGreaterThan(navigation);
    expect(closeOld).toBeGreaterThan(swapFence);
    expect(navigation).toBeGreaterThan(closeOld);
    expect(recovery).toContain("ManagedSurfaceKind::Recovery");
    expect(recovery).toContain("ManagedSurfacePhase::Provisional");
    expect(recovery).toContain("ManagedSurfacePhase::Retired");
    expect(recovery).toContain("state.close_coordinator.closing_roles.contains(role_id)");
    expect(recovery.indexOf("ManagedSurfacePhase::Live")).toBeGreaterThan(navigation);
    expect(recovery).not.toContain("close_surface_and_wait(&old_webview");
  });

  it("commits role and tab removal only after native close acknowledgement", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const releaseRole = runtime.slice(
      runtime.indexOf("fn release_marked_role_surfaces("),
      runtime.indexOf("fn commit_released_role(")
    );
    const commitRole = runtime.slice(
      runtime.indexOf("fn commit_released_role("),
      runtime.indexOf("fn destroy_tab(")
    );
    const closeRole = releaseRole.indexOf("self.close_managed_surface_and_wait(instance_id, role_id)");
    expect(closeRole).toBeGreaterThan(-1);
    expect(releaseRole).toContain("managed_surface_ids_for_role(role_id)");
    expect(releaseRole).toContain("std::thread::scope(|scope|");
    expect(releaseRole).toContain("scope.spawn(move ||");
    expect(commitRole).toContain("state.role_tabs.remove(&released.role_id)");
    expect(releaseRole.indexOf("self.forget_popup(&label)")).toBeGreaterThan(closeRole);

    const destroyTab = runtime.slice(
      runtime.indexOf("fn destroy_tab("),
      runtime.indexOf("fn show_tab(")
    );
    const releaseRoles = destroyTab.indexOf("self.release_marked_role_surfaces(role_id");
    const releaseDividers = destroyTab.indexOf("self.close_managed_divider(instance_id");
    const commitTab = destroyTab.indexOf("state.tabs.remove(tab_id)");
    expect(releaseRoles).toBeGreaterThan(-1);
    expect(releaseDividers).toBeGreaterThan(releaseRoles);
    expect(commitTab).toBeGreaterThan(releaseDividers);
    expect(destroyTab).toContain("SYSTEM_SURFACE_RELEASE_UNVERIFIED");
    expect(destroyTab).toContain("surface_registry");
    expect(destroyTab).toContain("surface.kind != ManagedSurfaceKind::Divider");
    expect(destroyTab).not.toContain("local_storage_sync_lane");
    expect(destroyTab).not.toContain("read_scoped_local_storage_entries");
    expect(runtime).toContain("closing_webviews");
    expect(runtime).toContain("closing_roles");
    expect(runtime).toContain('"surface.blank-finished"');
    expect(runtime).toContain('"surface.quiesce-unverified"');
    expect(runtime).toContain('"surface.release-deferred"');
    expect(runtime).toContain('"surface.quarantine-persisted"');

    const nativeClose = runtime.slice(
      runtime.indexOf("fn close_surface_and_wait("),
      runtime.indexOf("fn close_managed_surface_and_wait(")
    );
    expect(nativeClose.indexOf("quiesce_platform_surface(webview, lifecycle)")).toBeLessThan(
      nativeClose.indexOf("webview.close()")
    );
    expect(nativeClose.indexOf("wait_for_isolation(SURFACE_ISOLATION_TIMEOUT)")).toBeLessThan(
      nativeClose.indexOf("webview.close()")
    );
    expect(nativeClose).toContain('"surface.controller-close-queued"');
    expect(nativeClose).toContain("SURFACE_ISOLATION_TIMEOUT");
    expect(nativeClose).not.toContain("wait_for_platform_release(");
    expect(nativeClose).toContain("SYSTEM_SURFACE_RELEASE_UNVERIFIED");
  });

  it("routes close around slow effects and keeps failed close intent committed", async () => {
    const [runtime, core, macroRuntime] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/app.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/macro_runtime.rs", import.meta.url), "utf8")
    ]);
    const enqueue = runtime.slice(
      runtime.indexOf("pub fn enqueue_effect("),
      runtime.indexOf("fn execute_serial_work(")
    );
    expect(enqueue.indexOf("if is_surface_close_effect(&effect.action)")).toBeLessThan(
      enqueue.indexOf("self.effect_sender")
    );
    expect(enqueue).toContain("is_independent_tab_launch_effect(&effect.action)");
    expect(enqueue).toContain("self.close_effect_sender.get()");
    expect(enqueue).toContain("self.launch_effect_sender.get()");
    expect(enqueue).toContain(".try_send(ConcurrentRuntimeWork");
    expect(enqueue).not.toContain("std::thread::Builder::new()");
    expect(runtime).toContain("for index in 0..2");
    expect(runtime).toContain("for index in 0..4");
    expect(runtime).toContain('name(format!("rion-native-close-{index}"))');
    expect(runtime).toContain('name(format!("rion-native-launch-{index}"))');
    expect(runtime).toContain("mpsc::sync_channel(64)");

    const stopRole = core.slice(
      core.indexOf("fn stop_embedded_role_with_operation_lease("),
      core.indexOf("fn stop_embedded_workspace(")
    );
    expect(stopRole).toContain("request_stop_role(role_id)");
    expect(stopRole).toContain("Duration::from_secs(12)");
    expect(stopRole).toContain("commit_embedded_runtime_snapshot_without_native_effect");
    expect(stopRole).not.toContain("previous_runtime");
    expect(stopRole).not.toContain("publish_embedded_runtime_snapshot_best_effort");
    const stopWindow = core.slice(
      core.indexOf("fn stop_embedded_window("),
      core.indexOf("fn run_effect_plan(")
    );
    const isolateTabs = stopWindow.indexOf("for (tab_type, source_id) in sources");
    expect(stopWindow.indexOf("let sources = {")).toBeLessThan(isolateTabs);
    expect(stopWindow.lastIndexOf("embedded_window_sequence.acquire()?")).toBeGreaterThan(isolateTabs);
    expect(stopWindow.slice(0, isolateTabs)).toContain("sources\n        };");
    expect(macroRuntime).toContain("pub fn request_stop_role(");
  });

  it("keeps tab interaction responsive while native launch verification is pending", async () => {
    const [runtime, core, menu, shell, quickMenu, macBridge, macController, windowsStrip] =
      await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/app.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/runtime_tab_menu.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/quick_menu.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/runtime_tabs_macos.rs", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionRuntimeTabsController.mm", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src/renderer/runtime-shell/runtimeTabStrip.ts", import.meta.url),
        "utf8"
      )
      ]);

    expect(runtime).toContain("fn preview_tab_activation(");
    expect(runtime).toContain("fn preview_adjacent_tab_activation(");
    expect(runtime).toContain("fn preview_tab_close(");
    expect(runtime).toContain("optimistic_closed_tabs");
    expect(runtime).toContain("runtime_tab.visible");
    const activationPreview = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_activation("),
      runtime.indexOf("pub(crate) fn preview_tab_close(")
    );
    expect(activationPreview).toContain("request_tab_presentation");
    expect(activationPreview).toContain("request_provisional_tab_presentation");
    expect(activationPreview).toContain("desired_revision");
    expect(activationPreview).toContain("dispatch_native_presentation");
    expect(activationPreview).not.toContain("BrowserRuntimeSnapshot");
    expect(activationPreview).not.toContain("presentation_lane");
    const closePreview = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_close("),
      runtime.indexOf("pub(crate) fn reconcile_tab_activation(")
    );
    expect(closePreview).toContain("closing_tab.visible = false");
    expect(closePreview).toContain("successor_tab_after_close(");
    expect(closePreview).toContain("dispatch_native_presentation(");
    expect(runtime).toContain("struct PresentationCoordinator {");
    expect(runtime).toContain("struct LatestOnlyPresentationQueue<T>");
    expect(runtime).toContain("NATIVE_PRESENTATION_COALESCE_INTERVAL");
    expect(runtime).toContain("tab.selection-coalesced");
    expect(runtime).toContain("apply_native_presentation_batch(");
    expect(runtime).toContain("request.window.run_on_main_thread");
    expect(runtime).toContain("mainQueueWaitMs");
    expect(runtime).toContain("mainThreadMs");
    expect(runtime).toContain("tab.selection-superseded");
    const activateCommand = core.slice(
      core.indexOf("CoreCommand::EmbeddedTabActivate { tab_id }"),
      core.indexOf("CoreCommand::EmbeddedTabHide { tab_id }")
    );
    expect(activateCommand).toContain("apply_embedded_tab_selection_without_native_effect");
    expect(activateCommand).not.toContain("apply_embedded_runtime_command(");
    const roleLaunch = core.slice(
      core.indexOf("fn launch_embedded_role("),
      core.indexOf("fn launch_embedded_workspace(")
    );
    expect(roleLaunch).not.toContain("embedded_window_sequence.acquire");
    expect(roleLaunch).not.toContain("embedded_runtime_sequence.acquire");
    expect(roleLaunch).toContain("commit_embedded_runtime_snapshot_without_native_effect");
    const createTab = runtime.slice(
      runtime.indexOf("fn create_tab("),
      runtime.indexOf("fn load_roles(")
    );
    expect(createTab).toContain("reserve_native_tab(");
    expect(createTab).toContain("previous_surfaces");
    expect(createTab).toContain('"launch-reserved"');
    expect(createTab).toContain("remove_native_tab_reservation(");
    expect(createTab).not.toContain("publish_projection(");
    expect(createTab.indexOf("webview.navigate(url)")).toBeLessThan(
      createTab.indexOf("self.resolve_runtime_layout(")
    );
    expect(createTab).toContain("role_bounds_for_content(content_metrics, &role.rect)");
    expect(createTab).toContain("take_tab_launch_preview(");
    expect(createTab).toContain("selection.tab_order[index] = created_tab_id.clone()");
    expect(createTab).toContain("replace_native_tab_reservation(");
    const loadRoles = runtime.slice(
      runtime.indexOf("fn start_role_loads("),
      runtime.indexOf("fn install_overlays(")
    );
    expect(loadRoles).toContain("current_url.as_ref() != Some(&url)");
    expect(runtime).toContain("navigation.wait_async().await");
    const overlays = runtime.slice(
      runtime.indexOf("fn install_overlays("),
      runtime.indexOf("fn focus_role(")
    );
    expect(overlays).toContain("self.require_roles(role_ids)?");
    expect(overlays).toContain("MACRO_OVERLAY_REFRESH_SOURCE");
    expect(overlays).not.toContain("evaluate_webview");
    expect(overlays).not.toContain("thread::sleep");
    expect(shell).toContain("TAB_SELECTION_COMMIT_DEBOUNCE: Duration = Duration::from_millis(150)");
    expect(shell).toContain("tokio::sync::watch::channel(request)");
    expect(shell).toContain("preview_and_commit_tab_selection");
    expect(shell).toContain("runtime.preview_tab_launch(&target, &role_id, \"role\")");
    expect(shell).toContain("tauri::async_runtime::spawn_blocking(move ||");
    expect(runtime).toContain("pub(crate) fn preview_tab_launch(");
    expect(runtime).toContain('"zh-TW" => "載入中…"');
    expect(runtime).toContain('"launch-preview"');
    expect(quickMenu).toContain('name("rion-quick-menu-model".to_owned())');
    expect(quickMenu).toContain("Core and SQLite snapshots are collected on one bounded worker");
    const quickMenuNativeBuild = quickMenu.slice(
      quickMenu.indexOf("fn menu(app: &AppHandle, model: &MenuModel)"),
      quickMenu.indexOf("fn handle_menu_event(")
    );
    expect(quickMenuNativeBuild).not.toContain("core.invoke(");
    expect(menu).toContain("preview_adjacent_tab_activation(&window_id, direction)");
    expect(menu).toContain("resolve_tab_close_preview(tab_id, result.is_ok())");
    expect(macBridge).toContain("update_generation: AtomicU64");
    expect(macBridge).toContain("selection_generation: AtomicU64");
    expect(macBridge).toContain("inner.update_generation.load(Ordering::Acquire) != generation");
    expect(macBridge).toContain("inner.selection_generation.load(Ordering::Acquire) != generation");
    expect(macBridge).toContain("pub fn replace_reservation(");
    expect(macController).toContain("_tabItemsByIdentifier[tabIdentifier]");
    expect(macController).toContain("[previousItem updateVisualStateAnimated:NO]");
    expect(macController).toContain("[nextItem updateVisualStateAnimated:NO]");
    expect(macController).toContain("replaceTabIdentifier:");
    expect(macController).toContain("[_tabItems removeObjectAtIndex:index]");
    expect(macController).not.toContain("nextEventMatchingMask:");
    expect(macController).toContain("- (void)mouseDragged:(NSEvent *)event");
    expect(macController).toContain("_tabIconCacheKeys");
    expect(macController).toContain("nextIdentifiers");
    expect(windowsStrip).toContain("optimisticallyActivateAdjacentTab");
    expect(windowsStrip).toContain("optimisticallyCloseTab");
    expect(windowsStrip).toContain("reconcileTabButtons(nextButtons)");
    expect(windowsStrip).not.toContain("root.replaceChildren(");
  });

  it("never blocks the native UI thread on a tab launch lane and cancels provisional tabs locally", async () => {
    const [runtime, shell, menu, quickMenu, macBridge] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/runtime_tab_menu.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/quick_menu.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/runtime_tabs_macos.rs", import.meta.url), "utf8")
    ]);

    const launchPreview = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_launch("),
      runtime.indexOf("pub(crate) fn cancel_tab_launch_preview(")
    );
    expect(launchPreview).toContain("let existing_window = self");
    expect(launchPreview).toContain(".display_hosts");
    expect(launchPreview.indexOf("if let Some(window) = existing_window")).toBeLessThan(
      launchPreview.indexOf("with_native_creation_lane")
    );
    expect(launchPreview).toContain("reserve_native_tab(");

    for (const source of [shell, menu, quickMenu]) {
      const previewCall = source.indexOf("preview_tab_launch(");
      expect(previewCall).toBeGreaterThan(-1);
      expect(source.lastIndexOf("spawn_blocking(move ||", previewCall)).toBeGreaterThan(-1);
    }

    const createTab = runtime.slice(
      runtime.indexOf("fn create_tab("),
      runtime.indexOf("fn load_roles(")
    );
    expect(createTab.indexOf("take_tab_launch_preview(")).toBeLessThan(
      createTab.indexOf("with_native_creation_lane")
    );
    expect(runtime).toContain("pub(crate) fn cancel_provisional_tab_launch(");
    expect(runtime).toContain("launch.id == *tab_id && launch.window_id == window_id && !launch.cancelled");
    expect(shell).toContain("state.runtime.cancel_provisional_tab_launch(&tab_id)");
    expect(shell).toContain("preview_tab_activation(tab_id, native_style_applied)?");
    expect(shell).toContain("preview_and_commit_native_tab_selection");
    expect(menu).toContain("state.runtime.cancel_provisional_tab_launch(tab_id)");
    const scopedTabAction = menu.slice(
      menu.indexOf("pub async fn handle_scoped_action("),
      menu.indexOf("fn launch_from_menu(")
    );
    expect(scopedTabAction.indexOf('if action_type == "activate"')).toBeLessThan(
      scopedTabAction.indexOf("let snapshot = snapshot(&state.core)?")
    );
    expect(macBridge).toContain("state.runtime.cancel_provisional_tab_launch(tab_id)");
  });

  it("keeps native macOS close rollback state out of Windows builds", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const closeTransaction = runtime.slice(
      runtime.indexOf("struct CloseTransaction {"),
      runtime.indexOf("struct NativeSessionBackup {")
    );
    for (const field of ["original_active_tab_id", "revision", "window_id"]) {
      expect(closeTransaction).toContain(`#[cfg(target_os = "macos")]\n    ${field}`);
    }
    expect(runtime).toContain(
      '#[cfg(target_os = "macos")]\n    pub(crate) fn cancel_tab_close_preview('
    );
  });

  it("tracks exact native surface ownership across roles, popups, dividers, and moves", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    expect(runtime).toContain("struct ManagedSurface {");
    expect(runtime).toContain("struct CloseCoordinator {");
    expect(runtime).toContain("struct CloseTransaction {");
    expect(runtime).toContain("surface_registry: HashMap<String, ManagedSurface>");
    expect(runtime).toContain("fn wait_for_managed_surface_isolation(");
    expect(runtime).toContain("state.close_coordinator.closing_roles.contains(role_id)");
    expect(runtime).toContain("surface_instance_id: String");
    for (const kind of ["Role", "Recovery", "Popup", "Divider"]) {
      expect(runtime).toContain(`ManagedSurfaceKind::${kind}`);
    }
    const move = runtime.slice(
      runtime.indexOf("pub fn provisionally_move_tab("),
      runtime.indexOf("pub fn cancel_provisional_tab_move(")
    );
    expect(move).toContain("state.surface_registry.values_mut()");
    expect(move).toContain("surface.window_id = target_window_id.to_owned()");
    expect(move).toContain("surface.window_id = source_window_id.to_owned()");
    const popup = runtime.slice(
      runtime.indexOf("fn register_popup("),
      runtime.indexOf("fn schedule_surface_recovery(")
    );
    expect(popup).toContain("ManagedSurfaceKind::Popup");
    expect(popup).toContain("register_managed_surface(");
  });

  it("rolls back every provisional move stage and surfaces compensation errors", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const move = runtime.slice(
      runtime.indexOf("pub fn provisionally_move_tab("),
      runtime.indexOf("pub fn cancel_provisional_tab_move(")
    );
    const hidePhase = move.indexOf("for surface in &surfaces");
    const reparentPhase = move.indexOf("for (index, surface) in surfaces.iter().enumerate()");
    const stateCommit = move.indexOf("tab.window_id = target_window_id.to_owned()");
    expect(hidePhase).toBeGreaterThan(-1);
    expect(reparentPhase).toBeGreaterThan(hidePhase);
    expect(stateCommit).toBeGreaterThan(reparentPhase);
    expect(move).toContain("rollback_provisional_tab_move(");
    expect(move).toContain("provisional_move_error(");

    const rollback = runtime.slice(
      runtime.indexOf("fn rollback_provisional_tab_move("),
      runtime.indexOf("fn provisional_move_error(")
    );
    expect(rollback).toContain("errors.push");
    expect(rollback).not.toMatch(/let _ = surface\.(hide|show|reparent)/);
    expect(runtime).toContain("SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED");
  });

  it("persists restore state before acknowledging a successful native effect", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const executor = runtime.slice(
      runtime.indexOf("fn execute_effect_work("),
      runtime.indexOf("pub fn registration(")
    );
    const persist = executor.indexOf("self.persist_restore_session(false)");
    const finalize = executor.indexOf("finalize_persisted_effect_result(");
    const dispatch = executor.indexOf("dispatch_core_effect_results");
    expect(persist).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(persist);
    expect(dispatch).toBeGreaterThan(finalize);
    expect(executor).toContain("SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY");
    expect(runtime).toContain("SYSTEM_RUNTIME_PERSIST_FAILED");
  });

  it("releases role macro input when a tracked popup is destroyed", async () => {
    const [runtime, shell] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
    ]);
    const cleanup = runtime.slice(
      runtime.indexOf("pub(crate) fn forget_popup("),
      runtime.indexOf("fn register_popup(")
    );
    expect(cleanup).toContain("state.popup_roles.remove(window_label)");
    expect(cleanup).toContain("tauri::async_runtime::spawn(async move");
    expect(cleanup).toContain(".invoke_async(CoreCommand::MacroReleaseRole");
    expect(cleanup).toContain("CoreCommand::MacroReleaseRole {");
    expect(cleanup).toContain("SYSTEM_POPUP_MACRO_RELEASE_FAILED");
    expect(cleanup).toContain('"rion://shell-error"');

    const destroyed = shell.slice(
      shell.indexOf("tauri::WindowEvent::Destroyed =>"),
      shell.indexOf("_ => {}", shell.indexOf("tauri::WindowEvent::Destroyed =>"))
    );
    expect(destroyed).toContain("state.runtime.forget_popup(&label)");
  });

  it("keeps production popup, download, recovery, lifecycle, and platform input native", async () => {
    const [runtime, shell, macInput, platformProbe] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../crates/rion-platform/src/system_webview.rs", import.meta.url),
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
    expect(runtime).toContain("mark_native_surface_released");
    expect(runtime).toContain("fn add_child_bounded(");
    expect(runtime).toContain("fn create_window_bounded(");
    expect(runtime).toContain("surface_host_initialization_requires_visible_parent");
    expect(runtime).toContain("set_windows_surface_host_initialization_visibility");
    expect(runtime).toContain("SW_SHOWNOACTIVATE");
    expect(runtime).not.toContain("surface-host-main-thread-flush");
    expect(runtime).toContain("WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT");
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

    const applyRuntime = runtime.slice(
      runtime.indexOf("fn apply_runtime("),
      runtime.indexOf("fn sync_native_tab_strip(")
    );
    expect(applyRuntime).not.toContain("sync_native_tab_strip");
    expect(runtime).toContain("struct RuntimeDisplayHost");
    expect(runtime).toContain('runtime_label("game-display"');
    expect(runtime).not.toContain('runtime_label("game-tab", &tab.tab_id)');
    const windowsTabStrip = runtime.slice(
      runtime.indexOf("fn sync_windows_tab_strip("),
      runtime.indexOf("fn windows_tab_strip_height(")
    );
    expect(windowsTabStrip).toContain("crate::display_inventory(&window)");
    expect(windowsTabStrip).not.toContain("crate::workspace_displays(&window)");
    expect(windowsTabStrip).toContain('"resolvedTheme".to_owned()');
    expect(windowsTabStrip).toContain("json!(resolved_theme)");
    const nativeMacTabs = runtime.slice(
      runtime.indexOf("fn sync_native_tab_strip("),
      runtime.indexOf("fn sync_windows_tab_strip(")
    );
    expect(nativeMacTabs).not.toContain("resolved_theme");
    expect(applyRuntime).toContain("surface.reparent(&window)");
    expect(applyRuntime).toContain('reconcile_window_presentation(window_id, "topology-reconciled")');
    expect(applyRuntime).not.toContain("visibility_mutations");
    expect(applyRuntime).not.toContain("webview.set_focus()");
    expect(applyRuntime).not.toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");

    const closeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub(crate) fn handle_window_close_requested("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(closeRuntimeWindow).toContain(".hide()");
    expect(closeRuntimeWindow).toContain("-> RuntimeResult<bool>");
    expect(closeRuntimeWindow).toContain("apply_window_close_to_hide_transaction(");
    expect(closeRuntimeWindow).toContain("persist_game_window_placement(label)");
    expect(closeRuntimeWindow).toContain("persist_restore_session(false)");
    expect(closeRuntimeWindow).toContain(".show()");
    expect(closeRuntimeWindow).not.toContain("let _ = window.hide()");
    expect(closeRuntimeWindow).not.toContain("BrowserRoleStop");
    expect(closeRuntimeWindow).not.toContain("BrowserWorkspaceStop");
    expect(shell).toContain("match state.runtime.handle_window_close_requested(&label)");
    expect(shell).toContain('"windowLabel": label');
    const resizeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub fn resize_window("),
      runtime.indexOf("pub fn move_window(")
    );
    expect(resizeRuntimeWindow).toContain("runtime_window_resize_is_actionable");
    expect(resizeRuntimeWindow).toContain("TAURI_RUNTIME_WINDOW_LAYOUT_FAILED");
    expect(resizeRuntimeWindow).not.toContain("persist_game_window_placement");
    const resizeScheduler = runtime.slice(
      runtime.indexOf("pub fn schedule_resize_window("),
      runtime.indexOf("pub fn prepare_runtime_window_fullscreen(")
    );
    expect(resizeScheduler).toContain("schedule_window_placement_persistence");
    expect(resizeScheduler).toContain("WINDOW_PLACEMENT_PERSIST_DEBOUNCE");
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
      compatibilityWait.indexOf(".wait()")
    );
    expect(runtime).toContain("navigation.wait_async().await");

    const reloadTab = runtime.slice(
      runtime.indexOf("pub fn reload_tab("),
      runtime.indexOf("pub fn set_tab_audio_muted(")
    );
    expect(reloadTab).toMatch(/tab\s*\.roles/);
    expect(reloadTab).toContain("webview.reload()");
    expect(reloadTab).not.toContain("popup_roles");

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
    expect(dividerPointer).not.toContain("persist_restore_session(false)");
    expect(runtime).toContain("pub fn restore_tab_role_views(");

    expect(shell).toContain("on_web_content_process_terminate");
    expect(shell).toContain("rion-tauri-display-watcher");
    expect(shell).not.toContain("CoreCommand::EmbeddedDisplayRemove");
    expect(shell).not.toContain("CoreCommand::WorkspaceReconcileDisplays");
    expect(shell).toContain('"rion://displays"');
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
    expect(macInput).toContain("blankNavigationRequested");
    expect(macInput).toContain("__rionPrepareForNativeClose");
    expect(macInput).toContain("rion_wk_surface_quiesced");
    expect(macInput).toContain("rion_wk_surface_released");
    expect(macInput).toContain("webView.superview || webView.window");
    expect(macInput).toContain('[url.absoluteString isEqualToString:@"about:blank"]');
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
      runtime.indexOf("pub fn window_contains_screen_point(")
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
    expect(overlayRequest).toContain("webview.set_focus()");
    expect(overlayRequest).toContain('"OVERLAY_WEBVIEW_FOCUS_FAILED"');
    expect(overlayRequest).toContain("authorize_overlay_request(webview.label(), &capability)");
    expect(overlayRequest).toContain('"OVERLAY_REQUEST_UNAUTHORIZED"');
    expect(overlayRequest.indexOf("authorize_overlay_request(webview.label(), &capability)"))
      .toBeLessThan(overlayRequest.indexOf("webview.set_focus()"));

    const openMacroPage = runtime.slice(
      runtime.indexOf("CoreEffectAction::OverlayOpenMacroPage { role_id } => {"),
      runtime.indexOf("CoreEffectAction::OverlayCopyCoordinate")
    );
    expect(openMacroPage.indexOf("pending_macro_page_request = Some(request.clone())"))
      .toBeLessThan(openMacroPage.indexOf("run_on_main_thread"));
    expect(openMacroPage).toContain("window.unminimize()");
    expect(openMacroPage).toContain("window.show()");
    expect(openMacroPage).toContain("window.set_focus()");
    expect(openMacroPage.indexOf("window.set_focus()"))
      .toBeLessThan(openMacroPage.indexOf('emit("rion://macro-page-request", request)'));

    const mainNavigation = runtime.slice(
      runtime.indexOf(".on_navigation(move |url| {"),
      runtime.indexOf(".on_new_window(move |url, features|")
    );
    expect(mainNavigation).toContain("allow_navigation_after_macro_release(");
    expect(runtime).toContain('matches!(url.scheme(), "http" | "https")');

    const navigationPolicy = runtime.slice(
      runtime.indexOf("fn allow_navigation_after_macro_release("),
      runtime.indexOf("fn begin_controlled_navigation(")
    );
    expect(navigationPolicy).toContain("release_macros_for_unblocked_navigation(");
    expect(navigationPolicy).toContain(".invoke_async(CoreCommand::MacroReleaseRole");
    expect(navigationPolicy).not.toContain("webview.navigate(url)");
    expect(navigationPolicy).not.toContain('"url"');

    const windowsDocumentHandler = runtime.slice(
      runtime.indexOf("fn install_document_navigation_macro_release_handler("),
      runtime.indexOf("fn complete_windows_document_navigation_deferral(")
    );
    expect(windowsDocumentHandler).toContain("WebResourceRequestedEventHandler");
    expect(windowsDocumentHandler).toContain("AddWebResourceRequestedFilter");
    expect(windowsDocumentHandler).toContain("COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT");
    expect(windowsDocumentHandler).toContain("args.GetDeferral()");
    expect(windowsDocumentHandler).toContain("AgileReference::new(&deferral)");
    expect(windowsDocumentHandler).toContain(".invoke_async(CoreCommand::MacroReleaseRole");
    expect(windowsDocumentHandler).toContain("run_on_main_thread");
    expect(windowsDocumentHandler).not.toContain("navigate(");
    expect(runtime).toContain("deferral.Complete()");
    expect(runtime).toContain('should_defer_document_navigation("windows"');
    expect(runtime.match(/install_document_navigation_macro_release_handler\(/g)?.length)
      .toBeGreaterThanOrEqual(5);

    const popupNavigation = runtime.slice(
      runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("),
      runtime.indexOf(".on_download(move |_webview, event|", runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("))
    );
    expect(popupNavigation).toContain("allow_navigation_after_macro_release(");

    const pendingRoute = app.slice(
      app.indexOf("const consumePendingPageRequest"),
      app.indexOf("const consumePendingLaunchRequest")
    );
    expect(pendingRoute).toContain("consumePendingMacroPageRequest()");
    expect(pendingRoute.indexOf("openListForRole(request.roleId)"))
      .toBeLessThan(pendingRoute.indexOf("navigateToMacros()"));
  });
});
