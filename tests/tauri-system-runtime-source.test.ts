import { readSourceTree as readFile } from "./helpers/readSourceTree";

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

    expect(runtime).toContain("fn install_process_failure_monitor(");
    expect(runtime).toContain("handle_surface_process_failure");
    expect(runtime).toContain("webview2_process_failure_scope(kind)");
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
      runtime.indexOf("async fn release_marked_role_surfaces_event_bound("),
      runtime.indexOf("fn commit_released_role(")
    );
    const commitRole = runtime.slice(
      runtime.indexOf("fn commit_released_role("),
      runtime.indexOf("fn destroy_tab(")
    );
    const closeRole = releaseRole.indexOf("close_managed_surface_event_bound(&instance_id");
    expect(closeRole).toBeGreaterThan(-1);
    expect(releaseRole).toContain("managed_surface_ids_for_role(role_id)");
    expect(releaseRole).toContain("tokio::task::JoinSet::new()");
    expect(releaseRole).toContain("closes.spawn(async move");
    expect(runtime).toContain("wait_for_store_reusable_event");
    expect(commitRole).toContain("state.role_tabs.remove(&released.role_id)");
    expect(releaseRole.indexOf("self.forget_popup(&label)")).toBeGreaterThan(closeRole);

    const destroyTab = runtime.slice(
      runtime.indexOf("async fn destroy_tab_event_bound("),
      runtime.indexOf("fn prepare_destroy_tab_presentation(")
    );
    const releaseRoles = destroyTab.indexOf("release_marked_role_surfaces_event_bound(");
    const releaseDividers = destroyTab.indexOf("close_managed_surface_event_bound(instance_id");
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
    expect(runtime).not.toContain('"surface.quiesce-unverified"');
    expect(runtime).toContain('"surface.navigation-failed"');
    expect(runtime).toContain('"surface.native-released"');
    expect(runtime).toContain('"surface.wrapper-close-accepted"');
    expect(runtime).toContain('"role.store-reusable"');
    expect(runtime).not.toContain('"surface.blank-retry"');
    expect(runtime).not.toContain("schedule_surface_reclamation");

    const nativeClose = runtime.slice(
      runtime.indexOf("async fn close_surface_event_bound("),
      runtime.indexOf("fn close_surface_and_wait(")
    );
    expect(nativeClose).not.toContain("Duration::from_millis(250)");
    expect(nativeClose.indexOf("quiesce_platform_surface(webview, lifecycle)")).toBeLessThan(
      nativeClose.indexOf("webview.close()")
    );
    expect(nativeClose.indexOf("wait_for_isolation_event().await")).toBeLessThan(
      nativeClose.indexOf("webview.close()")
    );
    expect(nativeClose).toContain("release_platform_surface(webview, lifecycle)?");
    expect(nativeClose).toContain('"surface.native-release-requested"');
    expect(nativeClose).not.toContain("SURFACE_ISOLATION_TIMEOUT");
    expect(nativeClose).toContain("wait_for_store_reusable_event(platform).await");
    expect(nativeClose).not.toContain("recv_timeout");
    expect(nativeClose).not.toContain("wait_timeout");
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
    expect(enqueue).toContain("self.close_effect_senders.get()");
    expect(enqueue).toContain("self.close_effect_scope(&effect.action)");
    expect(enqueue).toContain("close_effect_shard_index(&scope, senders.len())");
    expect(enqueue).toContain("self.launch_effect_sender.get()");
    expect(enqueue).toContain(".try_send(ConcurrentRuntimeWork");
    expect(enqueue).not.toContain("std::thread::Builder::new()");
    expect(runtime).toContain("for index in 0..CLOSE_EFFECT_SHARD_COUNT");
    expect(runtime).toContain("resolved_role_tab_id");
    expect(runtime).toContain("for index in 0..4");
    expect(runtime).toContain('name(format!("rion-native-close-{index}"))');
    expect(runtime).toContain('name(format!("rion-native-launch-{index}"))');
    expect(runtime).toContain("mpsc::sync_channel(64)");

    const stopRole = core.slice(
      core.indexOf("fn stop_embedded_role_with_operation_lease("),
      core.indexOf("fn stop_embedded_window(")
    );
    expect(stopRole).toContain("request_stop_role(role_id)");
    expect(stopRole).toContain("parent_operation_id: Option<&str>");
    expect(stopRole).toContain("run_embedded_runtime_effect(");
    expect(stopRole).toContain("parent_operation_id,");
    expect(stopRole).toContain("commit_embedded_runtime_snapshot_without_native_effect");
    expect(stopRole).not.toContain("previous_runtime");
    expect(stopRole).not.toContain("publish_embedded_runtime_snapshot_best_effort");
    const stopWindow = core.slice(
      core.indexOf("fn stop_embedded_window("),
      core.indexOf("fn run_effect_plan(")
    );
    const isolateTabs = stopWindow.indexOf("for (tab_type, source_id) in sources");
    expect(stopWindow.indexOf("let sources = {")).toBeLessThan(isolateTabs);
    expect(stopWindow.indexOf("embedded_window_sequence.acquire()?")).toBeLessThan(isolateTabs);
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

    expect(runtime).toContain("fn preview_tab_activation_background(");
    expect(runtime).toContain("fn preview_adjacent_tab_activation(");
    expect(runtime).toContain("fn preview_tab_close(");
    expect(runtime).toContain("optimistic_closed_tabs");
    expect(runtime).toContain("struct LiveWindowRecord {");
    expect(runtime).toContain("struct NativeTabProjectionState {");
    expect(runtime).toContain("struct TabRuntimeStatusStore {");
    expect(runtime).not.toContain("struct LiveWindowTabState {");
    expect(runtime).toContain("selected_tab_id: Option<String>");
    expect(runtime).toContain("surface_bindings: HashMap<String, Vec<SurfacePresentationBinding>>");
    expect(runtime).not.toContain("runtime_tab.visible");
    const activationInfrastructure = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_activation_background("),
      runtime.indexOf("pub(crate) fn preview_tab_close(")
    );
    expect(activationInfrastructure).toContain("request_tab_presentation");
    expect(activationInfrastructure).toContain("request_provisional_tab_presentation");
    expect(activationInfrastructure).toContain("selected_tab_id");
    expect(activationInfrastructure).not.toContain("wait_native_operation_summary");
    expect(activationInfrastructure).not.toContain("BrowserRuntimeSnapshot");
    expect(activationInfrastructure).not.toContain("presentation_lane");
    const pointerActivation = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_activation_background("),
      runtime.indexOf("pub(crate) fn preview_adjacent_tab_activation_background(")
    );
    expect(pointerActivation).toContain("NativePresentationFocus::ContentOnly");
    expect(pointerActivation).not.toContain("NativePresentationFocus::WindowAndContent");
    const launcherActivation = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_launcher_tab_activation_background("),
      runtime.indexOf("fn resolve_live_presentation_tab_owner(")
    );
    expect(launcherActivation).toContain("NativePresentationFocus::WindowAndContent");
    expect(launcherActivation).toContain("Some(true)");
    const closePreview = runtime.slice(
      runtime.indexOf("pub(crate) fn preview_tab_close("),
      runtime.indexOf("fn compose_live_runtime_snapshot(")
    );
    expect(closePreview).toContain("next.remove_tab(");
    expect(closePreview).toContain("commit_live_window_record(\"command\"");
    expect(closePreview).toContain("successor_tab_after_close(");
    expect(closePreview).toContain("dispatch_native_presentation(");
    expect(closePreview).toContain("NativePresentationFocus::ContentOnly");
    expect(closePreview).toContain("request_preview_surface_isolation(isolation_surfaces)");
    expect(closePreview.indexOf("dispatch_native_presentation(")).toBeLessThan(
      closePreview.indexOf("request_preview_surface_isolation(isolation_surfaces)")
    );
    expect(closePreview).toContain("surface.phase.blocks_role_relaunch()");
    expect(closePreview).not.toContain("BrowserRuntimeSnapshot");
    const destroyEffect = runtime.slice(
      runtime.indexOf("CoreEffectAction::EmbeddedDestroyTab {", runtime.indexOf("fn execute(")),
      runtime.indexOf(
        "CoreEffectAction::EmbeddedFollowRoleOwnership",
        runtime.indexOf("fn execute(")
      )
    );
    expect(destroyEffect).toContain("prepare_destroy_tab_presentation");
    expect(destroyEffect.indexOf("prepare_destroy_tab_presentation")).toBeLessThan(
      destroyEffect.indexOf("self.destroy_tab(&tab_id)?")
    );
    expect(runtime).toContain('"tab.close-successor-preflight-scheduled"');
    const closePreflight = runtime.slice(
      runtime.indexOf("fn prepare_destroy_tab_presentation("),
      runtime.indexOf("fn record_close_preflight_event(")
    );
    expect(closePreflight).not.toContain("wait_until_applied");
    expect(closePreflight).not.toContain("Duration::from_secs(1)");
    expect(runtime).toContain('"preflightMode": preflight_mode');
    expect(runtime).toContain('"waitedTabId": waited_tab_id');
    expect(runtime).toContain("struct LiveWindowTabStore {");
    expect(runtime).toContain("struct NativePresentationQueue<T>");
    expect(runtime).toContain("NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY");
    expect(runtime).toContain("enqueue_ordered(request)");
    expect(runtime).toContain("NATIVE_PRESENTATION_COALESCE_INTERVAL");
    expect(runtime).toContain("tab.selection-coalesced");
    expect(runtime).toContain("apply_native_presentation_batch(");
    expect(runtime).toContain("run_on_appkit_tracking_main(task)");
    expect(runtime).toContain(".run_on_main_thread(task)");
    expect(runtime).toContain("mainQueueWaitMs");
    expect(runtime).toContain("mainThreadMs");
    expect(runtime).toContain('"noOp": outcome.no_op');
    expect(runtime).toContain('"hideMs": outcome.hide_ms');
    expect(runtime).toContain('"showMs": outcome.show_ms');
    expect(runtime).toContain('"windowVisibilityMs": outcome.window_visibility_ms');
    expect(runtime).toContain('"windowFocusMs": outcome.window_focus_ms');
    expect(runtime).toContain('"webViewFocusMs": outcome.webview_focus_ms');
    expect(runtime).toContain("struct NativeFocusBroker {");
    expect(runtime).toContain("focus_broker.accept(");
    expect(runtime).toContain("focus_broker.begin_mutation(lease)");
    expect(runtime).toContain("observe_native_focus(");
    expect(runtime).toContain("revoke_window(window_id, host.generation)");
    expect(runtime).toContain('"focusSuperseded": outcome.focus_superseded');
    expect(runtime).toContain('"presentationApplied": outcome.presentation_applied');
    expect(runtime).toContain("if (!still_desired && !ordered_window_control)");
    expect(runtime).toContain("tab.selection-superseded");
    expect(runtime).toContain("completed_failed_launch_cleanups");
    expect(runtime).toContain('"tab.launch-cleanup-compensation-noop"');
    expect(runtime).toContain("retryable_failed_launches");
    expect(runtime).toContain("close_failed_launch_surface_and_wait(");
    expect(runtime).toContain("automatic_role_setup_retry_allowed(");
    expect(runtime).toContain("WINDOWS_ROLE_SETUP_RETRY_DELAY");
    expect(runtime).toContain('"tab.launch-auto-retry-scheduled"');
    expect(runtime).toContain('"tab.launch-auto-retry-recovered"');
    expect(runtime).toContain('"tab.launch-auto-retry-exhausted"');
    expect(shell).toContain("let reveal_error = completion_runtime");
    expect(shell).toContain("install_safe_tao_event_dispatch()");
    expect(macBridge).toContain("rion_runtime_tabs_install_safe_tao_event_dispatch");
    expect(macBridge).toContain("std::panic::catch_unwind");
    expect(macController).toContain("RionSafeTaoWindowSendEvent");
    expect(macController).toContain("method_setImplementation(method, safeImplementation)");
    expect(macController).toContain("@catch (NSException *exception)");
    const macPrewarm = runtime.slice(
      runtime.indexOf('#[cfg(target_os = "macos")]\n    pub fn schedule_webview_prewarm'),
      runtime.indexOf('#[cfg(not(target_os = "macos"))]\n    pub fn schedule_webview_prewarm')
    );
    expect(macPrewarm).not.toContain("WebviewWindowBuilder");
    expect(macPrewarm).toContain('"runtime-prewarm", "skipped"');
    expect(core).not.toContain("CoreCommand::EmbeddedTabActivate");
    expect(core).not.toContain("CoreCommand::EmbeddedTabHide");
    expect(core).not.toContain("apply_embedded_tab_selection_without_native_effect");
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
    expect(createTab).toContain("reserve_native_tab_for_create(");
    expect(createTab).toContain('"launch-reserved"');
    expect(createTab).toContain(
      'reconcile_window_presentation(&target.window_id, "launch-reserved")'
    );
    expect(createTab).not.toContain("dispatch_native_presentation(");
    expect(createTab).not.toContain("previous_surfaces");
    expect(createTab).not.toContain("remove_native_tab_reservation(");
    expect(createTab).toContain("The live tab and its native chrome reservation intentionally remain");
    expect(createTab).not.toContain("publish_projection(");
    expect(createTab.indexOf("webview.navigate(url)")).toBeLessThan(
      createTab.indexOf("self.resolve_runtime_layout(")
    );
    expect(createTab).toContain("role_bounds_for_content(content_metrics, &role.rect)");
    expect(createTab).toContain("take_tab_launch_preview(");
    expect(createTab).toContain("selection.replace_tab_id(&preview.id, presentation_tab");
    expect(createTab).toContain("presentation.bind_surface(");
    expect(createTab).toContain("self.setup_role_surface(&webview, &role_id, generation)");
    expect(createTab).not.toContain("install_platform_security_policy(&webview)");
    const createTabLaunch = createTab.slice(
      0,
      createTab.indexOf("fn claim_role_slot_surface(")
    );
    expect(createTabLaunch).toContain("wait_for_role_relaunch_fences(");
    expect(createTabLaunch).not.toContain("wait_for_role_store_reuse_fences(");
    const claimRoleSlot = runtime.slice(
      runtime.indexOf("fn claim_role_slot_surface("),
      runtime.indexOf("fn finish_claimed_role_slot(")
    );
    expect(claimRoleSlot).not.toContain("wait_for_role_store_reuse_fences(");
    expect(claimRoleSlot).not.toContain("ROLE_STORE_REUSE_TIMEOUT");
    expect(claimRoleSlot).toContain("self.finish_claimed_role_slot(&role.role.id)?");
    const roleRelaunchFence = runtime.slice(
      runtime.indexOf("fn role_relaunch_fence_state("),
      runtime.indexOf("impl SystemRuntimeExecutor {\n    pub fn move_window")
    );
    expect(roleRelaunchFence).not.toContain("Duration::from_millis(50)");
    expect(roleRelaunchFence).not.toContain("retired_surface_registry.values()");
    const macRoleSetup = runtime.slice(
      runtime.indexOf('#[cfg(target_os = "macos")]\nfn platform_role_surface_setup_inner('),
      runtime.indexOf('#[cfg(target_os = "macos")]\nunsafe extern "C" fn macos_surface_event(')
    );
    expect(macRoleSetup.match(/\.with_webview\(/g)).toHaveLength(1);
    expect(macRoleSetup).toContain("rion_wk_install_security_policy(native)");
    expect(macRoleSetup).toContain("rion_wk_track_surface(");
    const loadRoles = runtime.slice(
      runtime.indexOf("fn start_role_loads("),
      runtime.indexOf("fn install_overlays(")
    );
    expect(loadRoles).toContain("current_url.as_ref() != Some(&url)");
    expect(runtime).toContain("wait_role_navigation_for_lifecycle");
    expect(runtime).toContain(".wait_operation_async(operation.clone())");
    expect(runtime).toContain("application_lifecycle_epoch_matches");
    const asyncRoleLoad = runtime.slice(
      runtime.indexOf("fn execute_role_load_effect_async("),
      runtime.indexOf("fn start_role_loads(")
    );
    expect(asyncRoleLoad.indexOf("dispatch_core_effect_results")).toBeLessThan(
      asyncRoleLoad.indexOf("wait_role_navigation_for_lifecycle")
    );
    expect(asyncRoleLoad).toContain('"navigation-submitted:{operation_id}"');
    expect(asyncRoleLoad).toContain('"tab.page-ready:{tab_id}:{}"');
    const overlays = runtime.slice(
      runtime.indexOf("fn install_overlays("),
      runtime.indexOf("fn focus_role(")
    );
    expect(overlays).toContain("self.require_roles(role_ids)?");
    expect(overlays).toContain("MACRO_OVERLAY_REFRESH_SOURCE");
    expect(overlays).not.toContain("evaluate_webview");
    expect(overlays).not.toContain("thread::sleep");
    expect(shell).not.toContain("TAB_SELECTION_COMMIT_DEBOUNCE");
    expect(shell).not.toContain("TabSelectionCommitCoordinator");
    expect(shell).toContain("preview_and_commit_tab_selection");
    expect(shell).toContain("schedule_live_window_state_persistence(window_id)");
    expect(shell).toContain("runtime.preview_tab_launch(&target, &source_id, tab_type)");
    expect(shell).toContain("tauri::async_runtime::spawn_blocking(move ||");
    expect(runtime).toContain("pub(crate) fn preview_tab_launch(");
    expect(runtime).toContain('"zh-TW" => "載入中…"');
    expect(runtime).toContain('"launch-preview"');
    expect(quickMenu).toContain('name("rion-quick-menu-model".to_owned())');
    expect(quickMenu).toContain("Core and SQLite snapshots are collected on one bounded worker");
    expect(menu).toContain('name("rion-runtime-launcher-model".to_owned())');
    expect(menu).toContain("native plus button never");
    expect(menu).not.toContain("popup_target");
    expect(menu).toContain("registered_window_ids");
    expect(menu).toContain("launcher_menu_item_id(");
    expect(menu).toContain("parse_launcher_menu_target(");
    expect(menu).toContain("launcher_context_for_window_id(window_id)");
    expect(menu).toContain("presented_tab_for_launcher_source(source_id, tab_type)");
    expect(menu).toContain("request_presence(app.clone(), Arc::clone(&state.runtime))");
    expect(menu).toContain('format!("✓ {name}")');
    expect(runtime).toContain("fn launcher_presence(&self)");
    expect(runtime).toContain("role_ids: Vec<String>");
    expect(runtime).toContain("retain_live_runtime_launcher_tabs(&mut presence, &live_tab_ids)");
    expect(menu).not.toContain("model.runtime");
    expect(quickMenu).toContain("runtime.wait_for_shell_idle()");
    const coreEffects = shell.slice(
      shell.indexOf("CoreEvent::CoreEffects { effects }"),
      shell.indexOf("CoreEvent::OverlayChanged", shell.indexOf("CoreEvent::CoreEffects { effects }"))
    );
    expect(coreEffects).not.toContain("runtime_launcher_refresh.request");
    const openLauncher = menu.slice(
      menu.indexOf("pub fn open_launcher("),
      menu.indexOf("fn launcher_menu(")
    );
    expect(openLauncher).toContain("runtime_launcher_refresh");
    expect(openLauncher).not.toContain("core.invoke(");
    expect(openLauncher).not.toContain("CoreCommand::RolesList");
    expect(openLauncher).not.toContain("CoreCommand::WorkspacesList");
    const launcherPopup = menu.slice(
      menu.indexOf("fn popup(&self"),
      menu.indexOf("fn desired_launcher_revision")
    );
    expect(launcherPopup).not.toContain("CoreCommand::");
    expect(launcherPopup).not.toContain("launcher_presence_snapshot");
    expect(launcherPopup).not.toContain("launcher_menu(");
    expect(launcherPopup).not.toContain(".request(");
    const macLauncherCallback = macBridge.slice(
      macBridge.indexOf('if action_type == "openLauncher"'),
      macBridge.indexOf("dispatch_action(", macBridge.indexOf('if action_type == "openLauncher"'))
    );
    expect(macLauncherCallback).toContain("open_launcher(&context.app, &window_id)");
    expect(macLauncherCallback).toContain("return;");
    expect(windowsStrip).toContain('dispatch({ type: "openLauncher" })');
    expect(runtime).toContain(
      "MacRuntimeTabsController::create(\n            &self.app,\n            &window,\n            &target.window_id,"
    );
    expect(macBridge).toContain(
      "pub fn create(app: &AppHandle, window: &Window, window_id: &str)"
    );
    expect(macBridge).toContain("window_id.as_ptr()");
    expect(macController).toContain("windowIdentifier:windowIdentifier");
    expect(macController).toContain("_windowID = [windowIdentifier copy]");
    const quickMenuNativeBuild = quickMenu.slice(
      quickMenu.indexOf("fn menu(app: &AppHandle, model: &MenuModel)"),
      quickMenu.indexOf("fn handle_menu_event(")
    );
    expect(quickMenuNativeBuild).not.toContain("core.invoke(");
    expect(menu).toContain("preview_adjacent_tab_activation(&window_id, direction)");
    expect(menu).toContain("crate::execute_tab_stop(state, tab_id)");
    expect(menu).not.toContain("fn stop_command(");
    expect(macBridge).not.toContain("fn stop_command_for_tab(");
    expect(macBridge).toContain("metadata_pending: Mutex<HashMap<String, PendingMacTabMetadata>>");
    expect(macBridge).toContain("metadata_scheduled: AtomicBool");
    expect(macBridge).toContain("fn schedule_metadata_batch(");
    expect(macBridge).toContain("selection_generation: AtomicU64");
    expect(macBridge).toContain("inner.selection_generation.load(Ordering::Acquire) != generation");
    expect(macBridge).toContain("pub fn replace_reservation(");
    expect(macBridge).toContain("pub fn ensure(");
    expect(macBridge).toContain("pub fn reorder(&self, tab_ids: &[String])");
    expect(macBridge).toContain("rion_runtime_tabs_is_main_thread()");
    expect(macController).toContain("_tabItemsByIdentifier[tabIdentifier]");
    expect(macController).toContain("[previousItem updateVisualStateAnimated:NO]");
    expect(macController).toContain("[nextItem updateVisualStateAnimated:NO]");
    expect(macController).toContain("replaceTabIdentifier:");
    expect(macController).toContain("ensureTabIdentifier:");
    expect(macController).toContain("reorderTabIdentifiers:");
    expect(macController).toContain("[_tabItems removeObjectAtIndex:index]");
    expect(macController).not.toContain("nextEventMatchingMask:");
    expect(macController).toContain("- (void)mouseDragged:(NSEvent *)event");
    expect(macController).toContain("contents:RionRuntimeTransparentDragImage()");
    expect(macController).not.toContain("contents:[item.surfaceView dragImage]");
    expect(macController).not.toContain("- (NSImage *)dragImage");
    expect(macController).toContain("positionDragSurfaceForTabIdentifier:");
    expect(macController).toContain("previewDragTabIdentifier:");
    expect(macController).toContain("RionRuntimeTabInsertionProbeX(");
    expect(macController).toContain("RionRuntimeDirectionalInsertionProbeX(");
    expect(macController).toContain("draggedMinimumX, draggedMaximumX, draggedCenterX");
    expect(macController).not.toContain("captureWasCancelled");
    expect(macController).toContain("cancelled:cancelledWithEscape");
    expect(macController).toContain("RionRuntimeTabDragPayload(");
    expect(macController).toContain("RionRuntimeTabDragPayloadParts(");
    expect(macController).toContain("canvasPoint.x - grabRatioX * width");
    expect(macController).not.toContain("canvasPoint.x - item.grabRatio.x");
    expect(macController).toContain("surface.layer.presentationLayer");
    expect(runtime).toContain("project_native_order: bool");
    expect(runtime).toContain("if committed && project_native_order");
    expect(runtime).toContain("schedule_native_tab_order_projection(");
    expect(macController).toContain("_tabIconCacheKeys");
    expect(macController).toContain("updateTabMetadata:(RionRuntimeTabModel *)tab");
    expect(macController).toContain("NSEventMaskFlagsChanged");
    expect(macController).toContain("_tabShortcutOriginResponder");
    expect(macController).toContain("RionRuntimeRelayShortcutModifierEvent");
    expect(macController).toContain('modifierHandoffCompleted');
    expect(macBridge).toContain("begin_macos_shortcut_modifier_handoff");
    expect(macBridge).toContain("finish_macos_shortcut_modifier_handoff");
    expect(runtime).toContain("begin_windows_shortcut_modifier_handoff");
    expect(runtime).toContain("release_windows_shortcut_modifiers");
    expect(runtime).toContain("windows_shortcut_modifier_codes");
    expect(runtime).toContain(
      '#[cfg(any(windows, target_os = "macos"))]\n    fn reassert_shortcut_handoff_keys'
    );
    expect(runtime).toContain("self.reassert_role_keys_in_lane(role_id, &context)");
    expect(runtime).not.toContain("reassert_tab_shortcut_modifiers");
    expect(quickMenu).toContain('#[cfg(any(target_os = "macos", test))]\n    Macos,');
    expect(quickMenu).toContain('#[cfg(any(target_os = "windows", test))]\n    Windows,');
    expect(quickMenu.match(/platform\.is_windows\(\)/g)).toHaveLength(2);
    expect(runtime).toContain('input.modifier-handoff-{phase}');
    expect(macController).not.toContain("- (void)updateState:");
    expect(windowsStrip).toContain("optimisticallyActivateAdjacentTab");
    expect(windowsStrip).toContain("optimisticallyCloseTab");
    expect(windowsStrip).toContain("reconcileTabButtons(");
    expect(windowsStrip).toContain("presentationActiveTabId,\n    deferAuthoritativeOrder");
    expect(windowsStrip).toContain("patchTabButton(button, tab, state, labels");
    expect(windowsStrip).toContain("window.__rionEnsureRuntimeTab = (tab)");
    expect(windowsStrip).toContain("window.__rionReorderRuntimeTabs = (tabIds)");
    expect(windowsStrip).toContain("applyRuntimeTabOrder(tabIds, false)");
    expect(windowsStrip).toContain("forceFallback: true");
    expect(windowsStrip).toContain('animation: 180');
    expect(windowsStrip).toContain('easing: "cubic-bezier(0.2, 0, 0, 1)"');
    expect(windowsStrip).not.toContain("lockFallbackGhostToHorizontalAxis");
    expect(windowsStrip).toContain("runtimeTabReorderBarrier.then(invokeAction)");
    expect(windowsStrip).toContain("revertOnSpill: true");
    expect(windowsStrip).toContain('sortable.option("disabled", callbacks.tabIds().length <= 1)');
    expect(windowsStrip).toContain('callbacks.startWindowDrag()');
    expect(windowsStrip).toContain("button.draggable = false");
    expect(windowsStrip).not.toContain("dataTransfer.getData(");
    expect(windowsStrip).not.toContain('addEventListener("dragover"');
    expect(windowsStrip).not.toContain("root.replaceChildren(");
    expect(windowsStrip).not.toContain("existing.replaceChildren(");
  });

