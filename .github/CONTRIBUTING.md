# Contributing

## Developer Notes

### Stack

- Tauri 2 + React + TypeScript
- Vite for the renderer build
- Rust core for SQLite, macros, platform work, WebView2 and WKWebView
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

### Runtime Data

The Rust core stores role metadata under the Tauri application data directory.
Each role owns an isolated browser directory at:

```text
roles/{roleId}/browser
```

The app stores browser session data only. It does not store login passwords.

### Browser Session Architecture

Roles always launch their configured game URL directly in an isolated System
WebView store: WebView2 on Windows and WKWebView on macOS. Browser data is never
read from or written to an installed third-party browser profile.

### Packaging Notes

Game roles use the operating system WebView runtime. Compatibility checks use a
short-lived isolated System WebView surface.

Windows platform operations are part of the `rion-platform` Rust crate. Install the pinned Rust
toolchain and the Visual Studio 2022 MSVC/Windows SDK components required by the
`x86_64-pc-windows-msvc` target. To run the Rust checks directly on Windows:

```bash
pnpm run lint:rust
pnpm run test:rust
pnpm run build:rust:release
pnpm run verify:rust
```

`pnpm run build:tauri` links the Rust core directly into the application. Release
CI must build on both `macos-latest` and `windows-latest`, verify the resulting
Tauri bundle, and run the platform-aware Rust and renderer tests. macOS releases
target 14+ and require Developer ID signing, hardened runtime, notarization and
stapling. Windows releases require Authenticode signing and a WebView2 runtime
presence check.

Ad-hoc-signed macOS builds use a manual update flow. The app checks GitHub
Releases, opens `releases/latest/download/Rion.Studio-mac.dmg` when an update is
available, and guides users to drag the app to Applications. The DMG includes
`Install Help.txt` with the Privacy & Security approval flow and a scoped
quarantine-removal fallback for trusted downloads. Keep the release asset names
`Rion.Studio-mac.dmg` and `Rion.Studio-win.exe` stable because the in-app update
flow and README download links depend on them. Set
`RION_STUDIO_RELEASE_REPOSITORY=owner/repo` at runtime if release assets are
hosted outside the default repository with the same asset names.

### Windows Multi-Display Release Check

Before releasing workspace display changes, smoke-test the x64 NSIS build on both
Windows 10 and Windows 11. Use at least two displays with mixed 100% and
125%/150% scaling, then repeat with the secondary display positioned to the left
or above the primary display. Verify bottom and side taskbar layouts when the
hardware permits.

For each topology, launch a System WebView workspace. The workspace must remain
on the selected display, fit inside that display's work area without covering the
taskbar, and keep the same display reserved. Also verify simultaneous launches,
all-displays-occupied cancellation, and display disconnect/reconnect behavior.
These native checks supplement the platform-aware unit tests and the existing
`windows-latest` x64 NSIS build job.
