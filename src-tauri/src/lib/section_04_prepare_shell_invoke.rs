async fn prepare_shell_invoke(
    app: &AppHandle,
    startup: &StartupWindowState,
    operation: &str,
    args: &[Value],
) -> Result<Option<Value>, CoreErrorPayload> {
    if operation == "waitForNativeStartup" {
        let windows_mica_enabled = startup.wait_for_native_startup().await?;
        return Ok(Some(serde_json::json!({ "windowsMicaEnabled": windows_mica_enabled })));
    }
    if operation == "rendererStartupFailed" {
        let message = string_argument(args, 0, "Renderer startup failure")?;
        show_startup_failure_message(app, message);
        return Ok(Some(Value::Null));
    }
    startup.wait_for_native_startup().await?;
    Ok(None)
}