it("never blocks the native UI thread and cancels provisional tabs through the stop transaction", async () => {
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
    expect(launchPreview).toContain("let existing_window = {");
    expect(launchPreview).toContain("host.retirement_revision");
    expect(launchPreview).toContain(".display_hosts");
    expect(launchPreview.indexOf("if let Some(window) = existing_window")).toBeLessThan(
      launchPreview.indexOf("with_native_creation_lane")
    );
    expect(launchPreview).toContain("reserve_native_tab(");

    for (const source of [shell, quickMenu]) {
      const previewCall = source.indexOf("preview_tab_launch(");
      expect(previewCall).toBeGreaterThan(-1);
      expect(source.lastIndexOf("spawn_blocking(move ||", previewCall)).toBeGreaterThan(-1);
    }
    const menuLaunch = menu.slice(
      menu.indexOf("fn launch_from_menu("),
      menu.indexOf("fn capture_launcher_action_event(")
    );
    expect(menuLaunch).toContain("preview_tab_launch(&target, source_id, tab_type)");
    expect(menuLaunch.indexOf("preview_tab_launch(&target, source_id, tab_type)")).toBeLessThan(
      menuLaunch.indexOf("launch_intents.try_launch(")
    );
    expect(menuLaunch).not.toContain(".preview_tab_launch(&target, source_id, tab_type)\n            .ok()");
    expect(menuLaunch).toContain('"tab.launch-preview-rejected"');
    expect(menuLaunch).toContain('"tab.launch-queue-rejected"');
    expect(menuLaunch).not.toContain("spawn_blocking");
    expect(menuLaunch).not.toContain("launch_target_for_game_window");
    expect(menuLaunch).not.toContain("core.invoke");

    const createTab = runtime.slice(
      runtime.indexOf("fn create_tab("),
      runtime.indexOf("fn load_roles(")
    );
    expect(createTab.indexOf("take_tab_launch_preview(")).toBeLessThan(
      createTab.indexOf("with_native_creation_lane")
    );
    expect(runtime).toContain("pub(crate) fn cancel_provisional_tab_launch(");
    expect(runtime).toContain("cancel_provisional_launch_state(&mut state, tab_id)");
    expect(runtime).toContain("take_provisional_launch_attempt(");
    expect(runtime).toContain('"LAUNCH_PREVIEW_STALE"');
    expect(runtime).toContain("active_provisional_launches");
    const stopTransaction = shell.slice(
      shell.indexOf("async fn execute_tab_stop("),
      shell.indexOf("async fn execute_tab_mutation_commit(")
    );
    expect(stopTransaction).toContain("cancel_provisional_tab_launch(tab_id)");
    expect(stopTransaction).toContain("preview_tab_close(tab_id)");
    expect(stopTransaction).toContain("CoreCommand::EmbeddedTabStop");
    expect(stopTransaction).toContain("RuntimeTabMutationTerminalStatus::Indeterminate");
    expect(stopTransaction).toContain("tab_surface_release_confirmed(tab_id)");
    expect(stopTransaction).toContain("tab_stop_terminal_outcome(");
    expect(shell).toContain("complete_background_presentation_summary(&operation_id)");
    expect(shell).toContain("preview_and_schedule_native_tab_selection");
    const scheduledNativeSelection = shell.slice(
      shell.indexOf("pub(crate) fn preview_and_schedule_native_tab_selection("),
      shell.indexOf("fn monitor_background_tab_presentation(")
    );
    expect(scheduledNativeSelection).not.toContain("wait_native_operation_summary");
    expect(menu).toContain("crate::execute_tab_stop(state, tab_id)");
    const scopedTabAction = menu.slice(
      menu.indexOf("pub async fn handle_scoped_action("),
      menu.indexOf("fn launch_from_menu(")
    );
    expect(scopedTabAction).toContain('if action_type == "activate"');
    expect(scopedTabAction).toContain("live_tab_window_id(tab_id)");
    expect(scopedTabAction).not.toContain("BrowserRuntimeSnapshot");
    expect(scopedTabAction).not.toContain("snapshot(&state.core)");
    expect(macBridge).toContain("crate::execute_tab_stop(&state, tab_id).await");
    expect(macBridge).toContain("state.runtime.preview_tab_close(tab_id)");
    expect(runtime).toContain("resolve_live_presentation_tab_owner(tab_id)?");
    expect(runtime).not.toContain("repair_missing_tab_presentation");
    expect(runtime).not.toContain("reconcile_presentation_tab_owner(tab_id, &window_id)");
  });

