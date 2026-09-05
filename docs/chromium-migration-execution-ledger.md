# Chromium Migration Execution Ledger

This ledger tracks the remaining work between the current transition tree and
the owner-approved Electron/Chromium v23 production cutover. The normative
requirements remain in [Chromium Runtime Migration](chromium-runtime-migration.md)
and [Updater Install Transaction](updater-transaction-contract.md); this file is
only an execution view and must never be used to waive a gate.

Last reconciled: 2026-09-06.

## Current count

- Five release-cutover work packages remain before the migration can be called
  done. A failed native gate may add remediation work, but cannot remove a gate.
- The known packages contain nine independently verifiable deliverables.
- Within the currently authorized candidate-branch scope, implementation and
  local validation are complete. Candidate closure requires the latest branch
  head to have a green exact-SHA macOS/Windows CI matrix; the hosted status is
  reported in the handoff because it can change after this ledger is committed.
- The one later repository-mutation package is the deliberately gated sole-entry
  cleanup, which cannot begin until the external native and release gates pass.
  The real-transaction producer and terminal-promotion finalizer are implemented
  as hard-disabled transition code but remain open execution gates. The
  owner-controlled release-configuration package is a provisional final delta
  audit, not a presumption that v23 needs a second release infrastructure. One
  package is exact-candidate native and physical-platform evidence.
- A passing portable or macOS-only test run does not reduce the Windows evidence
  count. Historical evidence does not count for the current source SHA.

## Local pre-cutover validation snapshot

The 2026-09-02 macOS working tree has passed the following non-GUI checks:

- the full Rust workspace test suite and Rust lint;
- the desktop-E2E build followed by a restored production renderer and the
  production-isolation verifier;
- the production Electron main/preload/renderer build and pinned runtime probe;
- an unpacked arm64 Electron application build plus the packaged-ASAR, fuse,
  native-addon, bundle-metadata, and ad-hoc-signature verifier; and
- the stable-v22-plus-scoped-Electron source architecture gate.

The packaged macOS addon links AppKit and QuartzCore and does not link WebKit,
which is the intended retained-AppKit/replaced-WKWebView boundary. This snapshot
does not close a release deliverable: the working tree is not an immutable
candidate SHA, no real updater transaction ran, and no Windows evidence was
produced.

The complete local macOS distribution formats also passed the production
package-binding verifier. The updater tar was safely extracted, the DMG was
verified and mounted read-only, and both copies reproduced the unpacked
application's exact package-manifest summary before their file identities were
re-read. This remains local working-tree evidence rather than a signed candidate
or updater transaction.

The current working tree was rebuilt as a release-mode arm64 Electron `.app`
on 2026-09-03. Its pinned Electron/Chromium/Node/Node-API/Rust runtime, ASAR,
production fuses, native addon, AppKit linkage, renderer purity, desktop-E2E
isolation, and stable-v22/scoped-Electron boundary all passed their local
verifiers.

An uncontested foreground macOS AppKit session then closed the remaining local
desktop gates:

- `chromium-tabs-visible-seed` and `chromium-tabs-visible-restart` passed with
  exact native topology, final flush, restart, and SQLite journal evidence in
  `.desktop-e2e-artifacts/2026-09-03T00-32-10-867Z-darwin`;
- `chromium-macro-cutover-terminal-cleanup-seed` and its restart passed with
  AppKit-Chromium binding, native application-quit, trusted-input cleanup, final
  flush, and SQLite clean-exit evidence in
  `.desktop-e2e-artifacts/2026-09-03T00-42-12-067Z-darwin`; and
- the five covered macOS journeys are
  `CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019`,
  `CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020`,
  `CHROMIUM-MACOS-APPKIT-RUNTIME-LAUNCH-DESTINATIONS-008`,
  `CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-TOPOLOGY-009`, and
  `CHROMIUM-MACOS-APPKIT-MACRO-TERMINAL-CLEANUP-006`.

The same reconciled tree passed source hygiene with the owner-approved 3,200
line ceiling and the unchanged 65,536-byte ceiling, TypeScript, lint with zero
errors, 424 JavaScript/TypeScript test files containing 3,174 tests, Rust fmt and
clippy with warnings denied, the full Rust workspace tests, the renderer/Tauri
build, and desktop-E2E coverage (P0 70/70, P1 66/66, and both Chromium platform
parity manifests 40/40).

## 2026-09-03 completion audit

- Local implementation and evidence are green: TypeScript, renderer, Electron
  main/preload, Rust workspace, contract generation, source hygiene, E2E
  coverage, foreground AppKit topology and terminal cleanup, release-package
  structure, and migration-boundary checks passed on the current working tree.
- No known local macOS implementation or foreground desktop-E2E task remains.
  This does not substitute for an immutable candidate's packaged update
  transaction or its Windows counterpart.
- Windows native build/install/update/trusted-input evidence cannot be produced
  by this macOS host. Portable tests and source checks remain supporting evidence
  only.
- Real updater transactions, terminal promotion, and protected recovery-store
  configuration require owner-controlled external state that is intentionally
  absent. Repository code must not invent or enable it.
- The sole-production-entry cleanup remains deliberately gated. Removing Tauri,
  System WebView, or dual-shell transition paths before the preceding native and
  release gates pass would violate the migration contract; `rion-appkit` remains
  after that cleanup.

