# Ownership and Activation

This document is part of [System WebView Runtime Contract version 16](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

## Window and tab ownership

The presentation actor is the only normal path for runtime window show, hide,
focus, restore, fullscreen, maximize, and role focus. It coalesces pending work
per window and records a `superseded` receipt for every request it replaces.
Tab topology commits only to `LiveWindowTabStore`, then queues native
presentation. Geometry and window-mode operations retain their own native
receipts, but neither Core nor SQLite participates in a tab UI commit.

`LiveWindowRecord` and `LiveTabRecord` contain topology and persistence demand
only. Native bindings, desired/applied follower revisions, and host visibility
live in `NativeTabProjectionStore`; loading, degraded, and provisional phases
live in `TabRuntimeStatusStore`. These stores do not share a mutable record, so a
native or status update cannot acquire topology write access by construction.

Platform-specific code may perform the native calls inside the adapter or a
bounded rollback transaction. It must not make an independent product decision
about the active tab or visible role.

Runtime window close captures the final immutable live snapshot, installs one
tombstone per live tab, removes the live window, and submits native close before
starting Core role cleanup. Repeated or late callbacks are silent
`superseded`. A surface-isolation uncertainty may quarantine an exact role
owner, but it cannot restore the window or any tab. `rion://window-lifecycle`
therefore reports the visible state commit; background cleanup has its own
generation-fenced diagnostics.

The teardown scope is the exact tab-ID list read from `LiveWindowTabStore` when
close is accepted. Core launch-time `windowId` metadata is never used to infer
that scope: a tab detached into another live window survives closing its source,
even while Core role bookkeeping is still settling. The explicit list flows
one way into role isolation and cannot move or restore visible tabs.

The main window uses a bounded FIFO actor for show, hide, minimize, maximize,
fullscreen, focus, and readback. Its queue limit is 64; stop and capacity errors
terminalize accepted operations rather than dropping them. Readback and events
share `NativeWindowStateRecord`. Focus itself is global: the latest intent lease
across the main window and runtime windows wins, a matching native focus
observation confirms it, and a different observation supersedes older leases.
Every lease is scoped to the exact window generation and lifecycle epoch.

### Launcher destination policy

Role and workspace launch always reuses an already admitted live source owner,
regardless of a renderer destination request. Otherwise an automatic launch
chooses the last native-focused live Game Window, then the persisted
last-focused ID only while it is still live, then the sole live Game Window.
Zero live windows, or multiple live windows without usable focus history,
creates a new transient Game Window. Automatic launch never selects a dormant
saved window by list order, UUID, or another implicit fallback.

The trusted main renderer may explicitly request a new transient window or an
exact live/saved Game Window. Rust resolves the requested ID against the
authoritative live topology and saved catalog. A live target receives the new
foreground tab. A dormant saved target focuses its existing matching source tab
or appends the source as the foreground tab before event-bound hydration. Empty
saved windows are valid targets. Missing, stale, recovering, restoring, or
failed targets reject with a stable error and never fall back silently.

### Role slot and native-surface ownership

A runtime tab owns a stable list of role slots. Every slot keeps its slot ID,
role ID, normalized rectangle, and zoom policy for the lifetime of the tab,
whether it currently contains a role surface or a local placeholder. Layout is
always computed from the full slot list, so stopping or moving one role never
reflows the remaining slots.

At most one native role WebView may exist for a role. Core stores that global
surface owner as `{ windowId, tabId, slotId, generation }`; all other slots for
the role project `blocked`. A stopped role has no owner and all of its slots
project `available`. Workspace state is derived from these slot projections and
is never a second mutable ownership authority.

Blocked and available slots use a bundled local placeholder WebView. It is not
registered as a managed role surface and cannot receive macro input, role audio,
role navigation, or role zoom. Its command is accepted only from the exact
registered placeholder label and generation-fenced tab, slot, role, and owner.
The placeholder names the current owner tab when one exists and disables its
button while a claim is in flight.

A role claim is serialized by the role operation lease and generation-fenced.
Core first marks the source `stopping`; native code then closes and verifies the
exact source surface before Core moves ownership to the target as `launching`.
Only then may native code create the target surface. Input readiness commits
`running` and replaces every other occurrence with a placeholder carrying the
new owner generation. Native state locks cover only snapshot preparation and
commit and are never held across WebView creation, close, navigation, or layout
calls.

If source isolation cannot be proven, no target WebView is created and the old
owner remains fenced. If isolation succeeds but target creation or readiness
fails, Core releases the owner and every occurrence remains an available,
retryable placeholder. Closing a tab isolates only roles whose owner points to
that tab; blocked placeholders do not stop a role owned elsewhere.

Geometry, presentation, and native window controls share one mutation lane per
window. A geometry transaction snapshots native bounds and mode before mutation,
suppresses intermediate move/resize persistence, applies child WebView layout as
one reversible batch, and commits runtime placement only after native success.
Window controls remain ordered while ordinary presentation requests coalesce, so
rapid fullscreen/maximized toggles cannot collapse into the wrong final state.
Normal-mode bounds allow one logical pixel of DPI rounding. Fullscreen and
maximized geometry restoration still claims `nativeSubmission`; the explicit
tab-strip control APIs instead acknowledge completion of their native call and
do not claim that a later operating-system animation has visually settled.

`hideGameWindow`, `showGameWindowTab`, `setGameWindowTabMuted`,
`moveGameWindowTab`, `setGameWindowTabHidden`, `stopGameWindowTab`, and
tab-strip minimize/fullscreen/maximize controls return terminal receipts
directly. `moveGameWindowTabToNewWindow` returns the target window ID together
with its terminal receipt. Unhiding and `showGameWindowTab` commit the live
selection immediately and queue visibility/focus as forward-only native work;
they do not wait for or claim page readiness.

## One-way tab activation

Tab pointer selection, tab-strip Ctrl+Tab, AppKit native selection, launcher
selection, and `showGameWindowTab` first commit a new `LiveWindowTabStore`
revision. The visible selection is complete at that boundary. Renderer-facing
calls receive an immediate `applied` topology result after background native
presentation has been queued; AppKit and HTML callbacks never wait for it.

Content focus and native active-style projection run after that commit. Core has
no active-tab projection or selection mutation. Presentation work is latest-only
by window. A newer revision supersedes older work, and a late native completion
cannot repaint the old tab. There is no activation convergence timeout or
renderer acknowledgement. Same-tab activation may still enqueue idempotent
native repair work, but it never delays the UI callback or surfaces a shell
error.

## Tab topology mutation transactions

AppKit or the local HTML tab strip commits move, move-to-new-window, hide,
reorder, selection, and close intents directly to `LiveWindowTabStore`. Every
insert, replacement, removal, reorder, move, selection, audio, zoom, divider,
and placement change advances a monotonic live revision. Cross-window moves
lock both live windows in stable ID order and commit them together; there is no
post-commit memory rollback.

Move, hide, reorder, and selection do not emit a Core topology command. The
per-tab lifecycle lane remains only for destructive owner work such as stop,
where repeated requests join the same operation and role generation fences
prevent a second login surface. That owner receipt cannot define, reject, or
compensate the already committed tab UI.

The generated stop request retains identity and generation fences for owner
work and diagnostics. Expected Core order, SQLite state, and native chrome
readback are absent from the public mutation contract. Native chrome mismatch
is reconciled and logged in the background. A failed surface reparent retains
the live destination and schedules forward projection; it never moves the tab
back to an older owner snapshot.