it("keeps failed destructive close quarantined instead of rolling presentation back", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    expect(runtime).toContain("struct TabCloseTombstone {");
    expect(runtime).toContain("slot_owners: Vec<(String, String, Option<u64>)>");
    expect(runtime).not.toContain("cancel_tab_close_preview");
    expect(runtime).toContain("pub(crate) fn resolve_tab_close_preview(");
    expect(runtime).toContain("surface.phase = ManagedSurfacePhase::Quarantined");
  });

it("tracks exact native surface ownership across roles, popups, dividers, and moves", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    expect(runtime).toContain("struct ManagedSurface {");
    expect(runtime).toContain("struct CloseCoordinator {");
    expect(runtime).toContain("struct TabCloseTombstone {");
    expect(runtime).toContain("surface_registry: HashMap<String, ManagedSurface>");
    expect(runtime).toContain("fn wait_for_managed_surface_release(");
    expect(runtime).toContain("state.close_coordinator.closing_roles.contains(role_id)");
    expect(runtime).toContain("surface_instance_id: String");
    for (const kind of ["Role", "Recovery", "Popup", "Divider"]) {
      expect(runtime).toContain(`ManagedSurfaceKind::${kind}`);
    }
    const move = runtime.slice(
      runtime.indexOf("fn provisionally_move_tab_with_visibility_inner("),
      runtime.indexOf("fn schedule_live_tab_drag_layout(")
    );
    expect(move).toContain("state.surface_registry.values_mut()");
    expect(move).toContain("surface.window_id = target_window_id.to_owned()");
    expect(move).toMatch(/state\s*\.native_tab_hosts/u);
    expect(move).not.toContain("surface.window_id = source_window_id.to_owned()");
    const popup = runtime.slice(
      runtime.indexOf("fn register_popup("),
      runtime.indexOf("fn schedule_surface_recovery(")
    );
    expect(popup).toContain("ManagedSurfaceKind::Popup");
    expect(popup).toContain("register_managed_surface(");
  });

