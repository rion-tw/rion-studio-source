# Compatible Macro Input

Chromium contract v40 preserves consumed System WebView Runtime Contract version 22
data compatibility without restoring the retired shell.

All Macro actions, including managed replacement keys and recovery releases,
use a fixed Canvas-compatible route from start to stop. The CDP rules below
continue to constrain trusted input; they are not a fallback for compatible
input. The owner authorized this default on 2026-09-14.

Core emits the existing ordered key effects and owns all logical pressed-key
state. The exact AppKit/Windows host is validated before and after the private
main-to-isolated-world operation. Only the original connected main-document
Canvas receives the event. Readiness resolves a unique/previously observed game
Canvas without focusing it; a missing or retired target fails explicitly.
On Windows, a foreground native frame can have no focused WebContents while
its tab strip owns focus. Compatible readiness and dispatch accept that exact
unfocused View observation; trusted input retains its content-focus gate.
Attachment, parent visibility, document identity and focus-fact consistency
remain required before and after dispatch.
Under v42, keyboard events merge the current native physical modifier snapshot
with Core modifiers and retain legacy key codes. A held physical Shift therefore
affects even a step with no explicit modifiers; there is no modifier isolation.
The snapshot changes only event flags and key values, not Core key ownership.
Pointer coordinates
retain the existing viewport/anchor/zoom conversion; an out-of-Canvas normal
click fails without hitting the verification overlay. Compatible pointer groups
use down, up, then click/auxclick; right clicks end with contextmenu after release
on both platforms. Cleanup sends releases
only, always to the original target.

Compatible key delivery retains the same original-Canvas metadata as trusted
key delivery, including physical modifier adoption. On Windows, moving focus
from that Canvas into another in-page control or the document body requests the
existing event-bound Core held-key continuity operation after page focus
propagation. Redirected focus settles once at the final destination; returning to
Canvas or a top-level/child-frame blur does not duplicate the observation.
Only Core may reassert keys that remain owned; the destination keeps focus, and an exact
compatible key release retires the metadata. A game handler moving focus during
keydown follows the same ordering. Overlay revision `2026-10-13.1` restores this
existing continuity path without adding polling or replaying a stopped Macro.

While that admitted keydown still owns its exact connected Canvas, a physical
same-code keyup cannot clear the game's held state. The page consumes that
release and retires only its physical observation; Core's subsequent keyup
still dispatches and clears the delivery metadata. Focus cleanup likewise
cannot synthesize a physical release over the same Core-owned Canvas hold.
This does not add key
effects, suppress physical keydown, or change receipt event-count rules.
Keyup on another Canvas or editable target is preserved. Managed shortcut
release keeps priority so a hold-to-run shortcut can still stop its Macro.

The isolated endpoint validates the document token, role/generation identity,
monotonic dispatch sequence, input epoch and declared external receipt deadline.
Its receipt echoes those identities, the owner/request, target token, exact event
count and `isTrusted=false`. For dispatched events, `applied` proves synchronous dispatch to that target,
not acceptance by game logic or a server. These receipts never consume native
physical evidence or masquerade as trusted DOM receipts. The diagnostic
`applicationPath=canvas-compatibility` and `cdpSubmissionCertainty=not-invoked`
make this distinction explicit.

An embedded-frame context does not fence this route or restart a Macro. Player
input in the frame remains native, while the same invocation and iteration
continue without a focus change, backlog replay, or an extra return-to-game click.
Document replacement, stop, lifecycle cancellation and surface teardown keep
existing Core fences. Unknown submitted delivery terminalizes indeterminate;
only exact release receipts can establish neutrality. There is no retry, polling,
time-derived success or automatic transport fallback. Games rejecting synthetic
events or disabling their own controls during verification remain incompatible.
The retained trusted route follows [Trusted Input Receipts](trusted-input-receipts.md).

## v43 modifier overlap and evidence

The compatible endpoint applies the existing Core-following modifier ownership
rules before forwarding events. An exact physical side already held is adopted
without a duplicate keydown. Releasing a Core modifier while that physical side
remains held releases ownership only; physical keyup while Core still holds the
side is consumed. Only the last holder releases the page key. This applies to
all eight momentary sides, cleanup, compensation and explicit Core reassertion.
The page mirror is delivery metadata, never an independent macro scheduler.

Private key commands preserve separate Core before/after modifier codes and the
native physical snapshot. Exact receipts distinguish `dispatch`, `adoptPhysical`
and `releaseOwnership`. Only proven modifier overlap may succeed with zero DOM
events; ordinary keys require one event. Zero-event success never claims game
delivery. Role, document, target, sequence, epoch and host fences remain required.
An unknown submitted result remains indeterminate and never triggers a retry.

At synchronous dispatch, flags also retain physical sides still observed down in
that document. A native release may precede Chromium's queued DOM keyup; it must
not remove a page-held modifier early. Core/native inheritance remains intact.
Shift-adjusted key text comes from the existing main-process descriptor mapping.
Receipt validation checks the resulting mask against these separate snapshots.

