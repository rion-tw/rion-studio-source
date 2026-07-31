# Build and Release

CI validates portable code on Linux plus native Tauri targets on `macos-latest`
and `windows-latest`. Build/package commands compile and bundle; they do not launch
the desktop application as validation.

Automatic releases inherit the exact successful CI SHA. Manually dispatched
candidates rerun CI. Updater signatures and SHA-256 checks are distinct from the
owner-locked unsigned platform-installer policy in `AGENTS.md`.

Release workflows publish the Tauri updater manifest and verify current Tauri
upgrade/data preservation. Historical Electron updater manifests are retired.
