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

Roles always launch their configured game URL directly in an isolated System
WebView store: WebView2 on Windows and WKWebView on macOS. The runtime never uses
an installed third-party browser profile directly. The user-consented one-time
Chrome transfer reads only the approved Cookies and exact launch-origin Local
Storage inputs, snapshots them in memory, filters them before persistence, and
never mutates the source profile.

### Packaging Notes

Game roles use the operating system WebView runtime directly.

Linux CI validates only the portable Rust crates because Linux is not a supported
Tauri shell target. Run the same portable gates locally with:

```bash
pnpm run lint:rust:portable
pnpm run test:rust:portable
```

The complete Tauri workspace must be linted and tested on both supported shell
platforms. Windows platform operations are part of the `rion-platform` Rust crate.
Install the pinned Rust toolchain and the Visual Studio 2022 MSVC/Windows SDK
components required by the `x86_64-pc-windows-msvc` target. To run the complete
Rust checks directly on macOS or Windows:

```bash
pnpm run lint:rust
pnpm run test:rust
cargo check -p rion-tauri
pnpm run verify:system-only
```

Linux portable checks do not compile the Tauri shell's Windows-only or macOS-only
`cfg` paths. Any change to native runtime code, platform imports, or shared
runtime contracts therefore requires the native platform gate above; do not
infer Windows reachability from a green Linux job.

CI builds the renderer in an independent Linux preparation job and shares those
assets with the macOS and Windows validation jobs. The renderer preparation,
common checks, and Linux sanitizer can run in parallel. The release workflow still
builds native installers separately; that packaging matrix is not a replacement
for daily platform compilation and tests.

`pnpm run build` links the Rust core directly into the application. CI must validate
both `macos-latest` and `windows-latest` with platform-aware Rust lint, tests, and
`cargo check -p rion-tauri --all-targets`. After that quality gate succeeds, the
release candidate workflow is the only production Tauri bundle build and verifies
the resulting installers on both platforms. macOS releases target 14+, use the
explicit ad-hoc signing identity (`-`), and must not import a Developer ID certificate
or submit for notarization. Windows releases remain unsigned and require a WebView2
runtime presence check. The updater archives on both
platforms still require Tauri's independent cryptographic signature.

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
