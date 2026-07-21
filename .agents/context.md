# Rion Studio AI Context

## Product Summary

Rion Studio is a desktop launcher and future automation host for isolated browser
roles. It manages isolated browser sessions for multiple roles and can launch
groups of roles into saved window layouts called launch workspaces. Roles open
their game URL directly; the app does not own or track authentication state.
External Chrome remains a compatibility fallback for accelerator or network
environments that reject the embedded view.

The project is an Electron + React + TypeScript app using Electron Vite,
Tailwind CSS v4, lucide-react, React Router, and Vitest.

## Architecture Map

- `src/main`: Electron main process. Owns app startup, BrowserWindow/BaseWindow
  creation, IPC handlers, role/workspace stores, embedded and external
  Chrome launch behavior, dock integration, and browser lifecycle.
- `src/preload`: Secure preload bridge. Exposes the typed `window.rionStudio`
  API through Electron `contextBridge`.
- `src/shared`: Main/preload/renderer contract. Contains IPC channel names,
  public API shape, shared domain types, role color helpers, and workspace
  layout helpers.
- `src/renderer`: React renderer app. Contains routes, hooks, UI components,
  feature modules, translations, styling, and browser-safe presentation logic.
- `tests`: Vitest unit tests for stores, IPC handlers, browser managers, Chrome
  profile import, dock menu behavior, and renderer utilities.

## Data Flow

The normal application flow is:

```text
renderer action
  -> window.rionStudio preload API
  -> IPC channel
  -> main process handler
  -> store/browser manager
  -> state broadcast
  -> renderer state refresh
```

Renderer code should stay browser-safe. It should not access Electron, Node file
system APIs or child processes directly. Add new capabilities by
extending the shared contract, preload bridge, and main IPC handlers together.

## Runtime Data

The Electron main process stores app metadata below `app.getPath("userData")`.
Role metadata is stored in `roles.json`, launch workspace metadata is stored
in `launch-workspaces.json`, and browser session data is stored per role at:

```text
roles/{roleId}/browser
```

Rion Studio stores browser session data only. It must not store login passwords.

Role and workspace stores validate and normalize inputs. They write JSON by
creating a temporary file and renaming it into place. Keep that pattern when
adding persisted data.

## Browser Sessions And Launch

Each role uses an isolated persistent Electron session partition and browser
directory. `browserSessionSource` selects either the normal embedded Electron
partition or an imported Chrome profile session. Role and workspace launches
always navigate directly to the role's launch URL; there is no login gate or
authentication status to settle.

Important runtime pieces:

- `BrowserManager` owns embedded `BaseWindow`/`WebContentsView` hosts, workspace
  layout, focus, popups, and lifecycle.
- `ChromeProfileSessionImporter` reads Chrome Cookies using macOS Keychain or
  Windows DPAPI and injects them into the imported Electron session. Copied
  Local Storage, IndexedDB, and Service Worker data remain in the role profile.
- `ChromeProfileImportManager` owns the consent, Chrome-close requirement,
  transaction journal, safe copy scope, and rollback behavior.
- `ExternalChromeManager` owns external Chrome compatibility sessions. Chrome
  discovery can be overridden with `RION_STUDIO_CHROME_PATH` or `CHROME_PATH`.
- `GraphicsDiagnosticsService` reports Electron GPU state and probes only the
  renderer and external Chrome sessions that are already running.

External Chrome uses loopback remote debugging for macro and CDN compatibility
control. Normal embedded launches do not add remote debugging flags.

## Roles And Launch Workspaces

Roles represent isolated browser sessions. A role includes a name, launch URL,
notes, launch preset, browser session source, optional cover image data URL,
optional dominant color, and timestamps. The browser session source is an
implementation choice (`embedded` or `chrome-profile`), not a sign-in state and
is not displayed as an authentication status in the UI.

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

Use Vitest for focused unit coverage. Prefer dependency injection and mocks, as
the existing tests do, instead of launching real Electron or real browsers unless
the requested change explicitly requires integration coverage.

Common test areas:

- Stores: input normalization, validation errors, sorting, deletion, migration of
  legacy stored data, and atomic write behavior.
- IPC: handler registration, state updates, error behavior, and interactions with
  stores/managers.
- Browser managers: launch/focus/stop behavior, Chrome profile session injection,
  browser user data lock retry behavior, rollback, and fallback paths.
- Renderer utilities: layout math, cover color helpers, status summaries, and
  workflow behavior that can be tested without Electron.

For runtime changes, run the narrowest relevant tests first, then broader checks
as needed:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

For documentation-only changes, use:

```bash
git diff --check -- AGENTS.md .agents/context.md
```
