# Trusted Input Receipts

This document is the normative Chromium contract v32 source for trusted-input
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

The isolated preload reports every ordered trusted key, pointer, and semantic
mouse observation for its exact document. It does not compare an observation
with the armed CDP effect and cannot terminate the lane.

Before delivering a physical event, the retained AppKit target path or exact
Windows foreground HWND owner advances a monotonic per-owner sequence by the
number of DOM observations projected by that native edge. CDP submission never
advances the sequence. Electron main correlates the native and DOM streams:

- a proven physical event passes to the game and does not consume the pending
  automatic-input action;
- an observation without physical provenance advances the CDP action only when
  it exactly matches the expected receipt;
- same-identity races, sequence gaps or regressions, unknown provenance, and
  changed document, frame, surface, input-epoch, host-generation, foreground,
  or focus proof fail closed as indeterminate.

Physical evidence is private to the native host, Electron main, and isolated
preload. It does not change `window.rionStudio`, Macro persistence, JSON, or
SQLite contracts.

## Uncertain edges and neutralization

Sequence terminal evidence records whether the current action is uncertain,
which key or button edges may have applied, whether cleanup proves a neutral
active set, and whether the Role remains quarantined.

An uncertain `rawKeyDown` belongs to the possible-applied set even when no DOM
receipt was accepted. After compensating the exact confirmed prefix in reverse
order, the runtime sends an inverse guarded `keyup` with `cleanup` intent. Mouse
submission follows the same rule when a button-down can be proven to have been
issued and the session remains capable of accepting guarded cleanup.

Only exact cleanup receipts, an empty active set, and exact Core rollback may
publish `cleanup-neutral`. Eligible toggle and loop roots may then restart once
from their beginning. While-held roots are not reconstructed. An uncertain
cleanup, unavailable provenance, terminal CDP session, or uncertain Core
rollback leaves the Role `restart-required`; the original effect is never
retried.

## Quarantine and teardown

Quarantine and restart-required projection release the managed shortcut guard,
while-held lease, and pass-through ownership for the affected Role. Automatic
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

Electron main retains a bounded in-memory journal of the most recent input
terminal records, including request, Role, input epoch, surface generation, CDP
submission certainty, physical-interleave classification, terminal code,
cleanup result, and recovery result. Role closure does not erase this evidence.

The journal never stores typed text. Physical observations are exported only as
relationship classes such as `unrelated`, `same-identity`, and
`modifier-change`. Individual unavailable native collectors do not replace the
remaining runtime diagnostics with `INPUT_DIAGNOSTICS_UNAVAILABLE`. Older
diagnostic fixtures may omit the v32 field; a v32 runtime provides it.