## Owner-controlled GitHub audit

A read-only audit on 2026-09-03 confirmed that the owner-controlled gate is
absent rather than merely unverified:

- source `main` has neither branch protection nor a repository ruleset;
- none of the five Electron production environments declared by the transition
  workflows exists;
- the repository-level release App, updater public key, and stable-Tauri signing
  secret names exist, but the recovery-store repository coordinates and its
  separate reader/writer GitHub App variables and secret names are not
  configured; and
- the remote `main` still points to `0b6e42f0939bb341a935e1d6e5bf6f3858c56073`,
  while local `HEAD` is `7bec758a458475dc4ffebcdbdea069d35b3ffd92`
  plus an uncommitted migration working tree, and none of its
  `electron-production-*` workflows exists on remote `main`.

The most recent successful remote CI run therefore validates only that older
remote SHA. It is not current migration evidence. No GitHub setting, credential,
environment, branch rule, workflow, or remote ref was changed by this audit.

The owner clarified on 2026-09-06 that this absence audit does not establish a
v23 requirement to create separate release infrastructure. Configuration review
is deliberately last: begin from the complete pre-migration v22 release
environment, reuse its secrets, permissions, endpoints, and owner settings, and
adjust only the Electron-specific workflow inputs that a final delta audit proves
necessary. The private recovery repository, separate GitHub Apps, and additional
environment assumptions recorded above remain provisional transition-workflow
assumptions; they are not owner-approved requirements and must be removed or
simplified if the existing release setup already supplies the required authority.

## Remaining work packages

| Package | Required deliverables | Current state | Completion evidence |
| --- | ---: | --- | --- |
| Real updater transaction producer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow seals one challenge and exact upstream identities, drives visible updater UI in four native cells, records product-authored terminality and target-process identity, detached-attests only each terminal receipt, and verifies the aggregate | Four exact source-runtime transactions: Tauri v22 and prior Electron to target Electron on both macOS and Windows |
| Terminal promotion finalizer | 2 | Implemented but hard-disabled and unexecuted: the fixed workflow re-verifies readiness/provisional/capsule/lease identities, brackets the sole lease release with exact target observations, writes only a create-new `promoted` receipt, and leaves every non-success path to durable recovery | Fresh external-state observation plus one terminal promotion receipt, with rollback or indeterminate closure for every non-success path |
| Sole Electron production entry and cleanup | 2 | Pending until every prior gate passes; Tauri v22 remains stable production | macOS and Windows release/CI matrices green; make Electron the only production entry, then remove Tauri/System WebView and dual-shell code while retaining `rion-appkit` |
| Owner-controlled release configuration | 1 | Deferred to the final delta audit; existing v22 release configuration is the baseline and no new repository, App, environment, variable, or secret is presumed necessary | Read-only v22-to-v23 configuration/workflow comparison, followed only by owner-approved Electron-specific adjustments that the comparison proves unavoidable |
| Current-SHA native release evidence | 2 | Pending physical/native execution | Retained AppKit-host macOS package/update evidence and physical Windows install/update/trusted-input evidence for the exact candidate SHA |

Repository code may validate and consume owner-controlled configuration, but it
must not create it, guess repository identity, or enable public mutation without
owner approval. This package stays last and may close as a no-new-configuration
result if the existing v22 environment already covers the Electron workflows.

The durable provisional-publication recovery package is no longer counted as
remaining repository implementation. Its hard-disabled workflow now covers the
private append-only capsule and outcome store, proof-derived one-shot mutation
markers, creator-only public mutation, zero-write resume and reconciliation,
rollback or held-lease release, and fresh terminal readback. All recovery jobs
remain statically disabled. Its currently modeled separate store, GitHub Apps,
protected environments, variables, and secrets remain provisional until the
final v22-to-v23 delta audit; they are not inferred owner requirements.

The real updater transaction producer is also no longer missing repository
implementation. Its hard-disabled fixed workflow is covered by focused source,
contract, bundle, promotion-readiness, and full repository tests. This does not
complete either of its deliverables: the owner-controlled provisional endpoint
or reused v22 endpoint and native environments must still run all four exact
transactions, including retained AppKit evidence on macOS and physical Windows
evidence.

The terminal-promotion finalizer is likewise no longer missing repository
implementation. Its closed receipt, file-bound CLI, source contract, and
hard-disabled workflow are covered by focused tests. This does not complete
either finalizer deliverable: the owner must first authorize and successfully
run the upstream four-cell producer, then authorize this finalizer against the
live public state. Unknown or failed mutation acknowledgement remains a durable
recovery outcome and is never promoted by elapsed time or local inference.

## 2026-09-04 current-branch validation hold

The active candidate branch is `codex/electron-chromium-v23-cutover`. Remote
commit `282751a3335d5a31be6c456912534a077e24314f` is not yet a completed candidate:
CI run `33872639465` found package-profile failures after the narrower macOS and
Windows desktop-E2E jobs passed. The Windows package failure is covered by an
uncommitted exact-process-exit correction. The macOS package failure exposed a
Quick Access foreground-focus gap which is also corrected in the working tree.

