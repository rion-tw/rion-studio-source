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
an isolated, unprivileged native WebContentsView. A Rion-owned install button
uses the current main-frame store detail URL; store DOM and private Chrome APIs
are not installation authorities. The store document, header, and main content use 100% of the embedded viewport width,
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
and executable contents are not migrated. Background
workers and content scripts depend on
the bundled Chromium API subset. Loading a package does not prove every API it
uses is compatible. Popups, extension settings pages, global-Web assignment,
automatic updates, authenticated store purchases, and Chrome-profile import
are outside this version.

The catalogue is shared; assignment policy, enabled roles and each role's Chromium extension data
are separate. Configuration changes affect the next full role close/open, not
the current document. Removal first records a tombstone, preserves files used
by an active lease, and cleans them after the last native release. Extension
storage remains in the role profile. Failed filesystem cleanup retains the
tombstone; it is never treated as proof that files were deleted.

## Authority and propagation

The additive `applyToAllRoles` field defaults to false for old records and commands.
Rust normalizes explicit role IDs to empty in All roles mode and evaluates the
rule at lease acquisition. Future roles need no copied assignments; global-Web
sessions remain outside role scope. Removal disables the rule before cleanup.
Settings commits publish revisioned snapshots only after successful persistence.

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
cannot terminalize a replacement. A load failure blocks that role launch.

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
  replies, storage isolation, unload/reload, and persistence. CI runs it on both
  supported native hosts. The committed signing key is a throwaway test fixture,
  never a production trust anchor.
- `CHROMIUM-MACOS-APPKIT-EXTENSIONS-001` and
  `CHROMIUM-WINDOWS-EXTENSIONS-001` cover visible AdBlock installation, role assignment,
  actual role loading, application restart, disabling, and cancel/confirm removal in their existing
  Chromium smoke profiles. These journeys explicitly depend on live store
  availability; external failure fails the journey.

Production eligibility requires both native platforms. Local macOS evidence
does not satisfy Windows or the broader Chromium cutover gates.

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
