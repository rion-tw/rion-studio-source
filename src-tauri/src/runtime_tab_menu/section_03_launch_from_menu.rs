fn launch_from_menu(
    app: &AppHandle,
    state: &crate::CoreState,
    target: EmbeddedLaunchTargetRecord,
    source_id: &str,
    workspace: bool,
) {
    if let Err(message) = state.launch_intents.try_launch_source(
        source_id,
        workspace,
        RuntimeLaunchTargetPolicy::AuthenticatedLiveWindow(target.window_id),
        "native-tab-launcher",
    ) {
        reveal_menu_error(app, message);
    }
}

fn reveal_menu_error(app: &AppHandle, message: impl Into<String>) {
    crate::reveal_shell_error(
        app,
        rion_core::CoreErrorPayload {
            code: "TAURI_RUNTIME_TAB_MENU_FAILED".to_owned(),
            message: message.into(),
        },
    );
}

fn current_tab_muted(state: &crate::CoreState, tab_id: &str) -> Result<bool, String> {
    state.runtime.tab_audio_muted(tab_id)
}

struct Labels {
    hide: &'static str,
    loading: &'static str,
    move_to_window: &'static str,
    move_to_new_window: &'static str,
    mute: &'static str,
    no_roles: &'static str,
    no_workspaces: &'static str,
    reload: &'static str,
    roles: &'static str,
    save_window: &'static str,
    stop: &'static str,
    unmute: &'static str,
    workspaces: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            hide: "隱藏分頁（保持運行）",
            loading: "正在準備角色與工作區…",
            move_to_window: "移至遊戲視窗",
            move_to_new_window: "移至新遊戲視窗",
            mute: "將分頁靜音",
            no_roles: "沒有角色",
            no_workspaces: "沒有工作區",
            reload: "重新整理",
            roles: "角色",
            save_window: "儲存為新遊戲視窗",
            stop: "停止並關閉",
            unmute: "取消分頁靜音",
            workspaces: "工作區",
        },
        "zh-CN" => Labels {
            hide: "隐藏标签页（保持运行）",
            loading: "正在准备角色与工作区…",
            move_to_window: "移至游戏窗口",
            move_to_new_window: "移至新游戏窗口",
            mute: "将标签页静音",
            no_roles: "没有角色",
            no_workspaces: "没有工作区",
            reload: "重新加载",
            roles: "角色",
            save_window: "保存为新游戏窗口",
            stop: "停止并关闭",
            unmute: "取消标签页静音",
            workspaces: "工作区",
        },
        "ja" => Labels {
            hide: "タブを非表示（実行を継続）",
            loading: "ロールとワークスペースを準備中…",
            move_to_window: "ゲームウィンドウへ移動",
            move_to_new_window: "新しいゲームウィンドウへ移動",
            mute: "タブをミュート",
            no_roles: "ロールなし",
            no_workspaces: "ワークスペースなし",
            reload: "再読み込み",
            roles: "ロール",
            save_window: "新しいゲームウインドウとして保存",
            stop: "停止して閉じる",
            unmute: "タブのミュートを解除",
            workspaces: "ワークスペース",
        },
        _ => Labels {
            hide: "Hide tab (keeps running)",
            loading: "Preparing roles and workspaces…",
            move_to_window: "Move to Game Window",
            move_to_new_window: "Move to New Game Window",
            mute: "Mute Tab",
            no_roles: "No Roles",
            no_workspaces: "No Workspaces",
            reload: "Reload",
            roles: "Roles",
            save_window: "Save as New Game Window",
            stop: "Stop and Close",
            unmute: "Unmute Tab",
            workspaces: "Workspaces",
        },
    }
}
