# Chromium Extensions

Extensions is an additive Chromium capability. The stable Tauri v22 adapter
rejects its commands, and the renderer discovers availability through the typed
bridge after startup. This does not introduce a selectable browser engine.

## User behavior

The Extensions route manages installed packages with a header search and Add extension action.
Add extension opens `https://chromewebstore.google.com/category/extensions` with
`hl` synchronized to the app language (`en`, `zh-TW`, `zh-CN` → `zh`, `ja`)
and a separate Back to extensions action. A language change updates the current
store URL while retaining its path and other search parameters; resizing or
reopening in the same language does not reset navigation.
The sidebar displays the catalogue count, including zero and pending-removal
entries until cleanup, and follows revision-fenced Core events on every route.
At the supported 960 px minimum window, installed packages appear as an
equal-height three-column card grid; a defensive content-width fallback below
660 px uses one column, and the grid never grows beyond three. Each card keeps
the existing version, assignment summary, state badges, and explicit management
action while adding a transparent, background-free 48 px package icon, a two-line description, localized
logical installed size, and a compact ID whose tooltip exposes the full value.
Invalid or unavailable metadata falls back to the Puzzle icon and localized
missing-description or unavailable-size text without disabling management.
Successful installation returns to the unfiltered catalogue; cancelling confirmation
returns to the store. Empty and no-match states offer add and clear-search actions. The store is
an isolated, unprivileged native WebContentsView. Electron 44.4.3 renders the complete remote detail document, including navigation
from search results and autocomplete. The current main-frame URL and native
navigation history own the Rion toolbar state; there is no virtual detail selection.
A Rion-owned install button uses the validated current detail ID; store DOM and
private Chrome APIs are not installation authorities. Electron 44.3.0 exposed
`chrome.webstorePrivate` without its native delegate (upstream electron/electron#53752),
so calling it from store details crashed the browser process. The previous anchor-click
interception missed autocomplete navigation and was removed with the 43.7.0 rollback.
The current 44.4.3 pin includes the upstream fix that keeps this unsupported API
unavailable to store pages.
The store document, header, and main content use 100% of the embedded viewport width,
overriding the upstream 1280px minimum without changing zoom. Horizontal document
scrolling is disabled; vertical browsing remains available. A presentation-only
CSS selector hides the header's specific Chrome-promotion dialog controller
(`h4ilFc`), without dismissing or hiding generic dialogs. This upstream selector
is covered by the live-store journey and may need updating when Google changes
its markup. The native view is hidden during extension
confirmation, Quick Access, and route departure.

Installing first downloads and verifies a public CRX3 package, then displays
its manifest permissions and asks the user to choose Selected roles or All roles.
No role is selected by default. All roles includes current and future roles; it
is a durable rule, not a one-time selection. Selected roles offers search, select
all current roles (independent of search), and clear selection. Switching modes
preserves the current draft; switching a saved All roles rule to Selected roles
starts with all current roles selected. No-role installations remain supported.
Dialogs keep their actions visible while the contents scroll. Removal has a
separate confirmation step; cancellation restores the management draft. New
preparations accept Manifest V3 packages only after every RSA and P-256 ECDSA
CRX3 proof verifies. The signed-header ID, requested store ID, and developer-key
derived ID must match, and a proof whose SPKI SHA-256 matches Chromium's
production Chrome Web Store publisher key is mandatory. A matching 1024-bit
legacy RSA developer proof is accepted only when that production publisher
proof is valid; every other RSA proof requires at least 2048 bits. The verified
developer SPKI is written to manifest `key` so Electron retains the same ID.
Existing installed directories are not reverified. Their display metadata is
backfilled from the already-managed files as described below; package identity
and executable contents are not migrated. Electron 44.4.3 (bundled Chromium
152.0.7977.130) loads each package in its assigned Role Session. An audited,
vendored compatibility layer fills only the API surface listed below; native
Chromium remains authoritative for declarativeNetRequest and scripting. A
successful package load does not imply support for undeclared APIs. Popups,
extension settings pages, global-Web assignment,
automatic updates, authenticated store purchases, and Chrome-profile import
are outside this version.

The catalogue is shared; assignment policy, enabled roles and each role's Chromium extension data
are separate. Configuration changes affect the next full role close/open, not
the current document. Removal first records a tombstone, preserves files used
by an active lease, and cleans them after the last native release. Extension
storage remains in the role profile. Failed filesystem cleanup retains the
tombstone; it is never treated as proof that files were deleted.

## Electron 44.4.3 runtime (2026-09-22)

The current runtime pin is Electron 44.4.3, Chromium 152.0.7977.130,
Node 24.21.0, and Node module ABI 149. The official
[release record](https://releases.electronjs.org/release/v44.4.3) identifies the
stable engine; `verify:electron-runtime` checks the installed binary and Rust
Node-API addon together. Electron 44's asynchronous clipboard writes are awaited
before acknowledging coordinate copies or graphics-report copies. No profile,
extension package, or persisted user setting is reset for this upgrade.

The checks below retain their recorded engine versions as historical evidence.
The source-only DNR allocation candidate under `patches/electron` targets 43.7.0;
its input hashes do not authorize applying it to 44.4.3.

The isolated DNR allocation probe was rerun on macOS arm64 with 44.4.3 on
2026-09-22. Seed still succeeds, but fresh-process restart rejects disabling the
one-rule resource with `The set of enabled rulesets exceeds the rule count limit.`
The known 43.7.0 engine defect described below remains unresolved in this upgrade;
passing extension isolation, storage, and filtering probes does not certify it.
A separate 43.7.0 binary reproduced the same seed/restart failure on that host.

The live store journey also remains non-passing: after opening and reloading a
Buster detail page, Back briefly restores the search URL, then the remote store
navigates to its home page instead of restoring the visible search results.
The same isolated UI sequence reproduced on both 43.7.0 and 44.4.3; waiting for
the document load and visible search content did not resolve it. The paired
`CHROMIUM-*-EXTENSIONS-001` journeys remain required, with no relaxed assertions
or claimed full-profile pass. Windows still requires its native CI run.

## Electron 43.7 rollback validation (2026-09-14)

The runtime pin at that validation was Electron 43.7.0, Chromium 150.0.7871.250,
Node 24.21.0, and Node module ABI 148. The official
[release record](https://releases.electronjs.org/release/v43.7.0) and
[upstream delegate fix](https://github.com/electron/electron/pull/53752)
explain the engine selection; `verify:electron-runtime` probes the installed binary.

`RION_DOWNGRADE_PREVIOUS_ELECTRON=<44.3 executable> node scripts/verifyElectronDowngradeStorage.mjs`
requires the exact old/new versions and performs a clean 44.3 write/exit followed
by a fresh 43.7 reader. The isolated fixture preserved cookies, LocalStorage,
IndexedDB, and extension `storage.local`. A stopped existing role profile was
also copied to a disposable directory and opened with an inert same-origin page
using `scripts/electronProfileReadbackProbe.cjs`: both binaries returned identical
hashes for 73 cookies and 9 LocalStorage records (that origin had no IndexedDB).
The source profile was never opened by the probe, reset, or rewritten. This is
bounded compatibility evidence for those formats and that copied role, not a
guarantee for every third-party database schema.

The development computer-use check entered the Buster detail document through
normal results, autocomplete mouse selection, and autocomplete keyboard selection.
Reload, Back, and Forward retained real document content and the original process.
The paired Extensions journeys assert the actual detail URL and visible heading,
retain process identity, and capture each route; button enablement alone is insufficient.

## Authority and propagation

The additive `applyToAllRoles` field defaults to false for old records and commands.
Rust normalizes explicit role IDs to empty in All roles mode and evaluates the
rule at lease acquisition. Future roles need no copied assignments; global-Web
sessions remain outside role scope. Removal disables the rule before cleanup.
Settings commits publish revisioned snapshots only after successful persistence.

## Runtime compatibility boundary

The compatibility layer is a bounded fork of Rambox's
`@ramboxapp/electron-chrome-extensions` 4.10.3 at commit
`026cea78b6d743a81e2aa0e84d236081fccf4c72`. Rion compiles only the audited
alarms, commands, document context menus, notifications, offscreen, permissions, session-storage, tabs,
and web-navigation modules plus its compatibility handshake. It deliberately
does not compile the upstream remote-session, WebSocket, native-messaging,
downloads, identity, management, context-menu, cookie, or window-mutation
modules.

Supported compatibility APIs are `permissions` (including `onAdded` and
`onRemoved`), `webNavigation` events, `notifications`, `offscreen`, `commands`,
`alarms`, document `contextMenus`, `storage.session`, and safe `tabs` read/query/reload/navigation events.
`action` and `browserAction` expose bounded read/no-op behavior; popup opening is
not supported. Chromium supplies Manifest V3 service workers, content scripts,
`declarativeNetRequest` including static rulesets, and `scripting`. This covers
the core blocking flow used by uBlock Origin Lite and the core challenge flow
used by Buster; it is not a promise of arbitrary Chrome extension parity.

Packages requiring `debugger`, `enterprise.*`, `management`,
`nativeMessaging`, `proxy`, or `vpnProvider` are rejected before load. Rust supplies
`requiredApiPermissions` from manifest `permissions`, separately from the combined
`permissions` list shown during installation. Optional permissions do not block
loading and are not granted; requests continue to be denied. Native
`management.getSelf()` remains available without the management permission.
Missing classification metadata skips that package with
`ELECTRON_EXTENSION_PERMISSION_METADATA_UNAVAILABLE`, never an implicit empty list. Native
messaging, native clients, toolbar popups, arbitrary tab/window mutation,
renderer/preload debugger access, external Chrome/CDP clients, and a Node
WebSocket proxy remain outside the security boundary.

Rust owns the revisioned catalogue stored under the `extensions` settings key in
the existing SQLite state worker, package preparation, bounded official-source
HTTP download, CRX identity/signature verification, safe unpacking, and role
leases. No new database file or profile-import field is introduced. Package
directories belong to the app's `extensions` root. The original CRX digest is
recorded, and the verified publisher key is retained in the unpacked manifest
to preserve the store ID independently of its filesystem path.

After verified unpacking and the manifest publisher-key rewrite, Rust resolves
literal or `__MSG_*__` descriptions through `default_locale` and bounds display
text to 400 characters. It prefers the manifest's 48 px management icon, then
the nearest larger or largest smaller supported raster source. Unsafe paths,
symlinks, SVG/WebP sources, unreadable files, and icons over 512 KiB are ignored.
The recorded installed size is the deterministic sum of extracted regular-file
bytes, including the rewritten manifest—not download bytes or allocation blocks.

Before Core publishes `Ready`, a bounded one-time catalogue pass backfills
missing metadata only from canonically contained package directories. Recovered
records are atomically persisted with one catalogue revision increment. A
missing, unreadable, or invalid legacy directory preserves its original record,
emits a bounded warning, and never prevents startup or extension management.

The typed `extensions` Core command separates renderer-allowed operations from
privileged acquire/complete/release commands. Core publishes revisioned
`extensionsChanged` snapshots. Electron owns only native Sessions and handles,
loads the frozen Core selection before game navigation, and acknowledges the
matching lease. Release waits for exact `extension-unloaded` events. Old leases
cannot terminalize a replacement. Each extension is isolated: a known unsafe
manifest is skipped, and an ordinary load, bootstrap, or ruleset failure marks
the Role extension lease `degraded` while the Role continues opening. The
15-second external load/bootstrap deadline is `DeadlineBound`; an unknown late
load is `indeterminate` and blocks Role navigation until its exact extension is
observed and unloaded. Normal release remains `EventBound` on the exact
`extension-unloaded` event.

Development output and exported diagnostics correlate Electron permission
warnings, extension/service-worker runtime errors, compatibility handshake
results, and terminal lease outcomes by extension ID. Records contain bounded
codes, API/member names, relative source paths, line/column, and Role ID only;
absolute user paths and extension payloads are not retained. The Diagnostics
log-source filter includes both `preload` and `extension` records.

HTTP has a 10-second connection and 60-second overall external deadline; failure
does not install anything. Both declared `Content-Length` and bytes actually
read are limited to 128 MiB. Before writing any file, the ZIP central directory's
cumulative declared unpacked size is limited to 512 MiB; extraction also checks
every file's actual byte count. Download chunks and ZIP entries observe explicit
cancellation, and the staging `TempDir` owns complete cleanup on every failure.
The HTTPS-only store and redirect allowlist remains bounded to Google delivery
hosts. Local operations and native callbacks are
event-bound. Explicit cancellation and shutdown cancel staged preparation.
There is no installation retry loop, profile scan, remote debugger, or extension
injection into the application renderer or store Session.

This follows Chromium's [CRX verifier](https://chromium.googlesource.com/chromium/src/+/HEAD/components/crx_file/crx_verifier.h)
and [CRX3 proof format](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/crx3.proto)
without adopting the [Chrome Web Store's broader 2 GiB publishing ceiling](https://developer.chrome.com/docs/webstore/publish).
The
128/512 MiB limits are deliberate Rion product bounds.

Package failures cross the existing typed Core bridge with stable codes for
temporary store unavailability, compressed and unpacked limits, invalid
signatures, unsupported manifests, cancellation, and generic package failure.
The renderer localizes those outcomes in all four app languages. Only temporary
store unavailability asks the user to retry; permanent size, signature, and
manifest failures are reported as unsupported.

## Validation and release gate

- `cargo test -p rion-core extensions` covers signed and tampered packages,
  cross-platform path safety, frozen role leases, removal, and v22 exclusion.
- `cargo test -p rion-core live_adblock_download_signature_and_unpack -- --ignored`
  downloads the current official AdBlock package and exercises CRX3 identity,
  production publisher proof, Manifest V3, bounded unpacking, and manifest ID.
- `pnpm run verify:electron-extensions` launches two fresh Electron processes
  with isolated profiles and checks stable IDs, content scripts, background
  replies, storage isolation, unload/reload, and persistence. It then loads a
  representative Manifest V3 worker containing the original
  `permissions.onRemoved`, `webNavigation`, and `notifications` failure shape,
  and verifies session storage, tab query, offscreen document creation, and a
  native static DNR ruleset. CI runs it on both supported native hosts. The
  committed signing key is a throwaway test fixture, never a production trust
  anchor.
- `pnpm run verify:electron-extension-compat` checks that the built compatibility
  bundles contain the required APIs and do not contain forbidden native,
  remote-session, WebSocket, or privileged management surfaces.
- `CHROMIUM-MACOS-APPKIT-EXTENSIONS-001` and
  `CHROMIUM-WINDOWS-EXTENSIONS-001` cover visible AdBlock installation, role assignment,
  native worker-running plus validated compatibility readiness, application restart, disabling, and cancel/confirm removal in their existing
  Chromium smoke profiles. These journeys explicitly depend on live store
  availability; external failure fails the journey. AdBlock 6.45.5 declares
  `management` only as optional. These journeys require fresh `ELECTRON_EXTENSION_READY`
  evidence after classification, including close/reopen and application restart;
  a generic `degraded` role status alone is insufficient. Later API incompatibilities
  remain visible and do not establish complete AdBlock support. Deterministic
  extension fixtures separately prove native load and exact unload completion.

Production eligibility requires both native platforms. Local macOS evidence
does not satisfy Windows or the broader Chromium cutover gates.

Every public desktop release includes `Rion.Studio-source.tar.gz`, containing
the tracked release source and complete GPL text under a versioned top-level
directory. Release asset validation rejects a missing archive, version mismatch,
unsafe path, missing vendored fork source, or checksum mismatch.

## AdBlock publisher verification (2026-09-10)

The focused Rust package suite passed 14 deterministic tests plus the explicit
live AdBlock test. The live package was AdBlock 6.45.5 with ID
`gighmmpiobklfepjocnamgkkbiglidom`; production publisher proof verification,
the legacy 1024-bit developer proof, MV3 unpacking, and manifest ID retention
all passed. Its installed logical size was 329,611,180 bytes, above the retired
256 MiB limit and below the 512 MiB product limit.

The Electron two-process extension probe passed, and the focused macOS
`chromium-extensions-seed` and `chromium-extensions-restart` phases both passed
with visible AdBlock confirmation, All roles assignment, the exact extension
ID, role-load acknowledgement, restart persistence, and removal. The matching
Windows native profile remains a required CI gate.

## Implementation verification (2026-09-07)

On macOS arm64, the `chromium-macos-appkit-smoke` profile's focused
`chromium-extensions-seed` and `chromium-extensions-restart` phases passed,
including a live Chrome Web Store installation and a role launch acknowledged
as loaded by Core. The native two-process probe separately passed unload/reload
and storage isolation/persistence checks. The complete JavaScript/TypeScript
suite passed 3,654 tests across 454 files; native Rust workspace tests passed.
Windows platform mocks passed locally; the `chromium-windows-smoke` profile,
Windows native probe, and Windows Rust checks remain pending CI. No full
Chromium cutover or Windows production eligibility is claimed by this change.

The viewport-width follow-up passed the macOS smoke profile’s focused
`chromium-extensions-seed` phase, including document/header/main width assertions
and the existing install/role-launch flow. Native live-store checks at 600px and
1100px reported document scroll width equal to viewport width. Both Extensions
journeys include the width regression; Windows execution remains pending CI.

The Chrome-promotion follow-up passed the macOS `chromium-macos-appkit-smoke`
profile’s `chromium-extensions-seed` phase: the specific dialog exists but is
not displayed, followed by the existing install/role-launch flow. The affected
journeys are `CHROMIUM-MACOS-APPKIT-EXTENSIONS-001` and
`CHROMIUM-WINDOWS-EXTENSIONS-001`; Windows remains pending CI.

## Assignment and UI follow-up (2026-09-07)

The catalogue now uses a shared header search and Add extension action. Install
and management dialogs separate permissions, assignment scope, and removal,
with fixed action footers and scrollable contents. All roles is persisted by
Core and includes future roles; switching back to Selected roles restores the
explicit draft without modifying active leases.

The focused `chromium-macos-appkit-smoke` phases `chromium-extensions-seed` and
`chromium-extensions-restart` passed with the updated journeys. They exercise
live installation with All roles, visible creation and launch of a future role,
restart persistence, switching to explicit assignments, and cancelled/confirmed
removal. The launcher was resized to 960×640 through the test runner's Electron
API; light installation and dark management screenshots cover many long role
names and assert visible footers without horizontal dialog overflow. Geometry
is a test precondition; domain mutations still use visible UI.

Validation passed: 3,678 JavaScript/TypeScript tests, native Rust workspace tests,
typecheck, lint (existing warnings only), Rust lint, build, source hygiene,
documentation/context/dependency checks, E2E coverage, and production E2E
isolation. Windows platform mocks and Core platform-table tests ran locally;
Windows Rust and `chromium-windows-smoke` native execution remain pending CI.
These focused Chromium phases do not claim a full smoke/full-profile run or
Chromium cutover eligibility.

The store-entry locale follow-up passed 3,685 JavaScript/TypeScript tests,
including all four language mappings, preserving other URL parameters, and
avoiding repeated navigation on same-language show requests. The macOS
`chromium-macos-appkit-smoke` / `chromium-extensions-seed` phase passed with an
explicit `/category/extensions?hl=en` assertion followed by installation and
future-role loading. Both existing Extensions journey entries were updated;
Windows native execution remains pending CI.

The sidebar-count follow-up passed 3,688 JavaScript/TypeScript tests, typecheck,
lint, source hygiene, and coverage checks. The `chromium-macos-appkit-smoke`
seed/restart phases verified counts 0 → 1 → 1 after restart → 0 after removal
for `CHROMIUM-MACOS-APPKIT-EXTENSIONS-001`; the matching
`CHROMIUM-WINDOWS-EXTENSIONS-001` assertions are updated and await Windows CI.

## Extension metadata cards (2026-09-10)

Installed Extensions now use equal-height three-column cards at the 960×640
supported minimum. Verified package metadata supplies a transparent,
background-free icon, localized description, deterministic logical installed
size, and full ID tooltip; legacy catalogues receive the bounded startup
backfill described above.

The focused macOS `chromium-extensions-seed` and
`chromium-extensions-restart` phases passed with a live official-store package.
They asserted three computed tracks, no horizontal overflow, rendered metadata,
exact ID, and persisted metadata in light and dark views. Focused Rust metadata
and migration tests, generated bindings, Renderer/Event Vitest, Rust lint, and
the two-process Electron Extension probe also passed. The matching Windows
journey and native validation remain required CI gates.

## Required permission metadata migration

Startup backfills missing `requiredApiPermissions` from a bounded manifest read
inside the Rust-managed extension directory, even when display metadata is already
complete. Missing means unknown; an empty array means no required API permissions.
The existing atomic catalogue migration increments its revision only when records
change. It preserves package files, identity, assignment, storage, and tombstones.
Unreadable or invalid manifests retain unknown classification and emit migration
warnings. Classified records are not reread on later startups. No polling, new
permission prompt, automatic grant, or extension content rewrite is introduced.
Existing installations take effect after restarting the application.

The native compatibility probe verifies optional management remains ungranted
before and after a denied request, native `getSelf()` succeeds, and `getAll()`
cannot return an extension inventory without the grant. Full AdBlock filtering,
idle integration, popups, and settings remain outside the optional-permission fix.
Generic document context menus were added in the subsequent follow-up below.

### Optional-permission correction validation (2026-09-14)

The focused macOS `chromium-macos-appkit-smoke` extension seed/restart phases
passed with live AdBlock 6.45.5. Initial load, close/reopen, and application
restart passed required-permission classification and reached native loading.
AdBlock subsequently reported `ELECTRON_EXTENSION_BOOTSTRAP_DEADLINE_EXCEEDED`;
this remains a separate compatibility limitation, not proof of working ad filtering.
The isolated native probe passed denied optional management and native self-query
checks. Rust migration tests covered existing complete metadata and restart
idempotence; both platform tables passed. Windows native probe and desktop
journey execution remain pending Windows CI.

The broader macOS `smoke` run completed 61 PASS phases and four expected
force-termination phases, then failed to establish a WebDriver session in
`chromium-role-session-recovery` before scenario execution (`DevToolsActivePort`
missing). An isolated retry and the separately attempted
`chromium-role-session-upgrade-seed` also failed session creation with
`unable to discover open pages`; upgrade restart was not reached. These
non-extension startup failures remain unresolved; this is not a complete
smoke/full-profile pass. Smoke and full resolve to the same native phase set.


## Worker startup failures and generic context menus (2026-09-14)

Each service-worker bootstrap observes the exact Session before native load.
A worker's extension scope and version are captured at `starting`. After load,
Electron requests one native start for that exact scope if running or the
compatibility receipt has not arrived. The matching native `running` event or
the exact `startWorkerForScope` completion, plus a sender-version-bound receipt,
are required for success. A normal idle stop does not erase the earlier running
acknowledgement; an early receipt alone cannot hide a script evaluation exception.
JavaScript error events (`source=javascript`, `level=3`) terminate the matching
attempt immediately. Warnings, console API errors, network messages and stopping
alone do not establish a failed initialization. Unknown acknowledgements retain
the existing deadline; cancellation disposes the observer without retrying.

After native load has a known outcome and exact unload completes, diagnostics
record `ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR` with sanitized relative
source and line, and Core completes the lease as degraded. Role navigation can
then proceed without spending the bootstrap deadline on an already-known error.
Native load uncertainty still fences navigation and retains late cleanup.

The owner authorized generic API support in the same follow-up. The audited host
now provides document `contextMenus.create/update/remove/removeAll/onClicked`,
including nested menus, checkbox/radio state, URL/context filtering, and native
Electron Menu presentation attached only to managed Role WebContents. Mutations
require declared `contextMenus`; optional permission grants remain denied. Menu
IDs are extension-local, stale clicks are ignored, and retirement removes native
listeners. MV3 creation requires a string ID; callback errors use runtime.lastError.
Toolbar/action contexts, inline onclick callbacks and persistence across application
restart are outside this surface; extensions recreate menus on startup. A generic
fixture exercises native menu cancellation and selection through the paired P1
`CHROMIUM-*-EXTENSION-CONTEXT-MENU-001` journeys. Fixture loading is a deterministic precondition, not store-install evidence.

The original AdBlock contextMenus failure is no longer an expected compatibility
limit. Remaining initialization or filtering failures are recorded independently;
this change does not certify full AdBlock operation. The failure probe deliberately
throws after registering contextMenus.onClicked so failure handling remains covered
when the generic API is available. A separate successful worker verifies that
ordinary console.error does not cause failure, before and after process restart.


Electron can still emit `ExtensionLoadWarning: Permission ... is unknown` for
`contextMenus`, `notifications` and `webNavigation`: its native manifest validator
does not recognize Rion's independently provided compatibility APIs. These warnings
are retained, not converted to fatal classification or suppressed by rewriting the
manifest. Native probes exercise real calls to distinguish working compatibility
APIs from worker initialization errors; a warning alone proves neither outcome.


Static ruleset receipt validation compares only manifest resources enabled by
default, matching the preload's declared work. Disabled resources remain disabled.
AdBlock 6.45.5 declares 37 resources but enables three by default; comparing all
37 against the receipt of three incorrectly rejected an otherwise valid bootstrap.


### Follow-up validation evidence

The macOS smoke run at `.desktop-e2e-artifacts/2026-09-14T10-18-40-870Z-darwin`
passed native context-menu cancellation/selection and the live AdBlock 6.45.5
installation and restart phases. AdBlock recorded `ELECTRON_EXTENSION_READY`
on initial open, same-process reopen and application restart, at 10:19:23.816Z,
10:19:27.117Z and 10:19:33.175Z respectively, before Role navigation completed.
This supersedes the earlier timeout observation; filtering effectiveness is still
not part of these assertions. The later shell phase failed because its existing
Dock selector found five Rion items (`Rion Dock isolation unavailable; Rion=5`).
Other running applications were not closed to alter the user's desktop.

Earlier focused attempts failed in live-store Back/Forward navigation before
installation; those failures were not accepted as extension evidence. The eventual
smoke install/restart run passed without weakening those store assertions.


The later `full` run at
`.desktop-e2e-artifacts/2026-09-14T10-20-46-808Z-darwin` again passed the generic
menu click/cancel phase, including navigation-fenced menu ownership, then failed
before installation when live Buster search results did not become clickable.
Neither broad run is a complete smoke/full-profile pass. The successful AdBlock
seed/restart evidence above remains the observed native result for this change.

Final code validation passed 4,244 JavaScript/TypeScript tests (19 skipped) and
1,222 Rust tests (five ignored), typecheck, lint (23 existing renderer warnings),
Rust lint, hygiene/docs/context/dependency checks and coverage validation. The
coverage manifest now contains paired native P1 context-menu journeys. Windows
parameterized tests pass locally; Windows native probe and desktop CI results
remain pending and are not inferred from macOS execution.


## Existing dev Role acceptance and native DNR blocker (2026-09-14)

The existing dev Role `a78cc6e9-f7b5-4d81-8c91-58fa1a63f8c4` was opened through the visible Roles UI against
`https://universe.flyff.com/play`, preserving its installed AdBlock 6.45.5 and
Role store. This reproduced failures after `ELECTRON_EXTENSION_READY` that the
isolated bootstrap journey did not certify. READY is bootstrap evidence only.

The generic API corrections deliver expected context-menu failures as typed
API replies, then reject the extension Promise or expose `runtime.lastError`
for the duration of its callback. Duplicate IDs still fail without replacing
existing items. Security checks and unexpected host faults still reject IPC.
AdBlock deliberately creates a duplicate ID during its startup API test and
reads the callback error; that handled failure must not become a main-process
IPC exception. The same callback semantics now apply to unavailable APIs and
other bridged calls. In particular, `tabs.create` remains unsupported and fails
explicitly instead of resolving a missing Tab as success. Frame queries omit
uncommitted empty-URL frames and retain committed `about:blank` frames.

Visible dev reopening confirmed the duplicate-ID IPC exceptions and
`Invalid frame URL` errors disappeared, and the previous `undefined.id` error
became the accurate `RION_EXTENSION_API_UNAVAILABLE:tabs.create` error. The game
still opened. The three native unknown-permission warnings remain as described
above. AdBlock's native DNR update failure remains; this is not full AdBlock
acceptance and does not prove filtering effectiveness.

Run `node scripts/verifyElectronExtensionRulesetAllocation.mjs` for the isolated
engine regression. It uses no Rion preload, AdBlock scripts, or user profile.
It enables 31,001 synthetic static rules in two resources, exits normally, then
starts a second process against the same temporary Session. On Electron 43.7.0 /
Chromium 150.0.7871.250 on macOS, seed succeeds; restart reports
`The set of enabled rulesets exceeds the rule count limit.` when disabling the
one-rule resource. Both resources remain enabled. The runner exits nonzero for
this failed native acknowledgement; it does not accept elapsed time or log
suppression as success. This separately reproduces the real Role's failure and
requires an engine-level repair and rerun before DNR restart compatibility can
be certified. Preferences, user filters, quotas, and extension package contents
are not cleared or rewritten as a workaround. Windows native reproduction is
pending CI/a Windows host.


Dev evidence on 2026-09-14 (UTC): the original reproduction reported READY at
10:33:30.628 and Role launch completion at 10:33:32.330, while still emitting
16 handled duplicate-ID IPC exceptions, one empty frame URL error, two missing
Tab ID errors, and two DNR quota errors. With the API fixes, opening at
10:41:43.199 and reopening at 10:42:17.808 each reached READY, followed by Role
launch completion at 10:41:45.552 and 10:42:19.331. Across those two launches,
there were zero duplicate-ID IPC exceptions, zero empty frame URL errors, and
zero missing Tab ID errors. Each launch retained one explicit unsupported
`tabs.create` error and one native DNR quota error. The first launch displayed
the in-game scene; reopening displayed the game's existing-session login prompt,
which was not accepted to disconnect another session.

The additional macOS smoke run
`.desktop-e2e-artifacts/2026-09-14T10-45-05-991Z-darwin/report.json` passed
`CHROMIUM-MACOS-APPKIT-EXTENSION-CONTEXT-MENU-001` (native selection/cancellation).
`CHROMIUM-MACOS-APPKIT-EXTENSIONS-001` failed earlier in the unchanged Buster
store Forward-navigation assertion (`extensions-store-navigation.ts:65`), before
AdBlock installation. This is not a complete smoke pass; the existing dev Role
verification above is separate visible-UI evidence. Windows native and CI results
remain pending.


A final fresh dev process after the completed production build again opened the
same existing Role into the in-game scene. Its launch retained zero duplicate-ID
IPC exceptions, empty frame URLs, or missing Tab ID errors; the unsupported
`tabs.create` and native DNR quota failures each remained once. The dev application
was left running on that Role for inspection.

Validation for these corrections: 4,254 JS/TS tests passed (19 skipped), 1,222 Rust
tests passed (five ignored), typecheck, lint (23 existing renderer warnings),
Rust lint, hygiene, coverage, production build, production E2E isolation, and the
standard native extension probe passed. The final focused API suite passed 25
cases, including storage values that resemble error metadata. The standalone
DNR allocation restart probe failed as documented above. The native probe also
asserts that handled menu callback errors do not escape as main-process IPC
exceptions, optional management remains denied, native getSelf works, and
getAll cannot obtain the extension inventory without permission.

## Native filtering verification (2026-09-18)

The existing dev uBlock Origin Lite 2026.914.1325 failure at
`js/background.js:899` was reproduced with a generic module fixture selecting
`self.browser || self.chrome`. The same fixture using `chrome` succeeded:
Chromium's distinct `browser` object lacked the compatibility APIs injected
only into `chrome`. This was not evidence of a module preload ordering defect.
The shared preload now installs its bounded APIs into both native namespaces,
shares event listener identity, scopes callback `runtime.lastError` to both
runtime objects, and preserves native DNR and scripting bindings.

Electron 43.7.0 also exposes native `storage.session`, including `getKeys`,
`onChanged`, and `setAccessLevel`. The preload now preserves that native object;
the bounded in-memory fallback applies only when it is absent. This avoids
replacing native content-script access control with an unsupported API reply.
Classic and module fixtures both exercise static-import/top-level listeners,
callback error cleanup, and native session-storage reads from content scripts.

The Role network-failure observer previously installed
`session.webRequest.onErrorOccurred`. On the pinned engine even this passive
Electron listener replaces the extension network delegate and prevents DNR
filtering. Roles now consume exact-WebContents `did-fail-provisional-load` and
`did-fail-load` events through the existing generation-fenced, deduplicating
failure owner. Main-frame cancellation remains ignored; subframes and retired
surfaces cannot fail the Role. No request interception, polling or transport
fallback is introduced. Global-Web and shell-only sessions remain outside
extension assignment scope.

`pnpm run verify:electron-extension-filtering` creates isolated Sessions and a
controlled local server, runs a module fixture, and verifies allowed requests,
blocked requests absent from server receipts, native `ERR_BLOCKED_BY_CLIENT`,
CSS hiding, unassigned-session isolation, Role reopen and fresh-process restart.
It also waits for the exact worker's native `stopped` event, wakes that scope
through `startWorkerForScope`, and repeats the request/server-receipt assertions.
Both the generic module fixture and unchanged uBlock Lite passed this idle-worker
restart case in each process; a test deadline only reports missing evidence.
It is included in `verify:electron-extensions`. Do not attach an Electron
webRequest listener to collect filtering evidence: it changes the result.

For an unchanged installed package, set `RION_EXTENSION_FILTERING_PACKAGE` to
its absolute directory and `RION_EXTENSION_FILTERING_BLOCKED_PATH` to a path
matched by that package's rules. The harness copies only package files into its
temporary root; it never opens or copies user Role profiles. The original
uBlock Lite package blocked `/xpopup/xpopup.js` before and after reopen/restart,
while `/normal.js` loaded and the unassigned Session received both. Its test
page's `.adsbox` element was not hidden: network blocking passed, but this is
not a claim of complete cosmetic filtering support. The generic CSS fixture
passed independently.

The paired P1 `EXTENSION-FILTERING-001` journeys additionally use visible input
inside the production Role host and verify server receipts, CSS and Role reopen.
The focused macOS run at
`.desktop-e2e-artifacts/2026-09-17T19-00-22-034Z-darwin` passed. Windows native
execution remains pending; parameterized tests do not substitute for it.

The full macOS smoke run at
`.desktop-e2e-artifacts/2026-09-17T19-01-21-856Z-darwin` passed extension context
menus, filtering, and the existing extension seed/restart phases. It stopped at
the unchanged Workspace gap-divider journey with `First host mounted bottom
geometry waited for loading` in `chromium-workspace-first-host.ts:71`. This is
not a complete smoke pass, and no baseline comparison was run for that failure.

After a production build, computer use opened the existing dev `chromium test`
Role into its game scene. At 2026-09-17T19:09:07Z the unchanged uBlock Lite package
reported `ELECTRON_EXTENSION_READY`, with no worker initialization failure in
that launch. The Role was stopped again; the dashboard showed zero running
Roles. This proves live startup, separately from the controlled filtering test.

Validation: 4,534 JS/TS tests passed (19 skipped), 1,228 Rust tests passed (five
ignored), typecheck, lint (23 existing renderer warnings), Rust lint, hygiene,
coverage, production build, and production E2E isolation passed. The initial
isolation check correctly rejected the E2E bundle; rebuilding production and
rerunning passed. Classic/module compatibility and native storage-session
content access passed. The later idle-worker probe change passed its native
generic/original-package runs, typecheck, source hygiene and focused lint.

The separate 31,001-rule DNR allocation restart regression remains failing in
the stock engine. The [native patch candidate](../patches/electron/README.md)
corrects per-extension accounting against the current process's global pool;
its pinned source hashes and patch applicability were checked. It has **not**
been compiled or integrated into the bundled Electron binary. A native engine
build environment is required before that repair can be certified. Local disk
cleanup recovered room for checkout, but Xcode's unaccepted license currently
blocks the native toolchain. No role preferences,
enabled ruleset choices, package scripts or quotas are reset as a workaround.
