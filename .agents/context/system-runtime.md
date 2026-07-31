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
- Build/package/CI compile and test native targets without launching a machine-
  specific WebView.
