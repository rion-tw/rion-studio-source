# Live tab tearout validation

The v44 contract is defined in [Chromium runtime migration](../../chromium-runtime-migration.md#chromium-v44-live-tab-tearout).
Journey membership belongs to [the coverage manifest](../../e2e-coverage.json).

## Focused native procedure

Run the current platform's `chromium-tab-tearout` phase:

```sh
pnpm run test:e2e:desktop -- --profile=chromium-macos-appkit-smoke --phase=chromium-tab-tearout
pnpm run test:e2e:desktop -- --profile=chromium-windows-smoke --phase=chromium-tab-tearout
```

The visible UI creates saved source windows, launches two ready Roles and a gated
loading Role, then creates a mixed Role/Website Workspace. Real desktop pointer
input holds the tab outside the strip, returns it, detaches again, moves the
single-tab temporary window, presses Escape, and merges it back. Assertions cover
one reused transient host, continued loading, unchanged Chromium generations and
Session identity, retained Workspace slots, no implicit saved window, and exact
empty-host retirement. Debug reads observe ownership; they do not perform moves.

Also run `chromium-tabs-visible-restart` with its seed dependency to retain the
existing sorting, menu movement, persistence, and restart coverage. Hardware
acceptance must separately cover overlapping windows, monitors above/left of the
primary display, mixed DPI, and work-area edges on each platform.

## 2026-09-20 implementation evidence

These results apply to the uncommitted v44 worktree based on `4b73a370`.

| Check | Observed result |
| --- | --- |
| Hygiene, generated contracts, typecheck, lint | Passed; ESLint retains 23 existing Fast Refresh warnings outside this task |
| TypeScript suite | 4,592 passed; 19 skipped |
| Rust lint and workspace tests on macOS | Passed; 1,240 passed, 5 ignored |
| Production build and desktop E2E isolation | Passed |
| Coverage manifest | P0 54/54, P1 74/74, P2 4/4; both platform parity sets 41/41 |
| macOS focused tearout phase through the full profile selector | Passed, including gated loading, ready Role, mixed Workspace, Escape, and temporary-source merge |
| New Windows native hook module cross-compilation | Passed for `x86_64-pc-windows-msvc` in an isolated crate using the repository lockfile |
| Full Windows build and native desktop execution | Pending Windows CI/native host; the macOS host lacks the Windows C SDK required by workspace native dependencies |
| Mixed-DPI/multiple-monitor hardware matrix | Pending; negative-coordinate placement is unit-covered, not desktop hardware evidence |

The passing native report is the host-local focused macOS artifact
`.desktop-e2e-artifacts/2026-09-20T01-56-16-785Z-darwin/report.json`.
The full smoke attempt passed extension context-menu and filtering, then stopped
in `chromium-extensions-seed` because the external Buster store heading did not
appear. Its host-local smoke report is
`.desktop-e2e-artifacts/2026-09-20T01-49-44-879Z-darwin/report.json`.
An earlier `chromium-tabs-visible-seed` attempt failed its existing loading-cover
pixel assertion before entering tearout; the focused phase preserves that check
and avoids using its unrelated setup as the only tearout gate. Its host-local
seed report is `.desktop-e2e-artifacts/2026-09-20T01-25-14-915Z-darwin/report.json`.
These ignored artifacts remain on the originating host, not in a fresh checkout.
Smoke and full selectors currently resolve to the same platform smoke profile;
the focused pass is not a claim that every profile phase passed.

The new native journey exposed and drove fixes for empty preview occlusion on
release, stale AppKit dispatch observations, Workspace loading-layout targets
remaining bound to the old host, and loading activation being cancelled during
live transfer. Focused tests also cover cancellation during provisioning/geometry
waits, duplicate and late events, superseded native work, post-commit quarantine,
projection updates during a held Windows pointer, and exact cleanup scope.
Post-commit completion failures retain an `indeterminate` receipt through Core
even if native quarantine also fails; they cannot continue as degraded moves.
