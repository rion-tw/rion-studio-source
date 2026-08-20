# Native Projections and Placement

This document is part of [System WebView Runtime Contract version 16](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

## Native tab chrome projection

`RuntimeTabChromeProjectionRecord` is the complete native tab-chrome authority.
Presentation state supplies visible order, active tab, and hidden state; the
Core owner snapshot may refresh matching role metadata but cannot add, remove,
move, select, or hide a tab. The projection also carries the exact window generation, lifecycle
epoch, semantic projection revision, tab metadata, display state, fullscreen and
toolbar state, language, and theme. Identical semantic content reuses its
revision; a topology or active-tab change advances it.

`automaticInputPaused` is an independent orange, non-blocking status for a
focused embedded-frame input context. It does not change tab phase, cover game
content, or take focus. `automaticInputRestartRequired` has display and tooltip
priority when both flags are observed. Both Windows HTML chrome and macOS
AppKit render the same four-language meaning.

On Windows, every tab-strip document load creates a new renderer instance ID and
announces `RuntimeTabChromeReadyRecord`. Native code then sends a complete
replace projection for that exact instance. Until hydration completes, the
renderer queues deltas. Atomic hydration removes extra tabs, creates missing
tabs, replaces metadata, order, active and ARIA state, and then replays only
newer deltas. An acknowledgement is accepted only when instance, revision,
observed order, and observed active tab all match. Old instances, stale
revisions, wrong order, wrong active state, and late acknowledgements cannot
complete current work.

Windows waits at most two seconds for projection acknowledgement and resends the
complete projection once. A second failure terminalizes that projection with
`TAB_CHROME_PROJECTION_TIMEOUT`; the committed live tab state remains unchanged
and reconciliation continues independently. A newly ready renderer supersedes
pending projections for the old instance, which makes WebView reload recovery
deterministic instead of depending on retained DOM.

macOS consumes the same projection builder without a renderer instance ID. The
AppKit controller applies every item idempotently and reads back exact order and
active tab before acknowledgement. WKWebView/AppKit remains the product reference
for observable order and selection, while Windows is required to converge to
that behavior through its renderer protocol.

## Destructive tab stop boundary

Stop first removes the live tab and creates an idempotent tombstone containing
its slots and expected owner generations. Cancelling a provisional launch is a
normal applied outcome and never enters saved state. For a live tab, early input
revocation and surface isolation precede owner release.

The successful close boundary is: the tab is absent from live UI, its login,
input, and overlay capabilities are revoked, and every owned WebView is proven
isolated. A blank controller may remain in the retired registry for background
reclamation; this returns `applied` with
`tabStopIsolatedReleasePending`. Native chrome mismatch likewise returns applied
and schedules reconciliation. Only failure to prove isolation is
`indeterminate`; the tombstone retains the generation fence, roles are
quarantined, and a second login surface cannot be created. SQLite is not part of
the stop receipt and can never restore the closed tab.

Ordinary role LocalStorage is durable state owned exclusively by that role's
WebView2 profile or WKWebsiteDataStore. Tab hide, tab/window close, surface
replacement, process recovery, and clean restart must not evaluate, enumerate,
snapshot, clear, forward, or replay page LocalStorage. The user-consented Chrome
Profile import is the sole exception: it may transfer exact launch-origin
LocalStorage once with readback and rollback. The independent Windows cookie
checkpoint remains cookie-only and cannot become a LocalStorage writer.

## Live window snapshot persistence

One process-wide persistence coordinator keeps only the newest dirty revision
for each saved live window. A 200 ms debounce coalesces revisions and writes the
current set of dirty windows in one SQLite transaction: placement,
ordered tabs, active tab, role-slot demand, zoom, hidden state, and audio state.
Runtime role ownership is never serialized. Core compares
`(windowId, windowGeneration, revision)` and returns `superseded` for an older or
duplicate write.

An applied live snapshot fences that saved tab order for the lifetime of the
window. Later Core owner or launch-phase projections may refresh matching tab
metadata, but they cannot replace the live order, selection, visibility, or
SQLite order. The fence retires when the live window generation closes.

A failed batch leaves every newest snapshot dirty. Retries use 250 ms, 1 s, 5 s,
then bounded exponential backoff up to 30 s. Failure never mutates
`LiveWindowTabStore` or native chrome. Snapshot construction reads only the
already-committed in-memory live tab and runtime metadata; it does not query
Core, SQLite, AppKit, or a WebView. `LiveWindowTabStore` itself retains complete
persistable tab and role-slot metadata, so teardown never reconstructs topology
from Core or a native host. Window close immediately enqueues that final live
revision before teardown, continues closing without waiting, and retains the
captured input so retries do not depend on a native window handle. Application
exit makes one immediate dirty-revision enqueue and records any remaining
revision without blocking shutdown.

“Save as New Game Window” captures the same complete live-window record and
writes it directly through domain validation to SQLite. A detached transient
window is not required to exist in Core's role-ownership snapshot, and Core
cannot reject the save because its launch-time window association differs.
Native title/menu refresh is a downstream projection: failure defers that
refresh and never deletes or rolls back the saved Game Window.

Saved-window restore seeds the complete `LiveWindowTabStore` and native tab
chrome in saved order before starting any role surface. Surface creation may
still prioritize the saved active tab for first paint and role ownership, but
that owner-priority sequence is never observable as tab-strip insertion order.
Each later create replaces the matching reserved presentation item in place;
there is no final corrective reorder after the window becomes visible.

## Display topology and tab dragging

Display topology reconciliation freezes one observed topology revision and one
remap plan. Native window movement, child-surface layout, readback, runtime
placement, and persistence form the `topologyCommitted` transaction; the
revisioned projection is published from that committed state. A failure before
terminal commit compensates already attempted native mutations in reverse
order. Successful compensation is `failed`; incomplete compensation is
`indeterminate` with a rollback count. A stale observation is `superseded` and
cannot overwrite a newer topology. Both platforms are tested with explicit
platform inputs even when only one native shell is locally available.

A runtime tab drag has one stable tab identity and a lifecycle fence from
pointer-down to drop. Gesture completion is not receipt- or deadline-gated;
duplicate and late semantic events are silent `superseded`. A newer user gesture supersedes older background projection;
old source order, Core order, persistence revision, or native readback cannot
reject the final order currently visible in the UI. An accepted AppKit or HTML
drop is never visually compensated by a later Core, surface-transfer, or SQLite
failure. Core advances role ownership only, WebView transfer retries toward the
committed host, and the retained live-window revision retries durability
independently.

On macOS, AppKit owns the held gesture and updates in-strip reorder previews and
insertion indicators synchronously. Each changed preview reports its complete
visible order; the native callback commits that order under one short
`LiveWindowTabStore` lock and schedules persistence without querying Core,
SQLite, WebViews, or native readback. The equivalent Windows HTML preview emits
the same complete-order intent. Hover intents are coalesced and SQLite writes
are debounced latest-wins, so intermediate orders may be skipped on disk but
never applied backward to the UI. Leaving every tab-strip hit region uses the
original live native-window preview: coalesced pointer samples enter only the
in-memory SystemRuntime lane, which creates or positions the provisional native
window and moves the real WKWebView surface. It never captures a frozen game
viewport or tab bitmap and never consults Core or SQLite. The AppKit dragging
item stays transparent so only the current titlebar's real tab UI is visible.
Returning to a tab strip reparents
the same surface into the hovered live host. The macOS live-drag transfer never
hides a WKWebView before reparenting, never makes the held AppKit tab transparent
when it exits a strip, and promotes the target insertion slot to the real tab in
the same native layout pass. Full role/divider layout runs only after that visible
transfer; transient move and hover samples are latest-wins across both event
types. These native transitions run behind the AppKit callback, so no receipt,
persistence result, Core layout, or topology readback can block pointer delivery.
The terminal drop only closes the drag lifecycle and materializes any pending
cross-window surface transfer. It does not reorder AppKit again: the visible
order is already live and persistence continues on its independent latest-wins
background lane. Cancellation only releases drag cursor, motion, and
pointer-pass-through resources. The last topology already visible in AppKit or
HTML remains live; cancellation never restores a source snapshot.
Pointer pass-through is a session- and window-generation-scoped lease. A
terminal callback atomically retires only its own lease, immediately restores
mouse handling on every involved host, and reasserts a newer lease if another
drag started during the native call.

Activation, native tab-menu lookup, and close resolve a tab's window from
`LiveWindowTabStore`. A temporarily stale Core/surface owner can only schedule a
background surface move toward that live owner; it cannot move the live tab back
to the runtime's older window. Native close commits the live tombstone in the
AppKit callback turn before Core stop and controller release continue in the
background.

A newly observed native drag session supersedes an abandoned macOS session whose
terminal destination callback was not delivered. Late callbacks for a completed,
superseded, or never-accepted session are idempotent no-ops and never surface a
`TAURI_TAB_DRAG_STALE` user error.