it("retains the live destination when native surface projection fails", async () => {
    const [runtime, move] = await Promise.all([readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    ), readFile(
      new URL("../src-tauri/src/system_runtime/section_11_provisionally_move_tab_with_visibility.rs", import.meta.url),
      "utf8"
    )]);
    const hidePhase = move.indexOf("for surface in &surfaces");
    const reparentPhase = move.indexOf("surface.reparent(&target_window)");
    const reparentSyncPhase = move.indexOf("synchronize_windows_reparented_surfaces(");
    const presentationRead = move.indexOf("let selected_tabs_after_move");
    const revealPhase = move.indexOf("let reveal_result");
    expect(hidePhase).toBeGreaterThan(-1);
    expect(reparentPhase).toBeGreaterThan(hidePhase);
    expect(reparentSyncPhase).toBeGreaterThan(reparentPhase);
    expect(move).not.toContain("tab.window_id = target_window_id.to_owned()");
    expect(presentationRead).toBeGreaterThan(reparentSyncPhase);
    expect(revealPhase).toBeGreaterThan(presentationRead);
    expect(move).not.toContain("self.relocate_native_tab_reservation(");
    expect(move).not.toContain("commit_live_topology(");
    expect(move).not.toContain("presentation.move_tab(");
    expect(move).toContain('"provisional-move"');
    expect(move).not.toContain("retain_live_destination_after_surface_error(");
    expect(move).not.toContain("surface_projection_error(");
    expect(move).not.toContain("rollback_provisional_tab_move(");
    expect(move).not.toContain("provisional_move_error(");
    expect(move).not.toContain("SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED");
    expect(runtime).not.toContain('"provisional-rollback"');
  });

