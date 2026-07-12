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

## Contributing

Developer notes, local commands, runtime data details, and packaging notes live in
[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).