A subsequent full local `chromium-macos-appkit-smoke` run deliberately continued
past those known failures and exposed later validation defects. The Quick Access
seed/restart and background-tab phases now pass locally. The restart half of
`chromium-macro-cutover-topology` then exposed a saved-window hydration defect:
a visible Show intent moved the persisted Game Window from `dormant` to
`restoring`, but no native launch began. The exact cause was a schema-v2 restore
path writing the complete GameWindow back into the schema-v1 compatibility
snapshot field. Two valid workspace tabs shared one role; Rust normalization
removed the later legacy snapshot tab, so exact receipt validation rejected the
mutation before native hydration. The working correction persists only the
schema-v2 in-progress identity and keeps GameWindow state authoritative. It also
clears the full schema-v2 recovery cohort when the user discards all recovery.
Focused tests cover both shared-role tabs and an empty legacy snapshot field.
Foreground confirmation remains pending and the defect must not be bypassed by
creating a duplicate workspace tab or extending a timeout.

Foreground macOS automation is temporarily paused at the owner's request while
another full-screen application is in use. Until the owner resumes foreground
testing, work is limited to source/event-chain diagnosis, unit and static tests,
repository hygiene, and Windows/CI remediation. Before the next candidate push,
the complete local macOS AppKit smoke profile must pass from a clean start. Only
then may a new current-SHA CI matrix be dispatched.

The non-foreground working-tree validation after the correction is green:
source hygiene, TypeScript, ESLint (zero errors), 424 Vitest files / 3,207 tests,
Rust formatting and clippy, and the complete Rust workspace test suite. These
checks do not replace the paused macOS foreground profile or Windows CI.

The same hold also exposed and corrected a release-only AppKit ABI verifier
drift: the native addon and production host require ABI 6, while
`verifyElectronRuntime.mjs` still expected ABI 5. A pinned verifier regression
test now requires 6 and cross-checks the Electron AppKit host constant. The
release addon runtime probe, macOS arm64 Electron
package build, final `.app` structure verifier, ad-hoc signature/linkage checks,
DMG checksum, and tar payload inventory all pass locally.

## 2026-09-05 local candidate closure

The owner resumed foreground testing. The complete current-source
`chromium-macos-appkit-smoke` profile passed from a fresh start, including
saved-window seed/restart hydration, Quick Access foreground activation,
shared-role tab restoration, browser-data cleanup, workspace-web surfaces,
trusted input, macro terminal cleanup, native AppKit tab identity, and clean
exit. Its artifact root is
`.desktop-e2e-artifacts/2026-09-05T10-53-54-780Z-darwin`.

The retained stable shell was then revalidated from the same tree. The macOS
`smoke` profile passed fullscreen toolbar, contained fullscreen, seed, and
restart journeys in
`.desktop-e2e-artifacts/2026-09-05T14-30-52-724Z-darwin`. The complete macOS
`full` profile also passed native macro input and cleanup, role-store isolation,
workspace recovery, cross-domain lifecycle, system-settings boundaries, and
Game Window seed, restart, force-terminate, crash-restart, and crash-discard
journeys in `.desktop-e2e-artifacts/2026-09-05T14-33-20-538Z-darwin`. This
preserves local evidence that the v22 AppKit/WKWebView fallback remains healthy
while the v23 Chromium candidate retains AppKit presentation.

The fresh 8.5.0 macOS Electron distribution then passed the pinned runtime,
ASAR/fuse/native-addon/AppKit-linkage/package-structure verifier and the packaged
black-box AppKit Role journey. The black-box accessibility probe now follows the
actual retained native hierarchy through `AXScrollArea`, validates the prefixed
AppKit window/tab identity before pressing content, and quits with the physical
Command-Q key code.

The packaged updater gate also passed locally with a CI-equivalent ephemeral
trust fixture. It built a real ad-hoc-signed 8.3.0 Tauri v22 application with the
`rion-tauri` executable and no Electron `app.asar`, then verified the 8.3.0 and
8.4.0 source transitions into the signed 8.5.0 Electron archive, rollback,
wrong-platform rejection, recovery journal removal, and audit-token-supervised
active-zero process cleanup. The macOS helper sandbox now permits only its
bundle executables, framework helpers, and the fixed `/usr/bin/codesign` needed
to validate the replacement; unrelated external execution remains denied. The
process admission bound is 10 seconds so a freshly copied app can complete the
OS policy check, while the authoritative updater acknowledgement remains a
separate fail-closed 120-second external boundary.

The reconciled tree passes source/document/dependency hygiene with the
owner-approved 3,200-line limit, TypeScript, ESLint with zero errors, all 426
Vitest files containing 3,223 tests, Rust formatting and clippy with warnings
denied, the full Rust workspace suite, production build, desktop-E2E build, and
production renderer isolation. Coverage remains P0 70/70, P1 66/66, and both
Chromium platform manifests 40/40.

