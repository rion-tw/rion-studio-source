# System Runtime

WebView2 on Windows and WKWebView on macOS own persistent role stores.
`RuntimeKernel` owns logical window/tab topology, role leases, logical surface
lifecycle, operation terminality, and revisioned desired state. Tauri owns
native handles and input APIs; platform adapters translate native events and
apply complete desired projections.

- Do not expose remote debugging or fall back to another browser runtime.
- Never hold the runtime-state mutex while creating, closing, or calling native
  WebViews; native callbacks may reacquire the same state.
- Do not synchronously call `AppCore` while applying an effect that AppCore is
  waiting to acknowledge.
- macOS window layout and mouse coordinates use `NSWindow.contentLayoutRect`.
- Windows WebView2 and macOS WKWebView implementations must expose the same
  semantic result even when their native mechanisms differ.
- AppKit/HTML gestures submit `RuntimeIntent`; a transient drag overlay may be
  shown while held, but committed membership/order/selection comes only from a
  `RuntimeCommit`. `LiveWindowTabStore` may expose compatibility snapshots but
  cannot mutate outside Kernel transactions.
- `NativeResourceRegistry` contains only exact non-serializable handles.
  `NativeTabProjectionStore` and `TabRuntimeStatusStore` remain follower caches;
  neither may decide topology, ownership, or relaunch eligibility.
- Native tab chrome is a complete revisioned projection. Windows must rehydrate
  it after every renderer instance reload; macOS must apply it idempotently and
  read back exact order and active state.
- Once destructive role isolation begins, unknown outcomes quarantine only the
  exact role owner. They never restore a closed tab/window or mutate live
  topology.
- Exact native release terminalizes the matching Kernel close operation, Core
  macro stopping/quiesced state, and the native input lane while preserving its
  monotonic epoch. No released role may remain as an orphan input fence.
- Build/package/CI compile and test native targets without launching a machine-
  specific WebView.
