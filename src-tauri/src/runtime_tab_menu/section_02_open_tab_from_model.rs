#[allow(clippy::too_many_arguments)]
fn open_tab_from_model(
    app: &AppHandle,
    tab_id: &str,
    language: &str,
    muted: bool,
    live_window_id: &str,
    game_windows: &serde_json::Value,
    window: Window,
) -> Result<(), String> {
    let text = labels(language);
    let mut displays = SubmenuBuilder::new(app, text.move_to_window);
    for game_window in game_windows.as_array().cloned().unwrap_or_default() {
        let (Some(window_id), Some(label)) =
            (game_window["id"].as_str(), game_window["name"].as_str())
        else {
            continue;
        };
        let item = MenuItemBuilder::with_id(format!("{MOVE_PREFIX}{tab_id}:{window_id}"), label)
            .enabled(window_id != live_window_id)
            .build(app)
            .map_err(|error| error.to_string())?;
        displays = displays.item(&item);
    }
    let displays = displays.build().map_err(|error| error.to_string())?;
    let mute = CheckMenuItemBuilder::with_id(
        format!("{MUTE_PREFIX}{tab_id}"),
        if muted { text.unmute } else { text.mute },
    )
    .checked(muted)
    .build(app)
    .map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(app)
        .text(format!("{RELOAD_PREFIX}{tab_id}"), text.reload)
        .separator()
        .item(&displays)
        .text(
            format!("{MOVE_NEW_PREFIX}{tab_id}"),
            text.move_to_new_window,
        )
        .item(&mute)
        .separator()
        .text(format!("{HIDE_PREFIX}{tab_id}"), text.hide)
        .separator()
        .text(format!("{STOP_PREFIX}{tab_id}"), text.stop)
        .build()
        .map_err(|error| error.to_string())?;
    menu.popup(window).map_err(|error| error.to_string())
}

pub fn open_launcher(app: &AppHandle, window_id: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "runtime state is unavailable".to_owned())?;
    let (window, _) = state.runtime.launcher_context_for_window_id(window_id)?;
    state
        .runtime_launcher_refresh
        .request_presence(app.clone(), Arc::clone(&state.runtime));
    state.runtime_launcher_refresh.popup(window_id, window)
}

fn launcher_menu(
    app: &AppHandle,
    model: &LauncherMenuModel,
    window_id: &str,
) -> Result<Menu<tauri::Wry>, String> {
    let text = labels(&model.catalog.language);
    let mut roles_menu = SubmenuBuilder::new(app, text.roles);
    let role_values = model.catalog.roles.as_array().cloned().unwrap_or_default();
    if role_values.is_empty() {
        let item = MenuItemBuilder::new(text.no_roles)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        roles_menu = roles_menu.item(&item);
    } else {
        for role in role_values {
            let (Some(id), Some(name)) = (role["id"].as_str(), role["name"].as_str()) else {
                continue;
            };
            roles_menu = roles_menu.text(
                launcher_menu_item_id(LAUNCH_ROLE_PREFIX, window_id, id),
                launcher_item_label(
                    name,
                    launcher_presence_tab(&model.presence, id, false).is_some(),
                ),
            );
        }
    }
    let mut workspaces_menu = SubmenuBuilder::new(app, text.workspaces);
    let workspace_values = model
        .catalog
        .workspaces
        .as_array()
        .cloned()
        .unwrap_or_default();
    if workspace_values.is_empty() {
        let item = MenuItemBuilder::new(text.no_workspaces)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        workspaces_menu = workspaces_menu.item(&item);
    } else {
        for workspace in workspace_values {
            let (Some(id), Some(name)) = (workspace["id"].as_str(), workspace["name"].as_str())
            else {
                continue;
            };
            workspaces_menu = workspaces_menu.text(
                launcher_menu_item_id(LAUNCH_WORKSPACE_PREFIX, window_id, id),
                launcher_item_label(
                    name,
                    launcher_presence_tab(&model.presence, id, true).is_some(),
                ),
            );
        }
    }
    let saved = model
        .catalog
        .game_windows
        .as_array()
        .is_some_and(|windows| windows.iter().any(|window| window["id"] == window_id));
    let mut menu = MenuBuilder::new(app);
    if !saved {
        menu = menu
            .text(format!("{SAVE_WINDOW_PREFIX}{window_id}"), text.save_window)
            .separator();
    }
    menu.item(&roles_menu.build().map_err(|error| error.to_string())?)
        .item(&workspaces_menu.build().map_err(|error| error.to_string())?)
        .build()
        .map_err(|error| error.to_string())
}