The first exact-SHA hosted matrix for branch
`codex/electron-chromium-v23-cutover`, run `33972543890` at
`4dfa8e1fdd64e35aae5321adb233dfae9044aa49`, passed checks, both native
validation jobs, macOS desktop E2E, renderer assets, and the Linux sanitizer and
concurrency soak. Its three failures exposed native evidence gaps rather than a
new product-boundary decision: the Windows package workspace exceeded the
ordinary SQLite `MAX_PATH` open boundary; the macOS Chromium evidence validator
rejected a legitimate fully hidden ready observation between native close and
show; and the Windows stable native-menu input plan counted middle menu rows
whose native representation is host-dependent. The candidate corrections use a
verbatim Windows SQLite destination path when required, preserve strict visible
terminal-state validation while admitting the exact hidden-ready state, and
select Hide relative to the final actionable menu item. These corrections still
require a green exact-SHA hosted matrix and Windows evidence is never inferred
from this macOS host.

The second exact-SHA matrix, run `33973955767` at
`f8a380e211430d0d997e870498d82c7b5f7f2831`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, macOS desktop E2E, and both native
validation jobs. It confirmed that the Windows SQLite long-path correction and
the macOS hidden-ready evidence correction work. The remaining three failures
each exposed a later physical boundary. The macOS package reached empty Game
Window creation, where AppKit's authoritative layout callback legitimately
updated saved placement and `updatedAt`; the Electron coordinator compared the
entire saved record and compensated the valid host. The correction now retains
immutable saved-window identity, requires monotonic time and exact active-display
geometry, and permits only the expected native placement commit. The local
AppKit `chromium-game-window-ui-seed` and seed-plus-restart runs pass with that
correction.

The Windows package advanced through Chromium Game CRUD and entity persistence,
then showed that a physical workspace-divider release could cross from its thin
host control into an adjacent Chromium `WebContentsView`. The Windows host now
keeps its transparent divider layer pointer-active for the drag lifetime and
terminalizes from document release, cancellation, lost capture, or host blur.
The stable Windows desktop E2E also proved that the separator between Hide and
Stop consumes one native keyboard traversal; the exact input plan now anchors
at Stop and crosses the separator before selecting Hide. These Windows
corrections remain pending physical validation on the next exact-SHA matrix.

The third exact-SHA matrix, run `33975626227` at
`4c27f13430f48424705be8b6235a0249705e04e7`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, both native validation jobs, and the
Windows desktop E2E. It therefore closed the preceding Windows native-menu and
both-platform native-validation gaps. Its three later failures exposed exact
terminal-boundary defects. The Windows package proved that the physical divider
updated the authoritative Runtime Kernel topology to 55/45 while a stale shell
persistence fence left the SQLite follower at 50/50. Internal Runtime Kernel
snapshots bypass that non-authoritative fence to repair the follower, while the
public shell snapshot API retains strict latest-wins duplicate supersession. A
focused Core regression test covers both sides of that boundary.

The stable macOS cross-domain journey proved that two successive visible Quick
Open launches could race after the native dialog closed but before React finished
its awaited launch and recency mutation. The palette now publishes an explicit
presentation state, and the E2E waits for the authoritative React-closed state
before beginning the next visible action. The macOS Chromium macro cleanup
journey also showed that traversing every accessibility descendant of an AppKit
window could enter Chromium's large accessibility tree and exhaust the external
automation boundary. Known game windows are now closed through their exact
retained AppKit `AXIdentifier` and native close button; the descendant fallback
remains only for controlled popups without a game-window identity. The three
corrected journeys pass locally on physical macOS: stable
`p1-cross-domain-seed`, Chromium/AppKit
`chromium-macro-cutover-terminal-cleanup-seed`, and Chromium/AppKit
`chromium-workspace-web-slot-seed`. Windows packaging and the new branch head
remain pending the next exact-SHA hosted matrix.

The fourth exact-SHA matrix, run `33977476889` at
`ea37c551d2b4955c34809f76f3412e1aefb80ca0`, passed checks, renderer assets,
the Linux sanitizer and concurrency soak, both native validation jobs, and the
macOS desktop E2E. Its three package/later-journey failures exposed independent
incarnation and viewport boundaries. The Windows package confirmed that a
higher stale shell persistence fence could still block the authoritative Rust
Runtime Kernel snapshot; internal authoritative snapshots now bypass that
non-authoritative fence, while public shell commits remain strict latest-wins.
The stable Windows transcript appends multiple app incarnations whose sequence
numbers each begin at one; geometry validation now captures an exact byte offset
so an older incarnation's numerically larger failed receipt cannot leak into the
current action. The macOS package accumulated enough Workspaces to push the
visible reorder target outside the viewport; its physical pointer drag now uses
the product's edge auto-scroll before releasing on the target instead of relying
on an off-screen element origin.

The current correction tree passes 427 Vitest files containing 3,225 tests,
TypeScript, ESLint with zero errors, source/document/dependency hygiene, Rust
formatting and clippy with warnings denied, the full Rust workspace suite,
production Tauri and Electron builds, Electron renderer purity, and production
desktop-E2E isolation. The local Core suite includes 955 tests, including the
authoritative-follower repair across a stale shell revision fence. A physical
macOS Chromium/AppKit run passed the corrected `chromium-app-crud-mutations`
journey and all of its focused lifecycle dependencies in
`.desktop-e2e-artifacts/2026-09-05T16-49-16-871Z-darwin`. The corrected Windows
paths and the next immutable branch head remain pending the next exact-SHA
hosted matrix.

