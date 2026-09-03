# Chromium Runtime Migration

## Status and scope

This document is the staged contract for replacing the Tauri 2 System WebView
shell with Electron and its bundled Chromium runtime. System Runtime contract
v22 remains the production authority until every cutover gate in this document
passes. The Chromium implementation advances the contract to v23 only when the
new shell, role sessions, updater, release artifacts, and desktop journeys are
verified on both supported operating systems.

This is a product migration, not a permanent engine choice. Users are never
offered a Tauri-versus-Chromium selector. During development the two shells may
coexist behind explicit build and test entry points; production remains on the
last verified shell.

## Target ownership

- Rust remains the authority for SQLite state, filesystem policy, managed role
  stores, operation identity, revisions, cancellation, receipts, diagnostics,
  macro orchestration, update verification, and terminal outcomes.
- `crates/rion-node` exposes that authority to Electron through a narrow
  Node-API boundary. It serializes existing shared contracts and does not create
  a second domain model in TypeScript.
- `crates/rion-appkit` owns the reusable macOS runtime-window/tab controller and
  its engine-neutral C ABI. Tauri v22 and Chromium v23 link the same controller;
  Tao/WKWebView event compatibility remains outside this crate in the v22 shell.
- The legacy System WebView capability probe is compiled only through the
  `system-webview-probe` Cargo feature. The Tauri v22 compatibility shell enables
  it explicitly; `rion-node` disables default features, so the Chromium addon
  retains AppKit and QuartzCore while linking neither WebKit nor WebView2.
- Electron main owns application lifecycle and non-serializable Chromium
  handles: `WebContentsView`, `WebContents`, and `Session`. The Windows adapter
  also owns its Electron native runtime windows. macOS retains the AppKit-native
  runtime window, tab presentation, gestures, and trusted-input boundary; its
  adapter coordinates Chromium handles with Rust-owned AppKit state.
- The sandboxed preload publishes only the typed `window.rionStudio` bridge.
  Renderer code cannot import Electron, Node.js, Tauri internals, or browser
  automation clients.
- Windows may continue to use the shared renderer tab chrome. macOS continues to
  use its AppKit-native tab chrome and must not be downgraded to HTML chrome.
  Game pages render through isolated Chromium content handles; the `<webview>`
  tag is not part of the target architecture.
- A shell-side registry maps Rust-issued logical IDs and generations to native
  objects. Rust events initiate projection changes, and shell acknowledgements
  return exact operation IDs and revisions before Core terminalizes work.

## macOS AppKit retention

The v23 macOS cutover replaces WKWebView only. Existing AppKit ownership of game
windows, native tab chrome, traffic-light geometry, window gestures, focus,
fullscreen/presentation transitions, display placement, and trusted input is a
hard compatibility boundary. A dedicated Rust/Node-API AppKit adapter retains
those native identities and exposes only bounded attach/layout/focus/close events
for Chromium content. Electron main must fail closed if that adapter is absent or
returns a stale window, tab, role, generation, or lifecycle revision.

Windows uses its own Electron/Chromium host adapter. The two adapters implement
the same revisioned Core effect contract, but their native UI ownership is
intentionally different and must be exercised by separate desktop E2E profiles.

The macOS attachment sequence is explicit:

1. Electron creates a Chromium compositor host without renderer-owned tab chrome
   and obtains its native `NSView *` handle through the locked Electron API.
2. The Node-API adapter resolves that view's owning `NSWindow` on the AppKit main
   thread and installs the existing `RionRuntimeTabsController` before the window
   becomes visible.
3. AppKit action and content-layout callbacks cross the Node-API boundary with
   the logical window ID, native generation, and lifecycle revision. Chromium
   `WebContentsView` bounds follow the accepted AppKit content-layout projection;
   JavaScript must not recreate traffic-light or tab-strip geometry.
4. Teardown first fences new callbacks, detaches and flushes every Chromium
   surface, destroys the exact AppKit controller on the main thread, observes the
   native host close event, and only then acknowledges the Core effect.

An absent adapter, a non-main-thread AppKit call, a malformed native handle, a
missing owning window, or a stale identity is a terminal non-success. The macOS
factory must not fall back to the Windows HTML host.

## Chromium security baseline

Every application renderer and embedded game page uses context isolation and a
sandbox. Node integration is disabled. A process-lifetime policy is installed
once for every exact Chromium `Session` identity before that session can own a
surface. Permission checks and requests, device access, display capture,
Bluetooth pairing, and downloads are denied synchronously. The only permission
exception is a user-activated main-frame `fullscreen` request in the dedicated
global-Web Session; `disableHtmlFullscreenWindowResize` contains it to the exact
native viewport and the owner-fenced Chromium events drive its projection. The application
rejects invalid server certificates and implicit client-certificate selection;
remote pages cannot turn either failure into an interactive bypass. Chromium
safe-dialog protection remains enabled for every privileged and unprivileged
content surface.

