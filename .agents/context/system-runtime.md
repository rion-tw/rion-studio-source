# System Runtime

WebView2 on Windows and WKWebView on macOS own persistent role stores. Shared Rust
state owns launch ordering, recovery, display reservations, tabs, and macro queues;
platform adapters own native handles and input APIs.

- Do not expose remote debugging or fall back to another browser runtime.
- Never hold the runtime-state mutex while creating, closing, or calling native
  WebViews; native callbacks may reacquire the same state.
- Do not synchronously call `AppCore` while applying an effect that AppCore is
  waiting to acknowledge.
- macOS window layout and mouse coordinates use `NSWindow.contentLayoutRect`.
- Windows WebView2 and macOS WKWebView implementations must expose the same
  semantic result even when their native mechanisms differ.
- Route move, hide, reorder, move-to-new-window, and stop through the shared
  per-tab mutation coordinator. Do not add a native-menu or renderer bypass.
- Native tab chrome is a complete revisioned projection. Windows must rehydrate
  it after every renderer instance reload; macOS must apply it idempotently and
  read back exact order and active state.
- Once destructive tab isolation begins, unknown outcomes stay quarantined and
  must not restore optimistic UI without authoritative projection evidence.
- Build/package/CI compile and test native targets without launching a machine-
  specific WebView.
