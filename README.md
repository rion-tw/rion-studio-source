# Rion Studio

Cross-platform Electron launcher for isolated browser roles and future automation.

## Stack

- Electron + React + TypeScript
- Electron Vite for main/preload/renderer builds
- Playwright bundled Chromium for isolated browser windows
- Vitest for unit tests

## Commands

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run package
```

`pnpm install` runs `scripts/install-playwright-browsers.mjs`, which installs Chromium with
`PLAYWRIGHT_BROWSERS_PATH=0` so packaged builds can bundle the browser.

## Runtime Data

The Electron main process stores role metadata under `app.getPath("userData")`.
Each role owns an isolated browser directory at:

```text
roles/{roleId}/browser
```

The app stores browser session data only. It does not store login passwords.

## Login

Google can block sign-in from browsers that are controlled by automation. Use the
`Login` button on a role to open the same role directory in system Chrome
without Playwright control or remote debugging flags. After signing in, close the temporary
Chrome window manually; Rion Studio then checks the session and automatically launches the
normal automation-ready Chromium window when login is confirmed.

Roles that have a confirmed login show `Launch` as the primary card action. The card
hides `Login` until the session check fails or the role is explicitly re-logged
from the edit panel.

## Packaging Notes

Playwright browser binaries are unpacked with Electron Builder via:

```json
"asarUnpack": ["node_modules/playwright-core/.local-browsers/**"]
```

macOS packaging works locally, but signing is skipped until a valid Developer ID Application
certificate is configured.

Unsigned macOS builds use a manual update flow. The app checks GitHub Releases, opens the
matching DMG download when an update is available, and guides users to open the installer
and drag Rion Studio to Applications. Set `RION_STUDIO_RELEASE_REPOSITORY=owner/repo` at
runtime if release assets are hosted outside the default repository.
