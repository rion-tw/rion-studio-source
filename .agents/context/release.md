# Build and Release

CI validates portable code on Linux plus native Tauri targets on `macos-latest`
and `windows-latest`. Build/package commands compile and bundle; they do not launch
the desktop application as validation.

Automatic releases inherit the exact successful CI SHA. Manually dispatched
candidates rerun CI. Updater signatures and SHA-256 checks are distinct from the
owner-locked unsigned platform-installer policy in `AGENTS.md`.

After the candidate and upgrade checks succeed, semantic-release creates an
immutable tag and private draft. The public release remains a draft until its full
asset set and checksums verify. Use the **Resume Release** workflow with an
existing tag to recover a failed finalization; it never deletes tags or overwrites
non-identical assets.

Release workflows publish the Tauri updater manifest and verify current Tauri
upgrade/data preservation. Historical Electron updater manifests are retired.
