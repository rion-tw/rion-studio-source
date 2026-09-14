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
Keyboard events retain Core modifiers and legacy key codes. Pointer coordinates
retain the existing viewport/anchor/zoom conversion; an out-of-Canvas normal
click fails without hitting the verification overlay. Compatible pointer groups
use down, up, then click/auxclick; right clicks end with contextmenu after release
on both platforms. Cleanup sends releases
only, always to the original target.

The isolated endpoint validates the document token, role/generation identity,
monotonic dispatch sequence, input epoch and declared external receipt deadline.
Its receipt echoes those identities, the owner/request, target token, exact event
count and `isTrusted=false`. `applied` proves synchronous dispatch to that target,
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