fn launcher_presence_tab<'a>(
    presence: &'a crate::system_runtime::RuntimeLauncherPresence,
    source_id: &str,
    workspace: bool,
) -> Option<&'a crate::system_runtime::RuntimeLauncherPresenceTab> {
    presence.tabs.iter().find(|tab| {
        if workspace {
            tab.tab_type == "workspace" && tab.source_id == source_id
        } else {
            tab.role_ids.iter().any(|role_id| role_id == source_id)
                || (tab.tab_type == "role" && tab.source_id == source_id)
        }
    })
}

fn launcher_item_label(name: &str, launched: bool) -> String {
    if launched {
        format!("✓ {name}")
    } else {
        name.to_owned()
    }
}

fn launcher_menu_item_id(prefix: &str, window_id: &str, source_id: &str) -> String {
    format!("{prefix}{window_id}:{source_id}")
}

fn parse_launcher_menu_target(value: &str) -> Result<(&str, &str), String> {
    let (window_id, source_id) = value
        .split_once(':')
        .ok_or_else(|| "runtime launcher menu target is invalid".to_owned())?;
    if window_id.is_empty() || source_id.is_empty() {
        return Err("runtime launcher menu target is invalid".to_owned());
    }
    Ok((window_id, source_id))
}

fn launcher_loading_menu(app: &AppHandle, language: &str) -> Result<Menu<tauri::Wry>, String> {
    let item = MenuItemBuilder::new(labels(language).loading)
        .enabled(false)
        .build(app)
        .map_err(|error| error.to_string())?;
    MenuBuilder::new(app)
        .item(&item)
        .build()
        .map_err(|error| error.to_string())
}

pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    if !is_runtime_menu_event(id) {
        return false;
    }
    let Some(state) = app.try_state::<crate::CoreState>() else {
        reveal_menu_error(app, "runtime state is unavailable");
        return true;
    };
    if let Some(tab_id) = id.strip_prefix(ACTIVATE_PREFIX) {
        if let Err(message) = crate::preview_and_schedule_native_tab_selection(app, &state, tab_id) {
            reveal_menu_error(app, message);
        }
    } else if let Some(tab_id) = id.strip_prefix(HIDE_PREFIX) {
        spawn_tab_mutation(app, tab_id, "hide", None, None);
    } else if let Some(tab_id) = id.strip_prefix(RELOAD_PREFIX) {
        let app = app.clone();
        let runtime = Arc::clone(&state.runtime);
        let tab_id = tab_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || runtime.reload_tab(&tab_id))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
            match result {
                Ok(receipt)
                    if matches!(receipt.status.as_str(), "applied" | "superseded") => {}
                Ok(receipt) => reveal_menu_error(
                    &app,
                    receipt
                        .failure_code
                        .as_deref()
                        .unwrap_or("SYSTEM_RELOAD_PARTIAL_FAILURE"),
                ),
                Err(message) => reveal_menu_error(&app, message),
            }
        });
    } else if let Some(tab_id) = id.strip_prefix(STOP_PREFIX) {
        spawn_tab_stop(app, tab_id);
    } else if let Some(tab_id) = id.strip_prefix(MUTE_PREFIX) {
        match current_tab_muted(&state, tab_id) {
            Ok(muted) => {
                let app = app.clone();
                let runtime = Arc::clone(&state.runtime);
                let tab_id = tab_id.to_owned();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        runtime.set_tab_audio_muted(&tab_id, !muted)
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result.and_then(crate::runtime_operation_receipt_result));
                    if let Err(message) = result {
                        reveal_menu_error(&app, message);
                    }
                });
            }
            Err(message) => reveal_menu_error(app, message),
        }
    } else if let Some(tab_id) = id.strip_prefix(MOVE_NEW_PREFIX) {
        let app = app.clone();
        let tab_id = tab_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let Some(state) = app.try_state::<crate::CoreState>() else {
                reveal_menu_error(&app, "runtime state is unavailable");
                return;
            };
            if let Err(error) = crate::move_game_window_tab_to_new_window(
                &app,
                &state,
                &tab_id,
                None,
            )
            .await
                && error.code != "TAURI_RUNTIME_TAB_MOVE_SUPERSEDED"
            {
                crate::reveal_shell_error(&app, error);
            }
        });
    } else if let Some(value) = id.strip_prefix(MOVE_PREFIX) {
        let Some((tab_id, window_id)) = value.rsplit_once(':') else {
            reveal_menu_error(app, "runtime move menu target is invalid");
            return true;
        };
        match state.runtime.launcher_context_for_window_id(window_id) {
            Ok((_, target)) => {
                spawn_tab_mutation(app, tab_id, "move", Some(target), None);
            }
            Err(message) => reveal_menu_error(app, message),
        }
    } else if let Some(value) = id.strip_prefix(LAUNCH_ROLE_PREFIX) {
        launch_from_scoped_menu(app, &state, value, false);
    } else if let Some(value) = id.strip_prefix(LAUNCH_WORKSPACE_PREFIX) {
        launch_from_scoped_menu(app, &state, value, true);
    } else if let Some(window_id) = id.strip_prefix(SAVE_WINDOW_PREFIX) {
        save_runtime_game_window(app, &state, window_id);
    }
    true
}

