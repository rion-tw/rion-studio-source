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
`2026-09-15.1`; runtime registration requires Chromium contract v43.
Log capture preserves this typed 64-entry evidence, including modifier-code
arrays, while retaining text redaction and the ordinary bounds for generic logs.