Capability registration describes evidence, not Electron API availability.
Navigation, persistent sessions, audio mute, macOS and Windows
trusted/background input, dialogs, certificate handling, custom fonts, file
upload, and controlled popups are `supported` only where the
adapter has an authoritative event or exact readback. Custom-font payloads are
loaded from Core in the sandboxed role preload, validated against the same
catalog/asset bounds, and copied through a one-shot main-world data slot. The
page receives no invoke, Node, or Electron capability. Initial installation is
part of the surface effect; later settings and font install/remove mutations use
a per-role FIFO with exact role generation, frame token, payload revision,
application identity, and terminal DOM/Canvas receipt. Navigation and AppKit
surface retirement supersede the exact pending application. The mechanism is
identical on Windows and within the retained macOS AppKit host boundary. A
cached face decode, load, or document-registration failure is counted in the
receipt and terminalizes the application as failed instead of reporting partial
success.

Frame evaluation and permissions remain `degraded`: evaluation is restricted
to the bounded isolated-world/main-frame paths used by the product, while
permissions deliberately implement a strict deny subset. Downloads remain
`disabled`. Controlled popup support is bound to the paired visible Chromium
desktop journeys and a bounded read-only journal copied only from exact Core
lifecycle receipts. The journal retains popup/open-operation identity, the
complete parent window/tab/surface/AppKit generation fence, and operation plus
lifecycle terminality; transport cancellation is corroboration, not lifecycle
authority. Windows
foreground trusted input is `supported`: Core first requests Focus, Electron
focuses the exact visible Role host, and Win32 ABI v4 must prove that host's
parent HWND equals `GetForegroundWindow()` before Focus can acknowledge and
again before every native submission. The isolated preload must then report the
exact trusted DOM sequence. Windows `backgroundInput` is a distinct supported
path: Core admits only the exact bound hidden Role and owner generation without
selecting, showing, focusing, or invoking an activation API; the same ABI must
prove its runtime parent remains foreground and visible while the target surface
remains hidden and unfocused. The isolated preload must return a trusted DOM
receipt, and held-key continuity may reassert only the same owner after the
revision-fenced hidden presentation event. Any topology, visibility, parent,
generation, or acknowledgement mismatch terminalizes without native submission
or recovery.

The paired `CHROMIUM-*-WORKSPACE-WEB-SECURITY-POLICY-027` journeys make the
permission/download deny subset executable without changing those capability
values. A visible remote-page click requests geolocation, and the read-only
journal for that exact persistent global-Web `Session` must record the canonical
origin, `geolocation`, and the submitted `callback=false` decision. A second
visible click requests an attachment; the same Session journal must record its
exact URL and `will-download` event after `preventDefault()` with
`defaultPrevented=true`. The held fixture transport must then observe its own
connection cancellation as external corroboration, never as the policy's sole
truth source. Both decisions are synchronous event evidence; no timer, scan, or
download-file absence is accepted as success. The macOS half runs inside the
retained AppKit host and does not replace its native window or tab chrome. This
deny-policy gate is independent from file-upload parity.

The paired `CHROMIUM-*-WORKSPACE-WEB-FILE-UPLOAD-028` journeys establish that
file-upload parity independently. WebDriver clicks the actual visible remote
`input[type=file]` while an OS-native helper waits concurrently for exactly one
chooser owned by the Electron app PID. macOS must find the retained AppKit
`AXDialog`/`AXSheet`, enter the exact isolated phase fixture through its Go sheet,
and press the native Open/Choose action. Windows must find one top-level
`#32770` dialog for that same exact PID, set only AutomationId `1148`, and invoke
only AutomationId `1`; it never widens ownership to an arbitrary child process.
The remote page reads the selected `File`, then reports its filename, byte count,
and Web Crypto SHA-256. Detached phase evidence must match those values to the
bounded artifact at the exact phase path. The chooser deadline is an external
liveness failure only: elapsed time cannot become success. On macOS this flow
remains inside the retained AppKit host and does not replace native window/tab
chrome. Only this paired visible/native evidence permits both Chromium targets
to register `fileUpload=supported`.

The staged popup contract starts from Electron's exact owner WebContents
`window-open` event and synchronously returns `deny`; a bounded coordinator then
submits the request to Rust. Core alone allocates popup/open-operation identity,
admits the canonical HTTP(S) target, and owns lifecycle revision plus terminal
receipt. Admission rejects POST bodies, nested popups, uncontrolled frame names
or dispositions, unsupported window features, stale parent window/tab/surface
generations, and external schemes. `about:blank` is only the hidden native-host
creation transition; it is never an admitted final destination. The popup uses
the exact parent role or global-Web `Session`, with isolated/noopener semantics.

