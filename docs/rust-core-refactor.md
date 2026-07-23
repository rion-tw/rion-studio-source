# Rust core architecture and 2.1 release gates

Rion Studio keeps Electron, Chromium, React, preload and native UI integration. The
required `rion-core.node` addon owns portable application state, SQLite, log storage,
macro timing, system pressure sampling, resource policy, CDN matching, external Chrome
process supervision and its DevTools HTTP/WebSocket transport. Renderer code never
loads the addon directly.

## Runtime boundaries

- `rion-core` owns domain validation, the state and log database workers, migration,
  monotonic scheduling, bounded event queues, CDN rules, resource decisions and CDP.
- `rion-platform` owns macOS/Windows discovery, process and system-pressure adapters,
  Chrome profile discovery/copy/cookie decryption, plus the `windows-rs` visible-frame
  implementation.
- `rion-node` is the only Node-API boundary.
- Electron objects, windows, sessions, cookies, dialogs, menus and updates remain in
  TypeScript adapters. AppKit runtime tabs remain Objective-C++.
- SQLite is the only production write source. Legacy JSON is retained as a read-only
  migration backup and is not updated after migration.

Missing or incompatible addons are fatal startup errors. Persistence never silently
falls back to JSON. Rion Studio has no TypeScript runtime-core fallback: runtime
decisions and side effects must have exactly one production implementation.

## 2.1 command and effect boundary

The production `NativeAppCore` object exposes only `invoke`,
`subscribeCoreEvents`, `dispatchCoreEffectResults`, `matchCdnUrl`, and
`shutdown`. Bootstrap reads remain a module-level call before the core is
created. Commands, results, events, effects, and errors are generated from Rust.

Rust operations read their authoritative inputs from SQLite, obtain operation
leases, emit typed Electron effects, and wait for acknowledgements without
holding a SQLite connection or global mutex. TypeScript owns the Electron handle
registry and applies only Electron-specific effects. It does not maintain a
parallel operation queue or runtime snapshot.

The operation actor exposes release metrics through `coreEffectMetrics`:
current and peak queue depth, effect capacity, active operations, emitted and
acknowledged effect counts, acknowledgement p50/p95/max, and embedded-launch
operation/effect counts. `telemetrySnapshot` separately reports NAPI call count
and bridge latency.

## 2.0 migration and downgrade boundary

On first 2.0 startup, Rion Studio recovers any interrupted portable/profile journal,
normalizes legacy data, imports it into temporary state and log databases, validates
integrity, foreign keys, row counts and the snapshot hash, and then atomically installs
the databases. Original JSON/JSONL files are copied to a timestamped read-only folder
under `migration-backups` in the application user-data directory. These backups are
never deleted automatically.

SQLite is the only production write source after migration. Installing 1.x again can
only see the legacy JSON as it existed at migration time; it cannot preserve changes
made in 2.0. Portable JSON export is the supported path for moving application data
across versions. Portable files deliberately exclude cookies, browser profiles and
login sessions.

Role browser directories remain at `roles/{roleId}/browser`, and Electron session
partitions keep their existing identifiers. Migration does not proactively clear
cookies, Chromium storage or login data, so existing sign-in state is expected to
remain available. Third-party sites may still invalidate their own sessions.

## Verification

Run the complete local checks with:

```bash
pnpm run lint:rust
pnpm run test:rust
pnpm run generate:rust-types
git diff --exit-code -- src/shared/generated
pnpm run build:rust
pnpm run verify:rust
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
pnpm run build:native:macos
pnpm run test:native:macos
pnpm run package
```

`verify:rust` loads the release addon, creates and queries both databases, supervises
a child process and exercises a loopback DevTools HTTP/WebSocket fixture. CI repeats
the addon and unpacked-package smoke tests on macOS arm64 and Windows x64. macOS CI
also runs the AppKit runtime-tabs native tests.

## Performance protocol

Start the deterministic browser workload with `pnpm run performance:fixture`. Configure role URLs
as `http://127.0.0.1:47831/play?role=1` through `role=9`, and keep the optional `work` query
parameter identical between 1.37 and 2.0. The seeded animation and fixed canvas workload avoid
depending on a changing live game deployment.

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

The harness samples the complete process tree and the non-renderer host subset,
records CPU/RSS medians and steady-state RSS growth, and can compare against a
prior result via `--baseline=...`. Capture `coreEffectMetrics` and
`telemetrySnapshot` before and after every launch so the report also includes
peak effect queue depth, effect acknowledgement p95, effects per launch, and
NAPI call count. After collecting exactly three baseline and three candidate
runs for a scenario, aggregate the medians and enforce every gate with:

```bash
pnpm run performance:aggregate -- \
  --baseline=baseline-1.json,baseline-2.json,baseline-3.json \
  --candidate=candidate-1.json,candidate-2.json,candidate-3.json \
  --output=performance-results/9-visible-comparison.json
```

Aggregation rejects mismatched hardware/fixture/scenario metadata, shortened warmup or
measurement windows, and missing IPC/tab/macro p95 samples. A release decision still
requires all launcher idle, 1/4/9 visible roles, hidden workspace, macro on/off,
embedded and external Chrome scenarios. Visible
roles must remain at full speed; only a wholly hidden workspace may use adaptive 2x/4x
CPU throttling, and macro roles always remain unthrottled.

Required gates are: host CPU -30%, host RSS -20%, nine-role process-tree CPU -10%,
process-tree RSS -5%, relevant p95 command/tab/macro dispatch regression no worse than
5%, and steady-state host RSS growth no more than 5%. A subsystem that misses its gate
must be optimized and revalidated before release.