The fifth exact-SHA matrix, run `33979452487` at
`0021dc78cea254be8ba82f5f7c83a8c8d3c81f84`, passed renderer assets, checks,
both native-validation jobs, both macOS and Windows desktop-E2E jobs, and the
Linux sanitizer and concurrency soak. Its two package failures reached still
later native boundaries. The Windows Chromium workspace-divider gesture
committed the exact 55/45 geometry into Runtime Kernel while SQLite remained at
50/50. Divider completion now persists the already-fenced Runtime Kernel window
directly through the authoritative state mutation, rejects any topology change
between motion and release, and remains independent of a stale shell snapshot
revision. A Core regression test installs an impossible higher shell fence
before release and proves that the exact saved divider geometry still commits.

The macOS package failure showed that AppKit can create and reveal the retained
native host, then enqueue its authoritative frame/window-state correction. The
launch coordinator could compare Core against an intermediate revision and
compensate by retiring an otherwise valid window. Coherent launch readback now
first drains AppKit callbacks admitted before the event fence, then drains the
Rust projection queue before comparing state. A coordinator regression test
proves that no Core snapshot is read before that native fence. The focused
physical macOS Chromium/AppKit `chromium-game-window-ui-restart` seed and restart
journey passes with the correction in
`.desktop-e2e-artifacts/2026-09-05T17-27-30-195Z-darwin`.

The corrected tree passes source/document/dependency hygiene, TypeScript,
ESLint with zero errors, all 427 Vitest files containing 3,226 tests, Rust
formatting and clippy with warnings denied, the complete Rust workspace suite,
the stable Tauri production build, the Electron production build, renderer
purity, system-only boundary verification, and production desktop-E2E
isolation. The sixth immutable branch head and its hosted package evidence
remain pending.

The sixth exact-SHA matrix, run `33981080989` at
`d8a54049383e07d9297495d200585dcf9f10195f`, passed renderer assets, checks,
the Linux sanitizer and concurrency soak, both native-validation jobs, and the
macOS desktop E2E. Its three remaining failures were distinct native input and
message-delivery boundaries. The Windows Chromium package delivered an exact
55/45 divider move before its adjacent child `WebContentsView` took pointer
capture; Chromium emitted capture loss instead of the physical release, so the
renderer submitted cancellation and correctly left the moved Core state
non-durable. Capture loss after an accepted move now submits `end`, while loss
before any move and explicit host blur remain cancellation. A renderer
regression test covers both terminal paths.

The stable Windows package submitted `WM_CLOSE` with `PostMessageW` while the
WebView was actively navigating. The asynchronous message was accepted but did
not reach Tauri's real `CloseRequested` policy within the external E2E
boundary. The E2E-only native control now uses synchronous `SendMessageW`; the
real Tauri handler still prevents the native default and defers admission to the
Rust close transaction, whose exact native-destroyed event remains terminal.
This Windows-only correction requires hosted compilation and physical evidence;
the local macOS host cannot substitute for it.

The macOS Chromium package reached exact post-restart Core, native AppKit,
generation, and topology state, then timed out while System Events traversed the
complete Accessibility contents of the target window to rediscover a known
tab. The visible action now binds the exact Core/AppKit window and tab IDs,
validates ordered native membership, derives the physical point from AppKit's
first-tab screen bounds and per-tab window-relative anchors, raises only that
AX-identified window, and sends a real CoreGraphics right click. Chromium's
Accessibility subtree is no longer traversed. The focused AppKit seed and
restart phases pass locally in
`.desktop-e2e-artifacts/2026-09-05T18-07-03-450Z-darwin`, covering reorder,
move, detach, hide/reveal, restart persistence, and consolidation. The seventh
correction tree also passes source/document/dependency hygiene, TypeScript,
ESLint with zero errors, all 427 Vitest files containing 3,227 tests, Rust
formatting and clippy with warnings denied, the complete Rust workspace suite,
the stable Tauri and Electron production builds, desktop-E2E debug build,
production isolation, and the system-only boundary verifier. The seventh
immutable branch head and full hosted matrix remain pending.

Post-commit foreground validation at the seventh local head
`cd284959e6434abb26f0a88db8c244b68730548f` twice exposed a deterministic E2E
ordering race before the corrected native menu path. The first Role URL was
deliberately held at the external loading gate while the test asked the renderer
for a globally coherent application projection. If admission crossed the Core
and AppKit projection fence during that read, the coherent snapshot correctly
waited for the next native event while the test withheld the event by retaining
the URL gate. Loading admission now comes directly from the exact E2E-only
Core/AppKit Game Window observation: it requires one new tab ID and identical
ordered Core and native tab membership before inspecting AppKit's loading
presentation. The gate is then released before the renderer coherence read.
This changes no production timer, authority, or runtime behavior. The corrected
foreground seed and restart phases pass in
`.desktop-e2e-artifacts/2026-09-05T18-28-02-215Z-darwin`. The eighth immutable
branch head and its exact-SHA hosted matrix remain pending.

The eighth exact-SHA matrix, run `33984444918` at
`4a4bdd499d90a89692051fe314235cc1943d7a35`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both macOS and Windows native validation,
and both hosted desktop-E2E profiles. Its two Chromium package jobs failed in
separate late shell-E2E paths before any packaged release step. The Windows job
failed while restoring the saved mixed Workspace: Core
created the dormant Game Window at generation zero, then asked the shell to load
its global Web surfaces before the later ownership follower projected the
committed positive generation. The shell correctly rejected that stale identity
instead of attaching Chromium to an unfenced native host.

