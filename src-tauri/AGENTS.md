# Tauri Shell Scope

- Apply semantic `rion-core` effects and own Tauri/native object handles here.
- Keep shared orchestration platform-neutral; isolate AppKit/WKWebView and
  Win32/WebView2 APIs in matching `#[cfg]` platform modules.
- Never hold runtime-state locks across native calls or synchronously re-enter
  `AppCore` while acknowledging an effect.
- Preserve the native C ABI and validate both target platforms for native changes.
