# System Runtime

The stable v22 runtime uses WebView2 on Windows and WKWebView on macOS. The
target v23 runtime uses the Electron-bundled Chromium and per-role
`session.fromPath` stores on both platforms. macOS retains the current AppKit
game-window/tab presentation, gestures, and trusted-input adapter while replacing
WKWebView with Chromium; Windows uses the Electron/Chromium native host.
The v22 System WebView probe is available only through the explicit
`system-webview-probe` Cargo feature: Tauri enables it, while `rion-node` keeps
default features disabled so the Chromium addon does not link WebKit/WebView2.
`RuntimeKernel` owns logical window/tab topology, role leases, logical surface
lifecycle, operation terminality, and revisioned desired state. Platform adapters
own only their native handles and input APIs, translate native events, and apply
complete desired projections.

`docs/system-webview-runtime-contract.md` is the versioned contract index. Load
only the contract part it identifies for the current runtime task.

- Do not expose remote debugging or fall back to another browser runtime.
- Treat the per-role WebView2 profile, WKWebsiteDataStore, or Chromium session as
  the only ordinary LocalStorage writer. Enumeration or replay is allowed only
  inside the authenticated, revision-fenced v22-to-v23 migration or the
  user-consented Chrome Profile import; ordinary Runtime must not checkpoint,
  forward, clear, or synchronize page LocalStorage.
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
- Transition code never exposes a user engine selector. A role remains on v22
  only until its encrypted, readback-verified Chromium store migration commits;
  final v23 removal is gated by both-platform E2E parity.
- Cookie set/get/flush promises may acknowledge cookie-only Chromium migration.
  DOM Storage flush has no completion receipt, so LocalStorage-bearing migration
  stays non-success until a fresh process reopens the exact role path and reads
  back the canonical inventory. Timers and same-process reopen are not evidence.
- The macOS adapter may change its embedded page engine, but it must not replace
  AppKit-native runtime chrome with renderer HTML or silently route through the
  Windows BrowserWindow host.
