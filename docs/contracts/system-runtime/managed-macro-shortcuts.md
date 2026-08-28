# Managed Macro Shortcuts

This document is part of [System WebView Runtime Contract version 21](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

## Physical ownership and admission

The authenticated role overlay is the single owner of a physical macro-shortcut
lifecycle. It captures only a uniquely matched, enabled shortcut in an
input-admissible game context. Unbound or conflicting chords, editable and IME
input, and operating-system or runtime-reserved shortcuts remain pass-through.
For an owned chord, the physical main-key `keydown`, repeat, and `keyup` never
reach the page directly; modifier events retain their physical DOM lifecycle and
exact left/right codes. One `pressId` and modifier-side snapshot identify the
owned cycle.

Every replacement main-key event enters the selected role's existing native
input lane and carries the accepted application lifecycle epoch, role input
epoch, and surface generation. Native delivery arms the shortcut-suppression
guard only for the replacement main key, waits for the exact trusted DOM event
to finish page propagation, and accepts success only from that acknowledgement.
Role/WebView authorization, automatic input context, epoch, generation, and
page-observation failure all terminalize fail-closed. An indeterminate delivery
uses the existing input quarantine and restart-required recovery contract; it
cannot admit a macro action.

## Toggle and while-held ordering

A toggle waits until the entire physical chord is released and the final
pass-through modifier release finishes propagation. Native then replays one
balanced chord in this order: modifier downs, main-key down/up, modifier ups.
Only after every trusted DOM acknowledgement succeeds may the overlay dispatch
the macro `toggle`.

A while-held shortcut waits for replacement main-key down acknowledgement before
dispatching `press`. Physical release first completes the replacement keyup
acknowledgement and then dispatches `release`. If release was observed while
`press` was still pending, the same ordered chain finishes and uses
`complete_first_iteration`, producing exactly one admitted iteration. Blur,
hidden-page, page teardown, and overlay disposal use `immediate` release after
native key cleanup and clear the same Core lease.

This flow is event-bound. It adds no polling, retry timer, replay watchdog, or
second pressed-key owner; cancellation and supersede cannot be converted into a
macro start.

## Toggle-held continuity across role and tab changes

A toggle macro may retain a Core-owned `hold_until_stop` key after its initiating
shortcut and first iteration have completed. A visible role `blur` and native
tab-hide presentation are authoritative input-context-loss events, but they do
not release that Core key. On blur, the authenticated overlay first releases
pass-through physical keys and any active while-held shortcut lease, waits for
those ordered actions and page event propagation to finish, and then reports a
monotonic loss revision. Hidden-page overlay work performs cleanup only; the
native presentation receipt owns tab-hide continuity so background throttling
cannot prevent its terminal event.

The System Runtime serializes an admitted event through the role's native input
lane and reasserts every still-Core-owned key with the existing guarded trusted
DOM acknowledgement. Windows uses this event to restore WebView2 consumer state
cleared by focus or visibility loss. WKWebView preserves that state, so macOS
schedules no tab-hide restoration and any delivered blur request terminalizes
`notRequired`. The operation does not advance the input epoch, change the macro
status or iteration, synthesize a new invocation, select the role, or focus or
reveal a hidden surface. A role with no remaining Core-owned key terminalizes
`noHeldKeys`; stale role, generation, or input context terminalizes
`superseded`. This ordering is event-bound and adds no polling, timeout
reconciliation, generic debugger retry, or second pressed-key owner.

## Managed middle-button shortcuts

The same authenticated role overlay may uniquely own a physical middle-button
shortcut, with or without Ctrl, Alt, Shift, or Meta. Admission uses the same
enabled macro, source-role, selected surface, editable/IME, automatic-input
context, lifecycle epoch, role input epoch, and surface-generation fences as a
managed keyboard shortcut. Unbound or conflicting middle-button combinations
remain pass-through.

An owned middle-button `mousedown`, `mouseup`, and resulting `auxclick` are
stopped at capture and never reach the page. One `pressId` and modifier snapshot
own the cycle. Toggle dispatch waits for middle-button release and the final
pass-through modifier release to finish propagation. While-held dispatches
`press` from the accepted down event and pairs it with `release` from the exact
up event; early release completes the first admitted iteration. Blur, hidden
page, teardown, and overlay disposal use immediate release and clear the Core
lease.

Automatic middle-click macro steps arm the overlay suppression guard before
native submission. Their trusted down/up/auxclick sequence remains page-visible
but cannot recursively enter the managed shortcut owner. The guard is scoped to
one exact sequence and a later physical middle click starts a new ownership
cycle. These flows are event-bound and use no timer, polling, or watchdog.