Every v23 Chromium launch now projects the exact committed Core window,
active-tab, generation, and topology ownership immediately after native tab
creation and before Role or Web-surface loading. A foreground launch continues
to carry reveal and focus intent; restore hydration carries empty reveal/focus
sets and therefore preserves the current key window. The cross-platform Core
regression test proves both the positive fences and `create < ownership < load`
ordering. The focused macOS AppKit Workspace Web seed and restart phases pass
locally in `.desktop-e2e-artifacts/2026-09-05T18-55-40-254Z-darwin`. This local
run cannot replace the failed Windows package evidence; the ninth immutable
branch head and full hosted matrix remain pending.

The macOS package completed the preceding Chromium/AppKit journeys and reached
the final visible-tabs seed before rejecting a menu-click geometry fence. After
a committed reorder or cross-window move, the titlebar observer read the current
CALayer presentation frame while each tab anchor still came from its destination
model frame. A still-visible AppKit animation could therefore make two otherwise
valid native observations disagree. The desktop-E2E-only anchor now samples the
same presentation layer as the titlebar observer, so the real CoreGraphics input
targets the pixels currently on screen without traversing Chromium's
Accessibility subtree. Native AppKit compilation and the focused tabs seed plus
restart pass locally in
`.desktop-e2e-artifacts/2026-09-05T19-03-54-908Z-darwin`. This correction is not
part of the ninth immutable head; it requires the following exact-SHA matrix.

The ninth exact-SHA matrix, run `33985708422` at
`bdfd61fe594f313d351e1d189752903f1aea8437`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both native-validation jobs, and both
macOS and Windows desktop-E2E jobs. Its macOS package job reached the same final
visible-tabs geometry fence described above; the correction is committed at
`55ae85e88c276e8c4bc7f5cea831e0173e99a643` and its clean exact-SHA local tabs
seed/restart evidence is
`.desktop-e2e-artifacts/2026-09-05T19-07-18-744Z-darwin`.

The Windows package advanced beyond saved mixed-Workspace generation and load
admission, then reopened the correct global-Web URL with both prior cookie and
LocalStorage absent. Its paired Role profile, under the same user-data root,
retained process-restart state. The exact difference is that Rust
`fs::canonicalize` serialized only the global-Web profile with a Windows
verbatim device-path prefix; Chromium accepted and echoed that storage path but
did not recover its persistent data. The pending correction preserves Rust
canonical and symlink-boundary validation while serializing the equivalent
ordinary absolute drive or UNC path for Chromium, and makes Electron reject a
verbatim device path instead of silently running a non-durable session. The next
immutable matrix must prove both this Windows persistence correction and the
already-corrected AppKit presentation geometry at one exact SHA.

The tenth exact-SHA matrix, run `33987222000` at
`299258f8a2bfa6ceb06760df644f391ea08a470f`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, and both macOS and Windows desktop-E2E
profiles. Its Windows package run physically proved that the ordinary absolute
global-Web profile path restores both the cookie and LocalStorage across an app
restart. Windows native validation then stopped only at a Windows-only Clippy
`needless_return` finding; `2704c532de8562daf026c905e9f0bc7edc1d9b1f`
removes that target-specific lint without changing path behavior.

Both tenth-matrix package jobs advanced to later E2E tooling edges. The macOS
journey passed through Workspace Web fullscreen and Web-only visible actions,
then the evidence reader rejected one valid hidden `activating` projection
sampled between the degraded surface and its visible reopen. The reader now
accepts at most one such projection only inside that generation-fenced interval;
the original CI artifact and a focused behavior test both pass, while a visible
or misplaced activating projection remains rejected. The Windows journey passed
global-Web seed and restart, then its exact-PID native file-dialog script failed
PowerShell parsing before UI Automation ran because the nested dialog condition
was missing one closing parenthesis. The script and its Windows-only portable
source fence are corrected.

The complete working-tree `chromium-macos-appkit-smoke` profile passes locally
after both corrections, including retained AppKit Workspace Web file upload,
fullscreen, tabs, trusted input, recovery, and all restart phases. Its artifact
root is `.desktop-e2e-artifacts/2026-09-05T19-45-05-164Z-darwin`. This local
evidence closes the macOS diagnosis but is not immutable candidate evidence; the
next exact-SHA hosted matrix must still prove the Windows dialog correction,
Windows lint, both native jobs, both package jobs, and the same AppKit profile
together.

The eleventh exact-SHA matrix, run `33989123321` at
`c850847d391759342155d4cc61c7c75375efd182`, passed checks, renderer assets, the
Linux sanitizer and concurrency soak, both hosted desktop-E2E profiles, and
macOS native validation. Windows native validation passed target Clippy and 954
of 956 Rust Core tests. Its two failures were stale test expectations from the
ordinary Windows Chromium-path correction: they compared the serialized engine
path with `fs::canonicalize`'s verbatim device path instead of the same
`chromium_engine_path` contract used by production. Both assertions now use the
authoritative conversion and pass locally; the Windows host remains the required
proof.

