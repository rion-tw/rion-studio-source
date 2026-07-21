# Rust core architecture and release gates

Rion Studio keeps Electron, Chromium, React, preload and native UI integration. The
required `rion-core.node` addon owns portable application state, SQLite, log storage,
macro timing, system pressure sampling, resource policy, CDN matching, external Chrome
process supervision and its DevTools HTTP/WebSocket transport. Renderer code never
loads the addon directly.

## Runtime boundaries

- `rion-core` owns domain validation, the state and log database workers, migration,
  monotonic scheduling, bounded event queues, CDN rules, resource decisions and CDP.
- `rion-platform` owns macOS/Windows discovery, process and system-pressure adapters,
  plus the `windows-rs` visible-frame implementation.
- `rion-node` is the only Node-API boundary.
- Electron objects, windows, sessions, cookies, dialogs, menus and updates remain in
  TypeScript adapters. AppKit runtime tabs remain Objective-C++.
- SQLite is the only production write source. Legacy JSON is retained as a read-only
  migration backup and is not updated after migration.

Missing or incompatible addons are fatal startup errors. Persistence never silently
falls back to JSON. For the first rollout only, optional runtime subsystems can use the
old implementation by setting a comma-separated
`RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS` value. Accepted names are `cdn`,
`external-chrome`, `macro-timing`, `pressure`, and `resource-policy`; `all` selects all
optional fallbacks. This switch does not change SQLite ownership.

## Verification

Run the complete local checks with:

```bash
pnpm run lint:rust
pnpm run test:rust
pnpm run build:rust
pnpm run verify:rust
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

`verify:rust` loads the release addon, creates and queries both databases, supervises
a child process and exercises a loopback DevTools HTTP/WebSocket fixture. CI repeats
the addon and unpacked-package smoke tests on macOS arm64 and Windows x64. macOS CI
also runs the AppKit runtime-tabs native tests.

## Performance protocol

Use a release/package build on the same machine, display resolution, fixture and
settings. Warm each scenario for 10 minutes, measure for 30 minutes, run it three times
and compare the median. Enable bridge telemetry before starting the app:

```bash
RION_PERFORMANCE_TELEMETRY_PATH=/tmp/rion-telemetry.json pnpm run dev
```

While the app is running, measure its root PID:

```bash
pnpm run performance:measure -- \
  --pid=12345 \
  --scenario=9-visible-roles \
  --fixture=fixture-v1 \
  --resolution=2560x1440 \
  --settings=release-defaults \
  --telemetry=/tmp/rion-telemetry.json
```

The harness samples the complete process tree and the non-renderer host subset, records
CPU/RSS medians and steady-state RSS growth, and can compare against a prior result via
`--baseline=...`. A release decision still requires all launcher idle, 1/4/9 visible
roles, hidden workspace, macro on/off, embedded and external Chrome scenarios. Visible
roles must remain at full speed; only a wholly hidden workspace may use adaptive 2x/4x
CPU throttling, and macro roles always remain unthrottled.

Required gates are: host CPU -30%, host RSS -20%, nine-role process-tree CPU -10%,
process-tree RSS -5%, relevant p95 command/tab/macro dispatch regression no worse than
5%, and steady-state host RSS growth no more than 5%. A subsystem that misses its gate
stays on the temporary fallback until the bottleneck is resolved.
