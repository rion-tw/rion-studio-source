# Rion Studio 2.0

Rion Studio 2.0 moves the non-UI application core to Rust while retaining Electron,
Chromium, React, existing role browser directories, IPC channels and update artifacts.

## Data migration

- Legacy application state is migrated automatically to `rion-studio.sqlite3`; logs
  move to the independently maintained `logs.sqlite3` database.
- Before the database is installed, the original JSON and JSONL files are copied to a
  timestamped, read-only `migration-backups` directory under Rion Studio's user-data
  folder. Backups are not removed automatically.
- Downgrading to 1.x cannot preserve changes made after the 2.0 migration. Portable
  JSON export is the supported cross-version transfer path.
- Existing `roles/{roleId}/browser` data and Electron session partitions are retained.
  Rion Studio does not proactively clear cookies or login sessions during migration.
  A third-party service can still expire its own session.
- Portable exports contain application records and selected settings, but never
  browser profiles, cookies, saved login sessions or passwords.

## Supported platforms

- macOS 12 or newer on Apple silicon (arm64)
- Windows 10/11 on x64

The release retains Electron's Chromium engine and the current macOS AppKit runtime-tab
controller. Windows external-Chrome frame alignment is now implemented in the Rust
platform adapter; the former standalone C++ helper is not included.