The eleventh Windows package run reached the real visible file-upload action.
Fixture evidence proves that the trusted pointer down/up and default click
arrived, while the WebDriver log proves it switched back to the main renderer
three milliseconds before the input's default action requested its OS chooser.
The upload-only pointer path now retains the exact Role target until the
exact-PID native chooser selects and closes, then restores the main target in a
`finally` boundary. Other pointer actions retain their existing immediate
restore behavior. The same nested Windows UI Automation condition in the later
diagnostics save-panel helper also receives its missing parser parenthesis and a
portable source fence. The focused macOS AppKit dependency, file-upload,
fullscreen seed, and fullscreen restart chain passes with the retained target
in `.desktop-e2e-artifacts/2026-09-05T20-20-44-010Z-darwin`; Windows physical
proof and the complete next immutable matrix remain pending.

The eleventh macOS package run continued through every mixed-recovery phase and
then exposed a later seed-ordering gap in the multi-window recovery journey.
Three visible launches had completed their remote Session evidence, but the test
read the persisted Game Window list before the third tab projection committed
and dereferenced the absent tab. The seed now waits for the Rust-owned saved
topology to contain every exact Role in its requested Game Window, with a
non-successful external-liveness boundary if that projection never arrives,
before freezing lifecycle evidence. The focused retained-AppKit seed passes in
`.desktop-e2e-artifacts/2026-09-05T20-31-35-364Z-darwin`. This is E2E ordering
only; it does not add product polling or change recovery behavior. The next
immutable matrix must include this correction.

The twelfth exact-SHA Windows package run at
`183fd7a88e55b86b93c0d8bd432b5f4df8762cdc` proved that retaining the remote
WebContents target was necessary but not sufficient. The actual trusted
pointer down/up, captured click, and file-upload request all reached the page,
while UI Automation found no `#32770` whose own PID equaled the Electron main
PID. Chromium's Windows implementation creates the in-process
`IFileOpenDialog` with an explicit native owner HWND, so the helper now accepts
only a unique `#32770` whose UIA PID is the exact app PID or whose direct Win32
`GW_OWNER` HWND resolves to that PID. This preserves exact application
ownership across Windows UIA provider differences. If neither relation is
present, the phase remains failed and writes a bounded HWND/PID/class/owner
snapshot into its uploaded artifact instead of widening selection to another
application. The next immutable Windows run must prove which exact ownership
path is present and complete the native selection.

The thirteenth exact-SHA matrix, run `33991852617` at
`e6508373ddf154e851d283aab748116b65451090`, reached the revised Windows
owner-chain observer. Its failure occurred before native selection because
PowerShell enumerated the single matching dialog returned by the helper into an
`AutomationElement`; under `Set-StrictMode`, that scalar has no `Count`
property. Every exact-dialog read is now explicitly array-wrapped, preserving
the zero/one/many ownership fence while allowing the unique owned chooser to
advance. The same run passed checks, renderer assets, Linux soak, both hosted
desktop-E2E profiles, and macOS native validation; its remaining jobs were
still running when this correction was prepared.

The twelfth run's macOS package artifact also made the remaining AppKit geometry
mismatch precise. The titlebar observer reported the target window's first tab
at absolute screen `y=42`, while Core's Chromium content bounds began at
`y=68`; using the latter as a titlebar origin incorrectly rejected a real
native tab. Visible drag and menu input now translate every window-relative tab
anchor through AppKit's first-tab absolute screen frame, and take vertical
input from that same frame. No Core/AppKit ownership fence is relaxed and no
Chromium Accessibility node substitutes for the native action. The focused
retained-AppKit seed plus restart chain passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-16-47-637Z-darwin`.

The fourteenth exact-SHA Windows package run, `33992859467` at
`dcea42c9f515f0024b6856d5cdc0e581d3306666`, passed the array-cardinality
correction and again captured the trusted page input, but its ten-second UIA
snapshot contained only the two Electron `Chrome_WidgetWin_1` windows and no
top-level `#32770`; the foreground HWND belonged to a different process.
Chromium's authoritative Windows contract presents the common-item dialog with
`Show(owner)`, and Chromium's own native test identifies related windows by
their direct `GW_OWNER`, not a stable class name. The helper now snapshots the
exact top-level HWNDs belonging to the Electron app before the click, then
accepts an out-of-process candidate only when its direct owner equals one of
those handles and it uniquely contains both the file-name edit control `1148`
and Open button `1`. The legacy same-process `#32770` path remains, but also
requires those exact controls. Failure evidence now includes the foreground
window's class, name, owner HWND, and owner PID. The next immutable Windows run
must physically prove this stricter native-window ownership path.

