# Desktop E2E and AI Development Strategy

`docs/e2e-coverage.json` is the versioned source of truth for desktop user-journey
coverage. Coverage is measured by product journeys, not bridge methods or source
lines. P0 automation must remain at 100%; P1 automation must remain at or above
80%. Every product feature listed in the manifest must have an automated UI happy
path.

## Profiles and gates

| Profile | Gate | Scope |
| --- | --- | --- |
| `smoke` | Pull requests on hosted macOS and Windows | Legal/first run, primary navigation, Game/Role/Workspace/Macro creation and launch admission, Game Window lifecycle, and Settings persistence. |
| `full` | Nightly plus advisory branch soak | All smoke journeys, destructive confirmations, native Game Window/tab persistence and recovery, and system Settings boundaries. |
| `extended` | Nightly hardware runners and release candidates | The complete full profile plus mixed-DPI, multi-display, fullscreen Spaces, and other native fixtures. |

Run profiles with `pnpm run test:e2e:desktop:smoke`,
`pnpm run test:e2e:desktop:full`, or
`pnpm run test:e2e:desktop:extended`. The runner reads its phase list from the
manifest, launches the real debug-feature Tauri binary, and rejects unknown
profiles. Product builds continue to be checked for E2E-control isolation.

PR smoke is a required, non-advisory macOS and Windows check. The full hosted soak
remains advisory until each platform records 20 consecutive complete runs without
an infrastructure flake; product failures do not count as infrastructure flakes
and are never auto-retried. After that promotion threshold, remove its
`continue-on-error`. Nightly and release-candidate extended runs are fail-closed:
`BLOCKED` or an incomplete platform is not success.

## Journey authoring

- Add one stable journey ID per independently reportable user outcome. P0/P1
  entries must name an existing spec, both required platforms, a profile/gate,
  and success plus any applicable failure, cancellation, or restart outcome.
- Put a `[journey:JOURNEY-ID]` marker in the owning spec. Run
  `pnpm run check:e2e-coverage`; missing files, markers, platforms, profiles,
  duplicate IDs, low targets, and feature UI gaps fail CI.
- Perform the primary action through visible UI. `rendererCall` and debug-only
  native controls may create deterministic preconditions, inject a controlled
  fault, or read authoritative state; they may not substitute for the action
  being tested.
- Wait for authoritative renderer/native events or persisted evidence. Do not
  use elapsed time as success. External OS boundaries may be declared `BLOCKED`,
  which deliberately fails gated runs.
- Preserve `report.json`, failure screenshots, frontend/backend logs, the event
  transcript, fixture log, and read-only SQLite snapshots/query output for every
  phase. Artifacts are retained for 14 days on hosted CI and 30 days on hardware
  runners.

## Agent change contract

Every user-visible implementation handoff must list affected journey IDs and the
macOS/Windows profiles actually run. New visible behavior updates the manifest and
its E2E in the same change. If E2E is genuinely inapplicable, use exactly one of
`internal-only`, `compile-only`, or `lower-layer-covered`, and include the focused
lower-layer evidence. A platform that was not executed locally must be called out
as pending its required CI gate.

The manifest deliberately retains one planned P1 journey for edit/reorder,
bulk-delete, partial launch failure/cancel, shortcuts, and the unsaved-quit guard;
this keeps the remaining gap visible while P1 automation stays above its 80%
gate. P2 planned entries record expensive native work without inflating P0/P1
coverage. Current planned extended work includes complete portable import/export, Chrome
profile import, font installation, diagnostic export, staged updater installation,
application shortcuts, tray/menu behavior, native window controls, and the
unsaved-changes quit guard.
