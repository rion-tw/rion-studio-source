# Contributing

## Developer Notes

### Stack

- React + TypeScript renderer
- Rust Core with a narrow Node-API boundary
- Electron/Chromium v23 target shell, with AppKit retained for macOS native game windows
- Tauri 2 v22 compatibility shell during the bounded session migration
- Vite for the renderer build
- Rust Core for SQLite, macros, platform work, runtime topology, and migration journals
- Vitest for unit tests

### Commands

```bash
pnpm install
pnpm run dev
pnpm run dev:renderer # Optional renderer-only UI development
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run package
```

### Runtime Data

The Rust core stores metadata in `rion-studio.sqlite3` below the canonical
`Rion Studio` application-data directory (`~/Library/Application Support/Rion Studio`
on macOS and `%APPDATA%\\Rion Studio` on Windows).

The retired sibling directory named `rion-studio` is ignored. Rion Studio does not
move, delete, or replace that data; it opens the canonical `Rion Studio` directory
when present and creates a fresh canonical data root otherwise.

Each role owns an isolated browser directory at:

```text
roles/{roleId}/browser
```

The app stores browser session data only. It does not store login passwords.

### Browser Session Architecture

The v23 runtime gives every role an isolated bundled-Chromium profile below its
Rust-owned `browser/chromium` directory. Windows uses the Electron Chromium host.
macOS keeps the AppKit native window, tab, focus, fullscreen, display, and trusted
input boundary while replacing only WKWebView with Chromium content surfaces.
It must not fall back to the Windows HTML window host.

The v22 compatibility shell continues to use WebView2 or WKWebView only while an
authenticated, revision-fenced migration transfers the launch origin's cookies
and Local Storage. The runtime never uses an installed third-party browser
profile directly, never exposes session secrets to the renderer, and never
mutates the source profile.

### Packaging Notes

Production remains on the Tauri compatibility shell until the Chromium capability,
session migration, updater, and desktop-E2E cutover gates are complete. Do not
switch the unqualified `dev`, `build`, `package`, or `dist` commands early.

Linux CI validates only the portable Rust crates because Linux is not a supported
Tauri shell target. Run the same portable gates locally with:

```bash
pnpm run lint:rust:portable
pnpm run test:rust:portable
```

The complete Rust workspace and both desktop shells must be compiled on both
supported platforms. Windows platform operations are part of the `rion-platform` Rust crate.
Install the pinned Rust toolchain and the Visual Studio 2022 MSVC/Windows SDK
components required by the `x86_64-pc-windows-msvc` target. To run the complete
Rust checks directly on macOS or Windows:

```bash
pnpm run lint:rust
pnpm run test:rust
cargo check -p rion-tauri
pnpm run package:electron:dir
pnpm run verify:electron-package -- --app <unpacked-app-path>
pnpm run verify:system-only
```

Linux portable checks do not compile the Tauri shell's Windows-only or macOS-only
`cfg` paths. Any change to native runtime code, platform imports, or shared
runtime contracts therefore requires the native platform gate above; do not
infer Windows reachability from a green Linux job.

CI builds the renderer in an independent Linux preparation job and shares those
assets with the macOS and Windows Tauri validation jobs. A separate macOS/Windows
matrix builds an unpacked Electron package and verifies its fuses, final ASAR
entry points and E2E isolation, native addon, portable macOS install name, and
platform linkage. It runs the target-specific Chromium shell E2E both before
packaging and from the final packaged binary: macOS binds its result to the
retained AppKit target, while Windows binds its result to the Windows Chromium
target. Packaged smoke uses an artifact-local fixed home on macOS. Windows uses
a GitHub-hosted temporary local-user profile and its real OS Known Folders, with
the command tree fenced by a kill-on-close Job Object; it does not relax the
product ban on packaged user-data overrides. Neither shell result
substitutes for the v22 compatibility suite or the later full Chromium P0/P1
migration gates. The renderer preparation, common
checks, Linux sanitizer, compatibility validation, and Chromium package
validation can run in parallel. Release packaging is not a replacement for these
daily platform checks.

`pnpm run build` links the Rust core directly into the application. CI must validate
both `macos-latest` and `windows-latest` with platform-aware Rust lint, tests, and
`cargo check -p rion-tauri --all-targets`. After that quality gate succeeds, the
release candidate orchestration is the only production Tauri bundle build and
verifies the resulting installers on both platforms. Its build/manifest and
upgrade-compatibility gates both complete before semantic-release creates the
immutable tag and private draft. Assets are checksum-verified in that draft before
the public draft is promoted. If finalization fails, dispatch **Resume Release**
with the existing tag; it reuses the retained preflight candidate when available,
otherwise rebuilds the tagged SHA and refuses to overwrite non-identical assets.
macOS releases target 14+, use the explicit ad-hoc signing identity (`-`), and must
not import a Developer ID certificate or submit for notarization. Windows releases
remain unsigned and require a WebView2 runtime presence check. The updater archives
on both platforms still require Tauri's independent cryptographic signature.

Releases use only Tauri's updater-signed `latest.json`. Keep
`Rion.Studio-mac.dmg`, `Rion.Studio-mac.app.tar.gz`, and
`Rion.Studio-win.exe` stable because updater manifests and README links depend on
them. Manifests are uploaded only after the immutable assets and updater signatures verify.

`pnpm run verify:system-only` validates the negative architecture boundary. Keep
current product behavior covered by focused Rust and Vitest tests; historical
parity ledgers are not part of the release contract.

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
