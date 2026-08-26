# Managed Macro Shortcuts

This document is part of [System WebView Runtime Contract version 19](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

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
