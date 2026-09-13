# Trusted Input Receipts

This document is the normative Chromium contract v35 source for trusted-input
receipt provenance, uncertain-edge neutralization, quarantine, and retained
terminal evidence. The broader recovery transaction remains defined by
[Lifecycle and Recovery](lifecycle-and-recovery.md).
It preserves consumed System WebView Runtime Contract version 22 data
compatibility without restoring that retired shell.

## Transport and provenance

The only production automatic-input transport is in-process CDP on the exact
managed Role `WebContents`, restricted to `Input.dispatchKeyEvent` and
`Input.dispatchMouseEvent`. A debugger detach or rejected command is terminal
for that document. The runtime does not reconnect, switch transports, or infer
success from elapsed time.

Every automatic-input arm and its CDP submission use the same modifier
projection. Synthetic macro keyboard effects and held-key reassertions include
only Core-owned active modifier codes; live physical Shift, Control, Alt, or
Meta state cannot change their DOM flags or `key` value. Managed
`physical-pass-through` replacement keys and macro clicks retain the physical
modifier snapshot. Direct player input remains outside this projection and is
unchanged.

After every Core key effect, the arm also names each exact physical modifier
side that is still down but absent from the effect's resulting active-code set.
Once the guarded main-key lifecycle or synthetic modifier-ownership release is
accepted, CDP submits one `rawKeyDown` re-projection for each named side. The
isolated overlay stops that re-projection before page listeners but deliberately
does not prevent Chromium's native default modifier update; the isolated overlay
must still return its exact authenticated observation through the private
binding. This restores Chromium's
still-held modifier state for the next physical shortcut without creating a
second page-visible modifier owner, sending a synthetic modifier keyup, retrying,
or inferring success from time.

The isolated preload reports every ordered trusted key, pointer, and semantic
mouse observation for its exact document. It sends the receipt synchronously
from the capture callback so a later physical event cannot overtake an earlier
CDP observation at the process boundary. It does not compare an observation
with the armed CDP effect and cannot terminate the lane.

Before delivering a physical event, the retained AppKit target path or exact
Windows foreground HWND owner advances a monotonic per-owner sequence by the
number of DOM observations projected by that native edge. CDP submission never
advances the sequence. Electron main correlates the native and DOM streams:

- a proven physical event passes to the game and does not consume the pending
  automatic-input action;
- an observation without physical provenance advances the CDP action only when
  it exactly matches the expected receipt;
- when a native physical edge is counted before its DOM observation but an
  intervening CDP observation arrives first, main keeps the ambiguous receipt
  pending and reconciles it when the exact phase/category observation arrives;
- an unresolved same-identity race, sequence gap or regression, unknown
  provenance, or changed document, frame, surface, input-epoch, or stable native
  host identity fails closed as indeterminate.

The native adapter requires the strict foreground/focus/first-responder proof
before CDP submission. After CDP accepts the command, completion is fenced by
the same Role, surface generation, document, native host/controller generation,
and current input-capable host mode. Mutable focus, first-responder, and geometry
fields may drift while the exact event is propagating; that drift is diagnostic
evidence and cannot retroactively turn an otherwise exact DOM receipt into a
partial submission.

This reconciliation is event-bound: a later trusted DOM receipt is the only
event that can disambiguate the queued receipt. It adds no polling, retry,
reordering timer, or inferred success. Ordinary in-document loading is not a
navigation fence. A genuine main-document replacement still fences automatic
input until the new document and its exact receipt lane are ready.

Physical evidence is private to the native host, Electron main, and isolated
preload. It does not change `window.rionStudio`, Macro persistence, JSON, or
SQLite contracts.

## Uncertain edges and neutralization

Sequence terminal evidence records whether the current action is uncertain,
which key or button edges may have applied, whether cleanup proves a neutral
active set, and whether the Role remains quarantined.

An uncertain `rawKeyDown` belongs to the possible-applied set even when no DOM
receipt was accepted. After compensating the exact confirmed prefix in reverse
order, the role lane retains every confirmed or possibly-applied key code and
the last uncertain pointer action. A Core-issued `neutralizeInput` cleanup
transaction sends idempotent `keyup` effects for that union, non-modifiers
before modifiers, followed by exactly one `mouseReleased` when a pointer-down
may have applied. It then clears Core embedded-key ownership. The cleanup never
sends a new pointer-down and never retries the original macro action.

Only exact cleanup receipts, an empty active set, and exact Core rollback may
publish `cleanup-neutral`. For a native-input failure, Core cancels the affected
tree without retaining press/loop restart intent: successful neutralization
reopens the same live document for a later user start, while the original Macro
stays stopped and its running/recovering badge is removed. Temporary
`embedded-frame` context recovery remains a distinct pre-submission path and may
restart eligible press/loop roots after the exact same document reports `game`.
An uncertain cleanup, unavailable provenance, terminal CDP session, or uncertain
Core rollback leaves the Role `restart-required`; the original effect is never
retried.

## Quarantine and teardown

Quarantine and restart-required projection release the managed shortcut guard,
hold lease, and pass-through ownership for the affected Role. Automatic
input remains disabled, while player keyboard and pointer input fail open.

Role, tab, and window teardown advances the native input epoch and drains the
exact per-Role lane before native surface isolation. An admitted callback
terminalizes while its WebView remains attached; cleanup from an older Core
epoch that has not started is superseded. Native surface release never
overtakes either outcome.

Live blur and tab-hide held-key continuity follows the managed-shortcut
contract. Game Window focus loss neutralizes pass-through momentary modifiers
through the platform adapter before the page fallback. Focus return restores
only the exact left/right modifier sides still physically held on the same live
window generation; Caps Lock and Fn are outside this handoff.

Role close cancels the recovery owner before retiring the surface. A late
`MACRO_INPUT_RECOVERY_STALE` result for that retired owner terminalizes as
cancelled or superseded and is not projected as a shell error.

## Diagnostic retention

Electron main retains 128 recent terminal records and a separate 32-entry
abnormal-incident ring. Each record includes request, Role, input epoch, surface
generation, failure stage, CDP terminal reason, submission certainty,
physical-interleave classification, changed native-proof field names, a bounded
ordered Core/Electron/preload/native/CDP trace, truncation/drop counts, cleanup
result, and recovery result. The diagnostics snapshot also reports journal
capacities, retained counts, dropped counts, oldest/newest capture times, and
collector completeness. Abnormal records are persisted at error level so a
normal debug-log filter cannot remove the only failure evidence. Role closure
does not erase this evidence.
Every record also captures the exact modifier re-projection codes, the final CDP
modifier bitmask, and the last observed DOM modifier bitmask. These relation-level
fields distinguish a missing projection, an incorrect CDP descriptor, and a DOM
observation mismatch without retaining typed text.
Consecutive identical trace observations are coalesced before the bound is
applied, so a noisy DOM observation lane cannot evict the terminal step that
identifies the actual failure stage.

The journal never stores typed text. Physical observations are exported only as
relationship classes such as `unrelated`, `same-identity`, and
`modifier-change`. Individual unavailable native collectors do not replace the
remaining runtime diagnostics with `INPUT_DIAGNOSTICS_UNAVAILABLE`. Older
diagnostic fixtures may omit the v32 provenance field; a v35 runtime provides
the bounded trace and incident summary.
