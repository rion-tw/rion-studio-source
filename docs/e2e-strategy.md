# Desktop E2E and AI Development Strategy

`docs/e2e-coverage.json` is the versioned source of truth for desktop user-journey
coverage. Coverage is measured by product journeys, not bridge methods or source
lines. P0 and P1 automation must remain at 100%. Every product feature listed in
the manifest must have an automated UI happy
path.

## Profiles and gates

| Profile | Gate | Scope |
| --- | --- | --- |
| `smoke` | Pull requests on hosted macOS and Windows | Legal/first run, primary navigation, Game/Role/Workspace/Macro creation and launch admission, Game Window lifecycle, and Settings persistence. |
| `full` | Required hosted macOS and Windows gate on `main` and release/rebuild validation; advisory on non-release branch pushes | All smoke journeys, edit/reorder/bulk-delete persistence, Workspace partial failure/cancellation, the unsaved-change quit guard, native Game Window/tab persistence and recovery, and system Settings boundaries. |
| `extended` | Scheduled or manually dispatched hardware runners | The complete full profile plus mixed-DPI, multi-display, fullscreen Spaces, and other native fixtures. |

Run profiles with `pnpm run test:e2e:desktop:smoke`,
`pnpm run test:e2e:desktop:full`, or
`pnpm run test:e2e:desktop:extended`. The runner reads its phase list from the
manifest, launches the real debug-feature Tauri binary, and rejects unknown
profiles. Product builds continue to be checked for E2E-control isolation.

PR smoke is a required, non-advisory macOS and Windows check. The full hosted
profile is required for `main`, release candidates, and manually dispatched
rebuild validation; non-release branch pushes may keep it advisory. Product
failures are never auto-retried. Extended runs remain fail-closed when explicitly
scheduled or dispatched on provisioned hardware: `BLOCKED` or an incomplete
platform is not success, but unavailable hardware runners do not block release.

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

Windows 實機執行與回報格式見
`.agents/windows-p1-e2e-validation.md`；Windows full 與 mixed-DPI extended 的證據必須
綁定同一個 exact SHA，且 `BLOCKED` 不得當成跨平台完成。

P0 and P1 are fully automated. The full profile performs primary actions through
visible UI and uses the local runtime fixture only to hold or fail exact navigation
boundaries. P2 planned entries record expensive native work without inflating
P0/P1 coverage. Current planned extended work includes complete portable import/export, Chrome
profile import, font installation, diagnostic export, staged updater installation,
application shortcuts, tray/menu behavior, and native window controls. The P1
quit-guard journey injects the native request through the debug-only control; P2
retains responsibility for proving the real OS menu and shortcut entry points.