The same fourteenth run's macOS package stopped earlier in the Quick Access
seed, independently of the AppKit tab correction. The exact localized Role
action button existed and was visible in the failure screenshot, but its
post-hover opacity transition had not completed when the test synchronously
called `isDisplayed()`. Quick Access now follows the already-proven CRUD E2E
pattern: select the unique existing localized action control, then wait for
that real control to become clickable before clicking it. The focused entity
seed/restart plus Quick Access seed/restart chain passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-38-06-887Z-darwin`; no renderer or product
timing behavior changed.

The fifteenth exact-SHA Windows package run, `33993690606` at
`b673b26852a3a3254598d27f46775af1ed0d3860`, proved the stricter native owner
relation without ambiguity. The foreground window was the native `Open`
`#32770` in process `5124`, and its direct owner HWND `524362` was the exact
Electron Game Window in process `4316`. Windows UI Automation nevertheless
omitted that dialog from `RootElement`'s direct children for the full bounded
observation. The helper now resolves the actual foreground HWND with
`AutomationElement.FromHandle`, then admits it only when it remains a
`#32770`, its direct owner is one of the snapshotted Electron HWNDs, and it
uniquely contains the exact file-name edit `1148` and Open button `1`. The
same-process and enumerated-owner paths remain unchanged, and multiple matches
still fail closed. A new immutable Windows package run must complete the
physical selection and subsequent packaged gates.

The same fifteenth run's macOS package crossed the earlier Quick Access race
and reached the background-tab Macro journey. Its retained AppKit host emitted
the trusted `Digit2` keydown and Core recorded the exact applied hold receipt,
but the E2E read the fixture's consumer state about 32 milliseconds before the
page's independent `consumer-keydown` report arrived. The later hidden-start
half of this journey already waits on that consumer event. The first start now
uses the same authoritative boundary and persists that exact trusted consumer
event in the validated runtime evidence before asserting held state. This is
E2E observation ordering only; it does not delay or otherwise change Macro,
trusted-input, Chromium, or AppKit runtime behavior. The corrected focused
AppKit/Chromium phase passes locally in
`.desktop-e2e-artifacts/2026-09-05T21-52-20-301Z-darwin`.

The sixteenth exact-SHA Windows package run, `33994424367` at
`41b9cd746130e7dd1d744996741fd7486dc61d45`, reproduced the same positive
native relation: foreground `Open` HWND `262236` in process `3564` was directly
owned by exact Electron Game Window HWND `589924` in process `6580`. The
foreground-`FromHandle` candidate did not pass the exact file-name/Open control
fence, but the prior diagnostic could not distinguish zero controls, duplicate
controls, or a descendant-provider exception because that inspection was
fail-closed and intentionally swallowed. Failure evidence now records the
foreground UIA exception, exact control counts, total descendant count, and at
most 160 bounded descendant identities. No selection path or acceptance fence
changes in this diagnostic step; the next Windows run must identify the exact
provider/selector mismatch before remediation.

The same sixteenth run's macOS package crossed the corrected Macro phase and
reached `chromium-fullscreen-toolbar-restart`. Rust had already projected the
restored Role as `running`, so the E2E skipped a duplicate visible Open action,
but it immediately read the still-materializing Electron/AppKit session and
found `currentRuntime: null` only 2.7 seconds into the phase. The existing
bounded launch observer now completes only when both the Rust Role status is
running and the corresponding native Chromium runtime is non-null. It neither
relaunches an in-progress restored Role nor changes the product restore path;
the native projection itself remains the successful event condition. The full
focused dependency chain through entity seed/restart and fullscreen-toolbar
seed/restart passes locally in
`.desktop-e2e-artifacts/2026-09-05T22-07-00-603Z-darwin`.

The seventeenth exact-SHA Windows diagnostic run, `33995062145` at
`dd33630029746bfefece72ac5ee04b3a1055951b`, reached the bounded foreground
control collection but PowerShell 5.1 rejected array-subexpression conversion
of the generic `List<object>` while constructing the JSON snapshot with
`Argument types do not match`. The snapshot now calls the list's explicit
`ToArray()` conversion. This corrects diagnostic serialization only; it does
not change the native chooser's acceptance or input behavior.

The eighteenth exact-SHA Windows diagnostic run, `33995526248` at
`d15be30487b12ae643c1dc0e577ef21c0ef9e8f2`, produced the complete bounded UIA
snapshot. The exact foreground/owner relation was intact and descendant
traversal completed without error over 54 controls, but this Windows provider
classified every HWND-backed common-dialog control as `ControlType.Pane`.
Within that tree, the unique file-name leaf was still the stable native pair
`AutomationId=1148, ClassName=Edit`, and the unique Open leaf was
`AutomationId=1, ClassName=Button`; both had positive native HWNDs, were enabled,
and were on screen. The selector now uses those exact native identity pairs
instead of the provider-dependent UIA ControlType. After the same unique
dialog/owner/control fence passes, the helper focuses those visible controls,
types the literal isolated fixture path, and presses Enter on the exact Open
control. This preserves the real page click that opens the chooser and the
visible native selection while avoiding unsupported Value/Invoke patterns on
the generic `Pane` provider.

## Non-completion rules

- Actions artifacts alone are not durable recovery storage.
- The public latest lease alone is not rollback evidence.
- Compatibility probes with `sourceUpdaterInvoked: false` are not real updater
  transactions.
- Candidate and readiness receipts are not terminal publication receipts.
- A hard-disabled recovery workflow is not an enabled publication path or an
  owner-approved recovery drill.
- Removing Tauri before exact-SHA macOS and Windows gates pass is not cutover.
- Replacing AppKit presentation with generic HTML or `BrowserWindow` chrome is
  outside the product target.
