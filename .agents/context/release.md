# Build and Release

`docs/updater-transaction-contract.md` is the normative updater installation,
drain, restart, and recovery contract.

CI validates portable code on Linux plus the active Tauri and Electron desktop
targets on `macos-latest` and `windows-latest` during migration. Build/package
commands compile and bundle; they do not launch the desktop application as
validation.

Automatic releases inherit the exact successful CI SHA. Manually dispatched
candidates rerun CI. Updater signatures and SHA-256 checks are distinct from the
owner-locked unsigned platform-installer policy in `AGENTS.md`.

After the candidate and upgrade checks succeed, semantic-release creates an
immutable tag and private draft. The public release remains a draft until its full
asset set and checksums verify. Use the **Resume Release** workflow with an
existing tag to recover a failed finalization; it never deletes tags or overwrites
non-identical assets.

Release workflows continue publishing updater-signed artifacts and must verify
Tauri-to-Electron plus Electron-to-Electron upgrade/data preservation before
the final shell cutover. The platform installer remains unsigned according to
the owner-locked policy; updater signatures and checksums are independent.

Runtime-contract labels `tauri-v22` and `electron-v23` are independent from
application SemVer. Production gates bind arbitrary strict application versions
and require the target to be newer than both the published Tauri source and the
prior Electron source; they never require application major 22 or 23.

The manual Electron production candidate gate is candidate-only and protected
by the `electron-production-release` environment. Both macOS and Windows must
use the existing production updater public/private key secrets for one exact
source, version, endpoint, and normalized key digest; fixture trust is
forbidden. macOS remains ad-hoc signed without notarization and Windows remains
Authenticode-unsigned. Before updater signing, each exact production-keyed
package must pass the native packaged Chromium black-box; macOS evidence must
show the retained AppKit tab host and Windows evidence must come from UI
Automation. The gate writes a verified, not-published receipt and has no
release-write permission. Real Tauri v22 cutover evidence remains a separate
required compatibility gate before any owner-approved promotion. The manual
v22 input/layout workflow is intentionally non-cutover evidence: its receipt
records `sourceUpdaterInvoked: false` and `cutoverEligible: false` until the
published v22 executable itself completes the production-signed transition on
both platforms.

That compatibility workflow also derives the exact source executable from the
published archive on macOS and from an isolated NSIS installation on Windows.
It binds those bytes to the public release and asset IDs, the peeled source tag,
the target SHA, and updater trust in one create-new public-lineage receipt per
platform. The receipts are attempt-bound and receive GitHub provenance
attestations; they remain `cutoverEligible: false`. The workflow has no contents
or release-write permission. Its identity-token and attestation writes can
attest only these evidence subjects, not publish or promote the candidate.

The separate promotion-readiness workflow is read-only. It rebuilds both the
exact target candidate and an independently pinned prior-v23 candidate from
their platform receipts, re-verifies production Minisign, and accepts only four
closed-schema terminal bundles whose receipts have GitHub artifact attestations
from the fixed external evidence workflow. Candidate, platform, and evidence
artifact names bind the API-verified workflow run attempt with an
`-attempt-<run_attempt>` suffix, so reruns cannot reuse an earlier attempt's
artifact. It separately verifies both attested public v22 lineage receipts and
cross-binds their release, tag, artifact, manifest, trust, and actual source
executable hashes to the v22 terminal transactions. Raw source journal IDs
remain runtime-typed while a separate evidence UUID is globally unique. Target
success must bind the original source journal to the durable product-authored
first-boot terminal receipt written only after platform finalization and
pending-state cleanup.

The published v22 binary can fetch a v23 target only after that target is served
from its compile-time public-latest endpoint. The read-only verifier therefore
reports `verified-terminal-evidence` and
`externally-served-terminal-evidence-observed`; this records what the source
updaters actually observed without claiming that the endpoint remains live at
readiness-verification time. It still cannot publish or write a terminal
promotion receipt. The fixed four-cell producer and terminal finalizer exist
only as hard-disabled transition code; no publisher or execution is approved or
enabled. The gate remains fail-closed and v22 stays authoritative.

The transition tree contains a hard-disabled provisional-publisher draft plus a
durable public-repository blob-SHA lease transport. Stable Tauri publication,
Tauri latest restore, and the disabled Electron draft now execute credentialed
control code only from protected `main`, fresh-read the exact public state, and
release the remote lease only for a safe acknowledgement/readback pair. The
Electron draft's stage, lease-acquisition, and latest-mutation jobs remain
statically disabled, so it is not an enabled publication path.

The separate hard-disabled durable recovery workflow now packages the canonical
capsule and store seal into a private append-only Git history, probes one fixed
mutation-marker slot per outcome predecessor, permits a public write token only
to the marker creator, reconciles resumed markers with zero public writes, and
records rollback, held-lease release, no-op, rejected, or indeterminate outcomes.
An applied outcome is fresh-read by a separate private reader, and only an exact
terminal outcome can pass the detached final gate. All recovery jobs remain
literal `if: ${{ false }}`. Owner-approved private-store coordinates, narrow
GitHub Apps, protected environments, variables and secrets, and an independent
recovery drill remain required before any guard can be removed. Owner-approved
execution of all four external updater transactions and of the
terminal-promotion finalizer also remain required.

A separate hard-disabled abandoned-lease cleanup draft is only a near-term,
non-durable escape hatch for a lease whose provisional latest-mutation job can
still be proven never to have run. It depends on retained live GitHub Actions
run, exact-attempt, and paginated job metadata: the one fixed publication job
must be terminal `skipped` with no steps, and a final bounded exact-attempt
job-list reread plus an exact Tauri-source latest/tag/assets observation must
remain unchanged immediately before lease CAS.
Missing, expired, non-unique, or ambiguous Actions metadata cannot authorize
cleanup; that lease must use the full durable recovery path. This shortcut is
not recovery storage, rollback evidence, or a publication outcome.

After a public release becomes latest, its immutable source tag is also the
canonical source for the public repository's README files, localized product
documentation, legal documents, image assets, and core support documents. The
workflow mirrors those managed paths to public `main` in one verified commit;
older resumed releases never replace documentation from a newer latest release.
