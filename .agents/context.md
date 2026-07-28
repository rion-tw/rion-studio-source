# Rion Studio AI Context

## Product Summary

Rion Studio is a desktop launcher and future automation host for isolated browser
roles. It manages isolated browser sessions for multiple roles and can launch
groups of roles into saved window layouts called launch workspaces. Roles open
their game URL directly; the app does not own or track authentication state.
The product browser runtime is the operating system WebView: WebView2 on Windows
and WKWebView on macOS 14+. CDN rewriting, external Chrome, and Chrome profiles as
a browser runtime are retired capabilities and must not be reintroduced as
fallbacks. A user-consented, one-time Chrome transfer is supported only for
launch-URL cookies and the selected game's exact launch-origin LocalStorage.

The product is a Tauri 2 + React desktop app with a Rust production core. Tauri is
the only desktop shell. Legacy runtime values remain readable only during the
documented upgrade window and must never select a retired runtime.

## Architecture Map

- `crates/rion-core`: Authoritative domain models, SQLite repositories,
  migrations, portable transactions, macro scheduling, runtime state, and logging.
- `crates/rion-platform`: Explicit macOS and Windows system-WebView probes,
  platform paths, system fonts, and native shell adapters.
- `src-tauri`: Desktop shell. It links `rion-core` directly and owns native
  shell integration plus WebView2/WKWebView hosting.
- `src/shared`: Rust/Tauri/renderer contract. Contains the public API shape,
  generated domain types, role color helpers, and workspace
  layout helpers.
- `src/renderer`: React renderer app. Contains routes, hooks, UI components,
  feature modules, translations, styling, and browser-safe presentation logic.
- `tests`: Vitest unit tests for typed contracts, release tooling, architecture
  boundaries, and renderer utilities.

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

Renderer code should stay browser-safe. It should not access Tauri internals,
Node file system APIs, or child processes directly. Add new capabilities through
the shared contract, Rust core, Tauri shell, and typed renderer bridge together.

## Runtime Data

The Rust core stores structured app metadata below the shared `Rion Studio`
application-data directory in `rion-studio.sqlite3`; high-volume logs use `logs.sqlite3`
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
external Chrome launch path or Chrome profile runtime path. The data-management
import wizard copies only the approved Chrome source files into private staging,
decrypts and filters the bounded session payload in native/core code, applies it
through a hidden same-store System WebView, verifies it, and removes staging.

Important runtime pieces:

- Rust owns browser runtime role/workspace/tab state, launch transitions,
  operation ordering, display reservations, recovery, and macro action queues.
- Tauri and platform adapters own only native object handles and apply the
  semantic effects selected by Rust.
- System WebView sessions do not expose general remote debugging endpoints.
- Capability gaps are reported explicitly; they do not trigger another runtime fallback.
- `pnpm run verify:system-only` is a mandatory CI and signed-candidate negative
  gate. It prevents removed CDN, External Chrome, profile-as-runtime, helper,
  engine, and retired object-effect contracts from returning. It also requires
  the one-time transfer to remain encrypted and transaction-scoped.
- `CoreEffectAction` contains only current product effects. The dedicated
  `LegacySessionRestore` and `ChromeProfileImportSnapshot/Apply/Rollback/Commit`
  family may carry transaction, role, URL, and store identifiers only. Do not
  reintroduce shell window/view attachment, cookie values, LocalStorage values,
  generic cookie/session, or generic debugger effects; browser automation belongs
  in the typed `BrowserAction` union.
- Chrome transfer staging contains only `Local State`, Cookies plus WAL/SHM, and
  `Local Storage/leveldb`. Passwords, autofill, history, bookmarks, Session
  Storage, IndexedDB, Service Workers, Preferences, extensions, other origins,
  and source modifications are out of scope.
- Trusted/background macro input is classified from the supported platform and
  installed System WebView runtime, not from a cached or compile-time flag.
  macOS 14+ dispatches native events through the app-owned WKWebView responder
  chain; Windows dispatches per-WebView input through WebView2. Neither path needs
  Accessibility, Input Monitoring, or another user system permission. Deterministic
  Rust tests cover input ordering, cancellation, held-key release, and macro stress.
  Build, package, and CI do not launch the application to probe the runner's WebView;
  environment-specific failures are bounded and reported by the production runtime.
  On macOS the 25 ms input settle applies only when dispatch hands off from one role
  WebView to another, never to every event for the same role.
- macOS layout and mouse coordinates must use `NSWindow.contentLayoutRect`, not
  full-size content-view bounds. The titlebar inset otherwise clips role surfaces
  and offsets trusted mouse events even when the normalized layout math is right.
- Save a role's intended URL before entering native navigation. A terminated
  WKWebView can return a nil URL and WRY currently unwraps that value; crash
  recovery must use Rust-owned state instead of querying the dead surface.
- Display IDs cross the renderer JSON boundary and must stay within JavaScript's
  `Number.MAX_SAFE_INTEGER`. Hashing a monitor into the full positive `i64` range
  can make an otherwise real display fail core launch-target validation.
- Runtime restore, unavailable-display fallback, role-store preservation, and clean
  shutdown eligibility are covered by deterministic core and shell tests. Async shell commands
  that fall back to synchronous core dispatch must use `spawn_blocking`; calling
  a blocking effect plan from Tokio panics.
- Portable/diagnostics tests must include successful export/preview,
  corrupt input rejection, and a post-temporary-write atomic replacement failure.
  Failure handling must preserve the existing destination/domain collections and
  leave no portable, diagnostics, or log-export temporary files.
- System WebViews inherit the operating system's network and proxy settings. Rion
  Studio does not expose, persist, inspect, or inject a custom proxy configuration.
- Never hold `SystemRuntimeExecutor`'s runtime-state mutex while creating,
  closing, or calling into Tauri/native WebViews. Main-thread window callbacks
  also acquire this state; holding it across a native callback can deadlock a
  stop-then-launch sequence.
- Do not synchronously call back into `AppCore` while applying a core effect.
  The originating operation is waiting for that effect result and may hold an
  operation sequence guard. A shell projection that needs core metadata must be
  refreshed after `dispatch_core_effect_results` acknowledges the effect.
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

Use Rust unit/property/integration tests for core behavior and Vitest for typed
bridge, architecture, release tooling, and renderer behavior. Prefer dependency injection
and deterministic fixtures; release validation builds platform packages and verifies
their artifacts without launching the application.

Common test areas:

- Rust domain/repository: input normalization, validation, transaction rollback,
  schema upgrade, legacy migration, portable crash recovery, macro
  ordering/cancellation/held-key release, and system runtime recovery.
- Typed bridge: command routing, state updates, error behavior, and Tauri shell effects.
- Browser effect adapters: launch/focus/stop effects, browser user data lock retry
  behavior, rollback, native crash recovery, and macOS/Windows capability paths.
- Renderer utilities: layout math, cover color helpers, status summaries, and
  workflow behavior that can be tested without a native UI process.

For runtime changes, run the narrowest relevant tests first, then broader checks
as needed:

```bash
pnpm run typecheck
pnpm run lint:rust
pnpm run test:rust
pnpm run test
pnpm run lint
pnpm run build
```

For documentation-only changes, use:

```bash
git diff --check -- AGENTS.md .agents/context.md
```
