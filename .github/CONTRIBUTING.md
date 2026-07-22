# Contributing

## Developer Notes

### Stack

- Electron + React + TypeScript
- Electron Vite for main/preload/renderer builds
- Rust Node-API core for SQLite, macros, platform work and external Chrome CDP
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

### Browser Session Architecture

Roles always launch their configured game URL directly. A role uses either its
isolated embedded Electron partition or an imported Chrome profile session; the
`browserSessionSource` field selects that storage backend and is not an auth
status. Chrome profile import requires Chrome to be closed, copies only the
approved browser storage, decrypts and injects cookies through platform APIs, and
rolls back role and profile data if injection fails.

External Chrome remains available only as a game compatibility mode. Normal
embedded launches do not add remote debugging flags.

### Packaging Notes

Embedded roles use Electron's packaged Chromium. External compatibility sessions
control the user's installed Google Chrome with isolated per-role browser profiles.

Windows external-Chrome process, path and DWM visible-frame operations are part of
the `rion-platform` Rust crate and the required `rion-core.node` x64 addon. The old
standalone C++ frame helper is no longer built or packaged. Install the pinned Rust
toolchain and the Visual Studio 2022 MSVC/Windows SDK components required by the
`x86_64-pc-windows-msvc` target. To run the Rust checks directly on Windows:

```bash
pnpm run lint:rust
pnpm run test:rust
pnpm run build:rust
pnpm run verify:rust
```

The generated addon lives under `build/native/win32-x64/rion-core.node` and is
packaged under `resources/native`. Release CI loads it from the unpacked application
before accepting a Windows artifact.

macOS runtime game windows use an Objective-C++ Node-API addon to host the tab
strip in `NSTitlebarAccessoryViewController`. `pnpm run dev`, `package`, and
`dist` build the addon automatically on macOS. To run the native build and
verification directly:

```bash
pnpm run build:native:macos
pnpm run test:native:macos
```

The development addon is written to `build/native/darwin-${arch}` and the
release workflow packages the arm64 build at
`Contents/Resources/native/rion-runtime-tabs.node`. The addon uses Node-API
protocol version 1 and targets macOS 12 or later. Release CI verifies its Mach-O
architecture, exported protocol, native controller tests, and nested signature.

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

For each topology, launch a workspace in embedded mode, external Chrome mode,
and automatic fallback mode. The workspace must remain on the selected display,
fit inside that display's work area without covering the taskbar, and keep the
same display reserved through fallback. Also verify simultaneous launches,
all-displays-occupied cancellation, and display disconnect/reconnect behavior.
These native checks supplement the platform-aware unit tests and the existing
`windows-latest` x64 NSIS build job.