fn launch_from_scoped_menu(
    app: &AppHandle,
    state: &crate::CoreState,
    value: &str,
    workspace: bool,
) {
    let result = parse_launcher_menu_target(value).and_then(|(window_id, source_id)| {
        state
            .runtime
            .launcher_context_for_window_id(window_id)
            .map(|(_, target)| (target, source_id))
    });
    match result {
        Ok((target, source_id)) => launch_from_menu(app, state, target, source_id, workspace),
        Err(message) => reveal_menu_error(app, message),
    }
}

fn save_runtime_game_window(app: &AppHandle, state: &crate::CoreState, window_id: &str) {
    match state.runtime_launcher_refresh.begin_save(window_id) {
        Ok(true) => {}
        Ok(false) => return,
        Err(message) => {
            reveal_menu_error(app, message);
            return;
        }
    }
    let app = app.clone();
    let core = Arc::clone(&state.core);
    let runtime = Arc::clone(&state.runtime);
    let coordinator = state.runtime_launcher_refresh.clone();
    let language = state
        .menu_language
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "en".to_owned());
    let window_id = window_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let preparation_core = Arc::clone(&core);
        let preparation_runtime = Arc::clone(&runtime);
        let preparation_window_id = window_id.clone();
        let preparation_language = language.clone();
        let preparation = tauri::async_runtime::spawn_blocking(move || {
            let windows = saved_game_windows(&preparation_core)?;
            if windows
                .iter()
                .any(|window| window.id == preparation_window_id)
            {
                return Ok((None, windows));
            }
            let name = crate::next_game_window_name(&windows, &preparation_language);
            let input = preparation_runtime
                .runtime_game_window_save_input(&preparation_window_id, name)
                .map_err(|message| crate::shell_error("TAURI_GAME_WINDOW_SAVE_FAILED", message))?;
            Ok((Some(input), windows))
        })
        .await
        .map_err(|error| crate::shell_error("CORE_INTERNAL_FAILED", error.to_string()))
        .and_then(|result| result);

        let result = async {
            let (input, existing_windows) = preparation?;
            let Some(input) = input else {
                runtime
                    .refresh_saved_game_windows(&existing_windows)
                    .map_err(|message| crate::shell_error("SHELL_WINDOW_FAILED", message))?;
                return Ok::<(), rion_core::CoreErrorPayload>(());
            };
            let saved = core
                .invoke_async(CoreCommand::GameWindowSaveRuntime { input })
                .await
                .map_err(crate::error_payload)
                .and_then(|value| {
                    serde_json::from_value::<StateGameWindowRecord>(value).map_err(|error| {
                        crate::shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string())
                    })
                })?;
            let windows = saved_game_windows(&core)?;
            if let Err(message) = runtime.refresh_saved_game_windows(&windows) {
                // The SQLite save is authoritative and must never be deleted
                // because a downstream native-title projection failed. Menu
                // refresh will retry from the saved definition independently.
                eprintln!(
                    "Saved Game Window native metadata refresh was deferred: window={} error={message}",
                    saved.id
                );
            }
            Ok(())
        }
        .await;

        coordinator.finish_save(&window_id);
        let _ = coordinator.request(app.clone(), Arc::clone(&core), language);
        if let Err(error) = result {
            crate::reveal_shell_error(&app, error);
        }
    });
}