it("acknowledges close isolation before coalesced restore persistence", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const executor = runtime.slice(
      runtime.indexOf("fn execute_effect_work("),
      runtime.indexOf("pub fn registration(")
    );
    const closeBranch = runtime.slice(
      runtime.indexOf("fn finish_event_bound_close_effect("),
      runtime.indexOf("fn schedule_restore_session_persist(")
    );
    const closeDispatch = closeBranch.indexOf("dispatch_core_effect_results");
    const closePersist = closeBranch.indexOf("schedule_restore_session_persist");
    expect(closeDispatch).toBeGreaterThan(-1);
    expect(closePersist).toBeGreaterThan(closeDispatch);
    expect(closeBranch).not.toContain("persist_restore_session(false)");

    const regularBranch = executor.slice(executor.indexOf("let persistence_error"));
    const regularPersist = regularBranch.indexOf("self.persist_restore_session(false)");
    const finalize = regularBranch.indexOf("finalize_persisted_effect_result(");
    const regularDispatch = regularBranch.indexOf("dispatch_core_effect_results");
    expect(regularPersist).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(regularPersist);
    expect(regularDispatch).toBeGreaterThan(finalize);
    expect(runtime).toContain("fn schedule_restore_session_persist(");
    expect(runtime).toContain("restore_persist_requested");
    expect(runtime).toContain("restore_persist_changed");
    expect(runtime).not.toContain("thread::sleep(RESTORE_PERSIST_COALESCE_DELAY)");
    expect(executor).not.toContain("SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY");
    expect(runtime).toContain("SYSTEM_RUNTIME_PERSIST_FAILED");
  });

