# Chromium Extensions

Extensions is an additive Chromium capability. The stable Tauri v22 adapter
rejects its commands, and the renderer discovers availability through the typed
bridge after startup. This does not introduce a selectable browser engine.

## User behavior

The Extensions route contains Installed and Chrome Web Store tabs. The store is
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
its manifest permissions and asks the user to select roles. No role is selected
by default. The first implementation accepts Manifest V3 packages with a
matching RSA publisher proof. Background workers and content scripts depend on
the bundled Chromium API subset. Loading a package does not prove every API it
uses is compatible. Popups, extension settings pages, global-Web assignment,
automatic updates, authenticated store purchases, and Chrome-profile import
are outside this version.

The catalogue is shared; enabled roles and each role's Chromium extension data
are separate. Configuration changes affect the next full role close/open, not
the current document. Removal first records a tombstone, preserves files used
by an active lease, and cleans them after the last native release. Extension
storage remains in the role profile. Failed filesystem cleanup retains the
tombstone; it is never treated as proof that files were deleted.

## Authority and propagation

Rust owns the revisioned catalogue stored under the `extensions` settings key in
the existing SQLite state worker, package preparation, bounded official-source
HTTP download, CRX identity/signature verification, safe unpacking, and role
leases. No new database file or profile-import field is introduced. Package
directories belong to the app's `extensions` root. The original CRX digest is
recorded, and the verified publisher key is retained in the unpacked manifest
to preserve the store ID independently of its filesystem path.

The typed `extensions` Core command separates renderer-allowed operations from
privileged acquire/complete/release commands. Core publishes revisioned
`extensionsChanged` snapshots. Electron owns only native Sessions and handles,
loads the frozen Core selection before game navigation, and acknowledges the
matching lease. Release waits for exact `extension-unloaded` events. Old leases
cannot terminalize a replacement. A load failure blocks that role launch.

HTTP has a 10-second connection and 60-second overall external deadline; failure
does not install anything. Local operations and native callbacks are
event-bound. Explicit cancellation and shutdown cancel staged preparation.
There is no installation retry loop, profile scan, remote debugger, or extension
injection into the application renderer or store Session.

## Validation and release gate

- `cargo test -p rion-core extensions` covers signed and tampered packages,
  cross-platform path safety, frozen role leases, removal, and v22 exclusion.
- `cargo test -p rion-core live_store_download_and_signature -- --ignored`
  exercises the optional external official-store boundary.
- `pnpm run verify:electron-extensions` launches two fresh Electron processes
  with isolated profiles and checks stable IDs, content scripts, background
  replies, storage isolation, unload/reload, and persistence. CI runs it on both
  supported native hosts. The committed signing key is a throwaway test fixture,
  never a production trust anchor.
- `CHROMIUM-MACOS-APPKIT-EXTENSIONS-001` and
  `CHROMIUM-WINDOWS-EXTENSIONS-001` cover visible installation, role assignment,
  actual role loading, application restart, disabling, and cancel/confirm removal in their existing
  Chromium smoke profiles. These journeys explicitly depend on live store
  availability; external failure fails the journey.

Production eligibility requires both native platforms. Local macOS evidence
does not satisfy Windows or the broader Chromium cutover gates.

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