fn saved_game_windows(
    core: &AppCore,
) -> Result<Vec<StateGameWindowRecord>, rion_core::CoreErrorPayload> {
    core.invoke(CoreCommand::GameWindowsList)
        .map_err(crate::error_payload)
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|error| crate::shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })
}

fn is_runtime_menu_event(id: &str) -> bool {
    [
        ACTIVATE_PREFIX,
        HIDE_PREFIX,
        LAUNCH_ROLE_PREFIX,
        LAUNCH_WORKSPACE_PREFIX,
        MOVE_PREFIX,
        MOVE_NEW_PREFIX,
        MUTE_PREFIX,
        RELOAD_PREFIX,
        SAVE_WINDOW_PREFIX,
        STOP_PREFIX,
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
}

pub async fn handle_scoped_action(
    app: &AppHandle,
    state: &crate::CoreState,
    window_id: String,
    action: serde_json::Value,
) -> Result<(), String> {
    let action_type = action["type"]
        .as_str()
        .ok_or_else(|| "runtime tab action type is required".to_owned())?;
    let allowed_keys = match action_type {
        "activate" | "hide" | "openTabMenu" => &["type", "tabId"][..],
        "stop" => &[
            "type",
            "tabId",
            "orderedTabIds",
            "activeTabId",
            "windowGeneration",
        ][..],
        "move" => &["type", "tabId", "windowId"][..],
        "tabDragStart" => &[
            "type",
            "sessionId",
            "tabId",
            "screenX",
            "screenY",
            "grabRatioX",
            "grabRatioY",
            "tabWidth",
            "tabHeight",
        ][..],
        "tabDragMove" => &["type", "sessionId", "screenX", "screenY"][..],
        "tabDragHover" => &[
            "type",
            "sessionId",
            "windowId",
            "beforeTabId",
            "screenX",
            "screenY",
            "tabWidth",
            "tabHeight",
        ][..],
        "tabDragDrop" => &[
            "type",
            "sessionId",
            "windowId",
            "beforeTabId",
            "orderedTabIds",
            "screenX",
            "screenY",
        ][..],
        "tabDragEnd" => &["type", "sessionId", "cancelled", "screenX", "screenY"][..],
        "tabDragCancel" => &["type", "sessionId"][..],
        "reorder" => &["type", "tabId", "beforeTabId"][..],
        "openLauncher" | "startWindowDrag" | "fullscreenToolbarEnter"
        | "fullscreenToolbarLeave" => &["type"][..],
        "activateAdjacent" => &["type", "direction"][..],
        "applicationShortcut" => &["type", "command"][..],
        "windowControl" => &["type", "control"][..],
        _ => return Err("runtime tab action type is not supported".to_owned()),
    };
    if action.as_object().is_none_or(|value| {
        value
            .keys()
            .any(|key| !allowed_keys.contains(&key.as_str()))
    }) {
        return Err("runtime tab action contains unexpected fields".to_owned());
    }
    if action_type == "openLauncher" {
        return open_launcher(app, &window_id);
    }
    if action_type == "startWindowDrag" {
        return state
            .runtime
            .window_for_id(&window_id)
            .ok_or_else(|| "runtime window was not found".to_owned())?
            .start_dragging()
            .map_err(|error| error.to_string());
    }
    if action_type == "applicationShortcut" {
        let command = action["command"]
            .as_str()
            .and_then(crate::application_menu::ApplicationShortcutCommand::parse)
            .ok_or_else(|| "application shortcut command is invalid".to_owned())?;
        return crate::application_menu::execute_shortcut(
            app,
            state,
            command,
            crate::application_menu::ApplicationShortcutTarget::RuntimeWindow(&window_id),
        );
    }
    if matches!(
        action_type,
        "fullscreenToolbarEnter" | "fullscreenToolbarLeave"
    ) {
        return state
            .runtime
            .set_windows_toolbar_revealed(&window_id, action_type == "fullscreenToolbarEnter");
    }
    if action_type == "activateAdjacent" {
        let direction = action["direction"]
            .as_str()
            .filter(|value| matches!(*value, "next" | "previous"))
            .ok_or_else(|| "runtime tab direction is invalid".to_owned())?;
        let (target_tab_id, provisional, _operation_id) = state
            .runtime
            .preview_adjacent_tab_activation(&window_id, direction)?;
        if provisional {
            return Ok(());
        }
        return crate::commit_previewed_tab_selection(
            app,
            state,
            &window_id,
            &target_tab_id,
        );
    }
    if action_type == "windowControl" {
        let control = action["control"]
            .as_str()
            .ok_or_else(|| "runtime window control is required".to_owned())?;
        return match control {
            "close" => state
                .runtime
                .window_for_id(&window_id)
                .ok_or_else(|| "runtime window was not found".to_owned())?
                .close()
                .map_err(|error| error.to_string()),
            "minimize" => state.runtime.minimize_runtime_window(&window_id).map(|_| ()),
            "toggleFullscreen" => state
                .runtime
                .toggle_runtime_window_fullscreen(&window_id)
                .map(|_| ()),
            "zoom" => state
                .runtime
                .toggle_runtime_window_maximized(&window_id)
                .map(|_| ()),
            _ => Err("runtime window control is invalid".to_owned()),
        };
    }
    let tab_id = action["tabId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "runtime tab ID is required".to_owned())?;
    if action_type == "activate" {
        if state.runtime.live_tab_window_id(tab_id).as_deref() != Some(window_id.as_str()) {
            state.runtime.publish_projection();
            return Ok(());
        }
        return crate::preview_and_schedule_native_tab_selection(app, state, tab_id);
    }
    if action_type == "stop" {
        return crate::execute_tab_stop(state, tab_id)
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))
            .and_then(crate::runtime_operation_receipt_result);
    }
    let Some(live_window_id) = state.runtime.live_tab_window_id(tab_id) else {
        // AppKit/WebView2 can deliver an already-queued click after the live tab
        // was removed. The visible topology has committed, so the callback is
        // complete and must not surface a "tab not found" error.
        return Ok(());
    };
    if live_window_id != window_id {
        return Err("runtime tab is outside this tab-strip WebView's window".to_owned());
    }
    if action_type == "openTabMenu" {
        return open_tab(app, tab_id);
    }
    let (target, before_tab_id) = match action_type {
        "hide" => (None, None),
        "move" => {
            let target_window_id = action["windowId"]
                .as_str()
                .ok_or_else(|| "target window ID is required".to_owned())?;
            if target_window_id != window_id {
                return Err("target window is outside this tab-strip WebView".to_owned());
            }
            let target = state
                .runtime
                .launcher_context_for_window_id(target_window_id)?
                .1;
            (Some(target), None)
        }
        "reorder" => {
            let before_tab_id = action
                .get("beforeTabId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if let Some(before) = before_tab_id.as_deref()
                && state.runtime.live_tab_window_id(before).as_deref() != Some(window_id.as_str())
            {
                return Err("reorder target is outside this tab-strip WebView's display".to_owned());
            }
            (None, before_tab_id)
        }
        _ => return Err("runtime tab action is invalid".to_owned()),
    };
    crate::execute_tab_mutation(state, action_type, tab_id, target, before_tab_id)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))
        .and_then(crate::runtime_operation_receipt_result)
}

