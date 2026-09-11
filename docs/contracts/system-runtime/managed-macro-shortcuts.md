# Managed Macro Shortcuts

This document is part of [System WebView Runtime Contract version 22](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

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

Electron preserves this contract through one cross-platform sequence executor;
it does not expand a key action into a guessed main-key event. Every key action
first enters Rust `EmbeddedInputRuntime`. Core returns the ordered
`rawKeyDown`/`keyUp` effects, active-code snapshots, repeat bit, and shortcut
suppression intent. Electron submits exactly one effect at a time through the
platform transport and advances only after the exact Role preload reports the
trusted DOM event after synchronous page propagation. Electron then commits the
Core transition. Repeated owners, a key retained by another owner, and a tap of
an already-held key are therefore decided only by Core; the last case emits one
trusted repeat keydown without a balancing keyup that would release the existing
owner.

Normal macro modifiers use canonical left-side DOM codes selected for the target
platform and are synthetic Core owners. A managed shortcut retains the observed
left/right physical codes. Toggle replay makes those exact modifiers synthetic,
while the `keyDown`/`keyUp` phases of a while-held shortcut are
`physical-pass-through` and submit only the replacement main key. Before every
native effect, the authenticated isolated-world guard reports the eight-sided
physical modifier snapshot. The adapter merges non-owned physical modifiers into
the event flags without converting them into synthetic Core ownership. A managed
hold must still match the admitted ownership snapshot. Its release remains
cleanup-reachable when focus continuity changes that snapshot: the original sides
identify the owned cycle, while the freshly armed sides determine release-event
flags.

If an effect fails before submission, Core rolls the pending transition back. If
a later effect fails after a confirmed prefix, Electron submits inverse effects
for only that prefix in reverse order and then rolls Core back. A missing trusted
DOM receipt after submission, document replacement, native transport
indeterminacy, or uncertain compensation quarantines only the affected Role. It
never retries the effect or switches transport, and elapsed time is never
success. Surface retirement clears the Role's embedded-input state. Context-loss
continuity requests one complete Core `embeddedKeysReassert` result and executes
that result through the same ordered lane instead of rebuilding held keys in
Electron.

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

## Modifier continuity across native focus loss

The overlay remains the single physical shortcut owner. The macOS Game Window
adapter keeps only a window-lifetime mirror of the eight momentary left/right
Shift, Control, Option, and Command codes delivered by physical AppKit events;
Rion-injected macro events never enter that mirror. On `resignKey`, AppKit sends
trusted `flagsChanged` releases in reverse press order to each original
responder and folds any active Ctrl+Tab handoff into those exact releases. On
`becomeKey`, it checks each neutralized side against combined-session physical
key state and reasserts only still-held sides, in original order, to the current
responder before later keyboard input. A missing window, responder, or replaced
controller discards the handoff rather than replaying it across generations.
The native neutralize and reassert callbacks are bounded diagnostic events, not
logical input mutations. The Electron main-process consumer records only the
window, optional tab, platform, and modifier count through Core logging; a
logging failure cannot alter focus handling or surface a shell error.

Top-level overlay blur clears ordinary keys and while-held leases immediately,
then defers only pass-through modifier fallback releases to a microtask in the
same event turn. A trusted native keyup removes its exact side before that
microtask; otherwise the overlay synthesizes one page keyup as a fallback.
In-page focus transfer, hidden, pagehide, and disposal keep immediate cleanup.
Windows retains WebView2 focus-loss cleanup plus the same overlay fallback
semantics. This ordering is event-bound and adds no polling, timeout, or second
macro-shortcut owner.

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
DOM acknowledgement. Electron/Chromium on Windows uses this event to restore
consumer state cleared by focus or visibility loss. The retained macOS AppKit
host preserves the same Role and responder fences while adapting Chromium
surfaces. The operation does not advance the input epoch, change the macro
status or iteration, synthesize a new invocation, select the role, or focus or
reveal a hidden surface. A role with no remaining Core-owned key terminalizes
`noHeldKeys`; stale role, generation, or input context terminalizes
`superseded`. This ordering is event-bound and adds no polling, timeout
reconciliation, generic debugger retry, or second pressed-key owner. Production
continues to use the Windows `sendInputEvent` and retained macOS AppKit submission
leaves until a separately gated cross-platform transport is promoted.

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

## Execution-role modes

`executionMode` distinguishes `source_role` from `selected_roles`; an absent
field retains the existing fixed-role behavior. Core resolves dynamic targets
from the authenticated overlay source or the role explicitly chosen in the
main application's launch dialog. It never derives a source from focus. The
`all_roles` source scope includes future roles; a selected scope remains bounded
when roles are deleted. The entire reachable call graph is checked for required,
allowed, active sources before admitting any input. Dynamic children inherit the
original source; fixed children retain their own assignments.

A dynamic invocation's toggle, press/release lease, duplicate admission, and
role-local stop are scoped to its source role. Stopping from one source must not
remove another source's statuses, recovery intent, or descendants. The main
application's global stop still cancels every execution of that macro. Shortcut
status projections for dynamic macros are source-local; fixed-role shortcut
projections retain their existing aggregate behavior. Admission, native input,
recovery and terminal cleanup retain the same event-bound epoch/generation
fences on both stable and Chromium runtimes.

Portable schema 20 preserves the execution mode and source restrictions even
without a shortcut. Schemas 11–19 remain readable as fixed assignments when the
mode is absent. SQLite records use the same backward-compatible optional field.
