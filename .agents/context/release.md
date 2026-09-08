# Build and Release

`docs/updater-transaction-contract.md` is the normative updater installation,
drain, restart, and recovery contract. The owner authorized the sole Electron
entry and retired the old migration backlog on 2026-09-09; see
`docs/chromium-migration-execution-ledger.md` and `docs/v22-configuration-delta.md`.

CI validates portable code on Linux and native Electron/Chromium on
`macos-latest` and `windows-latest`. Rust remains authoritative for updater
transactions and persisted data. macOS retains AppKit hosting and trusted input.
Build/package commands do not launch the application as validation. Explicit
native integration and desktop E2E commands have separate evidence.

`dev`, `build`, `package`, and `dist` target Electron. The desktop-release
workflows build the exact source SHA and reuse the existing release App,
updater keys, public endpoint, app identity, and asset names. No additional
GitHub environment, credential, or recovery infrastructure is required.
`@tauri-apps/cli` is retained only as the existing updater signing tool; it is
not a desktop runtime dependency. Private signing keys must be removed from
build, runtime, and test subprocess environments and exposed only to the signer.

Updater signatures and SHA-256 checks remain mandatory. Production macOS uses
ad-hoc signing without notarization; Windows remains Authenticode-unsigned.
Compressed distribution budgets account for bundled Chromium: 256 MiB for each
macOS archive/DMG and 128 MiB for the Windows installer. The prior Windows
fixture was about 97 MiB; these are size limits, not performance settings.

Automatic releases inherit the exact successful CI SHA. A manual candidate
requires the reusable CI quality workflow. Publication and latest restoration
execute control code only from protected main, preserve immutable tags and
non-identical-asset rejection, and use the existing durable latest lease and
exact acknowledgement/readback checks. Sources may be a previously published
v22 or Electron package; every new or restored target must be Electron.
Production publication is outside the cleanup task and must not be dispatched.

After candidate and installer compatibility checks, semantic-release creates
an immutable tag and private draft. The existing finalization workflow verifies
the complete signed asset inventory before publication. Resume Release recovers
an existing tag without deleting tags or overwriting non-identical assets.
Published-source documentation is mirrored only for the actual latest release.

Historical fixture, physical, and production-update evidence retains its original
classification. Physical dual-monitor, actual sleep/sign-out, four production
update transactions, and terminal promotion are no longer execution gates.
New cleanup changes still require relevant native tests, complete affected E2E
profiles, package verification, and exact source-specific receipts.
