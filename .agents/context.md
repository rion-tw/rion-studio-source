# Rion Studio AI Context

## Product Summary

Rion Studio is a desktop launcher and future automation host for isolated browser
roles. It manages isolated browser sessions for multiple roles, helps users
log in through system Chrome when automation-controlled browsers are blocked, and
can launch groups of roles into saved window layouts called launch workspaces.

The project is an Electron + React + TypeScript app using Electron Vite,
Playwright, Tailwind CSS v4, lucide-react, React Router, and Vitest.

## Architecture Map

- `src/main`: Electron main process. Owns app startup, BrowserWindow creation,
  IPC handlers, role/workspace stores, auth flow, system Chrome login, dock
  integration, Playwright launch behavior, and browser lifecycle.
- `src/preload`: Secure preload bridge. Exposes the typed `window.rionStudio`
  API through Electron `contextBridge`.
- `src/shared`: Main/preload/renderer contract. Contains IPC channel names,
  public API shape, shared domain types, role color helpers, and workspace
  layout helpers.
- `src/renderer`: React renderer app. Contains routes, hooks, UI components,
  feature modules, translations, styling, and browser-safe presentation logic.
- `tests`: Vitest unit tests for stores, IPC handlers, browser/auth managers,
  system Chrome launcher behavior, dock menu behavior, and renderer utilities.

## Data Flow

The normal application flow is:

```text
renderer action
  -> window.rionStudio preload API
  -> IPC channel
  -> main process handler
  -> store/auth/browser manager
  -> status or auth-status broadcast
  -> renderer state refresh
```

Renderer code should stay browser-safe. It should not access Electron, Node file
system APIs, Playwright, or child processes directly. Add new capabilities by
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

## Login And Browser Launch

Google can reject sign-in from automation-controlled browsers. The login flow
opens the same role directory in system Chrome, asks the user to complete
login, waits for Chrome to close and release the browser user data lock, checks the saved
session, and then launches the normal Playwright-controlled Chromium window when
authentication is confirmed.

Important runtime pieces:

- `AuthManager` coordinates login state transitions and session checks.
- `SystemChromeLauncher` opens system Chrome with the role directory used by
  the app. Chrome discovery can be overridden with `RION_STUDIO_CHROME_PATH` or
  `CHROME_PATH`.
- `BrowserUserDataLockWatcher` waits for Chrome to release the role browser directory before
  Playwright reuses it.
- `AuthSessionChecker`, `authSessionClassification`, and `loginEvidence` classify
  whether a saved login session exists.
- `BrowserManager` launches Playwright persistent contexts, verifies auth after
  page load, tracks running sessions, focuses existing sessions, applies launch
  workspace bounds, and resets auth state when persisted login evidence is gone.
- `MacHiddenBrowserHost` prepares a best-effort hidden macOS Chromium app bundle.
  If that fails, browser launch falls back to visible bundled Chromium.

Normal Playwright launches should stay app-mode and should not add remote
debugging flags. The current build config bundles Playwright Chromium by setting
`PLAYWRIGHT_BROWSERS_PATH=0` during install and by unpacking
`node_modules/playwright-core/.local-browsers/**` for packaged builds.

## Roles And Launch Workspaces

Roles represent isolated browser sessions. A role includes a name, launch
URL, window size, notes, launch preset, auth state, optional cover
image data URL, optional dominant color, and timestamps.

Launch workspaces group roles and assign each one to a normalized window
rectangle. Supported layout templates are:

- `single`
- `two_columns`
- `three_columns`
- `main_left_stack_right`
- `main_right_stack_left`
- `quad`
- `four_columns`

`two_columns` is the default workspace template. A launch workspace can contain
at most four slots. A role can appear only once in the same launch workspace.

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
- Auth and browser managers: state transitions, launch/focus/stop behavior,
  persisted login evidence, browser user data lock retry behavior, and fallback paths.
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
