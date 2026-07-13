# Contributing

## Developer Notes

### Stack

- Electron + React + TypeScript
- Electron Vite for main/preload/renderer builds
- Playwright Core controlling system Chrome for isolated browser windows
- Vitest for unit tests

### Commands

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run package
```

Rion Studio requires Google Chrome on the user's machine. Set
`RION_STUDIO_CHROME_PATH` or `CHROME_PATH` when Chrome is installed in a
non-standard location.

### Runtime Data

The Electron main process stores role metadata under `app.getPath("userData")`.
Each role owns an isolated browser directory at:

```text
roles/{roleId}/browser
```

The app stores browser session data only. It does not store login passwords.

### Login Architecture

Google can block sign-in from browsers that are controlled by automation. Use the
`Login` button on a role to open the same role directory in system Chrome
without Playwright control or remote debugging flags. After signing in, close the
temporary Chrome window manually; Rion Studio then checks the session and
automatically launches the normal automation-ready Chrome window when login is
confirmed.

Roles that have a confirmed login show `Launch` as the primary card action. The
card hides `Login` until the session check fails or the role is explicitly
re-logged from the edit panel.

### Packaging Notes

Packaged builds do not include Chromium. Playwright controls the user's installed
Google Chrome with isolated per-role browser profiles.

macOS packaging uses a complete ad-hoc signature with hardened runtime. The main
app and helper apps must include `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.disable-library-validation` so ad-hoc hardened runtime
builds can load Electron Framework after the user approves Gatekeeper. Release
validation requires the app bundle and its nested code to pass strict `codesign`
verification and entitlement checks. `build/signMacAdHoc.mjs` is wired through
electron-builder's `mac.sign` option because the current electron-builder
version does not treat `identity: "-"` as an ad-hoc signing identity by itself.
A paid Developer ID Application certificate and Apple notarization would still
be required for warning-free Gatekeeper launches.

Ad-hoc-signed macOS builds use a manual update flow. The app checks GitHub
Releases, opens the matching DMG when an update is available, and guides users to
drag the app to Applications. The DMG includes `Install Help.txt` with the
Privacy & Security approval flow and a scoped quarantine-removal fallback for
trusted downloads. Set `RION_STUDIO_RELEASE_REPOSITORY=owner/repo` at runtime if
release assets are hosted outside the default repository.