it("fences and drains role macro input when a tracked popup is destroyed", async () => {
    const [runtime, shell] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
    ]);
    const cleanup = runtime.slice(
      runtime.indexOf("pub(crate) fn forget_popup("),
      runtime.indexOf("fn register_popup(")
    );
    expect(cleanup).toContain("state.popup_roles.remove(window_label)");
    expect(cleanup).toContain("state.main_frame_navigation_input_fences.remove(window_label)");
    expect(cleanup).toContain("tauri::async_runtime::spawn(async move");
    expect(cleanup).toContain("advance_role_input_fence_local(role_id)");
    expect(cleanup).toContain(".invoke_async(CoreCommand::MacroInputFence");
    expect(cleanup).toContain(".invoke_async(CoreCommand::MacroInputDrain");
    expect(cleanup).toContain("finish_navigation_input_drain");
    expect(cleanup).toContain("try_resume_navigation_input");
    expect(runtime).toContain("CoreCommand::MacroInputResume {");
    expect(cleanup).toContain("SYSTEM_POPUP_INPUT_FENCE_FAILED");
    expect(cleanup).not.toContain("CoreCommand::MacroReleaseRole");
    expect(runtime).toContain('"rion://shell-error"');

    const destroyed = shell.slice(
      shell.indexOf("tauri::WindowEvent::Destroyed =>"),
      shell.indexOf("_ => {}", shell.indexOf("tauri::WindowEvent::Destroyed =>"))
    );
    expect(destroyed).toContain("state.runtime.complete_window_destroyed(&label)");
    expect(runtime).toContain("self.forget_popup(label)");
  });

  it("keeps macro focus as a fenced readiness check without changing game focus", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    const start = runtime.indexOf("BrowserAction::Focus => {");
    const focus = runtime.slice(start, runtime.indexOf("BrowserAction::Key {", start));

    expect(start).toBeGreaterThan(-1);
    expect(focus).toContain("role_webview_for_input(&role_id, &context)");
    expect(focus).not.toContain("evaluate_webview");
    expect(focus).not.toContain("window.focus");
    expect(focus).not.toContain("set_focus");
  });

  it("does not retain the retired role-to-role local storage subsystem", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    for (const retired of [
      "rion_local_storage_sync_changed",
      "LocalStorageRuntimeConfig",
      "FLYFF_SETTINGS_INVALID",
      "local-storage-sync-v1.enc",
      "local-storage-sync-v2.enc"
    ]) {
      expect(runtime).not.toContain(retired);
    }
  });

  it("fences cleanup by launch generation and poisons health only when release is unverified", async () => {
    const runtime = await readFile(
      new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
      "utf8"
    );
    expect(runtime).toContain("launch_attempt_generations");
    expect(runtime).toContain("attempt_generation");
    expect(runtime).toContain("The destroy request belonged to a stale launch attempt.");

    const boundedCreate = runtime.slice(
      runtime.indexOf("fn add_child_bounded("),
      runtime.indexOf("fn prepare_surface_parent_for_creation(")
    );
    expect(boundedCreate.indexOf("recv_timeout(SURFACE_RECLAMATION_TIMEOUT)")).toBeLessThan(
      boundedCreate.indexOf("self.health.mark_unhealthy()")
    );
    expect(boundedCreate).toContain("SYSTEM_SURFACE_RELEASE_UNVERIFIED");
  });

  it("keeps Windows-only tab chrome projection imports reachable", async () => {
    const [imports, projection] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_01_navigation_timeout.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_04_tab_chrome_projection.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);
    const windowsImportStart = imports.indexOf('#[cfg(windows)]\nuse rion_core::{');
    const windowsImportEnd = imports.indexOf("};", windowsImportStart);
    expect(windowsImportStart).toBeGreaterThan(-1);
    expect(windowsImportEnd).toBeGreaterThan(windowsImportStart);
    expect(imports.slice(windowsImportStart, windowsImportEnd)).toContain(
      "DisplayInfoRecord"
    );
    expect(projection).toContain(
      "fn display_records_for_tab_chrome(&self) -> Vec<DisplayInfoRecord>"
    );
  });
});