Windows projects the admitted popup into its exact Electron native host. macOS
creates a hidden `BaseWindow` only as the Chromium surface carrier and attaches
the retained Rust/N-API AppKit controller; the controller owns the popup tab,
window chrome, layout, close action, and native identity receipt. There is no
macOS BrowserWindow/HTML-chrome fallback. Parent retirement, cancellation,
failed navigation/load, unexpected native destruction, and application drain
all terminalize the original unfinished open operation before owned Views and
native hosts are detached. A separate close operation is created only after
page-ready already terminalized the open. The paired `CHROMIUM-*-POPUP-012`
journeys open and close one popup through visible native controls, then retire a
second popup by visibly closing its exact parent tab. They accept only the same
Core-issued popup/open-operation identity ending in `nativeClosed`,
`parentRetired`, `nativeDestroyed`, and terminal operation/lifecycle receipts.
This executable contract is what permits both Chromium targets to register
`popup=supported`; the release gate still requires the independent macOS and
Windows profile runs.

The product must not expose a remote-debugging port, attach a public Chrome
DevTools Protocol client, launch an external Chrome profile, rewrite content
through a CDN, or use a live browser profile as a runtime fallback. Chromium
command-line switches require a named contract capability, cross-platform
evidence, and a focused regression test.

Startup rejects both incoming `remote-debugging-port` and
`remote-debugging-pipe` transports before helper or ready-phase work. The sole
exception is the isolated desktop-E2E envelope, which must carry the exact
target, 256-bit session token, artifact and user-data paths, and either the
dedicated non-packaged E2E entry authorization. Packaged production builds
always reject both transports, including when caller-controlled E2E-looking
environment variables are present.
Supplying only environment flags or only a Chromium switch never grants the
capability, and simultaneous debug transports are always rejected.

## Role session layout

Each managed role has one persistent Chromium session created with
`session.fromPath` at the absolute, Rust-resolved path
`roles/<role-id>/browser/chromium`. The role ID, store path, generation, and
lifecycle revision originate in Rust. Electron may retain the `Session` handle,
but it cannot invent role identity or select another store.

All tabs for a role share exactly that role session. Different roles never
share a persistent partition, cache, cookies, storage, permissions, downloads,
service workers, or authentication state. Incognito or temporary sessions must
be represented by an explicit Rust-owned lifecycle and must not silently replace
a managed role store.

Workspace Web surfaces are intentionally different. Every synthetic Web surface
uses one Rust-resolved `web-profiles/global-web/chromium` session, shared only
with other workspace Web surfaces and isolated from every managed role. Core
identifies those surfaces and the canonical profile path; Electron must not
derive the path from a synthetic `web-*` ID or call the managed-role path API for
it. A dedicated shared-session registry retains one native `Session` while
tracking every exact surface and popup lease. Clearing the shared profile is
admitted only when that registry has no live or releasing lease, then awaits the
same Chromium storage-clear, cookie flush, and empty readback evidence used by
managed stores. A web-only workspace is a real native-content launch and cannot
be treated as an empty managed-role launch.

The shared Web session is not an automation target. Its synthetic IDs never
enter managed role ownership, macro input, role migration, or role status. Tab
visibility, layout, audio, navigation chrome, contained fullscreen, popup
lifecycle, and teardown still remain part of the exact tab/window effect and
must be represented in the native projection.

Each visible Workspace Web slot is one paired native presentation rather than a
single renderer document. Its remote HTTP(S) content surface uses the persistent
global-Web session above. Its bundled navigation-chrome surface loads only the
local `runtime-web-chrome-electron.html` document in a dedicated, sandboxed,
in-memory Rion-owned shell session whose native `storagePath` readback is `null`.
Neither surface may enter a managed Role session, and a caller-provided session
label is never accepted as storage-identity evidence. Exact sender fencing,
canonical action/state parsing, and native visibility plus bounds readback apply
to both halves; a mismatch compensates or quarantines the pair instead of
publishing remembered state.

