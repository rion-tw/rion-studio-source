# Engineering Documentation

This catalog separates normative sources from task guidance and historical
evidence. Load only the documents required by `.agents/context-map.json` or the
`ai:context` command.

## Contracts

| Document | Status | Load when |
| --- | --- | --- |
| [System WebView Runtime Contract](system-webview-runtime-contract.md) | Active, version owner | Any Core/Tauri/native runtime contract changes |
| [Operations and Receipts](contracts/system-runtime/operations-and-receipts.md) | Active, normative | Operation identity, completion, revisions, diagnostics |
| [Ownership and Activation](contracts/system-runtime/ownership-and-activation.md) | Active, normative | Window/tab ownership, launch, activation, topology |
| [Native Projections and Placement](contracts/system-runtime/native-projections-and-placement.md) | Active, normative | Native chrome, destructive stop, persistence, placement |
| [Lifecycle and Recovery](contracts/system-runtime/lifecycle-and-recovery.md) | Active, normative | Navigation, input fences, process recovery, power, shutdown |
| [WebView Policy and Performance](contracts/system-runtime/webview-policy-and-performance.md) | Active, normative | WebGL, popup security, capabilities |
| [Updater Install Transaction](updater-transaction-contract.md) | Active, normative | Updater, drain, restart, or release recovery work |

## Policies and guides

| Document | Status | Load when |
| --- | --- | --- |
| [AI Development](ai-development.md) | Active | Maintaining agent routing, skills, or documentation governance |
| [Design System](design-system.md) | Active | Renderer styling, components, theme, or runtime chrome presentation |
| [Event Topology](event-topology.md) | Active | Any asynchronous production behavior or timer review |
| [Desktop E2E Strategy](e2e-strategy.md) | Active | User-visible behavior, journey coverage, or desktop validation |
| [Validation](validation/README.md) | Active index | Native/hardware runbooks or historical evidence lookup |
| [Windows Game Window Placement](validation/runbooks/windows-game-window-placement.md) | Active runbook | Physical Windows placement, DPI, and generation acceptance |

## Machine-owned registries

| Registry | Authority |
| --- | --- |
| [Desktop E2E coverage](e2e-coverage.json) | Journey IDs, targets, profiles, phases, and feature coverage |
| [Event-topology exceptions](event-topology-exceptions.json) | Approved production liveness exceptions and their exact paths |
| [Validation archive manifest](validation/archive/manifest.json) | Immutable evidence paths and content hashes |

Query large registries by feature, journey ID, or exception ID. Do not load the
complete registry when a narrow query answers the task.

## Public and historical documents

Localized README and legal files are release-managed public documents, not
engineering context. [Rion Studio 2.0](release-notes-2.0.md) is a historical
product note.
Validation artifacts under `validation/archive` are exact-SHA evidence and are
never proof for current `HEAD` unless an active audit explicitly establishes
ancestry and applicability.
