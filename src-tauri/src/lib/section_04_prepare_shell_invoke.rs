async fn prepare_shell_invoke(
    app: &AppHandle,
    startup: &StartupWindowState,
    operation: &str,
    args: &[Value],
) -> Result<bool, CoreErrorPayload> {
    if operation == "waitForNativeStartup" {
        startup.wait_for_native_startup().await?;
        return Ok(true);
    }
    if operation == "rendererStartupFailed" {
        let message = string_argument(args, 0, "Renderer startup failure")?;
        show_startup_failure_message(app, message);
        return Ok(true);
    }
    startup.wait_for_native_startup().await?;
    Ok(false)
}