Optional `compatibleModifierEvidence` retains those snapshots, the observed
physical codes, actual event mask (null when no event was dispatched), disposition,
and the latest 64 ordered modifier transitions per document with a dropped count.
Physical, compatible and focus-cleanup sources are distinct. Missing interleave
evidence is indeterminate, not an asserted absence of physical input. Older
terminal records decode without the optional evidence. The overlay revision is
`2026-09-16.1`; runtime registration requires Chromium contract v43.
Log capture preserves this typed 64-entry evidence, including modifier-code
arrays, while retaining text redaction and the ordinary bounds for generic logs.

Legacy `keyCode` and `which` values are set through `KeyboardEventInit`, including
forwarded input and focus cleanup. Defining JavaScript properties on an isolated
world wrapper does not preserve those values in the game's main world. Native
regression tests must read both legacy fields in that main-world consumer;
isolated-world readback or a `code`-only pressed set cannot prove compatibility.

## v45 event-bound physical modifier reconciliation

A trusted physical keydown or keyup can prove a missing modifier release when
its family flag is false. After excluding forwarded, armed macro and modifier
projection events, the page removes stale physical sides in reverse press order
before admitting the triggering shortcut. The current event's exact modifier
side remains owned by the ordinary handler; a true family flag never identifies
which side was released. Native snapshot absence alone cannot trigger cleanup.

Core retains logical ownership. A remaining Core holder adopts page delivery
without a keyup; otherwise one synthetic release goes only to the original
connected document target, with current physical and Core flags and legacy key
codes. A subsequent delayed physical keyup is hidden from page listeners once,
without preventing Chromium's native flag update. A new physical keydown starts
a fresh cycle. Disposal removes the event handlers; retired targets never
redirect a corrective release to another Canvas. No timer or polling is used.

The bounded transition journal adds `physical-reconcile` as a source, retaining
actual corrective event flags or null for ownership-only/undelivered cleanup.
Existing terminal records remain decodable. Overlay revision `2026-09-20.1` and
Chromium contract v45 identify this ordering guarantee on both desktop platforms.

## v46 receipt validation and proven input neutrality

Core rollback removes logical ownership, not uncertainty about a submitted page
effect. An empty release sequence cannot prove native neutrality. Electron retains
each uncertain key and pointer until an exact release receipt clears that item;
unrelated cleanup, another input epoch, focus readiness and Core rollback do not
clear it. Partial neutralization retains only outstanding items. Core-authorized
`neutralizeInput` addresses those items in the original document. A failed release
keeps automatic input quarantined and uses the existing restart-required outcome.
Core projects restart-required lanes as unavailable through the existing Role
status, and recovery terminal events publish that projection. Surface readiness
alone cannot advertise a blocked lane as ready.
Only authoritative document replacement or exact surface retirement can discard
old-document delivery state; cleanup never redirects to a replacement Canvas.
Physical player input remains available and no failed action is replayed.

`compatibleReceiptValidation` is optional diagnostic evidence, separate from
validated delivery. It identifies the first failed identity, document, deadline,
trust, status, target, event count, modifier snapshot, disposition or history
check. Its field and bounded expected/received scalar summaries identify the
specific discrepancy, including a history entry index where applicable. Optional
reported status, event count and modifier mask are unverified claims. A rejected
receipt's reported event count never increases `observedDomEventCount` or sets
`gameDeliveryConfirmed`. Summaries are capped at 160 characters; arbitrary objects
are not serialized. Existing log redaction still applies and old terminal records
without this field remain readable. No receipt acceptance rule is relaxed.

The P0/P1 recovery and cleanup journeys inject an exact Role's malformed receipt
after actual Canvas delivery, including compensation. Visible macro start must
lead to unavailable automatic input without a document/surface replacement.
The exported incident preserves claimed delivery separately from validation.

## Native endpoint endurance evidence

`scripts/probeChromiumCompatibleInput.cjs` accepts an optional third argument,
a soak duration in milliseconds (up to 12 hours). For example, after building:

```sh
pnpm exec electron scripts/probeChromiumCompatibleInput.cjs \
  /tmp/rion-input-soak.json /tmp/rion-input-soak-profile 9000000
```

The isolated test Session repeats a physical-Alt overlap precondition and paired
Digit3 effects while an editable element retains focus. Every cycle validates
the production isolated-world receipt and the main-world consumer's legacy key
fields and pressed set. Final cleanup must leave that set empty. The report
records measured duration and cycle count; any mismatch fails the probe.
Physical preconditions are simulated by the fixture. This establishes endpoint
endurance, separately from physical keyboard, Core scheduling and desktop E2E
evidence. Its pacing timer exists only in the opt-in diagnostic process.
Before the background soak, a visible isolated fixture verifies real Chromium
Canvas focus loss into a text field, button, body and redirected control. Each
loss must yield one observation, and a separately authorized compatible reassert
must restore the consumer without changing its final focus. The probe observes
both native document blur and hidden visibility before starting the soak.

The separate ignored Core test holds `Digit6` with the real scheduler, injects
ordered context-loss events with controlled browser acknowledgements, then
requires one matching release and no late reassertion after stop:

```sh
RION_CORE_HOLD_SOAK_MS=3600000 cargo test -p rion-core \
  held_key_endurance_keeps_one_owner_until_acknowledged_stop -- --ignored --nocapture
```

It reports elapsed wall time and continuity count. This checks Core ownership
and cleanup longevity; it does not claim native Windows or game delivery evidence.
