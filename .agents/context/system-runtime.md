# System Runtime

WebView2 on Windows and WKWebView on macOS own persistent role stores. Shared Rust
state owns role launch/recovery, display reservations, and macro queues;
platform adapters own native handles and input APIs.

- Do not expose remote debugging or fall back to another browser runtime.
- Never hold the runtime-state mutex while creating, closing, or calling native
  WebViews; native callbacks may reacquire the same state.
- Do not synchronously call `AppCore` while applying an effect that AppCore is
  waiting to acknowledge.
- macOS window layout and mouse coordinates use `NSWindow.contentLayoutRect`.
- Windows WebView2 and macOS WKWebView implementations must expose the same
  semantic result even when their native mechanisms differ.
- AppKit/HTML commits complete post-intent window/tab records to
  `LiveWindowTabStore` without waiting for Core, SQLite, native readback, or a
  receipt. Never route a gesture through a compensating topology transaction.
- `LiveWindowRecord`/`LiveTabRecord` contain only durable topology demand.
  `NativeTabProjectionStore` owns surface bindings and follower progress, while
  `TabRuntimeStatusStore` owns loading/degraded phases. Never merge these locks
  or put runtime phase back into the live records.
- Native tab chrome is a complete revisioned projection. Windows must rehydrate
  it after every renderer instance reload; macOS must apply it idempotently and
  read back exact order and active state.
- Once destructive role isolation begins, unknown outcomes quarantine only the
  exact role owner. They never restore a closed tab/window or mutate live
  topology.
- Build/package/CI compile and test native targets without launching a machine-
  specific WebView.
