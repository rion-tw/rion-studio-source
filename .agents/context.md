# Rion Studio AI Context

## Product Summary

Rion Studio is a desktop launcher and future automation host for isolated browser
roles. It manages isolated browser sessions for multiple roles and can launch
groups of roles into saved window layouts called launch workspaces. Roles open
their game URL directly; the app does not own or track authentication state.
The product browser runtime is the operating system WebView: WebView2 on Windows
and WKWebView on macOS 14+. CDN rewriting, external Chrome, and Chrome profile
import are retired capabilities and must not be reintroduced as fallbacks.

The project is transitioning from an Electron shell to a Tauri 2 + React desktop
app with a Rust production core. Electron remains only as a temporary legacy shell
during parity work and is scheduled for complete removal. Do not add new product
dependencies on Electron or an Electron runtime helper.

## Architecture Map

- `crates/rion-core`: Authoritative domain models, SQLite repositories,
  migrations, portable transactions, macro scheduling, runtime state, and logging.
- `crates/rion-platform`: Explicit macOS and Windows system-WebView probes,
  platform paths, system fonts, and native shell adapters.
- `crates/rion-node`: Temporary Node-API surface consumed by the legacy Electron
  main process; remove after Tauri parity.
- `src-tauri`: Target desktop shell. It links `rion-core` directly and owns native
  shell integration plus WebView2/WKWebView hosting.
- `src/main`: Temporary legacy Electron main-process adapters. Owns app startup,
  BrowserWindow/BaseWindow/WebContentsView and session objects, IPC handlers,
  dialogs, menus, tray/updater integration, and execution of Electron-only
  effects requested by the Rust core.
- `src/preload`: Secure preload bridge. Exposes the typed `window.rionStudio`
  API through Electron `contextBridge`.
- `src/shared`: Main/preload/renderer contract. Contains IPC channel names,
  public API shape, shared domain types, role color helpers, and workspace
  layout helpers.
- `src/renderer`: React renderer app. Contains routes, hooks, UI components,
  feature modules, translations, styling, and browser-safe presentation logic.
- `tests`: Vitest unit tests for typed core clients, IPC handlers, shell/runtime
  adapters, menu behavior, and renderer utilities.

## Data Flow

The target application flow is:

```text
renderer action
  -> window.rionStudio typed API
  -> Tauri command
  -> rion-core
  -> Tauri/native system-WebView effect adapter
  -> state broadcast
  -> renderer state refresh
```

The legacy Electron preload/main path mirrors this contract only during the
transition and must not gain new product behavior.

Renderer code should stay browser-safe. It should not access Tauri internals,
Electron, Node file system APIs, or child processes directly. Add new capabilities
through the shared contract and implement both the Tauri bridge and any still-
required transitional bridge together.

## Runtime Data

The Rust core stores structured app metadata below `app.getPath("userData")` in
`rion-studio.sqlite3`; high-volume logs use the separate `logs.sqlite3`
database. SQLite is the only production metadata write source. Legacy JSON is
read once during migration, copied into a timestamped read-only backup, and is
not mirrored after migration. Installing an older release cannot retain changes
made after SQLite migration; portable export is the supported transfer path.

Browser session data remains outside SQLite at:

```text
roles/{roleId}/browser
```

Rion Studio stores browser session data only. It must not store login passwords.

Rust validates and normalizes domain inputs and completes each mutation in one
SQLite transaction. TypeScript stores are stateless typed clients and must not
read or write production metadata files.

## Browser Sessions And Launch

Each role uses an isolated persistent system-WebView store: a WebView2 user-data
directory on Windows or a persistent WKWebsiteDataStore on macOS. Role and
workspace launches always navigate directly to the role's launch URL; there is no
external Chrome launch path or Chrome profile import path.

Important runtime pieces:

- Rust owns browser runtime role/workspace/tab state, launch transitions,
  operation ordering, display reservations, recovery, and macro action queues.
- Tauri and platform adapters own only native object handles and apply the
  semantic effects selected by Rust.
- System WebView sessions do not expose general remote debugging endpoints.
- Capability gaps are reported explicitly; they do not trigger an Electron or
  external-browser fallback.
- `pnpm run verify:system-only` is a mandatory CI and signed-candidate negative
  gate. It prevents removed CDN, External Chrome, Chrome Profile, helper, engine,
  and Electron object-effect contracts from returning outside legacy migrations.
- `CoreEffectAction` contains only current product effects. Do not reintroduce
  Electron window/view attachment, cookie/session, or generic debugger effects;
  browser automation belongs in the typed `BrowserAction` union.
- Trusted/background input is fail-closed. macOS builds promote it to supported
  only when the native and packaged Tauri `isTrusted`/1000-cycle harness supplies
  an attested OS major at compile time; the runtime major must match. The same
  packaged harness exercises 1/3/6/9 pixel layouts, isolated storage, audio mute,
  same-store popup, byte-exact upload/download, actual web-content process
  termination and same-engine recovery, plus 100 create/destroy cycles. On macOS
  upload attestation must observe WKWebView's native open-panel delegate. The
  Windows automated path uses WebView2 CDP only to inject the diagnostic file and
  does not replace a manual native chooser UI candidate smoke. Windows CI uses the same
  Tauri/WebView2 harness and only injects its compile-time attestation after it
  passes; local macOS results are not evidence that the Windows gate passed.
