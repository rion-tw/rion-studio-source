# Rion Studio 2.1 verification record

Status: local functional candidate passed; public release remains blocked by the
formal 1.37 performance A/B matrix and remote Ubuntu/macOS/Windows CI.

Date: 2026-07-24 (Asia/Taipei)

## Local automated gates

The following checks passed on macOS arm64 with Node 24.15.0:

- `pnpm run test:rust`: 354 `rion-core` and 16 `rion-platform` tests.
- `pnpm run typecheck`.
- `pnpm run test`: 107 files and 725 tests.
- `pnpm run lint`.
- `pnpm run generate:rust-types`.
- `pnpm run build:rust`.
- `pnpm run verify:rust`.
- `pnpm run lint:rust`.
- `pnpm run build`.
- `pnpm run build:native:macos`.
- `pnpm run test:native:macos`.
- `pnpm run package`.

The generated Rust contracts were regenerated before the package build. The
unpacked candidate loaded the release Rust addon and AppKit addon successfully.

## Real userData copy

The source userData was cloned to an APFS copy below `$TMPDIR`. The installed
application's live userData was not passed to the candidate and was not
modified. Interactive role launch checks used only `米娜醬`.

Preflight and postflight database checks:

- state schema version: 4;
- SQLite `integrity_check`: `ok`;
- SQLite `foreign_key_check`: no rows;
- pending `operation_journal` rows: 0;
- original copy: 2 games, 11 roles, 4 workspaces, and 6 macros;
- imported-profile copy after the test: 12 roles.

Functional results:

- Embedded launch opened `米娜醬 - Flyff Universe` and displayed the signed-in
  character in the game world. Stopping the role returned the runtime count to
  zero.
- External Chrome launch progressed from Rust `launching` to `running`, then
  stopped cleanly. The temporary launch-mode setting was restored to `auto`.
- Portable v6 export created a 611 KiB JSON file containing 2 games, 11 roles,
  4 workspaces, and 6 macros. Re-import preview reported no warnings; applying
  it classified all 23 selected records as unchanged and preserved preferences.
- Chrome profile import used a disposable local fixture rather than the active
  system Chrome directory. It created the `明鑫` role with
  `browserSessionSource: chrome-profile`, installed its isolated browser
  directory, and left no operation journal. The imported role was not launched.
- After a full quit and restart, all 12 roles loaded, the imported role remained
  present, and there was no residual running role or pending journal.
- Both candidate processes exited with code 0.

The unpacked `electron-builder --dir` application logged an expected
`app-update.yml` `ENOENT` while checking for updates. That file is supplied by a
published update artifact, so the final signed candidate pipeline must still
verify updater metadata.

## Performance and remote release gates

The candidate now records peak effect queue depth, effect acknowledgement p95,
effects per launch, and NAPI count/p95 in the Rust telemetry snapshot. The
interactive run exercised that instrumentation, but it is not a substitute for
the release performance protocol.

The required three-run medians for launcher idle, 1/4/9 visible roles, hidden
workspace, macro on/off, embedded, and external Chrome have not yet been
collected against the packaged `v1.37.0` baseline. No CPU, RSS, latency, or
steady-state growth gate is claimed as passed by this record.

The branch has deliberately not been pushed. Therefore Ubuntu, macOS arm64, and
Windows x64 package/addon CI and the remote semantic-release dry run are also
pending. Do not merge, tag, or publish 2.1 until those gates pass and the dry run
reports exactly `2.1.0`.
