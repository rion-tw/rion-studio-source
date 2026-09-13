# Managed Macro Shortcuts

This document is part of [System WebView Runtime Contract version 22](../../system-webview-runtime-contract.md) and defines the managed-shortcut ordering introduced by Chromium runtime contract v33 and the exact modifier projection required by v34. The entry document owns the compatibility version and routes readers to the minimum normative section required for a task.

## Physical ownership and admission

The authenticated role overlay is the single owner of a physical macro-shortcut
lifecycle. It captures only a uniquely matched, enabled shortcut in an
input-admissible game context. Unbound or conflicting chords, editable and IME
input, and operating-system or runtime-reserved shortcuts remain pass-through.
For an owned chord, the physical main-key `keydown`, repeat, and `keyup` never
reach the page directly; modifier events retain their physical DOM lifecycle and
exact left/right codes. One `shortcutCycleId` and modifier-side snapshot identify the
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
left/right physical codes. Its `keyDown`/`keyUp` phases are
`physical-pass-through` and submit only the replacement main key; there is no
release-time chord replay. Before every native effect, the authenticated
isolated-world guard reports the eight-sided physical modifier snapshot. The
adapter retains the complete snapshot for exact-side adoption, interleave
classification, diagnostics, and platform phase cursors. It merges that snapshot
into event flags only for `physical-pass-through` replacement keys and macro
click steps. Synthetic macro keyboard effects, including held-key reassertion,
derive their modifier flags only from Core's active-code snapshot and never
inherit a live non-Core physical modifier. A managed hold must still match the
admitted ownership snapshot. Its release remains cleanup-reachable when focus
continuity changes that snapshot: the original sides identify the owned cycle,
while the freshly armed sides determine release-event flags.

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

## Press and hold ordering

A `press` captures a non-repeat physical main-key `keydown`, sends the managed
`keyDown`, and dispatches the macro `press` immediately after that trusted DOM
acknowledgement. A later physical `keyup` performs only the matching managed
`keyUp` cleanup. It does not decide whether the accepted press runs and cannot
cancel the action if it arrives before the macro response. A rapid keyup waits
only until the activation IPC has been submitted, not until the macro finishes,
so cleanup cannot overtake the accepted press. The completed keyup retires the
cycle and permits the next press, which preserves the existing second-press stop
behavior at Core. The exact `keyUp` uses cleanup intent, so it remains admissible
after a concurrent input failure has fenced the Role. If its native receipt is
indeterminate, both Core and Electron retire that exact physical cycle while the
Role remains quarantined for recovery. Any later physical `keydown` observed
before cleanup terminality is rejected instead of being queued for replay after
recovery.

A `hold` also waits for the managed `keyDown` acknowledgement before dispatching
`hold-start`. Its physical `keyup` immediately dispatches `hold-release` with the
same `shortcutCycleId`, independently of the outstanding start response and the
parallel managed `keyUp` cleanup. Core records an early release when it wins the
race, so a short press may complete no iteration and can never resurrect after
release. Blur, hidden-page, page teardown, and overlay disposal use the same
immediate hold release and clear the same Core lease.

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

The AppKit local event boundary directs each non-Command physical key to its
exact registered Role responder once. It marks that `NSEvent` before delivery;
if Chromium redispatches the same unhandled event through NSApp after DOM
propagation, the event-scoped mark consumes that fallback without a second Role
delivery, native key equivalent, or window action. A controller-local delivery
fence also consumes a synchronous nested redispatch when Chromium copies the
`NSEvent` and therefore loses the event-scoped marker. The mark does not
classify the event as macro-generated, does not survive the event object, and
does not intercept Command shortcuts or native text/titlebar responders.
The native input probe exposes separate physical key-down and key-up cursors in
addition to the total projected-event cursor. Receipt correlation must use the
phase cursors to distinguish an opposite key phase while retaining the total
cursor for modifier and pointer projections. A physical key-up that wins the
race against its managed key-down acknowledgement cannot consume that
acknowledgement or force the Role into indeterminate recovery.
If native evidence precedes its DOM receipt while a CDP event arrives first, the adapter defers
and reconciles both exact phases; rapid shortcuts cannot steal a key-up or leave a Macro recovering.
Each trusted-input terminal diagnostic retains the native total, key-down, and
key-up cursor before and after correlation together with the last observed DOM
event and its evidence classification. Debug exports can therefore distinguish
an automatic acknowledgement, an opposite-phase physical race, and a true
physical interleave without reconstructing identity from timestamps.

Top-level overlay blur clears ordinary keys and hold leases immediately,
then defers only pass-through modifier fallback releases to a microtask in the
same event turn. A trusted native keyup removes its exact side before that
microtask; otherwise the overlay synthesizes one page keyup as a fallback.
In-page focus transfer, hidden, pagehide, and disposal keep immediate cleanup.
Windows retains WebView2 focus-loss cleanup plus the same overlay fallback
semantics. This ordering is event-bound and adds no polling, timeout, or second
macro-shortcut owner.

## Press-run held-key continuity across role and tab changes

A press macro may retain a Core-owned `hold_until_stop` key after its initiating
shortcut and first iteration have completed. A visible role `blur` and native
tab-hide presentation are authoritative input-context-loss events, but they do
not release that Core key. On blur, the authenticated overlay first releases
pass-through physical keys and any active hold shortcut lease, waits for
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
uses one in-process CDP Input owner on both platforms. Windows View and retained
macOS AppKit code continue to prove exact host/generation and unchanged focus,
but do not submit the final event. Debugger detach or a rejected/uncertain CDP
command terminalizes and quarantines the Role; there is no native transport
fallback or same-document reconnect.

## Managed middle-button shortcuts

The same authenticated role overlay may uniquely own a physical middle-button
shortcut, with or without Ctrl, Alt, Shift, or Meta. Admission uses the same
enabled macro, source-role, selected surface, editable/IME, automatic-input
context, lifecycle epoch, role input epoch, and surface-generation fences as a
managed keyboard shortcut. Unbound or conflicting middle-button combinations
remain pass-through.

An owned middle-button `mousedown`, `mouseup`, and resulting `auxclick` are
stopped at capture and never reach the page. One `shortcutCycleId` and modifier
snapshot own the cycle. Press dispatches on the accepted `mousedown`; `mouseup`
only retires that cycle. Hold dispatches `hold-start` from the accepted down
event and pairs it with immediate `hold-release` from the exact up event. Early
release does not guarantee a first iteration. Blur, hidden page, teardown, and
overlay disposal use the same immediate release and clear the Core lease.

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

A dynamic invocation's press start/stop state, hold lease, duplicate admission, and
role-local stop are scoped to its source role. Stopping from one source must not
remove another source's statuses, recovery intent, or descendants. The main
application's global stop still cancels every execution of that macro. Shortcut
status projections for dynamic macros are source-local; fixed-role shortcut
projections retain their existing aggregate behavior. Admission, native input,
recovery and terminal cleanup retain the same event-bound epoch/generation
fences on both stable and Chromium runtimes.

Portable schema 23 exports only `press` and `hold`. Schemas 11–22 normalize a
missing activation mode and the retired press spelling to `press`, and normalize
the retired held spelling to `hold`; schema 23 rejects those retired spellings.
SQLite schema 31 performs the same stored-data normalization in its migration
transaction. Execution mode and source restrictions remain preserved even
without a shortcut.
