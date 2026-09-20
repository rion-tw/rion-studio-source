# System WebView Runtime Contract

Contract version 22 preserves the shared compatibility semantics documented in
the linked parts. The active Electron registration uses Chromium contract
version 47; Core retains version 22 only for consumed legacy data and fixtures.

The System Runtime contract retains Rust-owned semantics across the migration
from v22 WebView2/WKWebView to v23 Chromium. Electron is now the sole repository
shell; the legacy filename remains the contract index for existing references.
Historical native mechanisms in the linked parts describe compatibility origins;
they do not authorize a live Tauri/System WebView path.

`RuntimeKernel` is the logical authority. Electron owns Chromium handles and
applies revision-fenced Rust projections; macOS retains the AppKit native host.
Native adapters, SQLite, and renderer stores remain followers and cannot create
a second logical writer. See [the Chromium contract](chromium-runtime-migration.md)
for the current engine boundary.

Normal correctness is event-bound. Event-bound work never terminalizes because
time elapsed: it completes only from its exact authoritative event,
cancellation, supersede, actor stop, or event-stream failure. Deadline-bound
work is limited to declared external liveness boundaries, and an elapsed
deadline is never success.

## Contract parts

Read only the parts required by the task:

| Task | Normative contract |
| --- | --- |
| Operation identity, completion, subsystem semantics, revisions, diagnostics | [Operations and Receipts](contracts/system-runtime/operations-and-receipts.md) |
| Window/tab ownership, launch destinations, activation, topology mutation | [Ownership and Activation](contracts/system-runtime/ownership-and-activation.md) |
| Native tab chrome, destructive stop, persistence, display topology, dragging | [Native Projections and Placement](contracts/system-runtime/native-projections-and-placement.md) |
| Default compatible Macro delivery and verification-frame continuity | [Compatible Macro Input](contracts/system-runtime/compatible-macro-input.md) |
| Navigation, input fences, process-death recovery, power, shutdown | [Lifecycle and Recovery](contracts/system-runtime/lifecycle-and-recovery.md) |
| Physical keyboard/middle-button macro-shortcut ownership, trusted key-down/key-up interception, press and hold ordering | [Managed Macro Shortcuts](contracts/system-runtime/managed-macro-shortcuts.md) |
| WebGL performance, popup security, and capability policy | [WebView Policy and Performance](contracts/system-runtime/webview-policy-and-performance.md) |

Changing a terminal status, completion scope, identity fence,
popup/security policy, or ordering guarantee requires a contract-version bump
and matching macOS and Windows behavior tests. Additive fields remain compatible
within version 22 only when the generated Rust/TypeScript contracts and all
consumers remain aligned.

## Chromium v43 compatible modifier overlap

Canvas-compatible macro effects now share exact-side physical/Core modifier
ownership handling, including zero-event adoption and ownership-release receipts.
See [Compatible Macro Input](contracts/system-runtime/compatible-macro-input.md) for v43 ordering and bounded diagnostic evidence.
The v42 physical modifier inheritance and existing second-press stop behavior
remain in effect.

## Chromium v46 input recovery evidence

[Compatible Macro Input](contracts/system-runtime/compatible-macro-input.md)
defines exact release evidence across Core rollback, retained uncertainty across
empty cleanup, original-document recovery fences, and bounded rejected-receipt
diagnostics. The optional evidence decodes alongside previous terminal records.

## Chromium v45 physical modifier reconciliation

A trusted physical keyboard event with a cleared modifier-family flag releases
stale page-observed sides before shortcut admission. Core ownership remains
intact; only the last holder sends an exact-target release. Armed macro input,
projection input and forwarded events cannot provide physical release evidence.
See [Compatible Macro Input](contracts/system-runtime/compatible-macro-input.md).
