# Local storage retention

`pnpm storage:preview` reports candidates without deleting them.
`pnpm storage:prune` applies the checked-in policy. `pnpm test:storage` runs filesystem safety regressions.

Maintenance runs before these existing commands (arguments and the original command remain intact):
`test:e2e:desktop`, `test:e2e:desktop:smoke`, `test:e2e:desktop:full`, `test:e2e:desktop:extended`, `test:e2e:desktop:chromium:macos-appkit`, `test:e2e:desktop:chromium:macos-appkit:hardware`, `test:e2e:desktop:chromium:windows`, `test:e2e:desktop:chromium:windows:hardware`, `test:e2e:desktop:electron:packaged`.
It runs locally on demand, not through a background schedule. Housekeeping errors are reported without hiding the original test/build exit code.

| Generated output         | Expiry  | Size target |
| ------------------------ | ------- | ----------- |
| `.desktop-e2e-artifacts` | 14 days | 2 GiB       |
| `test-results`           | 14 days | 2 GiB       |

Expiry removes old candidates even if they are among the newest three. Size-based eviction otherwise keeps the newest three groups (two for isolated D1 state). Outputs modified in the last 24 hours are protected; Turbo cache has a one-hour grace period. These are soft size targets: in-use, recent or pinned data wins over the target, and excess is reported.

Only explicitly listed, Git-ignored, untracked outputs qualify. Nested Git repositories, symlinks, environment files, Blender/model/design source files, and directories containing `.keep`, `.retain` or `.storage-keep` are preserved. Put a `.keep` file in a run directory or in its configured output root to retain review baselines. Directory age uses the newest descendant modification time, not only the parent timestamp.

The tool checks process working directories and open files twice before removal. Live output files are retained. Shared Turbo cache is also preserved while another process is using its checkout/worktrees. No worktree, source tree, dependency installation, application database (only named test-output roots can contain removable fixture databases), release, backup or original asset directory is removed. Tracked files are checked again before deletion. A per-checkout Git-directory lock serializes cleaners; a stale lock after a killed cleaner is kept for manual inspection.

Automatic deletion requires successful `ps` and `lsof` inspection on macOS/Linux. Windows or unavailable/incomplete inspection retains all data and reports the limitation; it never disables or changes the test command. `test:storage` covers this fail-closed behavior; native Windows execution is not claimed. No production credentials or remote services are used.

Policies are checkout-local. Haoban's three existing worktrees receive the same limits. Commit these maintenance files and package scripts with the intended project changes so future checkouts inherit them. Old branches with independent configurations require the same maintenance update.

The utility has no third-party dependency. Its matching copies were installed together on 2026-10-20; keep filesystem safety fixes and tests synchronized if modifying it in several projects.

Read-only directories (including migration backups) preserve their containing run. Deletion errors preserve the remainder, record the error, and allow other eligible runs to finish; the cleaner never changes permissions or force-retries deletion.

## Rust build storage

`pnpm storage:rust:preview` previews the Cargo policy; `pnpm storage:rust:prune`
applies it. The existing `storage:preview` / `storage:prune` commands also include
Rust. The policy lives in `scripts/rust-storage-retention.json`:

| Scope per checkout | Age limit | Soft size target |
| --- | --- | --- |
| All recognized profiles under `target` | 14 days | 12 GiB total |
| Incremental compiler caches across those profiles | 7 days | 2 GiB total |

Old incremental groups are evicted first. If that is insufficient, an idle
profile is cleaned as a unit, including its dependency/fingerprint graph.
Cargo profile directories, `.cargo-lock`, `.cargo-build-lock`,
`.cargo-artifact-lock`, `.metadata_never_index`, and the root metadata remain in
place. Locks are never unlinked or replaced. The 12 GiB target leaves room for
the approximately 8.6 GiB of non-incremental output observed on 2026-10-21;
an 8 GiB target would repeatedly discard a useful dependency build.
Capacity counts each hardlinked inode once within `target`; removing one of
several incremental links does not count as reclaiming that file. This is a
deduplicated file-size estimate, not an APFS physical-disk quota.

The native addon build script runs maintenance before Cargo, including direct
invocations of that script and release/E2E callers. The package scripts that
invoke Cargo tests, clippy, diagnostics, fixture builds and type generation also
run it first. A `.storage-last-used` marker records these build invocations so
no-op Cargo builds do not make a warm profile appear unused. Direct `cargo`
commands bypass the maintenance hook; their native locks still protect them
from concurrent cleanup. There is no background schedule.

Rust cleanup additionally needs Python 3 and Unix `flock` on macOS/Linux.
It takes all three Cargo lock generations exclusively and nonblockingly, keeps
them held through planning/removal, and rechecks open files after acquiring
them. A busy lock or incomplete process inventory retains the output. Processes
working in this checkout and open target artifacts protect it; a separately
registered nested worktree has its own policy. Recent output (24 hours), pins,
tracked content, symlinks, source assets and read-only trees are retained.
Cleanup failure never changes the following build/test's exit status. Windows
and missing Python/process-inspection support retain all Rust output; native
Windows cleanup is not implemented.

Only this checkout's default `target` is managed. Custom `CARGO_TARGET_DIR`,
separate Cargo build directories, unrecognized output directories, installed
`build/native` addons, release packages and other checkouts are not deleted.
Per-checkout limits do not provide a global quota across many worktrees.
An active or newly rebuilt cache can temporarily exceed either target; run the
prune command after it has been idle for 24 hours or on the next build. Preserve
long-lived evidence with `.keep` rather than shortening the protection window.

The Rust policy uses Cargo's documented profile layout and native locking:
[Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html),
[Cargo lock compatibility](https://github.com/rust-lang/cargo/issues/16853).
The existing `clean:rust -- --delete` is still an explicit full reset; it does
not apply these retention protections. Use `storage:rust:prune` for safe upkeep.
