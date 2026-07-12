# Rion Studio

![Rion Studio banner showing isolated roles, browser workspaces, and assistive controls](.github/assets/rion-studio-github-preview-1280x640.jpg)

**A cross-platform login launcher and assistive workspace for web games.**

Rion Studio helps web game players keep every role, login session, and browser
layout organized in one desktop app. Create dedicated browser roles, sign in with
less friction, launch familiar window arrangements, and reduce repetitive manual
actions while you stay actively in control of play.

## Download

- [Download for macOS](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-mac.dmg)
- [Download for Windows](https://github.com/rion-tw/rion-studio/releases/latest/download/Rion.Studio-win.exe)

These links point to the installer assets attached to the latest GitHub release.
If a download returns 404, open the [latest release](https://github.com/rion-tw/rion-studio/releases/latest)
and confirm the release has finished uploading assets.

### macOS Installation

The macOS build uses an ad-hoc signature rather than a paid Developer ID. Open the DMG,
drag Rion Studio to Applications, and try to open it once. If macOS blocks it, open
**System Settings > Privacy & Security**, then click **Open Anyway** for Rion Studio.

If **Open Anyway** is unavailable, use this one-time fallback in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Rion Studio.app"
```

This fallback removes quarantine only from Rion Studio. It does not disable Gatekeeper
system-wide.

## Why Rion Studio

Web games often make players juggle multiple accounts, browser windows, login
states, and repeated routine actions. Rion Studio turns that scattered workflow
into a focused control desk:

- Keep each game role in its own isolated browser session.
- Return to saved window layouts instead of rebuilding your setup every time.
- Complete sensitive sign-in flows in system Chrome when needed.
- Run small assistive macros for keys, clicks, delays, and loops under your
  supervision.
- Keep passwords out of the app. Rion Studio stores browser session data only.

## Features

### Isolated Role Browsers

Create a role for each game account, character, or task. Every role owns its own
browser directory, so sessions stay separate and can be launched independently.

### Smoother Login Flow

Some services block sign-in inside automation-controlled browsers. Rion Studio
can open the same role directory in system Chrome for login, then verify the
saved session before launching the normal bundled browser.

### Launch Workspaces

Group roles into a launch workspace and assign each one a window layout. Start a
single role or launch a full multi-role setup into the arrangement you already
prepared.

### Human-Supervised Macros

Build compact assistive macros from key presses, clicks, delays, and repeat
intervals. Macros are designed to reduce repetitive manual input while you remain
present, supervising, and operating the game.

## Legal And Fair Use Notice

Rion Studio is a general-purpose launcher and assistive desktop utility. You are
responsible for how you use it.

- Always follow the terms of service, game rules, automation policies, community
  guidelines, and account policies of every target game or platform.
- Do not use Rion Studio to bypass anti-cheat systems, evade detection, exploit
  games, disrupt other players, or run unattended botting.
- Use this tool only to improve your own gameplay experience while you remain
  actively supervising and operating the session.
- Third-party tools can carry account, enforcement, and data risks. Those risks
  remain your responsibility.

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
without Playwright control or remote debugging flags. After signing in, close the temporary
Chrome window manually; Rion Studio then checks the session and automatically launches the
normal automation-ready Chrome window when login is confirmed.

Roles that have a confirmed login show `Launch` as the primary card action. The card
hides `Login` until the session check fails or the role is explicitly re-logged
from the edit panel.

### Packaging Notes

Packaged builds do not include Chromium. Playwright controls the user's installed
Google Chrome with isolated per-role browser profiles.

macOS packaging uses a complete ad-hoc signature without hardened runtime. Release validation
requires the app bundle and its nested code to pass strict `codesign` verification. A paid
Developer ID Application certificate and Apple notarization would still be required for
warning-free Gatekeeper launches.

Ad-hoc-signed macOS builds use a manual update flow. The app checks GitHub Releases, opens the
matching DMG when an update is available, and guides users to drag the app to Applications.
The DMG includes `Install Help.txt` with the Privacy & Security approval flow and a scoped
quarantine-removal fallback. Set
`RION_STUDIO_RELEASE_REPOSITORY=owner/repo` at
runtime if release assets are hosted outside the default repository.
