# Rion Studio 2.0

> Historical release note. For the current Tauri-only architecture and upgrade
> policy, see `docs/system-native-engine-tauri-plan.md`.

Rion Studio 2.0 moved the non-UI application core to Rust while retaining the legacy shell,
Chromium, React, existing role browser directories, IPC channels and update artifacts.

## Data migration

- Legacy application state is migrated automatically to `rion-studio.sqlite3`; logs
  move to the independently maintained `logs.sqlite3` database.
- Before the database is installed, the original JSON and JSONL files are copied to a
  timestamped, read-only `migration-backups` directory under Rion Studio's user-data
  folder. Backups are not removed automatically.
- Downgrading to 1.x cannot preserve changes made after the 2.0 migration. Portable
  JSON export is the supported cross-version transfer path.
- Existing `roles/{roleId}/browser` data and legacy session partitions are retained.
  Rion Studio does not proactively clear cookies or login sessions during migration.
  A third-party service can still expire its own session.
- Portable exports contain application records and selected settings, but never
  browser profiles, cookies, saved login sessions or passwords.

## Supported platforms

- macOS 12 or newer on Apple silicon (arm64)
- Windows 10/11 on x64

The release retained its then-current browser engine and macOS AppKit runtime-tab
controller. The current product line replaces that shell with platform System
WebViews managed by the Rust/Tauri runtime.
