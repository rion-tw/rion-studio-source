# Windows Game Window Placement Validation

Use this runbook on a physical Windows 10/11 host to validate current `main`.
Record the exact source SHA, Windows build and architecture, WebView2 version,
display topology, scale factors, and the starting worktree state. macOS,
portable tests, and hosted CI cannot replace physical Win32 evidence.

## Preconditions and gates

- Use a clean native NTFS worktree and an isolated debug data directory.
- Read the root and nearest `AGENTS.md`, `.agents/context.md`, the runtime
  contract parts for native placement and lifecycle, and the E2E strategy.
- Run the router with `system-runtime-native` and `desktop-e2e` intents.
- Run every gate emitted by the router on the same exact SHA before acceptance.
- Preserve `report.json`, runner/WDIO logs, screenshots on failure, read-only
  SQLite snapshots, and `events.ndjson` for each desktop phase.
- A timeout is failure or incomplete evidence; it is never operation success.

Use `pnpm run test:e2e:desktop:full` for W1-W9. Use
`pnpm run test:e2e:desktop:extended` for W10-W11 only when two physical displays
with the required topology are available. Bind every artifact to the exact SHA.

## Acceptance matrix

| ID | Required evidence |
| --- | --- |
| W1 | The sortable Window Mode column follows Target Display, exposes correct ARIA sort state, and orders Windowed, Maximized, Full screen semantically in every locale. |
| W2 | Windowed position and content size persist through three close/reopen cycles and an app restart without non-client-frame or DPI drift. |
| W3 | Maximized is the live and saved mode; restoring returns to the last valid windowed `normalBounds`. |
| W4 | Full screen is the live and saved mode; leaving it restores the last valid windowed `normalBounds`. Mark blocked if no supported full-screen action is reachable. |
| W5 | Minimized is never persisted as a restore mode; Windowed and Maximized return to their prior non-minimized mode. |
| W6 | Rapid move/resize/mode transitions persist the final accepted terminal placement; stale events from an old generation cannot write into a new generation. |
| W7 | A permanent zero-tab window retains its exact name, unique native host, and latest placement across repeated generations and app restart. |
| W8 | A permanent three-tab window survives close-during-launch without ownership leaks; order, active tab, hidden/audio state, dormant hydration, name, and placement remain correct. |
| W9 | Clean exit restores only the windows that were live at exit; a previously closed permanent window remains stored and can be shown manually. |
| W10 | Moving across same-scale displays persists the target display and visible work-area placement through close/reopen, restart, maximize, and full screen. |
| W11 | Mixed-scale `WM_DPICHANGED` transitions preserve logical content size, work area, scale, and `normalBounds` without cumulative drift. |

Geometry round trips allow at most ±1 logical pixel and may not accumulate over
three cycles. Placement truth requires agreement between Win32 readback,
RuntimeKernel projection, SQLite, generation/revision transcript, and the final
flush or destroyed terminal event.

## Result policy

- Report each case as `PASS`, `FAILED`, or `BLOCKED` with evidence paths.
- Missing mixed-display hardware makes W10/W11 `BLOCKED`, never `PASS`.
- Do not rerun a product failure into green. One retry is allowed only after an
  evidenced infrastructure classification, and both attempts remain recorded.
- Final `PASS` requires all available mandatory cases and gates on the same SHA;
  list every Windows or macOS gate still pending CI.