- macOS layout and mouse coordinates must use `NSWindow.contentLayoutRect`, not
  full-size content-view bounds. The titlebar inset otherwise clips role surfaces
  and offsets trusted mouse events even when the normalized layout math is right.
- Save a role's intended URL before entering native navigation. A terminated
  WKWebView can return a nil URL and WRY currently unwraps that value; crash
  recovery must use Rust-owned state instead of querying the dead surface.
- Display IDs cross the renderer JSON boundary and must stay within JavaScript's
  `Number.MAX_SAFE_INTEGER`. Hashing a monitor into the full positive `i64` range
  can make an otherwise real display fail core launch-target validation.
- Runtime restore is covered by a three-process packaged gate: seed a live role
  on a synthetic display, move it through the production display-removal effect,
  and bypass clean shutdown. Recover it through the production restore operation
  from an intentionally unavailable saved display while preserving its role store,
  exit normally, then verify the next process is auto-restore eligible without an
  unclean-recovery warning. Async shell commands
  that fall back to synchronous core dispatch must use `spawn_blocking`; calling
  a blocking effect plan from Tokio panics.
- Packaged portable/diagnostics coverage must include successful export/preview,
  corrupt input rejection, and a post-temporary-write atomic replacement failure.
  The failure gate must preserve the existing destination/domain collections and
  leave no portable, diagnostics, or log-export temporary files.
- Proxy is creation-time session configuration. The macOS automatic packaged gate
  inspects the actual `WKWebsiteDataStore.proxyConfigurations`; end-to-end macOS
  proxy transport remains a candidate smoke with a mature proxy. The Windows gate
  additionally requires a loopback request to traverse WebView2's configured proxy.
- Never hold `SystemRuntimeExecutor`'s runtime-state mutex while creating,
  closing, or calling into Tauri/native WebViews. Main-thread window callbacks
  also acquire this state; holding it across a native callback can deadlock a
  stop-then-launch sequence.
- macOS has no public per-WKWebView audio mute API that preserves playback. The
  runtime dynamically checks WebKit's `_setPageMuted:` SPI before use and fails
  closed when absent. `setAllMediaPlaybackSuspended:` is not an equivalent mute
  because it pauses media and prevents the page from resuming it.

## Roles And Launch Workspaces

Roles represent isolated system-WebView sessions. A role includes a name, launch
URL, notes, optional cover image data URL, optional dominant color, and timestamps.
Legacy browser engine, launch mode, and session-source values are accepted only
for migration and normalize to the system-managed store.

Launch workspaces group roles and assign each one to a normalized window
rectangle. Supported layout templates are:

- `single`
- `two_columns`
- `three_columns`
- `main_left_stack_right`
- `main_right_stack_left`
- `main_center_side_stacks`
- `quad`
- `four_columns`
- `six_grid`
- `eight_grid`
- `nine_grid`

`two_columns` is the default workspace template. A launch workspace can contain
at most nine slots. A role can appear only once in the same launch workspace.

## Renderer Conventions

The renderer is a compact desktop app, not a marketing site. Favor dense,
scannable UI with stable dimensions, existing glass surfaces, and restrained
controls.

Use these local patterns:

- Route-level features under `src/renderer/src/features`.
- Workflow hooks under `src/renderer/src/hooks`.
- UI primitives under `src/renderer/src/components/ui`.
- Cross-feature visual primitives such as `Surface`, `NavItem`, `SegmentedControl`,
  and `Field` from `components/ui/patterns.tsx`.
- Shared text through `src/renderer/src/i18n.ts`; add both English and Traditional
  Chinese translations for user-facing strings.

Prefer lucide-react icons for buttons, menus, navigation, and empty states. Keep
text fitting within controls and cards at the app minimum window size of 960x640.

## Testing Guidance

Use Rust unit/property/integration tests for core behavior and Vitest for IPC,
preload, Electron effects, and renderer behavior. Prefer dependency injection
and deterministic fixtures; release validation additionally uses packaged apps
and a copy of real userData.

Common test areas:

- Rust domain/repository: input normalization, validation, transaction rollback,
  schema upgrade, legacy migration, portable crash recovery, macro
  ordering/cancellation/held-key release, and system runtime recovery.
- IPC: handler registration, state updates, error behavior, and interactions with
  stores/managers.
- Browser effect adapters: launch/focus/stop effects, browser user data lock retry
  behavior, rollback, native crash recovery, and macOS/Windows capability paths.
- Renderer utilities: layout math, cover color helpers, status summaries, and
  workflow behavior that can be tested without Electron.

For runtime changes, run the narrowest relevant tests first, then broader checks
as needed:

```bash
pnpm run typecheck
pnpm run lint:rust
pnpm run test:rust
pnpm run verify:rust
pnpm run test
pnpm run lint
pnpm run build
```

For documentation-only changes, use:

```bash
git diff --check -- AGENTS.md .agents/context.md
```