Mixed Workspace layout remains Core-owned. The macOS projection installs an
`NSAccessibilitySplitterRole` `NSView` in the retained AppKit content host and
lets pointer input fall through everywhere except the exact projected divider
hit rectangle. Windows projects the same divider into its bundled sandboxed
host. Both native pointer streams carry one host/attempt/window-generation
ownership fence and strictly monotonic gesture sequence into the Rust browser
action lane; only Core-accepted moves alter projected bounds, and only the exact
terminal end makes the layout durable. The paired
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016` and
`CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016` journeys use the same visible creation,
popular-site override, and launch spec while producing independent native
pointer and restart verdicts. Workspace contained fullscreen remains a separate
journey and is not inferred from this layout evidence.

Contained fullscreen is a Chromium document event, not a logical-window state
transition. Unprivileged global-Web and controlled-popup contents set
`disableHtmlFullscreenWindowResize`; exact `enter-html-full-screen` and
`leave-html-full-screen` events project through their owning native lane. For a
main Workspace Web slot, only the paired local Rion chrome hides and the remote
content expands to the already-authoritative slot. Website exit, Escape,
navigation, retirement, and shutdown restore or terminalize that transient
projection without changing Core topology. A controlled popup keeps its exact
native host envelope throughout. Any bounds, visibility, presentation, or host
identity mismatch fails closed and compensates or quarantines; renderer HTML
never replaces retained AppKit window/tab chrome. The paired
`CHROMIUM-*-WORKSPACE-WEB-FULLSCREEN-017` journeys exercise visible main and
popup controls on macOS AppKit and Windows Chromium, including restart.

The remaining Workspace cutover journeys keep the same physical-host boundary.
`CHROMIUM-*-WORKSPACE-WEB-ONLY-024` proves an empty-Role Web topology, isolated
persistent remote content and memory-only local chrome Sessions, event-bound
ready/degraded projection, native close/reopen, and restart. The paired
`WORKSPACE-SHARED-ROLE-025` journey attaches a sandboxed local blocked-slot
placeholder only inside the retained AppKit content host or Windows bundled
host; its visible claim becomes a Core terminal owner-generation transfer before
the old/new host projections reverse. `WORKSPACES-RECOVERY-026` reports an
active main-frame failure with exact Role owner fences. Core degrades only that
Role, leaves its healthy sibling ready, performs no automatic surface recovery,
and requires visible stop/relaunch or visible cancellation of a gated relaunch.
None of these local surfaces replaces AppKit Game Window or tab chrome.

## Complete session migration

Cutover is blocked until every retained role reaches `v23-ready` or the user
explicitly authorizes a reset for that role. Elapsed time, application restart,
or an unreadable source never counts as successful migration.

Schema creation is not migration evidence. Upgrading the state database creates
no role journal rows, so a retained v22 role with a missing or non-`v23-ready`
journal remains blocked by Core launch preflight. A role genuinely created under
the v23 contract is the narrow exception: Core first creates its exact empty,
identity-fenced managed store and then commits the role plus an explicit-reset
`v23-ready` receipt in one SQLite transaction. Portable or profile-imported role
records do not use that initialization path and cannot inherit its receipt.
Portable snapshot replacement preserves the destination-owned migration row
only for a Role already retained by the destination state; a newly introduced
Role receives no migration evidence, and removing a Role removes its journal.

The last stable Tauri release is the source-authoritative bridge release. After
it registers the exact v22 System WebView adapter, Core opens one immediate
SQLite transaction and walks every retained role in stable ordinal order. A
matching `v22-ready` journal is replayed byte-for-byte. A missing journal is
created, while an unlaunched journal from any later migration phase is rearmed as
a fresh `v22-ready` transfer with an advanced source epoch and no reusable target
evidence. This makes a subsequent return to v23 migrate the newly authoritative
System WebView state instead of silently accepting an older Chromium snapshot.
Any platform/engine mismatch or already-armed Chromium launch fence aborts and
rolls back the whole batch. Only after that durable commit does the native macOS
or Windows exporter resume. The bridge release is therefore a production
prerequisite for ordinary retained roles, while v23 still fails closed for a
database that never acquired this source-owned evidence.

The empty-store receipt is bound to the role, platform, source/target engines,
zero source/target revisions, transfer ID, transition ID, and a strict private
filesystem marker. A missing, replaced, symlinked, or identity-mismatched marker
fails closed before Core emits any Chromium launch effect. The marker contains no
cookies, LocalStorage, origins, or renderer-visible payload.

The migration state machine is Rust-owned and revision-fenced:

1. `v22-ready`: the System WebView store remains authoritative.
2. `exported`: an encrypted journal contains a complete source inventory,
   canonical records, source digests, role ID, platform, and source revision.
3. `importing`: Electron applies records only to the target role session.
4. `verifying`: the target is read back and compared with the canonical journal.
5. `v23-ready`: all required records match and the committed receipt is durable.
6. `failed` or `indeterminate`: the role remains on v22; retry and explicit reset
   are offered without deleting either source or journal.

Electron main is part of the trusted native evidence-producing boundary for
Chromium operations, because only it can own a `Session`, launch the fixed-mode
helpers, and observe their native acknowledgements. It is not a second journal
authority. The v23 Node-API transition accepts only the current role/transfer
identity, CAS revision, requested target edge, terminal classification, and
native receipt. Rust copies the source hashes, inventory counts, target
revision, reset evidence, and other protected fields from the durable record;
the generic target CAS, source-vault writer, and `firstVerifiedLaunchAt`
mutation are not exported by the Chromium target addon.
Consequently renderer or preload input cannot manufacture a successful edge,
and an accidental Electron-main call cannot rewrite the source inventory or
open an unrelated state-machine transition. This boundary does not claim to be
cryptographically secure against a malicious main process; such a process is
already inside the native Chromium trust boundary.

The inventory includes every cookie available to the native store, including
HTTP-only and secure attributes, and every identifiable origin's LocalStorage
keys and values. Origin scope, cookie domain/path, expiry, same-site policy,
security flags, and value bytes are preserved. Platform adapters must report
unsupported or unreadable data as a classified non-success terminal outcome.

The supported macOS WKWebsiteDataStore surface cannot produce the complete,
stable cookie and origin inventory required by this contract. The v22 macOS
export adapter therefore terminates as unsupported and never promotes partial
data. A user can still choose the existing visible **Clear saved data** action:
under contract v23, Core accepts that destructive consent only after Chromium
returns the exact storage-clear, cookie-flush, and empty-readback receipt, then
commits the role mutation, operation journal, and `explicitReset` migration
receipt in one SQLite transaction. A missing, malformed, stale, or mismatched
receipt restores the quarantined source and leaves migration non-success. The
contract v22 clear path does not create or rewrite v23 migration evidence.

The v23 explicit-reset receipt is fresh-process evidence. Electron main first
holds an exact role/effect/operation/path reservation without materializing that
profile as a main-process `Session`. One fixed-mode child then reopens only that
Rust-resolved path, awaits the all-store `session.clearStorageData()` Promise,
with no options so Chromium also clears storage types introduced after this
contract, awaits `cookies.flushStore()`, requires `cookies.get({})` to be empty,
drains the Session, and exits. The native launcher must observe the exact child clean exit
and inherited-pipe EOF before main may return the existing
`electron-clear-storage-data-promise-and-cookie-readback` receipt to Core. That
stable receipt label therefore denotes the complete fresh-child sequence, not
the earlier same-process subset. Its retained `clearedStorages` array is a Core
receipt compatibility vector, never the selector or an exhaustive limit for the
underlying no-options clear. Electron exposes no trustworthy enumeration of
all unknown LocalStorage origins; the LocalStorage authority is Chromium's
fresh-process, whole-store clear acknowledgement, not a fabricated origin
readback, a timer, `flushStorageData()`, or same-process reopening. A malformed
child response, path/effect/operation mismatch, unknown exit, nonempty cookie
readback, or reservation-release ambiguity remains failed or indeterminate and
cannot commit `explicitReset`.

The helper-backed role clear is `DeadlineBound`. On timeout, Core retires the
pending acknowledgement and publishes the exact effect and operation IDs
through the critical cancellation stream; every later helper result is
classified `late` and cannot commit the reset. Core deliberately retains the
quarantined source, recovery journal, and active role lease instead of restoring
the directory while the child or Chromium Session may still own its path.
Electron forwards the abort to the native launcher, and clean shutdown's
`cancel_all_and_wait` fence terminates and reaps that child, drains stdout to
EOF, and releases the role-path reservation. The next process start restores
the quarantined source from the durable journal. If Windows rejected the
quarantine rename because the source was locked, restart treats the durable
`deferred` phase as an aborted prepare: it may delete only the journal, and only
after proving that the original role directory still exists and no quarantine
exists. It never deletes that source, completes the clear, or commits v23
`explicitReset`; any other disk topology remains journaled and fails closed.
An explicit helper failure
received before the deadline has already crossed the native cleanup fence and
may use the ordinary in-process rollback path.

Export runs only after role surfaces are closed and the authoritative native
store reports a stable snapshot. The encrypted journal is written atomically
under the managed session-transfer directory and contains no plaintext secrets.
Before the source-owned `v22-ready -> exported` CAS can commit, AppCore holds
the vault lock, decrypts and authenticates that exact pending vault, and matches
its role, transfer, hashes, and every inventory count against the transition.
An exact replay authenticates the already committed vault again. A caller-only
hash or an absent, replaced, or mismatched vault therefore cannot create
`exported` evidence.
Import is idempotent by transfer ID and target revision. Verification reads the
Chromium session back after storage flush, compares the full canonical set, and
commits only when no required record is missing, changed, or extra because of
the transfer. A crash at any point resumes from the durable state without
guessing completion.

On every v23 process start, the production Node addon checks the caller's
platform against its compile target and requires the exact v23 runtime contract
before AppCore opens the data directory or creates a backup. The retained-v22
factory is compiled only into the desktop-E2E addon and is rejected by the
production-addon surface gate. Electron then lists the durable Rust journals before it
registers the Chromium runtime or subscribes to Core effects. An exact
`exported` revision enters `importing` only through a private Rust admission
that atomically preserves the source digests and counts, allocates target
revision `1`, and supports exact replay after an unknown acknowledgement.
Admission JSON is limited to `roleId`, `transferId`, and
`expectedJournalRevision`; it cannot provide `platform` or
`runtimeContractVersion`. Core injects both values from the immutable `AppCore`
context and checks the v23 contract gate plus journal platform inside the same
immediate SQLite transaction that admits the import. Exact `importing` and
`verifying` revisions then resume through exclusive fresh-process migration
registries bound to the same Rust-resolved role path later used by live Chromium
surfaces. Those helper registries terminate before the live registry can open
the path. Runtime registration completes before a local effect consumer is
attached and the one raw Core event bridge starts; raw subscription never
precedes journal admission or drops an effect into an empty local listener set.
A startup scan validates the physical platform of every eligible journal before
starting any role lane and joins all lanes already started before propagating a
fatal rejection. A structured Rust admission or transition rejection is fatal;
only a transport failure or malformed/missing acknowledgement remains
indeterminate for exact replay.
A temporary main-process `before-quit` fence is installed before this scan and
hands authority to the normal lifecycle listener only after runtime startup has
finished. Its `AbortSignal` reaches every fresh migration helper through the
private Node boundary. Cancellation therefore kills the exact child and still
waits for child exit plus inherited-pipe EOF; cookie-only work instead finishes
its current Chromium acknowledgement and exact Session release before startup
observes cancellation. The scan joins every admitted lane and cannot transition
an aborted result to `verifying` or `v23-ready`.
A pending quit is checked again immediately before lifecycle handoff. The
normal listener is installed synchronously before the startup fence is removed;
if the earlier fence already observed quit, startup enters the ordered runtime
drain instead of consuming that request or creating the main window.
A pending, failed, malformed, or indeterminate resume remains non-success;
starting the shell or registering the adapter does not promote that role.

Electron 43 provides promise-backed cookie mutation, readback, and cookie-store
flush, so a cookie-only inventory can obtain an exact in-process receipt. Its
DOM Storage flush API returns no promise, callback, or completion event. A live
LocalStorage readback therefore proves the logical values but not crash-durable
disk completion. LocalStorage-bearing inventories use a fixed-mode packaged
helper protocol over bounded anonymous stdin/stdout pipes. The first helper
validates the canonical encrypted-vault envelope identity, journal revision,
Rust-owned role path, digests, and counts; it clears the destination, applies the
complete cookie and origin-scoped LocalStorage inventory, reads it back, drains
its exact `Session`, and exits. Only the native launcher-confirmed child exit
allows a second, distinct helper process to reopen the path and reproduce the
complete readback. Electron then records a bounded
`chromium-session-fresh:<sha256>` receipt derived from both clean-exit evidence
values and the exact migration identity before Core can enter `verifying` or
`v23-ready`.

A crash in `verifying` launches another read-only fresh verifier and requires it
to match the already committed receipt identity. Any apply, verify, revision
fence, or receipt failure invokes a separate clear helper followed by a fresh
rollback verifier for every migrated origin; failure to prove that empty state
terminalizes as indeterminate. A same-process delay, timeout, second view,
`flushStorageData()` call, or elapsed restart window is never durability
evidence.

Before Core publishes the first native Chromium effect for a role, it advances
that role's exact `v23-ready` journal with the durable
`firstVerifiedLaunchAt` admission fence. This ordering closes the crash window
in which a page could mutate Chromium storage before downgrade safety was
recorded. The fence is deliberately retained if native creation, navigation, or
readiness later fails: failure cannot prove that no durable page mutation
occurred. Stable v22 startup rejects the entire downgrade batch once any role
has this fence. A cross-shell rollback is therefore session-safe only before
any role's first v23 launch admission; an unlaunched v23 journal is rearmed to a
fresh v22 transfer as described above. This safety condition does not itself
promise that an updater backup is still available.

Source v22 data and the encrypted journal remain recoverable through this first
verified launch admission. Deletion requires a later retention policy or an
explicit user reset; successful import alone does not authorize destructive
cleanup.

## User-consented Chrome Profile import

Chrome Profile import is a bounded, one-time transfer into a managed Chromium
role; it is not the v22-to-v23 runtime migration and never makes the user's live
Chrome profile a runtime fallback. Core remains the transaction authority for
profile discovery, launch-origin filtering, unsupported-data counts, encrypted
staging, role creation/replacement, rollback, and commit.

Electron receives no staging path or plaintext through renderer IPC. A private
Node-API call first verifies the exact transaction, journal phase and revision,
role, launch origin, replacement policy, canonical destination, and staging
digest before releasing a bounded payload to a packaged helper. The helper
handoff uses a one-time native capability rather than argv, environment
variables, logs, or a TypeScript-decrypted file. A transaction-scoped exclusive
lease prevents live surfaces, browser-data maintenance, migration, or another
import from opening the destination session.

Import and durability verification run in separate clean Electron helper
processes. The first process applies cookies and origin-scoped LocalStorage,
flushes the store, records fenced backup/apply evidence, and exits cleanly. A
second fresh process reopens the exact destination path, reproduces the complete
canonical readback and authentication probe, records verification evidence, and
exits. Only then may Core atomically commit the role mutation and durable marker.
Same-process reopening, a second view, elapsed time, or a successful
`flushStorageData()` call is not LocalStorage durability proof. Crash recovery
re-enters from the durable Core phase; an unknown acknowledgement becomes
indeterminate and never success.

## Event topology and lifecycle

Runtime work remains event-bound unless an external API is explicitly declared
deadline-bound. Window creation, view attachment, navigation, close, crash,
download, permission, macro input, and application shutdown terminalize from an
authoritative Electron or Rust event carrying the exact logical ID, generation,
operation ID, and revision. Presentation coalescing may delay layout but cannot
discover state or decide success.

Renderer readiness, application-window close, and runtime-surface teardown are
ordered. Once drain begins, new work is rejected, active operations receive a
terminal outcome, Chromium storage is flushed, Rust shuts down, and only then
does the process exit. Renderer disappearance never becomes proof that Core
shutdown completed.

Windows OS shutdown, restart, and sign-out enter through the main native
window's `query-session-end` event because Electron does not deliver the normal
application quit sequence for that boundary. The handler prevents immediate
termination, joins one replayable Core/runtime drain, and admits `app.quit()`
only after that exact event-bound result succeeds. Repeated native queries do
not start another drain. macOS does not register this Windows-only event and
continues through its ordinary application lifecycle plus retained AppKit host
teardown.

A fatal startup after lifecycle admission joins that same `prepareQuit()`
result instead of directly shutting the runtime and re-entering `before-quit`.
Failures before lifecycle construction drain the active Chromium runtime, or
Core when no runtime exists. Only a successful drain and final shell disposal
use clean quit; any unknown or failed terminal result exits nonzero and is never
recorded as a clean shutdown.

Core effect identities are retained in a bounded replay ledger for the live
adapter process. An exact duplicate re-sends the original terminal receipt and
never repeats native mutation; reusing an effect identity for different content
fails closed. Trusted input adds per-role input-epoch and surface-generation
fences and accepts only an exact AppKit/Win32 native receipt. Electron
`WebContents.sendInputEvent` is not a background-input authority and cannot be
used to advertise that capability.

On macOS, native submission is only a `submitted` receipt. A sandboxed role
preload, unavailable to the page world, arms one exact main-frame observation
and reports the expected trusted DOM sequence. Main validates the sender
`WebContents`, main-frame object, opaque frame token, role and surface
generation, input epoch and sequence, event type, key/button, coordinates,
modifiers, and `isTrusted`. Key success requires its complete down/up sequence;
mouse success requires down/up/click. Navigation, frame replacement, surface
retirement, cancellation, or close terminalizes the event-bound observation.
None of these steps may make the AppKit host key window, change either first
responder, or focus the background Chromium document.

On Windows, the managed foreground lane owns one dedicated no-activate
`WS_CHILD` per Role surface. Electron `isFocused()` is necessary but not
sufficient: the native ABI locks opaque child/parent identities and returns
`parentWasForeground=true` only when the exact runtime parent HWND is the live
foreground owner. Focus success is event/readback-bound, and key/click success
also requires that native foreground fence before submission plus a preserved
owner and exact `isTrusted` DOM acknowledgement afterward. Elapsed time is only
a failed deadline, never focus or input success.

Fullscreen Game Window presentation uses the same Rust/Core-owned placement and
window-preference records on both targets. On macOS, the View-menu checkbox and
green fullscreen control remain real AppKit UI; Chromium Role surfaces only
follow the retained controller's revision-fenced content layout. On Windows,
managed-page F11 is intercepted above page delivery and enters the same
event-bound Core command. The frameless host loads a bundled, sandboxed local
tab/control document in the dedicated non-persistent `rion-runtime-shell`
session; exact sender URL, WebContents, generation, and projection revision are
required for reveal and minimize/maximize/close commands. Native enter/leave or
maximize/unmaximize events terminalize presentation, and a superseded Core
commit explicitly compensates the native host back to the latest Core state.
The paired `CHROMIUM-*-FULLSCREEN-TOOLBAR-012` journeys preserve transition
history as read-only evidence while their preference, fullscreen, and pointer
actions remain visible UI.

Game-window tab parity is admitted through the platform's real native control
surface, never a debug command. The paired
`CHROMIUM-*-TABS-VISIBLE-ACTIVATION-019` and
`CHROMIUM-*-GAME-WINDOWS-TABS-020` journeys activate and focus three ready Role
tabs, close and visibly relaunch one dormant Role, close and reopen the dormant
window, and repeat admission after restart while read-only evidence verifies the
exact active, dormant, ordered, visible, and native-window-generation topology.
macOS performs those actions through the retained AppKit tab row and host;
Windows performs them through the bundled, sandboxed local Chromium control
document and its revision-fenced Core command lane.

The paired `CHROMIUM-*-RUNTIME-TAB-TOPOLOGY-009` replacements extend that same
journey without changing authority. A real CoreGraphics drag on the retained
AppKit radio tabs, or a real WebDriver pointer drag on Windows, reorders the
native strip. The visible AppKit NSMenu or bundled-host context menu moves a tab
to an existing live Game Window, detaches the selected tab to a newly
Core-provisioned window, and hides it; the visible Role Open button reveals the
same durable tab. Menu selection re-reads the exact source and target Core/native
window generations, topology revisions, tab order, parent native handle, and
AppKit identity before entering the single Core-owned action lane. Read-only
evidence proves the source selects its successor after detach and that the
distributed topology survives restart before visible consolidation. On Windows,
two differently sized hosts additionally prove each role controller fills its
current-root content bounds, and minimize plus visible restore preserves those
bounds without a renderer resize event.

The retained AppKit menu keeps native Reload, Move, Move New, Mute/Unmute, Hide,
and Stop labels; the bundled Windows host exposes the matching visible context
menu. Reload captures the visible menu's exact tab, window generation, topology
revision, and application lifecycle epoch. macOS may compare that capture with
current AppKit/Core ownership only to reject a stale selection; neither platform
re-reads or upgrades the submitted fence. Core derives the role owner, surface,
document, and input epochs after accepting that exact source, then its
EventBound prepare/commit effects submit one permanent-WebContents navigation.
Only matching document-start, page-finished, and input-resumed evidence can
produce the Applied `inputReady` terminal receipt. A later Stop, Move, or Close
may supersede a pending reload without waiting behind it. Direct
`WebContents.reload()` outside this controlled lane, elapsed time, or stable
Tauri v22 cannot establish reload success.

## Updater and release

The existing signed updater manifest, detached signature, SHA-256 verification,
rollback, recovery journal, and drain semantics remain mandatory. Electron's
built-in macOS auto-updater is not the authority because production macOS builds
remain ad-hoc signed. A Rust-owned helper verifies and stages the correct
Electron artifact before the same install transaction terminalizes.

Production macOS applications remain ad-hoc signed and not notarized. Windows
installers remain Authenticode-unsigned. Tauri-to-Electron upgrade compatibility
and Electron-to-Electron update recovery must both pass before the production
channel changes shells.

`v22` and `v23` in this migration are runtime-contract identities, not
application-version majors. Published Tauri, prior Electron, and target Electron
artifacts each carry an independent strict SemVer application version. Release
gates bind those exact versions and require the target to be newer than both
sources; they must not require application major 22 or 23.

The cross-shell input/layout gate consumes immutable external artifacts from the
exact retained Tauri release rather than relabelling an Electron fixture as v22.
It binds the release tag, source commit, version, target Electron commit, both
platform artifact hashes, updater manifest, detached signature, and production
updater key into an auditable receipt. Its isolated macOS and Windows probes
exercise real bundle/installer replacement, but deliberately record
`sourceUpdaterInvoked: false` and `cutoverEligible: false`; they are not evidence
that the published v22 process fetched and initiated v23.

The gate also produces a separate, create-new public-source-lineage receipt on
each platform. It binds the public release and asset IDs, selected artifact
bytes and hashes, peeled source tag, target source SHA, updater trust, and the
actual v22 executable derived from the canonical macOS archive member or an
isolated Windows NSIS installation. Each single-file receipt is attempt-bound
and receives GitHub provenance attestation, but remains
`cutoverEligible: false`. Promotion readiness verifies both attestations and
cross-binds their artifact, manifest, trust, and executable hashes to the real
v22 terminal transactions; lineage alone never claims updater invocation.

Cutover additionally requires four externally attested source-runtime
transactions: v22-to-v23 and prior-v23-to-target-v23 on macOS and Windows. Each
transaction preserves the product's raw install-attempt ID, binds the actual
source fetch endpoint separately from the target binary's future embedded
endpoint, and ends only after target first boot writes a durable Rust-authored
terminal receipt. That receipt hashes the exact source journal and is committed
only after platform finalization, pending-payload cleanup, and preference
persistence; only then may the source journal be removed. On macOS the target
observation must still identify the retained AppKit host.

The published v22 endpoint is compile-time fixed to the public latest route, so
real v22 evidence cannot honestly be produced while the target is unserved. A
future owner-approved flow must preserve the v22 latest snapshot, provisionally
serve the exact candidate, obtain the four terminal transactions, and then either
finalize with a distinct terminal promotion receipt or record rollback or an
indeterminate outcome. Candidate construction and read-only readiness
aggregation cannot publish, finalize, or bypass these missing gates.

## Cutover gates

The production entry points change from Tauri to Electron only after all of the
following are true:

- the Node-API bridge and typed preload pass contract, validation, cancellation,
  subscription, backpressure, shutdown, and malformed-input tests;
- every v22 P0/P1 desktop journey has a visible-UI Chromium equivalent, including
  role isolation, popups, downloads, file uploads, macros, recovery, updates,
  and permissions;
- the complete session migration passes fresh, retry, crash-resume, readback,
  rollback, explicit-reset, and mixed-role fixtures on macOS and Windows;
- packaged Electron artifacts contain the correct native addon and Chromium
  resources, use a portable macOS addon install name, contain no renderer E2E
  controls, start from the final ASAR under an isolated platform AppData home,
  and pass signed-candidate integrity checks;
- macOS and Windows build, lint, Rust test, renderer test, smoke, full, isolation,
  update, and release workflows are green; and
- a source gate proves no renderer imports privileged APIs, no forbidden browser
  fallback has returned, and no production path still depends on Tauri.

After cutover, Tauri dependencies, `src-tauri`, Tauri build and release scripts,
System WebView native adapters, and transitional dual-shell entry points are
removed in one audited cleanup. The engine-neutral `rion-appkit` controller
remains part of the macOS product. Contract v22 remains documented as migration
history, while v23 becomes the only active runtime contract.