fn spawn_tab_mutation(
    app: &AppHandle,
    tab_id: &str,
    mutation_kind: &'static str,
    target: Option<EmbeddedLaunchTargetRecord>,
    before_tab_id: Option<String>,
) {
    let app = app.clone();
    let tab_id = tab_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::CoreState>() else {
            reveal_menu_error(&app, "runtime state is unavailable");
            return;
        };
        let result = crate::execute_tab_mutation(
            &state,
            mutation_kind,
            &tab_id,
            target,
            before_tab_id,
        )
        .await
        .and_then(|receipt| {
            crate::runtime_operation_receipt_result(receipt)
                .map_err(|message| crate::shell_error(&message, message.clone()))
        });
        if let Err(error) = result {
            crate::reveal_shell_error(&app, error);
        }
    });
}

fn spawn_tab_stop(app: &AppHandle, tab_id: &str) {
    let app = app.clone();
    let tab_id = tab_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::CoreState>() else {
            reveal_menu_error(&app, "runtime state is unavailable");
            return;
        };
        let result = crate::execute_tab_stop(&state, &tab_id)
            .await
            .map_err(|error| error.message)
            .and_then(crate::runtime_operation_receipt_result);
        if let Err(message) = result {
            reveal_menu_error(&app, message);
        }
    });
}
