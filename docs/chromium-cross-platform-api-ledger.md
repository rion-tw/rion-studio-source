# Chromium Cross-Platform API Ledger

This execution ledger reduces Windows/macOS maintenance while preserving current
product semantics. It does not replace the [runtime migration contract](chromium-runtime-migration.md),
[migration execution gates](chromium-migration-execution-ledger.md), or
[updater transaction contract](updater-transaction-contract.md).

Research baseline: `33fff22550b8f1959c54c8231717c13dfc4d1b16`, Electron 43.4.1,
2026-09-06. Source inspection is not physical-platform evidence. The initial
research ran four Session/lifecycle Vitest files containing 56 passing tests;
it did not establish native replacement parity on either platform.

## Status and ownership

`open` means implementation or audit remains; `probe` requires a bounded
equivalence experiment; `conditional` depends on that experiment; `gated`
requires existing migration/release evidence; `implemented` means code and focused
checks are complete while explicitly listed native acceptance remains; `verified` requires the stated
deliverable and its evidence. A documented retained adapter is a valid audit
outcome, not an implemented replacement. Never infer completion from API
availability, a filename, elapsed time, or a portable mock.

Rust owns domain state, filesystem policy, stores, topology, Macro scheduling,
and domain operation terminality. Electron owns Chromium handles and translates
authoritative events into revision-fenced Core effects and receipts. Prefer
standard Web APIs, then public Electron APIs, then shared Rust facilities, with
minimal native adapters where equivalent behavior is unavailable. AppKit native
windows, tabs, gestures, geometry, focus, fullscreen, and trusted input remain
required. Do not introduce an engine selector or public automation transport.

## Feature and capability inventory

The feature names below cover all nine entries in `docs/e2e-coverage.json`.
Capability rows also cover infrastructure outside the renderer feature registry.
Paths identify entry points to follow, not evidence that every native branch has
been executed. `shared` describes source architecture, not completed parity.

| Features / capability | Source and event flow | Assessment / task |
| --- | --- | --- |
| app-shell, dashboard, games, roles, workspaces, settings: CRUD, legal, preferences, portable data | `src/renderer/src/features` -> typed bridge -> `crates/rion-core/src/app`; committed Core snapshots -> renderer | Shared React/Rust authority; retain it. CP-01, CP-12, CP-14 |
| quick-access, application shortcuts | `src/electron/main/chromiumRoleQuickAccessShortcut.ts`, `src/electron/main/electronFocusedApplicationShortcutController.ts`; authenticated input -> command -> Core/native receipt | Shared command flow with Cmd/Ctrl and native host differences. CP-07, CP-12 |
| roles / workspaces: browser persistence and isolation | `src/electron/main/chromiumRoleSessionRegistry.ts`, `src/electron/main/chromiumGlobalWebSessionRegistry.ts`; Rust path/owner -> Session handle lease | Shared `session.fromPath`; repeated path policy. CP-03, CP-10 |
| Explicit reset and migration | `src/electron/main/chromiumRoleBrowserDataClearCoordinator.ts`, `src/electron/main/chromiumSessionMigrationImporter.ts`; Core intent -> exact isolation -> helper readback -> terminal result | Shared Chromium storage, distinct transaction semantics. CP-10 |
| game-windows: navigation, reload, popups | `src/electron/main/chromiumRoleNavigationLifecycle.ts`, `src/electron/main/chromiumPopupLifecycleCoordinator.ts`; WebContents events -> exact surface/operation receipts | Shared browser APIs; native presentation retained. CP-04, CP-11 |
| game-windows: topology, display, fullscreen, recovery | `src/electron/main/chromiumRuntimeAppKitProjection.ts`, `src/electron/main/chromiumRuntimeWindowsProjection.ts`, `src/electron/main/electronDisplayTopologyController.ts`; Core revision -> adapter -> native evidence | Shared screen inventory; duplicated surface application/compensation. CP-04, CP-12 |
| macros: scheduling, overlay, trusted input | `crates/rion-core/src/macro_runtime`, `src/electron/main/chromiumTrustedInputCoordinator.ts`; Core input lane -> native submission -> authenticated DOM/native receipt | Common authority/coordinator; platform submission remains. CP-08, CP-09 |
| Fonts, audio, zoom | `src/electron/main/chromiumRoleFontsCoordinator.ts`, `src/electron/main/chromiumRoleSurfaceRegistry.ts`; bounded preload receipt or exact WebContents readback | Shared rendering/effects and v23 Chromium family enumeration; `crates/rion-platform/src/system_fonts.rs` remains for v22 only. CP-05, CP-06, CP-11 |
| Security, permissions, downloads, file upload | `src/electron/main/chromiumSecurityPolicy.ts`; exact Session synchronous policy callback or native chooser -> page File receipt | Shared policy; Role and Global Web security domains must stay distinct. CP-11, CP-15 |
| settings: diagnostics export | `src/electron/main/electronDiagnosticsComposition.ts`; native save dialog -> exact window fence -> Core export | Owner retired performance diagnostics and high-refresh settings on 2026-09-06. General log/GPU/runtime export remains. CP-02, CP-13 |
| Application lifecycle and shell services | `src/electron/main/applicationLifecycleController.ts`, `src/electron/main/windowsSessionEndCoordinator.ts`, `src/electron/main/electronNativeShellActions.ts` | Shared suspend/resume, dialogs, clipboard and shell APIs; Windows session-end adapter required. CP-12 |
| Filesystem, encryption, Chrome import | `crates/rion-platform/src/filesystem.rs`, `crates/rion-platform/src/protected_data.rs`, `crates/rion-platform/src/chrome_cookie.rs` | Necessary OS effects under Rust authority; not browser APIs. CP-14 |
| Packaging, update, release, desktop test infrastructure | `crates/rion-updater/src/platform_install`, `scripts`, `.github/workflows`, `e2e/desktop` | Share orchestration, preserve installer and physical UI mechanisms. CP-15, CP-16, CP-17 |

## Execution register

P0 addresses a functional or persistence gap; P1 removes major duplicated
mechanisms or proves compatibility; P2 contains maintenance/governance work.
Owners are responsible subsystems, not assignments to unavailable people.

| ID | Priority / owner | State | Dependency | Deliverable and completion evidence |
| --- | --- | --- | --- | --- |
| CP-01 | P1 / Architecture | verified | none | Catalog all nine features and infrastructure, identify authoritative sources and replacement candidates, preserve explicit open/probe/gated work and link the active catalog. This ledger is the initial source-audit deliverable; physical verification is separately tracked. |
| CP-02 | P0 / Diagnostics | implemented; both Tauri platforms passed, Chromium Windows pending | CP-01 | Owner-directed complete removal of performance measurement UI, IPC commands/events, sampler, power/thermal probes and exported sample payload in both shells. Preserve general diagnostics export and verify absent controls on both platforms. |
| CP-03 | P0 / Core + Sessions | implemented; both native Rust gates and paired Chromium persistence smoke passed | CP-01 | Share Rust Chromium engine-path conversion and Electron canonical-path/ownership helpers across Role, Global Web and maintenance helpers. Reject unsupported device paths consistently without moving stores. Test drive/UNC/case/alias/owner boundaries and persistent restart on Windows. |
| CP-04 | P1 / Runtime projection | implemented; macOS smoke passed, Windows pending | CP-01 | Extract equivalent snapshot, bounds, visibility, zoom, reparent and compensation steps; retain AppKit transaction/geometry and Windows host effects. Test stale revision, partial application, compensation failure and exact quarantine, plus paired topology/recovery journeys. |
| CP-05 | P1 / Fonts | adopt canonical Chromium families; provider implementation is CP-06 | CP-01 | Evaluate queryLocalFonts on pinned Electron: family/CJK/duplicates, focus/activation, permission, reload, generic fallback and existing automatic settings loading. Allow enumeration only in an authenticated app frame; remote pages remain denied. Produce adopt/retain result with both native runs. |
| CP-06 | P1 / Fonts + bridge | implemented; both native font probes and macOS settings passed, Windows settings pending | CP-05 passes | Keep listSystemFonts Promise result, bounded Rust normalization/cache/fallback, and shell enumeration provider. Remove v23 native enumeration only after equivalent settings behavior is proven. Retain v22 reachability until CP-17. If CP-05 fails, close as a documented retained adapter. |
| CP-07 | P1 / Application input | verified retain; Windows lifecycle correction confirmed | CP-01 | Compare before-input-event and Menu with Windows F11 hook across main, Role, global Web, popup, focused/hidden hosts, repeat and key-up. Remove hook only with exact once-only routing and page suppression; do not substitute globalShortcut. |
| CP-08 | P1 / Trusted input | Windows foreground View gate passed; ordinary background continuity corrected, native parity/deletion pending | CP-01 | Evaluate sendInputEvent separately for foreground and hidden Role input, modifiers, held keys, middle button, zoom and reload. Preserve focus and owner/generation/epoch/DOM evidence. Partial replacement is permitted only with proven equivalent semantics; retain AppKit input. |
| CP-09 | P1 / Trusted input | implemented; macOS Macro journeys passed, Windows pending | CP-01 | Consolidate genuinely identical pending-sequence, frame, cancellation and retirement coordination around the existing shared coordinator. Preserve independent native evidence validation and Core scheduling. Test stale/duplicate/partial submission and paired Macro journeys. |
| CP-10 | P1 / Session maintenance | shared transport verified; macOS fresh-process storage passed, Windows/import acceptance pending | CP-03 | Share helper launch, process identity, response validation, drain and cancellation plumbing. Keep reset, migration and Chrome import data scopes/terminality distinct. Fresh-process DOM Storage readback remains required; test tampered/stale helper outcomes and restart persistence. |
| CP-11 | P1 / Browser capability owners | audited; macOS smoke passed, Windows/hardware pending | CP-01 | Trace navigation/reload/popups/audio/zoom/fonts/overlay/security/certificates/download denial/upload/HTML fullscreen from API through consumer and exact receipt to journey. Close shared capabilities with behavior evidence, not source tokens. Preserve distinct Session policies. |
| CP-12 | P2 / Shell | implemented; macOS smoke passed, Windows/hardware pending | CP-01 | Centralize command definitions, shell services, display event and exit-drain coordination where equivalent. Retain Cmd/Ctrl, AppKit, Mica/vibrancy and Windows session-end boundaries. Test cancel/close/drain/focus and paired shell journeys. |
| CP-13 | P1 / Diagnostics + settings | implemented; both Tauri platforms passed, Chromium Windows pending | CP-02 | Owner-directed removal of high-refresh UI, shared settings and WKWebView feature writes. Ignore retired persisted/imported fields without losing other preferences. Preserve unrelated WebGL policy and AppKit hosting. |
| CP-14 | P2 / Platform data | retained adapters verified; both native Rust gates passed at 280027d7 | CP-01 | Record exact retained boundaries for file identity/ACL/atomic replacement/locks, Chrome discovery/quit/decryption and transfer encryption. Keep legacy migration distinct from ongoing consented Chrome import. Audit callers and both cfg targets; no safeStorage format assumption. |
| CP-15 | P1 / Desktop E2E | macOS 56 phases passed at 280027d7; Windows 26 at 33da5f3e, full/hardware pending | CP-01; alongside behavior tasks | Share fixtures, seed/restart scenarios and receipt assertions; retain native UI drivers. Upload must still click the remote file input and native chooser. Preserve all coverage targets and run paired smoke/hardware profiles where relevant. |
| CP-16 | P2 / Release tooling | macOS CI-fixture package/updater verified at 280027d7; Windows/production release pending | CP-01 | Share manifest/version/hash/signature/job coordination; retain native installer and locked verification. Reuse v22 release environment in final delta audit. No new credentials/infrastructure, no autoUpdater, and no publication inferred from this task. |
| CP-17 | P1 / Migration | gated | existing migration execution gates | Make Electron the sole production entry only after exact-candidate native parity, update transactions and release gates. Remove Tauri/System WebView-only code/dependencies/tests, retain AppKit and required data import/upgrade compatibility. Never waive existing gates. |
| CP-18 | P1 / Validation | macOS full profiles passed; external gates pending | all applicable tasks | Prevent duplicated mechanisms from returning using focused behavior tests and dependency-boundary checks. Record actual macOS/Windows runs and remaining exceptions per task; branch count zero is not the goal. |

Start CP-02 and CP-03 after the baseline. CP-04 and CP-09 through CP-13 are
independent of native replacement approval, except for their listed data
dependencies. CP-05/07/08 must produce evidence before removal; CP-06 follows
only a passing CP-05. CP-14 through CP-16 can progress without enabling release.
CP-17 remains blocked by the existing migration gates. CP-18 accompanies every
change, not just the final batch.

## Probe protocols and retained boundaries

- **CP-05:** use the pinned bundled runtime and the actual trusted application
  origin/frame. Compare normalized families to the existing provider, including
  installed CJK families and generic fallback; exercise denial, reload and
  automatic settings entry. Never open local-fonts to Role/global-Web sessions.
  If equivalent behavior requires an unapproved user-flow change, retain the
  provider and document the precise mismatch rather than silently changing UX.
- **CP-07:** the existing Win32 hook filters plain F11 for an exact foreground
  HWND. Menu deliberately sets registerAccelerator=false. A replacement must
  capture both key halves once, suppress page delivery and never claim a chord
  belonging to another application. A synthetic DOM dispatch is not proof.
- **CP-08:** bind exact Role, parent, surface generation, input epoch and document
  before submission; require the expected trusted DOM sequence afterward. Test
  visible and hidden surfaces separately, including held-key retirement and
  ownership transfer. No focus acquisition is allowed to repair background
  delivery. Failed probes retain the native lane; do not weaken receipts.
- **CP-10:** cookie acknowledgements cannot stand in for DOM Storage durability.
  Do not replace fresh-process readback with a flush call or same-process reopen.
- **CP-12/14/16:** different native effects are legitimate when the OS contract
  differs. Centralize shared coordination, not native authority. Windows driver
  logs, macOS thermal data, DPAPI/Keychain, native chooser ownership, file locks,
  NSIS installation and AppKit gestures are not interchangeable browser effects.

## API research references

Official documentation was checked on 2026-09-06 and local Electron declarations
were inspected for the pinned runtime. Latest documentation is supporting
research, not proof that every feature exists or behaves identically in 43.4.1.

| API | Finding and consequence |
| --- | --- |
| [WebContents input](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent) | sendInputEvent requires its containing BrowserWindow to be focused; hidden-surface/background equivalence is unproven. before-input-event/before-mouse-event are candidates, not native receipt substitutes. |
| [Local Font Access](https://developer.chrome.com/docs/capabilities/web-apis/local-fonts) | queryLocalFonts enumerates installed fonts behind local-fonts permission; exact-frame admission and existing UI behavior require CP-05. |
| [Session](https://www.electronjs.org/docs/latest/api/session#sesflushstoragedata) | flushStorageData returns void in pinned declarations; fresh-process durability proof remains. session.fromPath is already the common store entry. |
| [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) | suspend/resume are shared; shutdown is not a Windows event. Retain query-session-end coordination. |
| [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | Platform key providers/security semantics remain different. API presence proves neither Chrome key access nor existing transfer-format compatibility. |
| [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) | Platform-specific update mechanisms do not replace the current Rust trust/transaction and installer contracts. The repository explicitly excludes autoUpdater. |

## Interfaces, acceptance and evidence

Preserve the public `window.rionStudio` API by default. New providers are internal
ports. Rust-generated shared types remain authoritative; change contracts and
all consumers together if terminal status, completion scope or ordering changes.
No generated file may be hand-edited. Diagnostic samples must carry exact
operation and surface identities; unavailable metrics must remain unavailable.

Tests pass platform explicitly and drive authoritative events. Cover stale,
duplicate, cancellation, supersede, stream failure, partial mutation and exact
native retirement. Finite diagnostic measurement may use the existing declared
sampling boundary, but timers cannot discover state or imply a successful
operation without its exact sample receipt. No new production polling.

Relevant paired Chromium journey suffixes include APPLICATION-SHORTCUTS-030,
MACRO-BACKGROUND-TAB-004, DIAGNOSTICS-EXPORT-029, ROLE-SESSION-ISOLATION-003,
WORKSPACE-WEB-FILE-UPLOAD-028, RUNTIME-TAB-TOPOLOGY-009 and
RUNTIME-TAB-RELOAD-031. Use the full MACOS-APPKIT/WINDOWS IDs from the coverage
manifest. Add P0/P1 journeys for newly exercised diagnostic/font behavior;
source tests alone cannot certify visible user actions.

Run focused tests first, then routed source hygiene, typecheck, lint, tests and
builds as applicable. Native/shared-contract changes require native lint:rust
and test:rust. Journey changes require check:e2e-coverage. Final native evidence
must include chromium-macos-appkit-smoke and chromium-windows-smoke; input and
display changes also require their hardware-extended profiles. Windows stays
pending when unavailable locally, even when platform-table tests pass.

For every execution update record the task ID, changed mechanism, source
revision or working-tree qualification, exact check/profile, outcome and artifact
location when produced. Do not copy historical migration evidence as current
proof. Do not edit immutable validation archives. Completion means all tasks
have implemented or justified-retained outcomes with required native evidence,
not that this ledger exists or that an API compiles.

### Execution evidence

- CP-01: initial feature/capability inventory and CP-01 through CP-18 register
  created from the research baseline; catalog and migration cross-links added.
  No product behavior changes are claimed by this documentation entry.
- CP-03: implemented in the working tree following the research baseline. The
  shared Rust engine-path serializer serves Global Web and Role path records;
  Electron Role, Global Web, ownership, both clear coordinators and the Role
  fresh-clear helper use one canonical wire-path boundary. Windows drive and UNC
  forms remain ordinary absolute paths; device and drive-relative/root-relative
  forms cannot reach Session creation. No profile data was moved, no new public
  interface or timer was added, and stable-v22 consumers remain compiled.
- CP-03 focused evidence: the initial eight-file Vitest batch passed 106 tests;
  after adding device/root-relative regressions, the two changed path/Role suites
  passed 48 tests. Two Rust Chromium-path tests passed, including canonical-root
  Role-store reopen. These are lower-layer-covered changes; existing paired
  ROLE-SESSION-ISOLATION-003 and WORKSPACE-WEB-SLOT-016 journeys remain the native
  acceptance gates. No journey behavior or coverage target was changed.
- At the initial CP-03 handoff, CP-02 and CP-04 through CP-18 remained pending.
  No replacement probe or desktop profile had run in that batch. CP-03 still
  needs both Chromium restart profiles, especially
  physical Windows persistence; it is not marked verified.
- Working-tree validation: check:hygiene (including documentation, AI context,
  source hygiene, Cargo dependency and E2E coverage checks), typecheck,
  lint:rust, the full native macOS Rust workspace tests, build and
  build:electron passed. Lint exited successfully with 23 warnings in unrelated
  renderer files; focused changed-file lint passed without warnings.
- The sandboxed full Vitest run passed 425 files and failed three environment-
  dependent files (DMG/Seatbelt and the loopback HTTP fixture). Those three files
  subsequently passed with the required native/loopback access: four DMG/Seatbelt
  tests and 14 runtime-fixture tests. The initial sandboxed Rust run failed five
  Keychain protection tests; the full workspace rerun with native access passed.
  This is a qualified working-tree result, not an immutable CI candidate or a
  desktop E2E run. Windows native checks remain pending CI.


### Owner-directed retirement: CP-02 and CP-13

On 2026-09-06 the owner explicitly retired performance diagnostics and the
high-refresh setting. These instructions supersede the original sampling-wiring
proposal. Both transition shells now remove the controls, typed commands/events,
operation controller, page sampler, native process/GPU sample readback,
power/thermal probes, high-refresh WebKit feature write and exported foreground
sample. General log export, application/runtime/GPU metadata, AppKit hosting and
unrelated WebGL experiment selection remain. The experiment launcher's retired
sampling-duration option is removed as well.

Rust and renderer settings no longer contain a performance section. Startup
repair ignores old boolean, enum and malformed retired values, preserves other
preferences, and is idempotent. Portable import accepts legacy preferences and
current export omits retired fields. Rust-owned generation removes the ten
retired TypeScript binding outputs; no generated contract was hand-edited.

Working-tree evidence for this batch:

- Full Vitest: 425 files, 3,243 tests passed. After the final native-source and
  documentation corrections, five focused files passed 50 tests; the experiment
  launcher, E2E source boundary and documentation graph passed another 13 tests.
- Production `build` and `build:electron` passed after sequential shell builds;
  `check:desktop-e2e-isolation` passed on the final production bundles.
- Native macOS `lint:rust` and `test:rust` passed: 1,638 tests, four existing
  ignored tests. Typecheck and lint passed; lint retains 23 unrelated renderer
  Fast Refresh warnings. Source hygiene and E2E coverage checks passed without
  changing any coverage target.
- `chromium-macos-appkit-smoke`, focused `chromium-system-settings`: PASS,
  including exact native diagnostics-save cancellation, clean exit and SQLite
  evidence that retired performance settings are absent. Local report:
  `.desktop-e2e-artifacts/2026-09-05T23-39-39-594Z-darwin/report.json`.
- Stable macOS `full`, focused `system-settings`: PASS. Local report:
  `.desktop-e2e-artifacts/2026-09-05T23-40-16-292Z-darwin/report.json`.
- Initial attempts are not acceptance evidence: the first stable run failed
  before reaching the initial screen while shell builds shared renderer output;
  sequential rebuilding passed. The first Chromium UI run passed but its old
  SQLite validator still required Disabled; the validator now requires absence
  and the complete phase rerun passed.
- Affected journeys: SETTINGS-SYSTEM-001, paired
  CHROMIUM-MACOS-APPKIT/WINDOWS-SYSTEM-SETTINGS-013 and paired
  CHROMIUM-MACOS-APPKIT/WINDOWS-DIAGNOSTICS-EXPORT-029. These are focused phases,
  not evidence that either entire profile or hardware-extended profile ran.
  Windows native lint/tests and both Windows settings phases remain pending CI.

CP-04 through CP-12 and CP-14 through CP-18 have not been completed by this
retirement batch. In particular, no font/input equivalence probe or final
migration/release gate is waived by removing these features.


### Shared surface projection: CP-04

The working tree now uses `chromiumRuntimeSurfaceProjection.ts` for both AppKit
and Windows Role/global-Web snapshot capture, bounds/visibility/zoom application,
acknowledged reparent journaling, reverse reparent compensation and surface
restoration. Snapshots copy bounds and retain the captured generation, so later
record or geometry mutation cannot redirect restoration to a newer surface.
Each restoration effect is attempted independently and failures still trigger
the existing exact window quarantine. Failed reparent submissions never enter
the acknowledged journal.

AppKit retains its native host/divider prepare/commit/rollback order, changed-only
surface application and adapter-sequence fence. Windows retains its Core layout
resolution, toolbar projection and host quarantine. No platform input, AppKit
chrome, domain owner, timer or public contract changed. Windows' rollback now
attempts visibility restoration even when zoom/bounds restoration fails, then
quarantines as before; this shares the best-effort compensation rule.

- Four focused projection/executor Vitest files passed 69 tests. The six new
  platform-explicit helper regressions additionally passed after strengthening
  reverse-order assertions; they prove immutable captured geometry/generation,
  independent restoration after failure, unchanged-effect suppression, failed
  submission exclusion and continued reverse rollback after a missing host.
- Typecheck, focused ESLint, source hygiene and production Electron build passed.
- Full Vitest: 425 files / 3,248 tests passed; one macOS packaged-process cleanup
  test reported an indeterminate OS process-tree cleanup. Its complete five-test
  file passed when rerun alone. This qualified result is not an unqualified full
  green suite. Logs: `/tmp/rion-cp04-full-tests.log` and
  `/tmp/rion-cp04-process-rerun.log`.
- E2E omission for this refactoring batch: `lower-layer-covered`, backed by both
  existing platform projection suites and shared failure regressions. Paired
  RUNTIME-TAB-TOPOLOGY-009 and application-recovery native acceptance remains
  outstanding. Prior settings E2E runs do not certify these changed paths.

CP-05/06 font experiments are the next independent item. CP-07/08 input probes,
CP-09 through CP-12, CP-14 through CP-18 and all recorded native/release gates
remain active; CP-04 implementation does not close their requirements.


### Local Font Access experiment: CP-05 / CP-06

A reproducible bundled-Electron probe now lives in
`scripts/probeChromiumLocalFonts.cjs`, exercised by
`tests/electron-local-fonts.native-integration.ts`. It uses isolated temporary
Electron/Core data, sandboxed file-backed fixtures and no debugging transport.
It compares the existing Rust provider with Chromium enumeration and records
exact-frame permission decisions. Production permission policy and enumeration
are unchanged while CP-06 remains conditional.

Observed on native macOS with Electron 43.4.1 / Chromium 150.0.7871.224:

- Automatic enumeration without user activation returned 705 faces / 251 unique
  families. Shown-window and reloaded-document enumeration returned the same
  families, including PingFang TC/SC and installed CJK families.
- Permission denial, a child frame, navigation to another file, and a different
  WebContents in the same Session all returned empty lists. Permission checks
  provide `isMainFrame` and the full `requestingUrl`, enabling exact application
  frame admission without granting Role/global-Web sessions permission.
- The current Rust provider returned its 16-family fallback. Independent native
  inspection produced 2,224,721 bytes of system_profiler JSON, exceeding the
  existing 2 MiB bound. Its 346 unique native family names comprise the same 251
  public families and 95 dot-prefixed private families; its broad `_name` walk
  also collects face/file names. These differences must not be mislabeled exact
  enumeration parity. Six fallback labels were absent from Chromium's actual
  installed-family inventory; stored font selections must remain compatible if
  the new enumeration provider is adopted.
- The isolated macOS integration test passed. The complete real native Electron
  integration command passed both files / six tests. Typecheck, focused lint,
  source/documentation/Cargo/E2E hygiene passed. The standalone local report is
  `/tmp/rion-cp05-report.json`; this is working-tree evidence, not immutable CI.

Both existing macOS and Windows native-validation jobs now execute the same
probe through the native-integration suite and upload their JSON report as a
Local Font Access compatibility artifact. Windows has not run for this working
tree yet. CP-05 remains open for its Windows observation and final equivalence
assessment; CP-06 is not implemented or declared retained merely because a
macOS API call succeeded. E2E omission for the probe itself is
`lower-layer-covered`: it changes no product behavior and directly exercises
native Chromium permission and enumeration behavior.


### Shared trusted-input coordination: CP-09

Both native adapters now use `chromiumTrustedInputPendingLane.ts` for pending
request ownership, exact frame identity, cancellation, retirement, DOM mismatch
and terminal completion. `chromiumTrustedInputDomReceipt.ts` supplies the common
bounded, closed-schema preload decoder and exact expected-event comparison.
AppKit native sequence evidence and Win32 HWND/process/focus/injection evidence
remain validated by their respective adapters; Core still owns scheduling.

The shared lane fences duplicate terminal events, removes only its own map
entries, admits reentrant work without overwriting another request, and completes
even when deadline cancellation or a retired frame throws. Native submission
without complete authoritative evidence remains indeterminate. Existing explicit
deadlines retain their classification; this introduces no polling or new timer.

- Five focused trusted-input test files passed 76 tests, including ten new
  platform-explicit shared-lane cases for reentrancy, stale frames, retirement,
  partial completion and independent cancellation failures.
- Full Vitest passed all 427 files / 3,259 tests. The first run exposed a missing
  migration-token admission for the CP-05 isolated font probe; adding its exact
  path to the existing allowlist fixed the gate. No broad scan exemption was
  added. Final log: `/tmp/rion-cp09-full-tests-rerun.log`.
- Typecheck, focused ESLint, full hygiene and production Electron build passed.
- E2E omission for this refactoring batch: `lower-layer-covered`, with the focused
  tests above. Native macOS and Windows acceptance remains pending for paired
  MACRO-NATIVE-EFFECT-018, MACRO-BACKGROUND-TAB-004,
  MACRO-STANDBY-RECOVERY-023 and MACRO-INPUT-RECOVERY-011 journeys under the
  CHROMIUM-MACOS-APPKIT and CHROMIUM-WINDOWS prefixes. The earlier settings
  profiles do not certify these input paths.


### Session maintenance transport audit: CP-10

The three operations already converge on one transport; no additional launcher
or platform switch is needed. The legacy Chrome-import naming of that private
transport is not a restriction to Chrome import. Verified call chain:

| Responsibility | Shared owner and evidence |
| --- | --- |
| Request launch | ClearFreshCoordinator, SessionMigrationFreshCoordinator and ChromeProfileImportCoordinator all call CoreAddonClient.launchChromeProfileImportHelperInternal. |
| Cancellation and JS buffer ownership | CoreAddonClient creates one cancellation UUID, binds AbortSignal, and waits for the original native launch promise. Aborting never resolves an operation while process cleanup is pending. |
| Process identity, pipes and drain | rion-node/chrome_profile_import_helper_launcher.rs launches the current executable with a fixed mode, owns the exact Child, requires bounded stdout EOF and clean child exit, and hashes PID plus response bytes into exit evidence. HelperProcessRegistry rejects drain-time admission and waits for registration release. |
| Windows-specific process presentation | rion-platform::background_command only supplies the required background-process flags; process ownership and exit rules stay in the common Rust launcher. |
| Wire validation | The common native response decoder and CoreAddonClient validator reject unsupported outcomes, bounds, framing and noncanonical exit evidence. chromeProfileImportHelperProtocol owns the common helper wire format. |
| Helper execution | runChromeProfileImportHelperProcess decodes one request, dispatches its family, writes one terminal frame, erases owned buffers, then exits. It awaits the response write; a failed terminal write produces a nonzero exit. |

Family-specific receipt identity and data semantics remain intentionally separate:
reset proves an all-store clear, cookie readback and exact Session drain;
legacy migration binds its inventory/journal and requires a distinct helper's
LocalStorage readback; consented Chrome import binds a transaction, origin scope,
backup and one-time verification capability. A shared permissive receipt schema
would lose these fences. Cookie flush or same-process reopen cannot replace the
fresh-process migration verification.

The helper-process suite now runs explicitly for both darwin and win32 paths.
New event-driven tests hold the terminal write pending and prove no exit or
response-buffer erasure occurs early; rejected writes prove a nonzero process
exit and buffer cleanup. Nine focused transport, coordinator and migration files
passed 121 tests, including stale/tampered outcomes, cancellation awaiting native
completion, reset uncertainty and distinct-session verification. These are
lower-layer behavior tests, not native Windows or persistence E2E evidence.
Native acceptance remains pending for the paired ROLE-EXPLICIT-RESET-007 journeys
and exact migration/import restart scenarios. E2E omission for this audit/test
batch is `lower-layer-covered`; no product behavior or coverage target changed.

Native macOS validation for this audit passed `lint:rust` and the entire
`test:rust` workspace (1,638 passed, four ignored), including the shared native
helper launcher's exact-child cancellation, bounded response framing,
pre-spawn cancellation and registry-drain tests. Typecheck, focused ESLint,
full hygiene and documentation checks also passed. Logs are
`/tmp/rion-cp10-rust-lint.log`, `/tmp/rion-cp10-rust-tests.log`,
`/tmp/rion-cp10-tests.log` and `/tmp/rion-cp10-fences.log`.
No desktop E2E profile ran in this audit batch; Windows native CI remains pending.


### Browser capability ownership: CP-11

The [capability audit](chromium-capability-ownership-audit.md) traces all requested
browser capabilities through their shared owners, exact completion sources and
behavior tests. It identifies two explicit desktop assertion gaps (live Role
font application and tab audio) for CP-15; settings controls and generic topology
journeys cannot substitute for those assertions. Certificate callback tests are
also labeled lower-layer evidence rather than claimed native TLS negotiation.


Fourteen focused capability/receipt files passed 190 tests. The macOS
`chromium-macos-appkit-smoke` profile's focused `chromium-controlled-role-reload`
phase passed the actual native-menu reload/failure/recovery journey
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031. Report:
`.desktop-e2e-artifacts/2026-09-06T00-22-52-395Z-darwin/report.json`.

The same profile's `chromium-workspace-web-fullscreen-restart` focused run failed
in its seed dependency at native file selection: the AX chooser driver could
not find `rion-e2e.txt`. The failure screenshot also contains an older Rion
Studio crash-report dialog and another partially obscured system dialog; that
observation does not establish the cause. This is failed acceptance, not a
passed upload/fullscreen/security run. Preserve its report and screenshot:
`.desktop-e2e-artifacts/2026-09-06T00-20-11-427Z-darwin/report.json` and the seed
phase's `native-file-panel-failure.png`. CP-15 must diagnose the native chooser
failure and rerun the complete paired scenario without replacing visible upload.
Windows has not run this worktree's capability acceptance.


### Shared shell command definitions and lifecycle audit: CP-12

`electronApplicationMenuCommands.ts` now owns the application command items and
callback routing used by both native menus. Both wrappers retain their platform
menu layout while consuming the same new-window, quit, zoom and fullscreen
commands. Command/Ctrl accelerators, Windows mnemonic labels, macOS app/services
roles and Quick Open remain explicit presentation differences. Windows F11
continues to set registerAccelerator=false; CP-07's physical routing experiment
is still required before changing that owner. No Electron menu role bypasses the
Core-controlled fullscreen/quit path.

The other requested shell mechanisms already have a common owner:

| Mechanism | Common owner and retained boundary |
| --- | --- |
| Focused application commands | ElectronFocusedApplicationShortcutController authenticates the focused main/runtime/popup owner; ElectronApplicationShortcutController serializes main-window commands and fences queued work when quitting. Native AppKit runtime-window identity stays required. |
| Shell services | ElectronNativeShellActions delegates dialog selections and shell operations through common ports, then returns Core results. Selection cancellation returns null before any Core mutation; filesystem authority stays in Rust. |
| Displays | Electron screen display-added/removed/metrics-changed events feed ElectronDisplayTopologyController. Semantic revisions advance from captured display inventories, not polling. The native placement effects remain in the host adapters. |
| Power | ElectronApplicationLifecycleController serializes suspend/resume effects, fences stale epochs and drains its active lane on disposal. The platform field describes the published record; it does not select duplicate coordinators. |
| Close and quit | applyElectronMainWindowClosePolicy hides until final close is admitted. ElectronMainLifecycle and the renderer quit handshake own normal quit. prepareElectronCleanExit closes ingress, drains runtime/helper/browser-clear work and persists a clean marker only after authoritative completion. Fatal termination keeps its separate invalidation rules. |
| Windows session end | ElectronWindowsSessionEndCoordinator maps query-session-end into the same confirm/drain promise because the OS does not use ordinary Electron quit events for that path. It deduplicates repeated signals and preserves failure. |
| Window materials | windowOptions selects Electron vibrancy on macOS and Mica on Windows. These are requested native material differences, not duplicated lifecycle logic. |

Twelve focused command/menu/lifecycle/display/close/shell suites passed 63 tests,
including canceled dialog selection, stale focus, fullscreen interruption,
renderer quit confirmation, exact drain order and Windows session-end mocks.
No Rust/shared contract or native implementation changed in this batch. Native
Windows acceptance remains separate from these platform-explicit unit tests.


Full Vitest passed 427 files / 3,265 tests (`/tmp/rion-cp12-full-tests.log`).
Focused ESLint, typecheck and full hygiene also passed. The native macOS
`chromium-macos-appkit-smoke` profile passed both focused validations:

- `chromium-shell-smoke`: SHELL-001 and APPLICATION-SHORTCUTS-030, with actual
  focused command/zoom receipt evidence. Report:
  `.desktop-e2e-artifacts/2026-09-06T00-26-53-235Z-darwin/report.json`.
- `chromium-quit-guard-restart` including seed: QUIT-GUARD-014, covering keep
  editing, discard/quit, final flush and restart. Report:
  `.desktop-e2e-artifacts/2026-09-06T00-28-05-029Z-darwin/report.json`.

Windows native shell/shortcut/quit profiles and physical display/power acceptance
remain pending. The source refactor does not change journey behavior or manifest
coverage. OS-specific material/session-end boundaries remain retained.

After native E2E, the production Electron build and pure-renderer isolation
verification passed (`/tmp/rion-cp12-production-build.log`); the final local
output is the production build, with no E2E instrumentation.


### Platform data adapters: CP-14

The [platform data audit](chromium-platform-data-audit.md) traces native effects
and Core callers for file identity, permission repair, atomic replacement,
instance locks, Chrome discovery/close/cookie decoding and transfer encryption.
These adapters remain necessary for OS semantics and persisted-format
compatibility. Shared Rust orchestration remains the owner; no Electron
safeStorage conversion or live external-Chrome fallback was introduced.

The audit explicitly distinguishes source lock-marker observation from positive
process identity and tests with injected keys from native Keychain/DPAPI access.
The local Parallels command entry is a broken symlink and cannot provide a
Windows host; Windows native validation remains pending CI.


On native macOS, focused Rust validation passed: rion-platform all-targets
24 tests; Core session_transfer 27; chrome_profile_import four; session_import
eight; chrome_import 12 (75 total). Logs: `/tmp/rion-cp14-platform-tests.log`,
`/tmp/rion-cp14-transfer-tests.log`, `/tmp/rion-cp14-import-tests.log`,
`/tmp/rion-cp14-cookie-tests.log`, `/tmp/rion-cp14-contract-tests.log`.
Documentation/full hygiene checks passed. E2E omission for this documentation
and source audit is `lower-layer-covered`, with the focused behavior evidence
above. No macOS or Windows desktop E2E profile ran in this batch, and no native
implementation, import, cfg guard or persisted format changed.


### Release-tooling consolidation: CP-16

The updater manifest generator and release-asset verifier now share
`releaseFileHash.mjs` for streamed SHA-256-to-EOF. Each caller still owns its
regular-file/symlink/size checks and signature requirements. The protected
handle-based package-manifest reader is deliberately not replaced by this
path-based hashing helper; it has stronger identity requirements.

`releaseVersionPolicy.mjs` now owns the identical strict SemVer syntax used by
the production candidate, public-latest snapshot and compatibility receipt I/O.
Callers preserve their own errors and version-ordering checks. Numeric identifiers
are not converted to floating point; build metadata and noncanonical leading
zeroes remain rejected. Existing legacy entry-point argument normalization is
unchanged. This removes duplicate mechanisms without rewriting trust policies.

| Release concern | Shared mechanism and retained boundary |
| --- | --- |
| Version mutation | applyReleaseVersion.mjs updates package, Tauri configuration and all Rust workspace package versions together. Strict evidence validators now share syntax; compatibility receipt I/O continues to own exact comparison and newer-than checks. |
| Manifest and checksums | createTauriUpdaterManifest.mjs is a compatibility wrapper around createUpdaterManifest.mjs. Both platforms feed the same manifest, releaseArtifacts asset list, signature sidecars and checksum verification. |
| Signing environment | updaterSignerEnvironment.mjs constrains signer inputs. Existing TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD names remain shared with the v22 workflow. No new secret or signing identity was added. |
| Cryptographic verification | electronProductionCandidate's Minisign verification still authenticates key ID, artifact signature and trusted-comment signature. Shared SHA-256 is evidence binding, not a replacement for this signature check. |
| Package build | Existing macos-latest/windows-latest matrices use shared orchestration while retaining native bundle/install steps. buildElectronRust selects only the library name and macOS linkage/ad-hoc signing effects. |
| Native distribution policy | electron-builder keeps macOS identity '-' and notarize=false. Windows installer verification still requires the unsigned policy. Native package identity and installed-payload verification remain platform-specific. |
| Candidate trust | electron-production-candidate reuses ci.yml, binds source/version/platform, runs exact native black-box checks before detached updater signing, and assembles both platform receipts. The existing protected environment remains in place. |
| Publication/cutover | Provisional publication, updater evidence execution and terminal promotion retain their disabled gates and owner prerequisites. CP-16 does not authorize publication, invent release credentials or substitute autoUpdater for Rust transactions. CP-17 remains gated. |

Six focused release/manifest/candidate/version suites passed 65 tests. Full
Vitest passed 428 files / 3,282 tests, including release workflow and trust-chain
regressions. Typecheck, lint (zero errors; 23 existing React Fast Refresh warnings)
and full hygiene passed. Logs: `/tmp/rion-cp16-tests.log`,
`/tmp/rion-cp16-full-tests.log`, `/tmp/rion-cp16-typecheck.log`,
`/tmp/rion-cp16-lint.log` and `/tmp/rion-cp16-hygiene.log`.
E2E omission for these release-helper refactors is `lower-layer-covered`, with
real temporary-file manifest/hash and candidate signature test evidence. No
native desktop E2E profile, Windows package build, production-key signing or
release transaction ran in this batch; exact-candidate native gates remain open.


### Desktop E2E recovery and shared scenarios: CP-15

The contained-fullscreen scenario already shares the fixture, seed/restart flow,
page actions and evidence assertions across both platform journey IDs. The
native-file-upload helper shares fixture bytes/hash verification and terminal
evidence while retaining AppKit AX and Windows UI Automation drivers. The
visible remote file input and actual OS chooser remain mandatory; no debug file
assignment or alternative upload path was added.

The macOS chooser now records bounded failure diagnostics (at most 300 native
nodes, depth 12, truncated labels; remote AXWebArea content excluded) to
`macos-native-file-dialog-failure.json`. A missing item now exits the Swift
selector normally with failure instead of fatalError, avoiding an additional
crash-report side effect. The existing screenshot and failed test verdict remain.
No permission prompt is automatically accepted or disabled.

The complete focused `chromium-macos-appkit-smoke` run for
`chromium-workspace-web-fullscreen-restart`, including seed and entity restart
dependencies, passed on macOS. Report:
`.desktop-e2e-artifacts/2026-09-06T00-38-00-929Z-darwin/report.json`.
POPUP-012, WORKSPACE-WEB-FULLSCREEN-017, WORKSPACE-WEB-SECURITY-POLICY-027 and
WORKSPACE-WEB-FILE-UPLOAD-028 all passed. Upload evidence proves exact native
application ownership, a visible action and the selected 57-byte file's SHA-256
matching its fixture; it is not merely a successful chooser return.

The prior failed run remains recorded above. This rerun did not reproduce the
missing-item failure, so its cause is still unproven. New diagnostics are for a
future recurrence, not evidence that the cause was repaired. Windows native
upload and CP-11's explicit live-font/audio assertions remain outstanding.


An independent repeat of the same complete focused profile also passed, without
manual UI interaction during the run. Report:
`.desktop-e2e-artifacts/2026-09-06T00-39-59-948Z-darwin/report.json`.
Both runs preserve real native chooser actions and the same page digest checks.
Typecheck, focused ESLint, five adjacent scenario tests, source/full hygiene and
coverage-manifest validation passed. The coverage target remains unchanged.
Logs: `/tmp/rion-cp15-upload-diagnose.log`, `/tmp/rion-cp15-upload-repeat.log`,
`/tmp/rion-cp15-source-tests.log` and `/tmp/rion-cp15-full-hygiene.log`.

Production Electron build and pure-renderer verification passed after both E2E
runs (`/tmp/rion-cp15-production-build.log`); final local build output contains
no E2E instrumentation.


### Visible tab audio parity: CP-11 / CP-15

The Windows host had no mute menu entry despite sharing the Chromium audio
executor. Its strict tab projection now carries `audioMuted`; the visible menu
submits `setTabMuted` with a boolean desired state and its captured projection
revision. The host rejects stale/unknown commands and forwards the existing
native action to Core `browserTabAudioMute`. After the authoritative terminal,
its existing layout observer republishes the executor's exact audio state.
Full and layout-only projections preserve audio state; the renderer does not
optimistically toggle it. The existing Role/Web rollback and readback executor
and retained AppKit menu remain the authorities for their respective work.

Read-only E2E inspection now includes `isAudioMuted` from the exact registered
Role surface. Paired P1 journeys `CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-AUDIO-032`
and `CHROMIUM-WINDOWS-RUNTIME-TAB-AUDIO-032` use visible menus to mute/unmute,
compare Core and native state, preserve owner/surface/document identity during
audio changes, and retain mute through controlled Reload success, injected
Reload failure and recovery. This does not claim native audio failure injection,
Web-only or popup audio coverage; existing focused executor tests cover those
lower-layer mutation/rollback paths.

macOS `chromium-macos-appkit-smoke`, focused phase
`chromium-controlled-role-reload`, passed both AUDIO-032 and RELOAD-031:
`.desktop-e2e-artifacts/2026-09-06T00-52-14-725Z-darwin/report.json`.
Windows `chromium-windows-smoke` remains pending native CI. Live font application
also remains outstanding; CP-11/CP-15 are not closed by this partial profile.

Validation: 65 adjacent tests and the complete 428-file / 3,283-test Vitest suite
passed; typecheck, lint (23 existing warnings), source hygiene and E2E coverage
passed. Coverage targets remain unchanged. Logs: `/tmp/rion-audio-unit.log`,
`/tmp/rion-audio-full-tests.log`, `/tmp/rion-audio-native.log`,
`/tmp/rion-audio-typecheck.log`, `/tmp/rion-audio-lint.log`.

Production Electron build and pure-renderer verification passed after the native
run (`/tmp/rion-audio-production-build.log`, 36 sources / 3,275,470 bytes),
restoring non-instrumented output. Native macOS Rust lint also passed
(`/tmp/rion-audio-rust-lint.log`).
Native macOS Rust tests passed: 1,638 passed, 4 ignored, zero failed
(`/tmp/rion-audio-rust-tests.log`). Windows native Rust/E2E remains pending CI.


### Live font application and Canvas compatibility: CP-11 / CP-15

Paired P1 `CHROMIUM-MACOS-APPKIT-FONT-APPLICATION-033` and
`CHROMIUM-WINDOWS-FONT-APPLICATION-033` extend `chromium-system-settings` with
an actual launched Role. Visible controls select `ui-monospace` for Latin and
numbers, cancel an unsaved draft, apply, and reset. A visible fixture button
produces main-world evidence from its trusted click handler; WebDriver only
reads that bounded DOM result. Assertions check Core selection, applied CSS,
equal Canvas W/i widths, preservation of the original page `font` getter, and
restoration of the original proportional widths and CSS after reset.

This exposed a real Chromium compatibility defect: Canvas accepts the
`ui-monospace` generic but resolves a proportional fallback on this bundled
Chromium/macOS host. An independent uninstrumented Electron probe produced
W/i widths 15.1015625/4.4453125 for ui-monospace, versus
9.6328125/9.6328125 for monospace (`/tmp/rion-canvas-probe.log`). The shared
browser font runtime now inserts `monospace` immediately after a requested
`ui-monospace` in Canvas override stacks. Engines supporting the UI family keep
it; others receive a genuine monospace fallback. DOM CSS and the page-facing
Canvas font getter remain unchanged. This shared source feeds Electron and the
stable Tauri overlays; no platform branch or replacement font authority was
introduced. Two platform-explicit regression cases verify the stack and getter.

The final macOS native run passed FONT-APPLICATION-033,
SYSTEM-SETTINGS-013 and DIAGNOSTICS-EXPORT-029:
`.desktop-e2e-artifacts/2026-09-06T01-07-48-409Z-darwin/report.json`.
Earlier failed attempts remain diagnostic evidence: Courier New was not listed
in the picker, and the pre-fix generic-family journey reproduced proportional
Canvas metrics despite applied CSS and an installed hook. This journey therefore
proves generic-family application, not the separate CP-05/06 named-font inventory
or downloaded-font validation. Windows native execution remains pending CI.

The 18 shared font-runtime tests passed (`/tmp/rion-font-fix-tests.log`), along
with typecheck, lint (23 existing warnings), source hygiene and coverage checks.
The coverage targets remain unchanged. The passing native log is
`/tmp/rion-font-native-fixed.log`.

The complete 428-file / 3,285-test Vitest suite passed after the runtime fix
(`/tmp/rion-font-fixed-full-tests.log`). Production Electron build and pure
renderer verification passed (`/tmp/rion-font-production-build.log`, 36 sources /
3,275,470 bytes), restoring non-instrumented output. macOS Rust lint passed
(`/tmp/rion-font-rust-lint.log`).
Native macOS Rust tests passed: 1,638 passed, 4 ignored, zero failed
(`/tmp/rion-font-rust-tests.log`). Windows native Rust/E2E remains pending CI.


### Named-font loading clarification: CP-05 / CP-11 / CP-15

The earlier picker snapshot was captured while automatic enumeration was still
loading; it was not proof that Core or the bridge omitted named families.
A fresh `/usr/sbin/system_profiler SPFontsDataType -json` run took 10.19 seconds
and produced 2,224,721 bytes on this host, above the retained 2 MiB bound
(`/tmp/rion-fonts-current-time.log`). Core's existing normalization/fallback
therefore remains relevant. No new native enumeration implementation or larger
output limit was introduced.

FONT-APPLICATION-033 now waits for the existing visible loading state to finish,
then checks the Core inventory and selects Courier New through the actual menu.
It cancels the first draft, exercises the generic-family regression, then applies
Courier New to Latin and numeric slots. The fixture's trusted main-world handler
reports loaded FontFace family aliases as well as DOM CSS and Canvas W/i widths.
Assertions require loaded Latin/numeric aliases, the exact Core selection,
monospace measurements, and restoration of the original CSS, faces and metrics
on reset. This closes the macOS named-font application evidence gap; it does not
claim complete native inventory parity or downloaded-font coverage.

macOS `chromium-macos-appkit-smoke`, focused `chromium-system-settings`, passed
FONT-APPLICATION-033, SYSTEM-SETTINGS-013 and DIAGNOSTICS-EXPORT-029:
`.desktop-e2e-artifacts/2026-09-06T01-14-19-202Z-darwin/report.json`.
The preceding inventory/loading clarification run also passed:
`.desktop-e2e-artifacts/2026-09-06T01-12-55-087Z-darwin/report.json`.
The corresponding Windows profile remains pending native CI. CP-05/06's
queryLocalFonts adoption decision still requires the paired Windows probe.

Typecheck, 37 adjacent fixture/font tests, lint (23 existing warnings), source
hygiene and coverage validation passed. Logs: `/tmp/rion-font-named-native.log`,
`/tmp/rion-font-named-unit.log`, `/tmp/rion-font-named-lint.log`.
This increment changes E2E evidence only; the shared runtime fix and the previous
native Rust validation are unchanged.

Final production Electron build and pure renderer verification passed
(`/tmp/rion-font-named-production-build.log`, 36 sources / 3,275,470 bytes),
restoring non-instrumented output. The native Courier New evidence contains both
loaded aliases and equal W/i widths of 9.6015625; the generic fallback measured
9.6328125 for both glyphs, versus original proportional widths
15.171875/3.640625.


### Retired diagnostics runbook audit: CP-02 / CP-13 / CP-18

The active Game Mode runbook still passed the removed `--sample-ms` option to
the experiment launcher. Its commands now use only supported mode/Game Mode
arguments. Both active macOS comparison runbooks explain that the launcher no
longer supplies FPS/process/GPU/thermal samples; external/game-owned evidence
must name its source, and unavailable required metrics cannot pass a gate.
Immutable archive commands were preserved unchanged. Six launcher tests and
source hygiene passed (`/tmp/rion-runbook-tests.log`). This is internal-only
documentation maintenance; product controls remain removed.

A complete macOS `chromium-macos-appkit-smoke` run was started against the current
worktree at HEAD `a7a48418bcb9bffd1c91292719a609198e0cdbb4`. The completed result is recorded below; the run log is `/tmp/rion-full-native.log`.


### Complete macOS Chromium smoke: CP-03 / CP-04 / CP-09–12 / CP-15 / CP-18

The complete `chromium-macos-appkit-smoke` profile passed on the current dirty
worktree: all 49 manifest journeys are PASS, with no NOT_RUN journeys in this
profile. All 56 phases completed: 52 PASS and four EXPECTED_FORCE_TERMINATION
phases, each with an explicit expected-termination receipt and zero runner exit
code, establishing crash-recovery preconditions. It ran from 01:16:22 to
01:29:35 UTC on 2026-09-06. Authoritative report:
`.desktop-e2e-artifacts/2026-09-06T01-16-22-345Z-darwin/report.json`.
Source HEAD is `a7a48418bcb9bffd1c91292719a609198e0cdbb4`; this is a local
unpackaged Electron/AppKit run, not an exact production-candidate receipt.

The report supplies current macOS native evidence for Role/global-Web session
persistence, shared-role/workspace projection and fullscreen, visible tab
reorder/move/restart/recovery, foreground/background trusted Macro input,
keyboard/standby/input-failure recovery, terminal cleanup, shell shortcuts and
quit guard, upload/security policy, Role session isolation/reset, and generic
and named live-font application. Its Role reset journeys verify that particular
maintenance path; they do not establish all Chrome import or v22 migration
acceptance. The full report's journey IDs are the authority for scope.

No Windows native profile, hardware-extended profile, packaged candidate,
production updater transaction, or release-publication gate is proved by this
run. CP-05/07/08 probes and CP-17 remain separately open/gated. The full goal is
therefore still active rather than complete.

Production Electron build and pure-renderer verification passed after the full
profile (`/tmp/rion-full-native-production-build.log`, 36 sources /
3,275,470 bytes), restoring output without E2E instrumentation. Coverage, source
hygiene and whitespace validation passed after updating the evidence ledger.


### Hardware preflight and native integration: CP-05 / CP-12 / CP-15 / CP-18

The pinned Electron `screen.getAllDisplays()` preflight reports one display:
id 2, scale factor 2, bounds 2560x1440 and work area 2560x1410. Evidence:
`/tmp/rion-display-preflight.log`. The hardware-extended spec requires at least
two real displays with different scale factors. This host does not meet that
precondition; no simulated display was substituted and the hardware profile was
not claimed as run. Windows and suitable mixed-scale macOS hardware execution
locations were requested while local validation continued.

The full Electron native-integration command passed both files / six tests on
macOS (`/tmp/rion-native-integration-full.log`), including the startup fixture
and Local Font Access probe. This is current macOS evidence only. The retained
Tauri full desktop profile subsequently completed as recorded below
(`/tmp/rion-tauri-full-native.log`). No parallel renderer builds were run.


### Retained Tauri macOS full profile: CP-02 / CP-13 / CP-15 / CP-18

The complete stable macOS `full` profile passed on the current dirty worktree:
all 39 journeys PASS; 29 phases PASS plus three expected forced-termination
phases, each with an explicit expected-termination receipt and zero runner exit.
It ran from 01:34:37 to 01:41:05 UTC on 2026-09-06, source HEAD
`a7a48418bcb9bffd1c91292719a609198e0cdbb4`. Report:
`.desktop-e2e-artifacts/2026-09-06T01-34-37-128Z-darwin/report.json`.

This verifies the retained WKWebView/AppKit path after settings removal and the
shared Canvas fallback change, including settings, macro/input, Role isolation,
workspace ownership, cross-domain topology, persistence and crash recovery.
It does not substitute for WebView2/Windows execution or the Chromium hardware
profile. Together with the previous 49-journey Chromium macOS report, both local
shell paths now have complete smoke/full-profile evidence; hardware, Windows,
exact-candidate packaging/updater and migration release gates remain open.

Electron production build and pure-renderer verification passed after the Tauri
run (`/tmp/rion-tauri-full-production-restore.log`, 36 sources / 3,275,470 bytes),
restoring the intended non-instrumented Chromium build output. Coverage, source
hygiene and whitespace validation passed after the ledger update.

### Hosted CI audit and native tab lookup follow-up

Existing GitHub Actions Windows runners are available. Run `33996548461` on
commit `1130331d0a1f266bfa4838b47ec7a641d7ca1928` passed native validation and
retained Tauri desktop E2E on both platforms. Both Electron package jobs failed
during unpackaged smoke, before packaging. This older revision does not validate
the current dirty worktree. Windows failed at contained-fullscreen escape; local
HEAD `a7a48418` includes the subsequent targeting fix, pending hosted validation.

The macOS failure occurred while locating Chromium Tabs Gamma through an
unrestricted accessibility `entire contents` traversal. The precise cause of
the subprocess failure was not established. Native tab activation now traverses
at most 512 accessibility elements and skips AXWebArea descendants, preserving
exact tab identity, native window ownership checks, and physical click input.
This avoids inspecting game-page contents when locating native tab chrome.

After correcting a helper integration error found by the first local run,
both visible-tab seed and restart phases passed:
`.desktop-e2e-artifacts/2026-09-06T01-52-39-206Z-darwin/report.json`.
The adjacent source suite passed five tests; lint had zero errors and the same
23 existing warnings; source hygiene and E2E coverage passed. Production Electron
build and pure-renderer verification passed afterward (36 sources / 3,275,470
bytes; `/tmp/rion-native-tab-production-restore.log`). This test-infrastructure
change is lower-layer-covered and does not introduce a product journey.

Current-revision Windows smoke/package validation, mixed-scale physical macOS
hardware, and exact-candidate release/updater gates remain pending. Availability
of the hosted Windows runner resolves the execution-location uncertainty; it
does not resolve those gates without a successful current-candidate run.

### CP-08 isolated native Chromium input probe

Added `scripts/probeChromiumInput.cjs` and its native integration test to the
existing macOS/Windows native-validation matrix. Each platform uploads a JSON
report containing runtime versions, exact submitted input, DOM event order and
trusted/modifier/button/coordinate fields, plus host and document focus and
visibility before and after submission. The bounded observation deadline reports
`indeterminate`; it never means successful delivery. No production adapter,
permission, automation transport, or runtime contract changed.

The current macOS run on bundled Electron 43.4.1 / Chromium 150.0.7871.224
received all ten expected sample sequences: foreground keys, Shift plus repeat,
middle button at 100% and 150% zoom, held key before reload and release in the
new document, fresh post-reload keys, hidden view, visible background host, and
hidden host. Every recorded event was trusted. Background/hidden-host samples
preserved an unfocused target. At 150% zoom, input coordinates (120, 90) produced
DOM coordinates (80, 60); conversion must remain explicit in any candidate
adapter. Report: `/tmp/rion-chromium-input-probe/chromium-input-darwin.json`;
test log: `/tmp/rion-chromium-input-probe-test.log`.

The [pinned Electron documentation](https://github.com/electron/electron/blob/v43.4.1/docs/api/web-contents.md#contentssendinputeventinputevent)
still specifies a focused containing BrowserWindow. The observed background
delivery is empirical evidence for this isolated configuration, not a supported
cross-platform guarantee. These samples use a sandboxed WebContentsView fixture,
not the retained AppKit Role host or a generation/epoch-fenced runtime input
lane. Releasing a key in a new document is not proof of old-document retirement.
Actual Role ownership transfer, stale document exclusion, complete native
receipt equivalence and Windows execution remain open; no replacement decision
is inferred from the test passing. AppKit trusted input remains required.

Validation: the native probe passed one test covering ten samples; eleven
release-workflow tests, focused ESLint, JavaScript syntax, TypeScript build and
repository hygiene passed. E2E omission reason is `lower-layer-covered`: this
adds API research evidence without changing product behavior or journey routes.
The new Windows probe has been wired into CI but has not yet run there.

### Current candidate CI dispatch and migration-boundary correction

The accumulated implementation and local validation were committed as
`a05c0466d776f2760bbe95209bd513af46965e35` on the existing migration branch.
Exact-SHA CI run [34005498824](https://github.com/rion-tw/rion-studio-source/actions/runs/34005498824)
started the paired native/E2E/package jobs. Its checks and macOS package job
failed at `verify:system-only`: the new isolated input probe had not been added
to the migration-only Electron token allowlist. Local execution reproduced the
same error. This is a test-tool registration failure, not native input parity
evidence. No failed or unexecuted downstream phase is counted as passing.

Added only `scripts/probeChromiumInput.cjs` to the existing exact-path allowlist,
alongside the Local Font Access probe. The production source roots, forbidden
tokens, and runtime migration gates remain enforced. The executable migration
gate and its eight focused tests passed locally; the corrective commit requires
a new exact-SHA CI run. Existing local native evidence remains qualified by the
source revision and scope recorded above.

### CP-07 terminal-event source audit while native CI runs

Source inspection at corrective commit `e94c26a90d754d420cbfec825433f54bc9e15594`
identifies a concrete replacement constraint. In
`crates/rion-node/src/windows_runtime_shortcut_owner.rs`,
`classify_f11_transition` consumes the initial plain key-down and subsequent
repeats, then emits once on the captured key-up even when modifiers changed
during the press. The hook first selects the exact registered foreground HWND;
its callback is acknowledged through the current owner revision before dispatch.
The source explains why dispatch waits until the native input transaction exits:
fullscreen entry from key-down can reenter that transaction.

By contrast, the host `before-input-event` listener in
`chromiumRuntimeHostFactory.ts` and the managed surface interceptor in
`chromiumRoleQuickAccessShortcut.ts` dispatch on non-repeat key-down and match
plain modifiers separately for each event. The application menu still disables
F11 accelerator registration. These existing paths therefore are not evidence
that removing the hook preserves its terminal-event semantics.

The CP-07 physical replacement matrix must additionally measure command timing
relative to key-up, repeated downs, modifier changes during a captured press,
focus/owner change before release, and registration retirement. Capture the
authoritative native and page event order for both mechanisms; a fullscreen
toggle alone cannot establish equivalence. This audit does not change input
behavior, assert that a race occurred, or close the native replacement probe.

Exact corrective CI run
[34005620760](https://github.com/rion-tw/rion-studio-source/actions/runs/34005620760)
has passed the prior migration-boundary step and entered macOS Chromium E2E.
Both platform results remain pending until terminal job and artifact evidence
is inspected. The superseded run was explicitly cancelled after its verified
boundary failure; its unfinished jobs are not acceptance evidence.

### CP-08 expanded modifier and hidden-pointer samples

Extended the isolated input probe with Control, Alt and Meta press/chord/release
sequences and middle-button down/up in hidden-view, background-host and
hidden-host states. The expanded macOS run received all 16 expected sequences;
the recorded modifier fields were set for the chord and cleared on release,
and background/hidden hosts remained unfocused before and after pointer input.
This closes gaps in the API experiment's sample inventory, not the actual Role
adapter equivalence gate. Report:
`/tmp/rion-chromium-input-expanded/chromium-input-darwin.json`; native test log:
`/tmp/rion-chromium-input-expanded.log`.

The native probe test, focused ESLint and executable migration-boundary check
passed. This is lower-layer-covered research infrastructure with no product
journey change. These added samples are working-tree changes after `e94c26a9`;
run `34005620760` still validates the earlier ten-sample probe and cannot be
cited for the expansion. Its live jobs are left running to obtain their exact
candidate results.

### Windows cfg and macOS restart-history findings from e94c26a9 CI

Windows native job `101412221427` failed Rust lint after diagnostic removal:
two WebGL imports remained at the shared runtime root, and macOS experiment
types/functions were still compiled without Windows consumers. Moved the two
imports into the macOS adapter, gated experiment types/implementation to macOS
or tests, and gated the environment-reading function to macOS. No dead-code
allowance was added. Local native Rust lint, complete Rust tests, Tauri build,
Electron build and pure-renderer verification passed. Windows verification of
the correction remains pending. Log: `/tmp/rion-e94-windows-native.log`.

The macOS Chromium job `101412129350` reached Web-only restart and failed the
post-run evidence predicate. Its artifact contains hidden `activating` followed
by visible `ready`, with the same exact tab/window/surface/native owner and
generations. The predicate incorrectly required every startup observation to
already be ready. It now accepts initial hidden activation followed by ready,
while fencing the entire history to the terminal identity and rejecting
post-ready regression or generation/owner changes. Seven focused tests passed,
including positive and negative histories for both platforms. The corrected
validator accepts the downloaded CI artifact; this is artifact revalidation,
not a fresh successful full-profile run.

The Windows Chromium job `101412129373` still fails HTML fullscreen Escape.
Unlike the earlier run with no key events, this candidate records trusted
Escape down/up in the expected page but no `contained-fullscreen-exit` receipt.
This narrows the failure beyond input targeting; the cause is not yet proven.
Logs and downloaded artifacts are under `/tmp/rion-e94-windows-package.log`,
`/tmp/rion-e94-win-artifacts` and `/tmp/rion-e94-mac-artifacts`. Other live jobs
remain independent evidence; no full native acceptance or CP-17 gate is closed
by these partial results.

### Escape driver reproduction and correction

An isolated sandboxed WebContentsView on the pinned macOS Electron/ChromeDriver
reproduces the Windows symptom using the same generic W3C key action: a visible
click enters HTML fullscreen, Escape does not exit, and the document remains
fullscreen. Sending `Input.dispatchKeyEvent` through that same ChromeDriver with
explicit Escape code plus Windows/native virtual-key values exits fullscreen.
A separate low-level experiment shows that a missing Windows virtual-key value
can produce the same non-exiting behavior; the exact Windows W3C wire payload
has not been captured, so its missing-field cause remains an inference.

Added the shared E2E-only `sendChromiumEscapeKey` helper. The Windows page action
keeps the existing exact URL and document-focus fence, then sends both key
halves through ChromeDriver with complete codes. It does not invoke
`document.exitFullscreen`, call a product debug action, or change production
fullscreen behavior. AppKit Escape retains its native input path. Journey:
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`; the existing contained-fullscreen
spec remains the acceptance action.

The new native integration test uses that same helper after a visible fixture
button click, independently observes DOM fullscreen exit, and records the
generic-W3C comparison. Any research-case cleanup runs only after the helper's
exit assertion. macOS passed; report:
`/tmp/rion-fullscreen-native-regression/fullscreen-escape-darwin.json`.
The fixture automatically joins both native CI platforms and their existing
input-report upload. Windows correction acceptance is still pending a new run.

CI `34005620760` is terminal: renderer build, shared checks, Linux sanitizer,
both retained Tauri desktop jobs and macOS native validation passed. Both
Chromium package jobs and Windows native validation failed as recorded above.
These are exact `e94c26a9` results; the subsequent working-tree corrections are
not retroactively validated by that run.

Before corrective submission, all four Electron native integration files / eight
tests passed on macOS (`/tmp/rion-escape-all-native.log`), including the expanded
input and shared Escape helper probes. Twelve focused E2E evidence/source tests,
focused ESLint, TypeScript, repository hygiene and whitespace checks passed.
The previously recorded native Rust checks and dual-shell builds cover the cfg
correction. Windows native lint and the paired Chromium smoke/package jobs must
still run on the corrective commit.

### Downloaded hosted Tauri and font evidence at e94c26a9

Inspected the actual Windows Tauri report from CI `34005620760`, artifact
`desktop-e2e-Windows-34005620760-1`: 39 journeys PASS; 29 phases PASS plus three
expected forced terminations. The clean `e94c26a9` checkout ran the `full`
`tauri-v22` profile from 02:08:45 to 02:20:19 UTC on 2026-09-06. Local copy:
`/tmp/rion-e94-tauri-windows/2026-09-06T02-08-44-938Z-win32/report.json`.
This supplies retained Windows/WebView2 settings-removal and full-journey
evidence. It does not certify Chromium Windows or cure that run's Rust lint
failure. CP-02/13 now distinguish the passed legacy paths from outstanding
Chromium Windows acceptance.

Also inspected `local-fonts-macos-latest-34005620760-1`. The hosted Mac returned
528 Chromium faces / 180 unique families, stable across automatic, shown and
reloaded queries without user activation. Denied permission, subframe, changed
document and different owner queries returned empty inventories. Its Rust
provider returned 3,150 names, including every Chromium family: 2,970 additional
names include 2,244 dot-prefixed names and 235 font-file names (categories may
overlap). Unlike the local Mac's overflow fallback, this host exposes the native
collector's broad name walk directly. This is positive evidence that Chromium
enumerates public families without the collector's file/face-name noise; it
does not prove compatibility for previously persisted private/face selections.
Report: `/tmp/rion-e94-fonts-macos/local-fonts-darwin.json`.

The probe source is unchanged between `e94c26a9` and `453d1f53`; the evidence is
still explicitly attributed to the earlier run. CP-05 remains open for Windows
and the final adoption assessment. Current CI `34006922119` continues against
exact `453d1f5354e6f646854fe89ac1255ec0b8d4d3b3`.

### CommonJS fixture lint classification

Current CI's Windows native job passed the previously failing Rust lint step
and entered the workspace tests. Its shared checks job `101415749279` instead
found that the newly added `.cjs` fixture was outside ESLint's existing
Node/CommonJS file scope. Extended that existing scope from scripts to
`tests/fixtures/**/*.cjs`; the fixture remains fully linted with the same
CommonJS rules, rather than ignored. Full local lint now passes with zero errors
and the same 23 pre-existing renderer warnings
(`/tmp/rion-453-fixture-lint.log`). The current native jobs remain running on
`453d1f53`; this lint-configuration correction has not been submitted to CI yet.

### Windows Escape passed; popup parent-revision assertion corrected

Windows Chromium job `101415749268` passed the previous Escape exit boundary
and continued to the popup creation assertion. It failed at line 693 because
the parent topology revision remained 8 instead of increasing. The popup
coordinator captures the current parent revision when opening a separate popup;
it does not mutate parent topology. A native focus event can incidentally advance
the revision, explaining why the strict increase was not a portable invariant.

Changed that assertion to require a non-regressing parent revision. Exact parent
window/generation/layout/slots and independent popup host/revision checks remain
in place, as do the later authoritative popup lifecycle fences. This changes
test semantics to match the source owner contract, not product behavior or the
required journey outcome. Twelve focused tests, typecheck and E2E coverage
passed. Native Windows acceptance of the remaining popup sequence is pending;
passing Escape alone does not establish the full
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017` journey.

### CP-03 / CP-10 Windows Chrome import physical-path correction

Windows native job `101415823077` passed lint but failed three Core Chrome
import tests with `CHROME_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH`. The failure
occurs before the import effects: `canonical_role_paths` compared a canonical
physical root retaining the Windows verbatim prefix with a Chromium wire path
whose prefix had been removed. `Path::strip_prefix` correctly rejects those
different lexical representations even when they identify the same directory.

The import contract now constructs its physical target through the shared Role
browser-directory helper and validates each component against the physical
canonical root before generating the existing Chromium wire record. It does
not normalize arbitrary paths to bypass containment checks or remove symlink
and intermediate-directory checks. A native filesystem regression covers
canonical-root acceptance and, on Windows, the distinct physical/wire prefixes;
another test confirms that an intermediate ordinary file remains rejected.

The two focused path tests and two existing matching import-contract tests
passed locally. Full macOS Rust tests passed 1,640 tests with four ignored;
Rust formatting and all-target Clippy passed after moving the focused tests to
a feature-specific child module. Windows acceptance remains pending. Evidence:
`/tmp/rion-453-windows-native.log`, `/tmp/rion-import-path-focused.log`,
`/tmp/rion-import-contract-focused.log`, `/tmp/rion-import-path-rust-lint.log`,
`/tmp/rion-import-path-rust-tests.log`. E2E omission is `lower-layer-covered` by
the filesystem and import transaction tests, not a waiver of native Windows CI.

Both shell builds subsequently passed (`/tmp/rion-import-path-build.log` and
`/tmp/rion-import-path-electron-build.log`). The final renderer was restored to
the pure Electron bundle (36 sources, 3,275,470 bytes). Source hygiene, AI context
validation and `git diff --check` passed as well.

### Follow-up native CI: restore visibility and Windows popup close

CI `34007374169` at `e70f47dd` passed shared checks. macOS Chromium job
`101416964234` observed `[ready hidden, ready visible]` on Web-only restart:
readiness and native visibility are separate authoritative events. The evidence
validator now orders activation against the first ready observation, while still
requiring a visible ready terminal and identical tab/window/attempt/native/surface
identities throughout. Paired platform tests reject activation after readiness,
changed identities and histories without visible completion. The downloaded
history validates; a fresh local seed/restart passed in
`.desktop-e2e-artifacts/2026-09-06T03-03-56-589Z-darwin/report.json` (dirty
`fc5affaf`, macOS Chromium profile, both selected phases PASS).

Windows job `101416964239` progressed through main/popup website and Escape
fullscreen exits, then failed selecting a nonexistent popup tab row. A Windows
popup is a standalone Core-admitted window without Game Window tabs. The E2E now
selects its exact published logical window ID before clicking the visible close
control. Source review and the focused regression also identified missing initial
popup chrome publication and incorrect routing of that control to the ordinary
Game Window stop command. The Windows factory now projects the admitted standalone
window with empty tab membership; its close control uses the existing popup
lifecycle observer and waits for the exact native closed event. Core retains
popup terminality. The native window-close event follows the same observer.

The affected automated journey is
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`; its manifest description and
adjacent visible E2E were updated. macOS AppKit close remains covered by
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017` with the same logical popup
identity. The host-factory suite passes 37 tests, including visible-control
admission to the popup observer before any closed receipt. Twelve focused E2E
validation tests passed. Windows native acceptance of these new changes is
pending a new exact-SHA CI run; the earlier failure is not relabeled as success.

The completed local validation for this follow-up is 428 Vitest files / 3,287
tests, typecheck, lint (zero errors; 23 existing warnings), source hygiene,
E2E coverage, AI context validation and the Electron build. The final bundle is
pure Electron (36 sources, 3,275,470 bytes). Logs are
`/tmp/rion-popup-close-full-tests.log`, `/tmp/rion-popup-close-typecheck.log`,
`/tmp/rion-popup-close-lint.log`, `/tmp/rion-popup-close-hygiene.log`,
`/tmp/rion-popup-close-coverage.log`, `/tmp/rion-popup-close-build.log` and
`/tmp/rion-e70-web-only-local.log`. The prior physical-path fix was submitted as
`fc5affaf` to CI `34007906617`; its still-running native jobs remain separate
from the popup/visibility changes recorded here.

### Windows native shortcut helper observation boundary

Run `34008237883` at `1893e7e2` reached Windows Chromium native E2E but job
`101419316990` failed the initial `newGameWindow` OS shortcut before the popup
journey. The PowerShell process reached its existing 30-second deadline and was
terminated, with no stdout/stderr. The final Core journal and SQLite artifact
contain no runtime or saved Game Window, so this run supplies no evidence that
the shortcut's intended action completed. It also cannot establish which helper
stage stalled or assess the popup fix.

Added four fixed diagnostic stage markers around native-input compilation,
exact-window selection and SendInput submission. These are test-helper stderr,
not product performance diagnostics. The original deadline, exact PID/foreground
checks and inserted-input-count requirement remain unchanged; no retry or elapsed
success was added. Nine adjacent tooling tests, typecheck, source hygiene and
diff checks passed. E2E omission for the logging-only change is `internal-only`;
Windows execution of the actual user journeys remains pending.

Evidence: `/tmp/rion-189-windows-package.log`,
`/tmp/rion-189-win-artifacts/2026-09-06T03-10-27-155Z-win32/report.json`,
`/tmp/rion-shortcut-stage-tests.log`, `/tmp/rion-shortcut-stage-typecheck.log` and
`/tmp/rion-shortcut-stage-hygiene.log`. Remaining jobs in that run were left
running; no new workflow was dispatched to supersede their native evidence.

### Exact-candidate macOS compatibility receipts (`1893e7e2`)

Native validation in run `34008237883` uploaded macOS font/input evidence before
finishing its final Tauri build. Bundled Electron 43.4.1 / Chromium
150.0.7871.224 reports 528 faces / 180 families for automatic, shown and reloaded
font enumeration; each denied, subframe, navigated and other-owner sample returns
zero faces. The native comparison contains 3,150 names, 2,970 native-only and no
Chromium-only families. The 16 isolated input samples all report `received`.
The separate Escape fixture again records generic W3C retaining fullscreen and
complete key codes exiting fullscreen. Files are
`/tmp/rion-189-fonts-macos/local-fonts-darwin.json`,
`/tmp/rion-189-input-macos/chromium-input-darwin.json` and
`/tmp/rion-189-input-macos/fullscreen-escape-darwin.json`.

The pinned Electron declaration (`node_modules/electron/electron.d.ts`,
`WebContents.sendInputEvent`) expressly requires the containing BrowserWindow to
be focused. Successful isolated hidden/background samples therefore demonstrate
observed behavior on this build, not a supported background delivery contract.
They do not authorize replacing the unfocused Role lane or retained AppKit input.
Windows probe receipts and the explicit CP-05/07/08 decisions remain outstanding.

### Windows API receipts and full retained-shell evidence (`1893e7e2`)

Windows native job `101419407676` passed Rust formatting/Clippy and the Rust test
step, then completed the Electron compatibility suite. It uploaded 260 font
faces / 89 Chromium families against 154 native names: 66 native-only names and
one Chromium-only family (`Franklin Gothic`). Automatic, shown and reloaded lists
match without user activation, and denied/subframe/navigated/other-owner samples
all return zero faces. All 16 isolated Windows input samples report `received`;
the Escape comparison matches macOS (generic W3C remains fullscreen; complete key
codes exit). Artifacts are under `/tmp/rion-189-fonts-windows` and
`/tmp/rion-189-input-windows`. Full native job acceptance remains separate from
these completed steps.

Both retained Tauri `full` profiles also passed at clean `1893e7e2`, each with
39 PASS journeys and 29 PASS phases plus three expected forced terminations:
`/tmp/rion-189-tauri-windows/2026-09-06T03-10-30-748Z-win32/report.json` and
`/tmp/rion-189-tauri-macos/2026-09-06T03-09-53-105Z-darwin/report.json`.

macOS Chromium passed 36 phases before `chromium-system-settings` failed because
System Events denied osascript assistive access (`-25211`) while cancelling a
native save panel. This is a required native-UI gate, not a font assertion
failure. Evidence is `/tmp/rion-189-macos-package.log` and
`/tmp/rion-189-mac-artifacts/2026-09-06T03-09-51-899Z-darwin/report.json` (the
report records a dirty CI worktree). No permission bypass or weaker cancellation
assertion was introduced.

### CP-05 full font-name comparison follow-up

The family-only Windows difference includes style names such as `Arial Black`.
That alone cannot prove that Chromium lacks the corresponding face. The probe now
records each FontData family, full name, PostScript name and style, and separately
lists native names absent from all three Chromium name fields after Core-compatible
whitespace/case normalization. Denied frames must expose no face metadata. This
avoids deciding against the Chromium provider from a narrower field than the API
actually offers. No product font provider or permission policy was changed.

The expanded macOS native probe passed; this local host's native provider used
its 16-name fallback, so it is not substituted for the hosted Mac native inventory.
Typecheck, lint (zero errors, 23 existing warnings), source hygiene and diff checks
passed. Logs: `/tmp/rion-font-alias-native.log`,
`/tmp/rion-font-alias-typecheck.log`, `/tmp/rion-font-alias-lint.log` and
`/tmp/rion-font-alias-hygiene.log`. The expanded Windows alias comparison remains
pending the next run. This probe-only change is `internal-only` for E2E purposes.

Run `34008237883` subsequently completed: Windows native validation also passed,
including Windows renderer tests and the Tauri build. CP-14 now has both native
validation jobs; CP-03 has both native Rust gates, while its Windows Chromium
journey remains pending. Both Chromium package jobs remain failed for the exact
reasons above; neither API-probe success nor Tauri parity overrides those gates.

### CP-02 remaining Core telemetry retirement

A follow-up source audit found an internal performance telemetry path left behind
after the user-visible diagnostics removal. Every Core startup still created
`TelemetryWorker`, including its periodic wake and sample buffer; the internal
`telemetryRecord` / `telemetrySnapshot` commands and startup output-path option
also remained. No active shell was supplying that path or sending samples.

Removed the worker, startup/shutdown plumbing, effect-result telemetry copies,
both commands, their four retired record/metric types and the unused startup
option across Core, Node-API, Electron and retained Tauri constructors. Binding
removal is generated by Rust's explicit retired-output list. A behavior regression
rejects both retired command names at deserialization. The independent, still-used
Core effect metrics query and retained WebGL policy types remain intact; offline
benchmark readers of existing artifacts do not launch a product telemetry worker.

Full macOS validation passed 1,636 Rust tests (four ignored), 428 Vitest files /
3,287 tests, Rust formatting/Clippy, TypeScript checking, lint, source hygiene,
Tauri build and pure Electron build (36 sources, 3,275,470 bytes). The changed
Rust contracts still require a new Windows native gate. Relevant logs start with
`/tmp/rion-telemetry-`; the removal is `internal-only` for E2E purposes because
there was no remaining renderer control or active bridge caller to exercise.

### Windows visible popup close now reaches authoritative terminality

Run `34009301032` at `881997a6` passed the earlier Windows shortcut helper step
and executed the popup's visible close, then failed the remaining parent-revision
`> 8` assertion with revision 8. Source ownership is the same as for popup open:
popup terminality belongs to the popup lifecycle, and closing it need not advance
the parent's Game Window topology. The E2E now requires non-regression of that
parent revision and directly waits for the exact popup/open-operation
`nativeClosed` receipt, with user close reason, native-destroyed completion scope,
closed lifecycle and applied outcome. Geometry and parent focus checks remain.

The paired journey IDs are
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017` and
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`. Twelve adjacent E2E evidence tests,
typecheck and E2E coverage passed. Fresh native macOS seed/restart passed;
Windows acceptance remains pending. Evidence:
`/tmp/rion-881-windows-package.log`, `/tmp/rion-881-win-artifacts`,
`/tmp/rion-popup-closed-evidence-tests.log` and `/tmp/rion-popup-closed-coverage.log`.

The fresh focused macOS report is
`.desktop-e2e-artifacts/2026-09-06T03-45-35-905Z-darwin/report.json`: dirty
`881997a6`, four selected entity/fullscreen seed/restart phases PASS and seven
journeys PASS. The two new popup terminal assertions execute through visible
AppKit close, followed by the exact Core receipt. Retired command rejection and
Rust binding regeneration also passed after final source formatting. The final
production Electron bundle was restored and source hygiene rechecked; logs are
`/tmp/rion-popup-closed-local.log`, `/tmp/rion-telemetry-retired-test.log`,
`/tmp/rion-telemetry-final-generate.log`,
`/tmp/rion-telemetry-final-electron-build.log` and
`/tmp/rion-telemetry-final-hygiene.log`.

### Role Session native visibility and launch-test terminality

Run `34009301032` at `881997a6` completed both Tauri desktop jobs and Windows
native validation successfully. Windows Chromium failed at the parent popup
revision assertion documented above. macOS Chromium passed 40 phases before
the Role Session restart assertion inspected the second Role while its native
surface was still hidden after Core had reported Running. The shared E2E helper
now observes both visible surfaces in the same native host before inspecting
session identity, generation and isolation. These existing assertions remain.

Fresh macOS `chromium-macos-appkit-smoke` focused seed/restart passed journey
`CHROMIUM-MACOS-APPKIT-ROLE-SESSION-ISOLATION-003` at dirty `c6efac6b`,
03:57:40–03:58:07 UTC, recorded in
`.desktop-e2e-artifacts/2026-09-06T03-57-40-717Z-darwin/report.json`. The paired
Windows journey `CHROMIUM-WINDOWS-ROLE-SESSION-ISOLATION-003` remains pending.
Three adjacent source tests, typecheck, E2E coverage, source hygiene and restored
production Electron build passed; logs use `/tmp/rion-role-visible-`.

The remaining macOS native job's live log identifies
`chromium_browser_workspace_stop_retires_kernel_and_ownership_topology` as
running beyond 60 seconds. Its launch helper previously stopped consuming
effects when invocation admission returned, although launch completion runs
separately. An effect emitted between the old subscription and the subsequent
stop subscription could remain unanswered. The stop topology test now uses the
existing exact-operation `BrowserLaunchCompleted` helper before issuing stop,
preserving all create/destroy and empty-topology assertions for both explicit
platforms. Production event policies are unchanged. This is `internal-only`
test-harness work. The old job is not passing native evidence.

The old macOS native job was explicitly cancelled after identifying that
unanswered-effect race; its terminal log is
`/tmp/rion-881-macos-native-cancelled.log` (the named test exceeded 60 seconds at
03:43:52 UTC). Cancellation is not a passing gate.

### Windows complete Local Font Access name comparison

The successful Windows native job at `881997a6` recorded 260 Chromium faces,
89 families and 154 native names. Comparing `family`, `fullName` and
`postscriptName` covers 49 of the 66 names missing from the family-only list.
Seventeen native names still have no exact normalized match, including the
legacy `Fixedsys`, `System` and `Terminal` names and several truncated
Bahnschrift / Segoe UI Variable names from GDI's fixed-size face-name field.
This establishes a naming compatibility gap, not proof that Chromium cannot
render those fonts. Evidence is
`/tmp/rion-881-fonts-windows/local-fonts-win32.json`. The hosted macOS complete
alias comparison did not run because its preceding Rust gate was cancelled;
CP-05/06 remain open for that result and the explicit provider decision.

The corrected launch/stop harness passed full macOS workspace validation:
1,636 Rust tests, zero failures, four ignored; Rust formatting and Clippy passed.
Documentation, AI context, desktop isolation, E2E coverage, source hygiene and
changed-spec lint also passed. Logs are `/tmp/rion-stop-terminal-tests.log`,
`/tmp/rion-stop-terminal-lint.log` and adjacent `rion-stop-terminal-*` logs.
The new Windows Rust and both complete Chromium profiles remain pending the
next exact-commit CI run; previous failures are not reclassified as passes.

Fresh CI run [34010684582](https://github.com/rion-tw/rion-studio-source/actions/runs/34010684582)
is validating exact commit `8f474391b51c3e8d3b453754582f6084366dd31a`, including
the telemetry removal and both E2E corrections. Its seven initial jobs started;
none is yet passing evidence. A preceding dispatch (`34010670635`) used a
mistyped checkout ref and was promptly cancelled and replaced; it provides no
validation evidence. The pure Electron production renderer is restored locally.

### CP-08 replacement decision: retain native submission

The pinned Electron 43.4.1 declaration at
`node_modules/electron/electron.d.ts` documents that the containing BrowserWindow
must be focused for `WebContents.sendInputEvent()` to work. Both isolated native
probe reports at `1893e7e2` nevertheless observed all 16 samples, including hidden
views, background hosts, hidden hosts, modifiers, middle clicks at two zoom
factors and held-key/reload sequences. These observations are useful regression
evidence but cannot expand the API's supported focus contract. They also do not
claim exact production Role identity or native-neutrality proof.

Decision: retain Windows native submission and the explicitly required AppKit
trusted-input adapter. Background Role execution must not acquire focus. A
foreground-only `sendInputEvent()` path would leave the complete native lane
necessary for background execution and would introduce a second submission
owner across focus changes and held-key release. There is no demonstrated
maintenance reduction or equivalent cross-owner cleanup protocol to justify
that partial replacement. This is a compatibility decision based on the
pinned API contract, not a claim that the successful hidden probes failed.

The common Core input epoch, Role/document fence, automatic-input preflight,
pending sequence, authenticated DOM decoder, cancellation and retirement remain
shared under CP-09. Native dispatch still requires exact child/parent identity,
binding revision, native submission and the complete trusted DOM sequence;
neither elapsed time nor an Electron void return becomes success. The existing
Windows adapter tests explicitly cover hidden delivery without changing the
foreground owner, obsolete binding/probe revision, lost focus evidence and
untrusted input. Coordinator tests cover held-key document replacement and
exact-generation recovery. Full current-commit native Macro/reload acceptance
is still required in the paired Chromium profiles. CP-08's replacement decision
is now settled; its acceptance is not inferred from this source audit.

CP-08/09's seven focused coordinator, runtime, adapter, pending-lane and preload
suites passed 89 tests on macOS (`/tmp/rion-cp08-retained-input-tests.log`).
This lower-layer evidence validates retained receipt and lifetime invariants;
it is not Windows native input or a replacement Role probe. Documentation, AI
context and source hygiene checks also passed. No product behavior changed.

### CP-07 native F11 comparison harness

Added a Windows-only bundled-Electron probe comparing the retained native hook,
a captured-key-up `before-input-event` candidate, and a registered Menu F11
accelerator. A persistent PowerShell test driver validates the exact HWND/PID
and foreground owner before inserting native scan-code input. Four isolated
surfaces (main, Role-like view, Global-Web-like view and popup) each receive
plain, repeated-down and modifier-during-press sequences in all three modes:
36 observations. Reports record commands before release, native/pre-input event
stages and trusted page events. The native-hook baseline requires one terminal
command and no observed page delivery; API candidates report differences.

This is an isolated compatibility probe, not production Role/window parity.
The 150 ms test observation boundary does not establish indefinite suppression.
Hidden/focus-transfer/registration-retirement coverage and the production
replacement decision remain open. Production input ownership is unchanged.
The native integration runner discovers the new Windows-only test and uploads
its report through the existing Chromium input evidence directory; macOS
explicitly skips it. E2E classification: `internal-only`.

Syntax, TypeScript, lint, migration-boundary validation and eight boundary tests
passed locally (`/tmp/rion-cp07-*`). macOS test selection reported one skip,
not a native F11 pass. Windows execution awaits the next source push after
current CI terminality.

### Current Windows fullscreen E2E navigation-driver boundary

At `8f474391`, Windows Chromium run `34010684582` passed seven phases / nine
journeys before failing the pending-popup parent-close portion of
WORKSPACE-WEB-FULLSCREEN-017. The prior visible popup close and its exact
user/nativeDestroyed receipt passed. With the second popup's navigation
deliberately gated, `windowsRuntimeHostHandle` times out enumerating WebDriver
window handles before it can click the parent tab close control. macOS already
uses pre-read native close evidence for this scenario. Windows needs an exact
visible close action that does not enumerate the pending browser targets;
releasing the network gate before close would invalidate this journey.
Evidence: `/tmp/rion-8f-windows-package.log` and
`/tmp/rion-8f-win-artifacts/2026-09-06T04-08-47-938Z-win32/report.json`.
Other jobs remain live; macOS native Rust has passed and entered API probes.

### Windows pending-popup close now uses captured native accessibility identity

The fullscreen journey now reads the exact tab/window DOM identity and visible
close button name before gating popup navigation, then binds that name to one
unique native UI Automation control under the exact app PID. It captures the
parent HWND and revalidates that HWND, PID, visibility and unique enabled control
before invoking the visible button. No WebDriver target enumeration occurs in
the pending-navigation close action. The fixture additionally requires the
gated request's transport-cancelled event before the exact popup terminal
receipt. The network gate is not released to make the click possible.

Seventeen focused helper and adjacent E2E evidence tests passed, as did
typecheck, changed-file lint, source hygiene, E2E coverage and desktop isolation.
Fresh local macOS `chromium-macos-appkit-smoke` entity/fullscreen seed/restart
passed at dirty `6a9e9163`; evidence is
`.desktop-e2e-artifacts/2026-09-06T04-24-41-863Z-darwin/report.json`. The pure
Electron renderer was restored (36 sources, 3,275,470 bytes). Logs use
`/tmp/rion-win-pending-close-*`. The affected paired journey is
WORKSPACE-WEB-FULLSCREEN-017; Windows native execution remains pending.

### CP-05 complete native font reports and compatibility interpretation

The `8f474391` macOS native job passed and uploaded its complete font report:
528 Chromium faces / 180 families versus 3,150 normalized native names. Comparing
family, fullName and PostScript name leaves 2,485 native names unmatched. All
but six are dot-prefixed internal names or font filenames ending in .ttc, .ttf,
.otf or .dfont. The six remaining names are AquaKana, AquaKana-Bold, HelveLTMM,
HelveticaLTMM, LastResort and TimesLTMM. The report includes public PingFang
HK/MO/SC/TC, Hiragino and Songti families. Windows includes Microsoft JhengHei
and Microsoft YaHei (and their UI families); 17 native names remain unmatched.

Both platforms pass automatic enumeration without transient activation, reload
and shown-window consistency; denied, subframe, navigated and other-owner
queries return no families. Reports are
`/tmp/rion-8f-fonts-macos/local-fonts-darwin.json` and
`/tmp/rion-8f-fonts-windows/local-fonts-win32.json`. A native-name count is not
a count of CSS-selectable families or evidence of missing Chromium rendering.
The renderer's `getBrowserSystemFontOptions` already merges persisted selected
family names with enumeration and generic families, so changing enumeration
does not inherently delete an existing selection. CP-05/06 must assess that
actual settings behavior rather than retaining filename/internal-name pollution
solely to reproduce the old native inventory. No provider has changed yet.

Run `34010684582` now has both complete Tauri desktop profiles and macOS native
validation passing. Windows Rust also passed and its job reached renderer tests.
Windows Chromium remains failed as documented; macOS Chromium and Windows
full native-job terminality are still pending.

### CP-05 adoption decision and saved-selection behavior

Decision: adopt Chromium's canonical local font families for the v23 provider.
Both native reports prove automatic trusted-owner enumeration, installed CJK
families, stable reload/shown results and denial outside the exact trusted
main frame. The old provider's extra filenames, internal names and truncated
GDI aliases are not an inventory of missing Chromium font families. Reproducing
that pollution would retain platform maintenance without proving better CSS
font compatibility. This decision does not assert that every legacy alias is
renderable or that the operating systems have identical installed fonts.

Fresh renderer behavior tests for explicit darwin/AquaKana and win32/Fixedsys
cases passed: with a provider containing only Arial, the persisted legacy
selection remains displayed, checked and selectable, and is not rewritten.
All 17 browser-font settings tests passed (`/tmp/rion-cp05-saved-font-tests.log`).
The existing generic choices and selected-name merge remain mandatory.

CP-06 will keep the typed listSystemFonts Promise, Rust normalization, bounded
cache and fallback; only the v23 enumeration source changes to the authenticated
app frame's queryLocalFonts. Remote Role/global Web sessions must remain denied.
The retained v22 provider stays reachable until CP-17. Production permission
and provider code have not changed yet, so CP-06 and paired FONT-APPLICATION-033
acceptance are still open. This test-only decision work is `internal-only`.

At `8f474391`, both native validation jobs and both Tauri full desktop jobs are
now terminal success. macOS Chromium completed its source desktop E2E step and
is building release artifacts; its package/updater/black-box gate remains live.
The Windows Chromium failure remains unchanged. Newer local changes still need
their own Windows validation.

### CP-06 Chromium family provider implemented

The typed listSystemFonts bridge now obtains the v23 family inventory from
`chromiumSystemFonts.ts` in the authenticated app WebContents/main document.
Only local-fonts permission for that exact owner and application document is
admitted; other permissions remain denied. The provider fences document
replacement, navigation and renderer loss and refuses stale completion. Native
query rejection or malformed results produce an empty inventory for Rust's
existing fallback; a retired document is an error and cannot populate the cache.

Core's systemFontsList accepts an optional shell inventory. Runtime v23 uses
that inventory (or fallback) and never calls platform font enumeration. v22
continues calling its native provider and ignores Chromium-supplied names.
Rust owns normalization, case-insensitive deduplication, sorting and the cached
result, capped at 4,096 input names. Saved selections and generic choices stay
in the renderer's existing merge; no persisted preference is rewritten.

The native font probe now compiles and exercises the actual production provider
and v23 Core. The already-completed CP-05 native baseline reports remain the
comparison evidence; the Node factory's strict v23 requirement is preserved.
New macOS evidence at `/tmp/rion-cp06-fonts-macos/local-fonts-darwin.json` contains
251 canonical production families and verifies reload, exact-owner/subframe
denial, denied-query fallback input and foreign-navigation rejection.

Validation passed: 430 Vitest files / 3,308 tests; 1,639 Rust tests, zero failures,
four ignored; Rust formatting/Clippy; typecheck; lint (zero errors and 23 existing
warnings); source hygiene; E2E coverage and desktop isolation; Tauri build and
restored pure Electron build. Logs use `/tmp/rion-cp06-*`.

Fresh macOS `chromium-macos-appkit-smoke` settings phase passed at dirty
`559a0af3`, 04:43:11–04:43:40 UTC:
`.desktop-e2e-artifacts/2026-09-06T04-43-11-553Z-darwin/report.json`. Journeys
SYSTEM-SETTINGS-013, DIAGNOSTICS-EXPORT-029 and FONT-APPLICATION-033 passed.
FONT-APPLICATION-033 now requires an installed family outside Rust fallback
(Hiragino Sans on macOS, Segoe UI on Windows), excludes font filenames, and
retains visible Courier New/generic apply, cancel and reset assertions against
live Role font loading and Canvas metrics. The manifest describes this coverage.
Windows native validation of the changed contract/provider and its paired
FONT-APPLICATION-033 remain pending; earlier native runs do not close them.

### Exact-commit CI and macOS offline updater toolchain homes

Fresh run [34012430832](https://github.com/rion-tw/rion-studio-source/actions/runs/34012430832)
validates exact commit `2420e72aa4a26400b06dd371fb2a571788e186f8`, including
Chromium font enumeration, Windows pending-popup native close and the F11 probe.
The workflow concurrency key includes the explicit input SHA, so this run did
not cancel the earlier exact-commit run.

Run `34010684582` at `8f474391` is fully terminal. Both native validation jobs,
both Tauri full jobs, shared checks, renderer and Linux validation passed.
macOS Chromium source E2E passed 52 phases / 49 journeys plus four expected
force-termination phases, recorded in
`/tmp/rion-8f-mac-artifacts/2026-09-06T04-08-18-621Z-darwin/report.json`. Its
release artifacts and previous-version fixtures built, then the packaged updater
probe failed before executing a Rust test: isolated HOME redirected Cargo's
default cache and rustup home, and offline resolution could not find package cc.
Evidence: `/tmp/rion-8f-macos-package.log`. This is not a packaged updater pass.

The macOS transaction harness now pins inherited CARGO_HOME/RUSTUP_HOME or
their original-home defaults before switching HOME/CFFIXED_USER_HOME to the
private runtime profile. The existing runtime environment allowlist already
permits those explicit toolchain paths; private updater signing variables remain
stripped. Windows profile handling and the --locked/--offline Cargo command are
unchanged. No signing, sandbox or publication gate is weakened.

Seventeen focused environment/fixture/sandbox tests, typecheck, lint and source
hygiene passed. A real local macOS `cargo test --locked --offline -p rion-updater
--lib --no-run` with isolated HOME and the pinned toolchain homes built the native
probe successfully (`/tmp/rion-updater-cache-offline-build.log`). This verifies
offline compilation, not the full packaged updater transaction. Additional logs
use `/tmp/rion-updater-cache-*`. This tooling change is `internal-only` for E2E;
the native package gate remains pending a run containing the correction.

### Windows pending-popup close: asynchronous Core command routing

Run `34012430832` reached the visible native parent-tab close in the Windows
Chromium fullscreen seed phase. Core's flow journal recorded `embeddedTabStop`
as started, then rejected it with "asynchronous browser intent reached the
synchronous core dispatcher". The UI Automation action arrived; no popup close
receipt followed because the command never reached its asynchronous handler.
Evidence is `/tmp/rion-2420-windows-package.log` and
`/tmp/rion-2420-win-artifacts/2026-09-06T04-51-03-534Z-win32/`.

`CoreCommand::requires_async_dispatch` now includes `EmbeddedTabStop`, matching
the existing async-only handler. A serialized Node-API command regression checks
the classification, and a real native addon integration test closes a retired
tab through the public invoke boundary and observes the idempotent empty
topology. The exact popup cancellation and native-close E2E assertions remain.

Local macOS validation passed: 1,640 Rust tests, zero failures and four ignored;
Rust formatting/Clippy; six real native Core startup integration tests;
typecheck, lint, source hygiene, E2E coverage, and the pure Electron production
build. Logs use `/tmp/rion-tab-stop-*`. The affected paired journey is
WORKSPACE-WEB-FULLSCREEN-017. Windows native and full Chromium confirmation of
this routing correction remain pending a new exact-commit run. The current run
has passed both Tauri full jobs and macOS native validation, but predates this
correction and the isolated updater toolchain-home fix.

Windows native validation subsequently completed its Rust checks and passed
eight native integration tests, including production Chromium font enumeration.
The font report contains 89 canonical families; reload preserves the inventory,
foreign owners/subframes receive no fonts, permission denial returns an empty
inventory, and navigation retires the provider. Evidence:
`/tmp/rion-2420-win-fonts/local-fonts-win32.json`. CP-06's native provider is now
verified on both systems; Windows FONT-APPLICATION-033 remains pending because
the full Chromium profile stopped earlier at tab close.

The new F11 probe failed before collecting its matrix: Windows PowerShell does
not resolve the `[ushort]` alias used by its test driver. The driver now uses
`[System.UInt16]`, matching the C# method argument without changing any input
semantics or assertions. This fixture-only correction is `internal-only`; its
Windows execution and all CP-07 comparison outcomes remain pending. The other
native test successes do not turn the failed native job into a pass.

### Refreshed macOS Chromium evidence and corrective CI

The downloaded macOS report from run `34012430832`, source `2420e72a`, records
52 passing phases, four expected force-termination phases and all 49 journeys
passing under `chromium-macos-appkit-smoke`. It ran from 04:49:40 to 05:09:20
UTC on 2026-09-06. The report's `worktreeDirty` flag is true; this is source E2E
evidence and must not be presented as a clean packaged production candidate.
Local evidence:
`/tmp/rion-2420-mac-artifacts/2026-09-06T04-49-39-946Z-darwin/report.json`.
The full run includes the updated SYSTEM-SETTINGS-013 and FONT-APPLICATION-033
journeys, extending the earlier isolated macOS settings evidence. Packaging
and updater transaction outcomes remain separate gates.

Corrective run
[34013275719](https://github.com/rion-tw/rion-studio-source/actions/runs/34013275719)
validates exact source `b22dd888d4e6afb7ac930446c6041057803a852a`: asynchronous
tab-close dispatch, the PowerShell F11 input-driver type correction and isolated
updater toolchain homes. Its renderer build passed and both native, desktop E2E
and Chromium package jobs are active. No pending Windows or release item is
closed merely because this new run started.

### CP-07 lifecycle comparison coverage

The isolated F11 probe now adds 36 lifecycle observations to the original 36
key-cycle observations: each of the four surfaces and three mechanisms is
exercised with focus transfer before release, hidden original owner before
release, and registration retirement before release. Native ownership is freshly
registered for each case; the Chromium candidate resets captured state on
retirement, and the Menu candidate removes its registration. Every physical
input insertion still validates the exact foreground HWND and process.

For focus transfer and hiding, the report retains the destination page's trusted
events and the original owner's event sequence, then returns focus and submits
an otherwise uncaptured key-up to expose any stale captured-down state. These
are observations, not assertions that existing native behavior is equivalent
or correct under a different owner. The bounded observation window does not
prove indefinite absence. No production shortcut behavior changes.

Node syntax, typecheck, lint (zero errors, 23 existing warnings), source hygiene
and diff checks passed. The Windows-only native test is explicitly skipped on
macOS (`/tmp/rion-f11-lifecycle-native.log`); the extended matrix still requires
Windows execution and is not part of run `34013275719`. This probe-only change
is `internal-only` for E2E and does not close CP-07.

Each native probe registration now receives a distinct monotonic owner revision.
The callback captures that exact revision for acknowledgement, and both the
outcome and command event record it. The native test rejects command events
whose revision differs from their scenario. Reusing a revision after unregister
could otherwise misattribute a late callback to the next observation; the probe
must not hide that ownership distinction. This changes only test instrumentation.

### Windows completed popup actions and parent-revision evidence correction

Run `34013275719` at `b22dd888` completed the Windows fullscreen seed's visible
actions, including parent-tab close and pending-popup cancellation. The post-run
validator then rejected its evidence because it required the parent window's
topology revision to increase when opening and closing an independently owned
popup. All 14 observations retain parent revision 8, exact host, bounds and slot
identities; popup revision 1 is independently recorded. Parent focus returns
after popup closure. The Core journal contains both exact operation sequences:
nativeReady/pageReady/closeRequested/nativeClosed for user close, followed by
nativeReady/closeRequested/nativeClosed with parentRetired/nativeDestroyed for
the gated popup. The asynchronous tab-close dispatch correction is therefore
observed working in this Windows phase; the overall job still failed.

Evidence is `/tmp/rion-b22-windows-package.log` and
`/tmp/rion-b22-win-artifacts/2026-09-06T05-11-10-610Z-win32/phases/chromium-workspace-web-fullscreen-seed/`.
The validator now accepts non-decreasing parent revisions across independent
popup lifecycles. It retains invariant host/layout/focus checks, exact popup
identity and revision, ordered lifecycle receipts and native-destruction
terminality. Seven focused tests cover unchanged and advancing parent revisions,
backward/missing revisions and forged terminality. Replaying the raw Windows
report locally passes the corrected topology and lifecycle checks and reaches
the native upload path check, which correctly differs after downloading Windows
artifacts to a macOS path. This replay is not a Windows E2E pass; a new native
run remains required for WORKSPACE-WEB-FULLSCREEN-017 and POPUP-012.

A second replay copied the downloaded phase to a separate temporary directory
and changed only the upload fixture's recorded path to its relocated local path.
The complete runtime validator then passed: four contained-fullscreen
transitions, exact popup parent retirement, geolocation/download denial and
native file-upload bytes/hash evidence. The original downloaded artifacts were
not modified. `/tmp/rion-b22-popup-validator-replay.json` records both paths,
scope and result. This verifies the full corrected validator against the captured
Windows seed evidence; it does not claim a new Windows run or restart pass.

### First Windows F11 results and stable-shell pointer evidence

Run `34013275719` passed its Windows native Electron probe step. The 36-case
F11 report is `/tmp/rion-b22-win-input/chromium-shortcuts-win32.json`. All 12
native-hook cases emitted once after release and observed no page F11 events.
The captured-key-up before-input candidate emitted no command in the eight
plain/repeat cases across all four surfaces: the bounded sample contains downs
but no key-up callback. Its modifier cases emitted once. Menu emitted before
release, repeated commands in repeat cases, and exposed two or three trusted
page events. These observations do not establish equivalent replacement
semantics. The additional lifecycle matrix is running at source `11369bb7` in
run `34013552237`; CP-07 remains open until those results are assessed.

The same run's stable Windows full E2E failed in
`p1-cross-domain-topology-force`: the minimize control rectangle cache was empty.
The initialization script publishes on DOMContentLoaded, but the native message
handler is registered only after child WebView creation, so that publication
can precede the receiver. Evidence: `/tmp/rion-b22-win-tauri.log` and downloaded
`/tmp/rion-b22-win-tauri-artifacts/2026-09-06T05-11-28-094Z-win32/`.

The test-only minimize locator now uses the existing exact WebView2 element
rectangle callback used by tab pointer targeting. It reads the visible button
on demand, converts through the exact controller/HWND/DPI path, and preserves
the real SendInput action and pointer terminal receipt. The redundant startup
rectangle cache, publication and conversion implementation were removed. No
polling, delay or debug minimize command was added. macOS Rust formatting/Clippy
and all 1,640 tests passed (zero failures, four ignored), as did source hygiene
and diff checks. Logs use `/tmp/rion-win-minimize-*`. This is `internal-only`
E2E instrumentation; the stable Windows cross-domain profile must still rerun.

### AppKit layout projection supersession during role launch

macOS run `34013275719` failed in `chromium-tabs-visible-seed` with an AppKit
projection error. Core flow entries 287–300 show layout event adapter sequence
3 and topology revision 11, then role ownership completion before its projection
effect executes. The terminal receipt reports current revision 13. Evidence:
`/tmp/rion-b22-mac-package.log` and
`/tmp/rion-b22-mac-artifacts/2026-09-06T05-10-26-320Z-darwin/phases/chromium-tabs-visible-seed/electron-core-flow-observations.json`.

Electron now distinguishes a strictly older topology revision on an otherwise
exact live AppKit host from invalid identity/generation/adapter-sequence errors.
Core uses its existing Superseded terminal status only for a non-committing
Layout event when its own snapshot independently proves the projected windows
remain in the same generation, none regressed, and at least one advanced.
Native application stays false. Other errors retain failure/degraded behavior;
no stale projection is applied and no timer or retry is added. Projection
completion moved to `section_16_appkit_projection.rs` to preserve source limits.

Eleven focused TypeScript tests and the Rust same-generation supersession
regression passed. The latter exercises unchanged Core revisions, advancing
same-generation state and replaced generations through the real effect-result
boundary. Full macOS Rust validation passed 1,641 tests, zero failures and four
ignored; formatting/Clippy, typecheck, lint, source hygiene, E2E coverage and
Electron production build passed. Logs use `/tmp/rion-appkit-supersede-*`.
Actual macOS TABS-VISIBLE-ACTIVATION-019 / GAME-WINDOWS-TABS-020 and Windows
validation remain required; passing unit evidence does not close those gates.

### Extended Windows F11 matrix received

Run `34013552237` passed the native probe step and uploaded all 72 observations
at `/tmp/rion-113-win-input/chromium-shortcuts-win32.json`. In all four surfaces,
focus transfer/hiding yields no native command at release on the other host,
but one command after returning and sending an additional otherwise uncaptured
key-up. Registration retirement yields no subsequent native command. The
before-input candidate yields no command in those lifecycle cases; Menu already
emits at key-down before the transition. These results reject direct candidate
equivalence and expose retained native captured-down state across focus changes.
CP-07 remains open for that focus-boundary correction and confirmation; the
probe pass is not a production replacement approval.

### F11 deactivation cancels the exact held capture

The retained Win32 window subclass now clears its owner's captured F11-down
state on `WM_ACTIVATE` / `WA_INACTIVE`. This is the authoritative top-level
window deactivation event ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-activate));
focus movement between child Chromium surfaces does not itself retire the owner.
The hook still waits for key-up for an uninterrupted chord and does not send
commands from cancellation. No foreground polling or globalShortcut was added.

The 36 native lifecycle observations now assert zero commands across focus
transfer, hiding and registration retirement, including the extra key-up after
return. The APPLICATION-SHORTCUTS-030 manifest notes this adjacent native-addon
coverage. Its E2E scope exception is `lower-layer-covered`: the physical HWND
driver and real addon directly cover capture lifetime without substituting a
debug fullscreen command. The changed Windows assertions have not run yet;
CP-07 remains pending native confirmation. Local macOS Rust lint/tests,
typecheck, lint, source hygiene and E2E coverage passed; logs use
`/tmp/rion-f11-deactivation-*`. macOS is not Windows event-reachability evidence.

Run `34014080241` at `8c0ba441` progressed past Windows popup verification but
failed later in `chromium-workspace-web-only-seed`; its stable Windows full
profile progressed past the minimize-cache failure but failed in
`p1-macro-multirole`. Evidence is `/tmp/rion-8c0-win-package.log`,
`/tmp/rion-8c0-win-tauri.log` and `/tmp/rion-8c0-win-artifacts/`. These later
failures remain to diagnose and are not successful whole-profile results.

### Single-slot Windows workspace projection and Core boundary validation

The Windows Web-only seed failure at `8c0ba441` is an actual projection rejection,
not a missing fixture acknowledgement: Core flow entries 69–77 show
ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INVALID. The Windows validator
required two workspace slots although the authoritative single-layout projection
contains one valid Web slot. It now accepts one or more slots and still rejects
empty/duplicate slot lists, missing owners and inconsistent live surface scope.
The new test applies a single Web-only slot with no Role owners and verifies
empty-list rejection. Eight Windows projection tests passed; the existing
WORKSPACE-WEB-ONLY-024 native seed/restart journey remains the acceptance gate.

Run `34014711183` at `0784927d` stopped affected jobs at the migration-boundary
check: the newly extracted Core projection module and its regression used an
Electron-prefixed error name. That cross-shell discriminator is now
MACOS_APPKIT_CHROMIUM_PROJECTION_SUPERSEDED in the producer, Core consumer and
tests. No boundary allowlist was widened. The exact migration-boundary checker
passes, as do all 19 paired AppKit/Windows projection tests and the focused Rust
supersession test. Logs: `/tmp/rion-078-checks.log`, `/tmp/rion-single-slot-*`,
`/tmp/rion-appkit-neutral-code-*`. Neither correction is validated by the
pre-correction CI run; a fresh native run remains required.

### Local AppKit projection regression and Windows macro investigation

At clean source `edc757d0`, the local macOS `chromium-tabs-visible-seed` phase
passed from 05:54:02 to 05:55:05 UTC on 2026-09-06. Report:
`.desktop-e2e-artifacts/2026-09-06T05-54-02-175Z-darwin/report.json`;
log `/tmp/rion-edc-appkit-tabs-e2e.log`. This exercises the previously failing
AppKit tab sequence with the supersession correction. It is one passing phase;
the four paired tab journeys remain NOT_RUN in this report because restart was
not included. A separate restart-focused invocation, including its seed
dependency, is running with log `/tmp/rion-edc-appkit-tabs-restart-e2e.log`.

Fresh CI [34014912798](https://github.com/rion-tw/rion-studio-source/actions/runs/34014912798)
validates exact `edc757d0c9fb4de80852b5bbf66ae0d61ca2e2fe` and has progressed
past the earlier migration-boundary failure. Native outcomes remain pending.

The stable Windows `p1-macro-multirole` failure is narrowed to creation and first
trigger of the held-key continuity macro: native events 130–137 submit real
Shift+Digit6, the correct target page records that chord, but no Digit2 macro
consumer key-down follows. No managed-shortcut receipt appears in that segment.
The source path is StateChanged -> OverlayRefreshRuntime -> OverlayChanged ->
Tauri refresh_macro_overlays -> page list/applyState. The current artifact lacks
an exact page configuration-application receipt tying the new macro to that
physical press, so a missed refresh remains a hypothesis, not a proven cause.
Evidence: `/tmp/rion-8c0-win-tauri-artifacts/2026-09-06T05-30-37-422Z-win32/user-data/p1-macro-multirole/desktop-e2e/events.ndjson`
and `/tmp/rion-8c0-win-tauri.log`. No delay or bypass was introduced to hide it.

The local paired AppKit run subsequently passed both seed and restart at clean
`edc757d0`, 05:55:47–05:57:05 UTC. Report:
`.desktop-e2e-artifacts/2026-09-06T05-55-47-538Z-darwin/report.json`.
TABS-VISIBLE-ACTIVATION-019, GAME-WINDOWS-TABS-020,
RUNTIME-LAUNCH-DESTINATIONS-008 and RUNTIME-TAB-TOPOLOGY-009 all report PASS
for the macOS Chromium profile. This closes the focused macOS regression
verification of the layout-supersession correction, not the remaining whole
profile, Windows, hardware or packaged-release gates.

### Windows gated Web-only observation and paired local regression

CI 34014912798 at exact `edc757d0` passes the single-slot projection and starts
its Web surface. During the deliberate navigation gate, Core completes both
runtime snapshot queries, but the WebDriver command waits for Puppeteer's
attachment to that gated target. It returns only when the existing load deadline
retires the surface; the fixture records transport cancellation before the test
releases the gate. This is a test observation deadlock, not evidence that the
Core snapshot query stalled. Evidence: `/tmp/rion-edc-win-package.log` and
`/tmp/rion-edc-win-artifacts/2026-09-06T05-50-23-907Z-win32/`.

The Windows test now reads the visible loading indicator beside the exact named
tab close button through native UI Automation, restricted to the previously
observed Electron process. It releases the fixture gate in `finally` before any
WebDriver snapshot, then binds the same native host to the exact Core Workspace
tab and verifies empty Role topology. The primary launch remains visible UI;
no product deadline, synthetic loading state, retry or polling was added.
Affected journeys: CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 and its paired
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024 regression.

Validation on local macOS: 15 adjacent evidence tests and all 3,322 Vitest tests
pass; typecheck, lint (23 existing warnings), source hygiene, coverage and desktop
E2E isolation pass. The macOS seed/restart pair passes at `7b47bfc4` plus this
working diff, 06:07:29–06:07:55 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-07-29-912Z-darwin/report.json`.
This is a dirty-worktree focused report, not an exact committed full-profile
verdict. Logs: `/tmp/rion-web-loading-*`. Windows UIA execution remains pending
fresh CI. Existing `edc757d0` CI has now passed macOS native validation and the
macOS Tauri full profile; its Windows Tauri full profile reproduces the separate
held-key macro failure. Those older results do not validate this test correction.


### CP-07 retained-adapter decision verified on Windows

The exact `edc757d0` Windows input artifact from CI 34014912798 contains all 72
observations on Electron 43.4.1 / Chromium 150.0.7871.224:
`chromium-input-windows-latest-34014912798-1`, artifact ID 9983820249;
local copy `/tmp/rion-edc-win-input/chromium-shortcuts-win32.json`.
Across main, Role-like view, global-Web-like view and popup, the native hook's
12 plain/repeat/modifier-change cases each emit exactly one owner-revision-bound
command after release and no page F11 events. Its 12 focus-transfer, hidden-owner
and retired-owner cases now emit zero commands, including an uncaptured key-up
after returning to the original host. This confirms the WM_ACTIVATE capture
cancellation correction; the prior stale-capture reproduction is absent in all
four host types.

The replacement candidates remain incompatible: before-input-event emits zero
commands in all eight plain/repeat cases and one in the four modifier-change
cases; Menu emits before release in all 12 cases, repeats in the four repeat
cases and delivers two or three page events. All 12 Menu lifecycle cases have
already emitted before the ownership transition. CP-07 therefore closes its
API-selection work as **retain the narrow native hook**, based on observed
terminality and suppression differences, not a preference for duplicated OS
code. Shared command routing stays centralized. The probe uses isolated real
native hosts; it does not establish complete production Role parity. Windows
product journey APPLICATION-SHORTCUTS-030 and the complete profile remain under
CP-15/18. No globalShortcut fallback is introduced.

The same CI's macOS Chromium report now records 52 passing phases, four expected
forced-termination phases and all 49 journeys PASS, 05:49:59–06:09:03 UTC on 2026-09-06. Artifact:
`chromium-shell-e2e-macOS-34014912798-1`, ID 9983826074; local report
`/tmp/rion-edc-mac-artifacts/2026-09-06T05-49-59-279Z-darwin/report.json`.
It identifies source `edc757d0` and reports `worktreeDirty: true`, so this is the
CI-built profile result, not a claim of a clean production package. Native
release packaging/updater validation is still running.

The gated Web-only UIA correction is committed as `2aed96909126d603c4f3eb62f2cfb3e58d3283e5`.
Fresh paired CI [34015776112](https://github.com/rion-tw/rion-studio-source/actions/runs/34015776112)
is running on that exact source. Its Windows loading-control result remains
pending; older runs do not validate this correction.

### Native Windows updater-tooling portability regression

The `edc757d0` Windows native job finishes with the F11 comparison test passing
and all 10 native integration tests passing, then fails two renderer/tooling
assertions in `electron-updater-toolchain-home.test.ts`. The macOS-only cache
helper used host-default `node:path.join`, producing Windows separators for
macOS fixture homes when tested on Windows. This does not invalidate the
completed F11 evidence; it leaves the whole native job failed.
Log: `/tmp/rion-edc-win-native.log`.

The helper now uses explicit `path.posix.isAbsolute/join` for macOS source homes.
Explicit cache overrides remain unchanged. Focused tests also reject drive and
backslash-rooted Windows source homes. Local macOS validation passes 27 adjacent
release/tooling tests, all 3,324 Vitest tests, lint (23 existing warnings), complete
source/dependency hygiene and the normal build. Pure Electron output is restored
separately after the build. This is `internal-only` E2E work: it fixes the probe
build environment, with no product journey or updater trust-policy change.
Fresh Windows tooling execution remains pending; CI 34015776112 predates this
correction. Logs: `/tmp/rion-updater-posix-*`.

### Windows loading-control native tree scope

CI 34015776112 at `2aed9690` now exits the gated Web-only observation in roughly
14 seconds, before the product load deadline, but UIA does not find the required
unique loading/close pair beneath the assumed immediate raw parent. The previous
WebDriver deadlock no longer determines this result. Log:
`/tmp/rion-2aed-win-package.log`; Windows job 101439155517. The same run passes
both Workspace Web fullscreen/popup seed and restart phases before this failure.

A local pinned-Chromium Accessibility.getFullAXTree experiment includes the
named loading status inside the activation button; it does not prove the
Windows UIA parent shape. The read-only helper now scopes both uniquely named
visible controls to the exact process-owned native window, rather than assuming
an immediate raw parent representation. It still requires exactly one matching
window, one close control and one loading control, and binds the captured handle
to the Core Workspace tab after gate release. Failure now includes per-window
close/loading/total-loading match counts. No renderer behavior or acceptance
outcome was weakened. The exact Windows tree behavior remains pending execution.
Local evidence: `/tmp/rion-loading-ax-probe.log`, `/tmp/rion-loading-scope-*`;
15 focused helper tests, typecheck, lint, source hygiene and coverage pass.
The E2E requirement remains CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024.

### Immediate shortcut configuration and native-accessible loading state

The Windows `8c0ba441` multirole artifact timestamps the held-key macro creation
at 05:38:05.673 UTC and physical Digit6 submission at 05:38:05.753 UTC. The
shared overlay worker coalesced StateChanged together with badge/status changes
for up to 250 ms. Configuration now bypasses that presentation coalescing on its
exact StateChanged event; status-only changes retain the existing rate limit.
The native page refresh is still asynchronous, so the Windows product outcome
must be verified rather than inferred from this scheduling correction.

A real worker test establishes an active 60-second presentation interval, sends
a configuration event and receives the immediate authoritative refresh. Existing
status-burst coalescing tests also pass. Local macOS `lint:rust` and `test:rust`
pass (1,642 passed, 4 existing ignored). The unchanged physical trigger sequence
in MACRO-MULTIROLE-005 passes locally at `d7a0f8f3` plus this working diff,
06:26:34–06:28:11 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-26-34-634Z-darwin/report.json`.
This focused Tauri result is not Chromium or Windows parity. No test settling
delay, retry or earlier macro creation replaces the first physical press.
Logs: `/tmp/rion-macro-urgent-*`.

CI 34016211814's Windows loading diagnostic finds one visible close button but
zero loading candidates in the entire exact native host. The immediate-parent
hypothesis is therefore insufficient. The Windows observation does not find the named nested status
seen in the local Chromium accessibility experiment; it does not by itself prove
why the platform representations differ. The visible
activation button now includes `, loading` in its accessible name while the
existing spinner is present. UIA reads that unique enabled visible button plus
the close button in the same exact process/host, preserving post-release Core
identity binding. No visible layout or primary action changes. Affected journey:
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024. The native result remains pending.
Log: `/tmp/rion-d7-win-package.log`.

All 3,324 Vitest tests, typecheck, lint (23 existing warnings), source hygiene and
coverage pass after the combined changes. Logs: `/tmp/rion-macro-loading-*` and
`/tmp/rion-loading-button-*`. The older `2aed9690` Windows Tauri full run passes
multirole but later fails p1-cross-domain-topology-force when the minimize bounds
ExecuteScript completion is not observed; this remains a separate investigation,
not evidence that all Windows macro or topology gates pass.

Pure Electron build and renderer-isolation verification pass after the focused
Tauri run. The older macOS package job 101436911578 passes previous-version
fixture construction and subsequently fails its updater transaction probe with
`kill EPERM`. This moves past the prior missing offline cache failure but does
not complete CP-16. Evidence: `/tmp/rion-edc-mac-package.log`.

### Darwin updater cleanup: independently verify zombie-only groups

The `edc757d0` macOS updater failure is the single cleanup error after the main
helper path, not an earlier Cargo/fixture error. A detached `/usr/bin/true` group
returns ESRCH after exit. A controlled native fixture instead forks a child into
its own session, waits for exit with WNOWAIT and keeps only the unreaped child in
that group: `kill(-pgid, 0)` returns EPERM while `/bin/ps` reports only state Z.
This reproduces the kernel edge locally without changing user processes.
Apple's [XNU killpg1 implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
filters zombie members and can return EPERM when no signalable member remains.
That explains a possible cleanup result; EPERM alone still cannot prove absence.

The shared Darwin group liveness helper now resolves only EPERM through a
bounded native `ps` snapshot of the exact detached group. Empty/reaped or entirely
zombie state establishes the existing `active-zero` outcome. A live member,
wrong group, malformed state or read failure remains a failure. Signals still
target only the captured group, and independent application-tree supervision is
unchanged. The full packaged updater transaction remains pending fresh CI.

Validation: 16 adjacent tests pass, including the real macOS WNOWAIT fixture and
negative live/permission/malformed/read-failure cases. All 3,336 Vitest tests,
typecheck, lint (23 existing warnings), complete hygiene and normal build pass.
Logs: `/tmp/rion-group-liveness-*`. This is `lower-layer-covered` E2E work:
it changes probe cleanup classification, not a visible product action; native
fixture evidence covers the exact kernel edge and the existing packaged updater
CI remains required. No Windows runtime behavior changes; Windows portable test
execution remains pending.

### Windows Web-only lifecycle confirmed after native-accessible state change

CI 34016712833 at `fa5c7737` reports
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 PASS. Both seed and restart phases pass,
including empty Role topology, isolated chrome/content sessions, explicit
navigation-failure recovery, identical tab/window identity across restart,
persistent content profile and final flush. Report:
`/tmp/rion-fa5-win-artifacts/2026-09-06T06-33-05-716Z-win32/report.json`;
artifact `chromium-shell-e2e-Windows-34016712833-1`.
This confirms the Windows native-accessible loading correction and the paired
Web-only lifecycle, not the full Windows profile. The next phase fails
CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025 because Workspace B does not reach
its expected Role-slot ownership. Investigation starts from the saved runtime
snapshots and effect receipts, with log `/tmp/rion-fa5-win-package.log`.

The Darwin zombie-group cleanup correction is committed and pushed as
`0430e3b9`; its complete packaged transaction has not yet run on CI. Local pure
Electron build and renderer isolation also pass after the normal build.

### Shared Role placeholder initialization follows the first Core fence

The Windows shared-Role failure at `fa5c7737` is effect 198's
ELECTRON_ROLE_PLACEHOLDER_WINDOW_FENCE_STALE during embeddedCreateTab. The newly
created second Windows host still has generation/revision zero; its first
embeddedFollowRoleOwnership (sequence 204) carries generation 13/revision 15.
Creating blocked placeholders before that projection incorrectly terminalizes
the launch, so the unique sibling never starts. Evidence:
`/tmp/rion-fa5-win-artifacts/2026-09-06T06-33-05-716Z-win32/phases/chromium-workspace-shared-role/electron-core-flow-observations.json`.

Tab creation now records the native host/tab and leaves placeholder reconciliation
to the authoritative ownership/window projection, before native reveal. The
positive window fence and exact Core owner checks remain unchanged. Both shells
use that sequence. The executor test harness now explicitly supports a Windows
host without AppKit initialization metadata and provides geometry for blocked
slots. New macOS/Windows cases create the unfenced target, require no premature
placeholder, apply the Core projection, and verify exact placeholder generation,
revision and owner. The existing claim-terminal test now supplies the initial
ownership projection instead of depending on early creation side effects.

Validation: all 50 adjacent projection/executor tests and all 3,338 Vitest tests
pass; typecheck, lint, source hygiene, coverage, macOS Rust lint and the complete
Rust suite pass (1,642 passed, 4 existing ignored). The retained AppKit Chromium
shared-Role phase passes locally at `85e0b94b` plus this working diff,
06:51:09–06:51:33 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-51-09-736Z-darwin/report.json`.
The journey is CHROMIUM-MACOS-APPKIT-WORKSPACE-SHARED-ROLE-025; its Windows
counterpart still needs fresh native CI. Both now explicitly assert positive
placeholder window fences. Pure Electron build/isolation is restored and passes.
Logs: `/tmp/rion-placeholder-init-*`. No ownership checks, retries or timeouts
were weakened, and no platform-specific placeholder initialization path was added.

### Native test window controls release the Tauri IPC thread

Windows Tauri CI 34015776112 reached the cross-domain minimize action but failed
the exact WebView2 ExecuteScriptCompleted bounds readback. The test command was
synchronous: Tauri's blocking command dispatch ran the native wait on its IPC
thread, preventing the callback from completing. The command now dispatches the
existing synchronous native control on spawn_blocking, matching the adjacent
runtime UI action command. Authorization, HWND/geometry fences, physical input,
terminal receipts and deadlines are unchanged.

Validation: 23 desktop E2E isolation tests, source hygiene, macOS Rust lint and
all 1,642 Rust tests pass (4 existing ignored). The desktop-e2e build and local
Tauri full-profile phase p1-cross-domain-topology-force pass, including its
required setup, at 522f7d4a plus this working diff, 06:57:11–06:58:37 UTC. Report:
`.desktop-e2e-artifacts/2026-09-06T06-57-11-002Z-darwin/report.json`. Affected
journeys are RUNTIME-TAB-TOPOLOGY-009 and MACRO-OWNERSHIP-TRANSFER-010; this
focused phase does not establish all restart outcomes. This is internal-only
test-driver scheduling work; product behavior and journey definitions are
unchanged. Windows native execution of this correction remains pending CI.
Logs: `/tmp/rion-window-control-*`.

Both macOS and Windows native validation passed on CI 34016712833 at fa5c7737,
including the POSIX updater toolchain-path correction. Later cleanup and
placeholder changes are not covered by that result. CI 34017674641 at 522f7d4a
failed earlier in Windows Chromium fullscreen seed: the native file chooser
helper was terminated at its external deadline. This run therefore does not
validate the later shared-Role correction; investigation continues from its
artifacts rather than treating earlier phase successes as full profile parity.

### Preserve Windows native file chooser progress before blocking UIA calls

The 522f7d4a file-upload failure produced neither the existing failure snapshot
nor upload-success evidence. A native helper deadline alone does not distinguish
UI Automation discovery, focus, SendKeys or dialog-close waits. The Windows
helper now persists a bounded phase/PID progress record before those calls and
a dialog-closed record only after exact-owner dialog disappearance. The artifact
is windows-native-file-dialog-progress.json; it is diagnostic evidence, not a
new success authority. Existing ownership/cardinality/control checks, physical
input and deadlines remain unchanged. No user data or input path is recorded.

Validation: 11 adjacent fullscreen/PowerShell transport tests, typecheck, scoped
lint, source hygiene, coverage and desktop E2E isolation pass. This is internal-only
E2E diagnostics for CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028; the native
Windows profile remains pending. The macOS helper is unchanged. Logs:
`/tmp/rion-file-chooser-*`. CI 34018078890 validates the preceding IPC correction
at 17306f6e and does not include these new diagnostic records.

Separately, macOS package validation on older CI 34016712833 failed in
chromium-system-settings with System Events assistive-access denial (-25211),
not a completed packaged updater verdict. Evidence:
`/tmp/rion-fa5-mac-package.log`. Native validation success on that run remains
valid at its narrower scope; complete package acceptance stays pending.

### Retain the Windows UI thread for native test controls

CI 34018078890 at 17306f6e failed the earlier p0-macro-middle-button phase:
Windows did not foreground the role pointer target. The newly asynchronous IPC
command also moved synchronous foreground/window controls off their owning UI
thread. The Windows adapter now schedules those controls on that thread and
returns their exact result to the worker. Only ClickVisibleMinimize retains the
worker execution needed for its WebView2 bounds callback. Native foreground
readback, pointer input and existing callback deadline are unchanged.

Validation: 23 isolation tests, source hygiene, macOS Rust lint and the complete
Rust suite pass (1,642 passed, 4 existing ignored). Local Tauri full-profile
p0-macro-middle-button passes at 6e9dea07 plus this working diff,
07:12:28–07:13:53 UTC, report
`.desktop-e2e-artifacts/2026-09-06T07-12-28-322Z-darwin/report.json`. The affected
journey is MACRO-MIDDLE-BUTTON-013; RUNTIME-TAB-TOPOLOGY-009 still requires
Windows minimize acceptance. This is internal-only test-driver dispatch work.
The macOS run verifies the unchanged adapter; Windows compilation/native
execution remains pending CI. Pure Electron build/isolation is restored and
passes. Logs: `/tmp/rion-control-ui-thread-*`.

### Focus the file-name control rather than the Windows dialog container

CI 34018289115 at 6e9dea07 identifies the exact native chooser failure:
$dialog.SetFocus() reports that the target element cannot receive focus. The
helper now activates the matched dialog HWND, focuses its exact editable
file-name control, and requires that same dialog to be foreground before
SendKeys. No container-level UIA focus capability is assumed. Exact application
ownership, single dialog/control cardinality, visible controls and native
close checks remain mandatory. Evidence: `/tmp/rion-6e9-win-package.log`.

Validation: 11 adjacent fullscreen/PowerShell tests, typecheck, scoped lint,
source hygiene, coverage and E2E isolation pass. This is internal-only driver
work for CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028; Windows physical
acceptance remains pending. Logs: `/tmp/rion-file-chooser-focus-*`.

The preceding Windows Chromium run 34018078890 passed the chooser phase but
failed Web-only seed after visible tab close: getEmbeddedRuntimeState timed
out in WebDriver, although the Core journal records embeddedTabStop and its
following appSnapshot as completed. That is not proof of an end-to-end reply.
Artifacts: `/tmp/rion-173-win-package-artifacts`; log:
`/tmp/rion-173-win-package.log`. Further investigation must identify the lost
reply/driver boundary without weakening the close assertion. On macOS,
34017674641 has completed source E2E and advanced to release artifact build;
its complete packaged updater verdict is still pending.

### Wake coherent snapshot readers for final Core-only topology commits

The Windows Web-only timeout at 17306f6e is consistent with a missing Core
commit wakeup, and source inspection identifies that gap. Effect 161 destroys
the last tab; receipt 165 already has empty native windows/tabs and acknowledgement
167 is accepted. Snapshot 168 still contains an empty Core window at runtime
revision 9; snapshot 169 removes it at revision 10. No later native effect is
needed. A reader receiving snapshot 168 fails the exact Core/native equality
check but previously waited only for another native effect admission. The final
Core stateChanged event could not wake it. Detailed evidence is in
`/tmp/rion-173-win-package-artifacts/2026-09-06T07-04-11-294Z-win32/phases/chromium-workspace-web-only-seed/electron-core-flow-observations.json`.

The shared effect coordinator now advances its projection observation sequence
on a strictly newer Core stateChanged revision as well as native effect
admission. Existing pending native/acknowledgement fences still settle before
readers retry. Duplicate/older Core revisions do not wake readers. Exact
Core/native projection equality is unchanged; no polling or timer was added.

Validation: all 3,340 Vitest tests pass, including both platform cases for a
Core-only final commit, an already-delivered commit, stale/duplicate events, and
a Core event that must not bypass an outstanding native acknowledgement.
Typecheck, lint, complete hygiene, macOS Rust lint and all 1,642 Rust tests pass
(4 existing ignored). Local retained-AppKit Web-only seed and restart phases
pass at be7b28b3 plus this working diff, 07:23:40–07:24:24 UTC, report
`.desktop-e2e-artifacts/2026-09-06T07-23-40-900Z-darwin/report.json`. Affected
journeys are CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024 and its Windows
counterpart. Windows native acceptance remains pending. Logs:
`/tmp/rion-core-projection-wakeup-*`.

### Use visible native pointer actions for the file chooser controls

CI 34018711131 at be7b28b3 progresses past container focus but the exact file-name
Edit also rejects UIA SetFocus. The chooser helper now clicks each verified
control's UIA GetClickablePoint through the existing Win32 physical pointer
mechanism used by desktop resize tests. It clicks the file-name control, checks
the exact dialog foreground HWND before typing, then clicks Open. Owner and
cardinality checks, enabled/visible controls, literal keyboard entry and native
dialog disappearance remain required. Evidence: `/tmp/rion-be7-win-package.log`.

This is internal-only E2E driver work for
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. Eleven adjacent tests, typecheck,
scoped lint, source hygiene, coverage and production isolation pass. Actual
Windows pointer/dialog acceptance is pending fresh CI; the macOS helper is
unchanged. Logs: `/tmp/rion-native-file-pointer-*`.

Normal build and restored pure Electron build/isolation also pass for this batch.

### macOS package, updater transaction and native black-box gates passed

CI [34017674641](https://github.com/rion-tw/rion-studio-source/actions/runs/34017674641)
at 522f7d4ad2440aec214bfcc1a8ef98ee51a278f3 completed the macOS Electron Chromium
package validation job successfully. Every applicable step passed: retained
AppKit source E2E, release artifact build, previous-version fixtures, exact
Electron/Chromium/Core/AppKit ABI, package structure, distribution payloads,
packaged Rust-owned updater transaction and packaged Role black-box smoke.
The updater command explicitly verified the real app bundle and signed update
archive; the job log records its success at 07:29:48 UTC. This confirms the
Darwin zombie-only cleanup correction in its complete packaged transaction.
It does not authorize publication or establish Windows installer/update parity.

Source report: 52 PASS phases, 4 EXPECTED_FORCE_TERMINATION phases and all 49
journeys PASS, 06:54:20–07:09:53 UTC. Report commit is exact, with the expected
CI fixture worktreeDirty flag. Artifact chromium-shell-e2e-macOS-34017674641-1
(ID 9984652799), downloaded to `/tmp/rion-522-mac-shell-artifacts`. This also
confirms the shared-Role placeholder initialization correction on macOS.

The packaged report has verdict passed, version 8.5.0, exitCode 0,
runtimeTarget chromium-v23-macos-appkit, nativeHostKind appkit-chromium,
fixtureInteraction visible-os-accessibility-click and remoteDebugging false.
Its retained native-window screenshot was inspected. Artifact
packaged-chromium-role-black-box-macOS-34017674641-1 (ID 9984941317); report:
`/tmp/rion-522-mac-packaged-artifacts/2026-09-06T07-29-50-231Z-faefbbdd-2689-4062-9318-5edfc76f6343-darwin-packaged-black-box/packaged-smoke-report.json`.
The report pins app.asar SHA-256
ee51917936d1e37674fa0f80bf7489fb640b170df691ebfbb062bf2b561f3f3b
and native addon SHA-256
bdaa1d1ededd40d6f77500a145d57a16ad3a0bfdf35b54bc1534537d8b856b3b.
Job log: `/tmp/rion-522-mac-package.log`.

Both macOS and Windows native validation and the macOS Tauri full E2E job also
passed at that SHA. Windows Tauri/Chromium E2E failed as recorded above. Later
IPC, Windows pointer and Core projection-wakeup changes retain their own fresh
CI requirement; the package success must not be attributed to current HEAD.
CP-16 therefore has verified macOS package/update evidence while its Windows
and owner-locked release gates remain pending. Physical extended-profile
requirements and CP-17 cutover remain unchanged.

### Windows stable-shell full acceptance confirms native control dispatch

CI [34018711131](https://github.com/rion-tw/rion-studio-source/actions/runs/34018711131)
at be7b28b3e130f1e6f3cc69a7ed1087ff19a6e9f3 passes the complete Windows Tauri
full profile: 29 PASS phases, 3 EXPECTED_FORCE_TERMINATION phases and all 39
journeys PASS. The report identifies runtimeTarget tauri-v22 and a clean tested
worktree, 07:18:26–07:31:18 UTC. This confirms the async IPC/UI-thread split
through MACRO-MIDDLE-BUTTON-013 and RUNTIME-TAB-TOPOLOGY-009, including the
Windows visible-minimize bounds/readback assertions. MACRO-MULTIROLE-005 also
passes with the urgent Core shortcut-configuration publication correction.

Artifact desktop-e2e-Windows-34018711131-1; report:
`/tmp/rion-be7-win-tauri-artifacts/2026-09-06T07-18-26-081Z-win32/report.json`.
The earlier macOS Tauri full run at 522f7d4a and local focused macOS middle-button
run remain their recorded evidence. The complete latest-head macOS profile is
still independently required. This stable-shell verdict does not establish
Chromium Windows parity; CI 34019181794 at c0e09041 is still running the
Chromium/native package gates and includes the later Core commit wakeup and
file-dialog pointer corrections.

### Windows Web-only, upload and shared Role journeys now pass together

CI 34019181794 at c0e09041 passes CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028,
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 (seed/restart) and
CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025. This confirms the physical file
chooser control actions, Core-only projection wakeup and positive-fence
placeholder initialization in the same native Windows run. The report records
12 PASS phases and 15 PASS journeys before WORKSPACES-RECOVERY-026 fails;
34 journeys remain NOT_RUN. Report:
`/tmp/rion-c0-win-package-artifacts/2026-09-06T07-28-50-469Z-win32/report.json`.

Recovery passes failure isolation and visible stop/relaunch, then fails gated
loading cancellation. Its test reads the runtime projection before clicking
Stop, while loading is deliberately blocked. That read can wait for the very
load being cancelled; effect 4caf085f reaches its Core deadline before the
later stop command. The Windows test now observes the exact native loading row
and invokes its visible close control without attaching ChromeDriver or
requesting a settled projection. It uses the same exact PID/HWND/control-name
validation as the existing native close helper. Both gated Role transports
must report cancellation before either fixture is released; final Core tabs
and Role statuses must still be absent. The macOS visible action is retained
and now has the same explicit transport-cancellation assertions.

Validation: 17 native-control evidence tests, typecheck, scoped lint, hygiene,
coverage and E2E isolation pass. Local macOS AppKit
CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026 passes at 31929ef5 plus this working
diff, report `.desktop-e2e-artifacts/2026-09-06T07-40-59-564Z-darwin/report.json`.
Windows native execution remains pending fresh CI. This is internal-only test
sequencing work; product cancellation and its deadlines are unchanged. The
Windows journey manifest names the exact native gated-cancel action and both
transport receipts. Logs: `/tmp/rion-workspace-loading-cancel-*`.

The latest Tauri Windows full run at c0e09041 fails later in p1-guard-cleanup
with mainWindowFocusSuperseded; log `/tmp/rion-c0-win-tauri.log`. The earlier
be7b28b3 full PASS remains valid at that SHA, but this new focus supersession
requires investigation and prevents a current-head full acceptance claim.

### Wait for restored-tab essential setup before cleanup takes foreground

The c0e09041 Windows p1-guard-cleanup transcript shows the main-focus request
accepted at 07:37:59.171, a restored Game Window native focus event at .174,
and the correct superseded terminal at .195. That restored tab did not reach
essentialReady until .393. Cleanup had waited for context/visibility and
final-focus-started, which do not establish completed WebView attachment.
Evidence: `/tmp/rion-c0-win-tauri-artifacts/2026-09-06T07-28-55-095Z-win32/user-data/app-entity-lifecycle/desktop-e2e/events.ndjson`.

The cleanup fixture now waits for each exact restored tab's existing
tab-launch-phase:<id>:essentialReady event after its Show action before
requesting main-window focus and visibly deleting entities. This is an
internal-only cleanup precondition for APP-FULL-CRUD-001, APP-CRUD-REORDER-002
and APP-QUIT-GUARD-002. Native focus supersession and product presentation
behavior remain unchanged; no retry or presentation delay was added.

Validation: typecheck, scoped lint, source hygiene and E2E production isolation
pass. The local macOS full-profile p1-guard-cleanup and required setup phases
pass at 028cc461 plus this working diff; report:
`.desktop-e2e-artifacts/2026-09-06T07-46-48-479Z-darwin/report.json`. Windows
execution of this precondition remains pending CI; the earlier Windows
be7b28b3 full PASS is not reused as its verification. Logs:
`/tmp/rion-cleanup-restore-ready-*`. Separately, macOS Tauri full E2E on
CI 34019181794 at c0e09041 has completed successfully.

### Admit exact Windows tab cancellation while presentation is catching up

CI 34019883290 at 028cc461 and 34020264959 at 32ff548f reach native gated
Workspace close but fail final tab absence. The former's native log reports
ELECTRON_CHROMIUM_RUNTIME_ACTION_WINDOW_STALE; no corresponding gated-tab
embeddedTabStop command reaches Core before the load deadline. Native topology
observation 11 has window generation 41/revision 43 with the exact tab, while
Core's pending presentation has revision 44 in that same generation. Requiring
revision equality for stop rejects a valid cancellation while presentation
is catching up. The resulting transport cancellation came from load expiry,
so it did not establish a successful user stop. Evidence:
`/tmp/rion-028-win-package-artifacts/2026-09-06T07-44-13-885Z-win32`; the
authoritative downloaded report and phase paths are under that artifact root.
Logs: `/tmp/rion-028-win-package.log`, `/tmp/rion-32ff-win-package.log`.

Windows stop now permits a positive native revision no newer than Core's,
while retaining identical window generation, complete ordered tab membership
and presentation. It submits the exact tab ID and current Core source-window
generation to the existing Rust stop transaction. Uninitialized, ahead,
different-generation and different-membership states still fail. Other
actions retain revision equality; AppKit retains its exact projection/event
protocol. No native handles or domain ownership are inferred from elapsed time.

The recovery E2E also waits for actual Core tab retirement after the native
click and two transport-cancelled events. The final absence/Role-status
assertions remain mandatory; an early native input return is not terminality.
Affected journeys are CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026 and its retained
AppKit counterpart.

Validation: 20 action-backend tests, all 3,347 Vitest tests, typecheck, lint,
complete hygiene, normal build, macOS Rust lint and all 1,642 Rust tests pass
(4 existing ignored). The seven adjacent Workspace source checks also pass
after the terminal-wait update. Final local macOS recovery E2E passes at
32ff548f plus this working diff; report:
`.desktop-e2e-artifacts/2026-09-06T08-01-03-549Z-darwin/report.json`. Windows
native verification of the corrected admission remains pending fresh CI.
Logs: `/tmp/rion-stop-pending-revision-*`.


### Follow-up CI admission and Windows stable-shell recovery verification

The pending-presentation stop fix is committed as
4bd48816f628b508f25890fe07bddd6310894db7. Immutable-ref CI
[34020983154](https://github.com/rion-tw/rion-studio-source/actions/runs/34020983154)
has been dispatched; its Windows Chromium cancellation, remaining journeys,
package and updater results are pending. Final coverage validation and pure
Electron renderer bundle verification passed before commit.

The preceding CI 34020264959 at 32ff548fd932739530bc10576c18200838b0cfc9
completed Windows x64 desktop E2E successfully (job 101451414368). This verifies
the restored-tab essentialReady precondition used by the stable-shell cleanup
focus journey. It does not verify the later Chromium stop-admission change.
The separate Windows Chromium package job at that revision failed the gated
Workspace final-tab absence check documented above. Log:
`/tmp/rion-32ff-win-tauri.log`.


### Preserve packaged native traversal across retired AX references

macOS package CI 34018711131 at be7b28b3 completed source E2E, package verification
and the packaged updater transaction, then failed the final native black-box
launcher traversal with System Events Invalid index (-1719). The AppleScript
queue dereferenced a retired Chromium accessibility element before entering its
existing guarded property read. Log: `/tmp/rion-be7-mac-package.log`.

The shared packaged macOS traversal now guards queue and child-reference
dereferencing, plus the launcher consumers, as well as property reads. Missing
elements cannot match. The traversal bounds, exact process and retained AppKit
identity, real native actions and domain receipts remain unchanged. This is an
internal-only E2E driver correction; it changes no product UI or native runtime
contract and does not add a reconciliation loop.

An actual macOS osascript regression supplies a retired AX group reference.
The previous handlers reproduce the same 277:285 Invalid index (-1719); the new
handlers return no descendants and no button match. All 11 adjacent tests and
all 3,348 Vitest tests pass, as do full hygiene and lint (23 existing warnings).
The local packaged black-box also passes with exit code 0, a visible OS
accessibility click and retained appkit-chromium host; its screenshot was
inspected. Report:
`.desktop-e2e-artifacts/2026-09-06T08-11-51-673Z-a77e0205-069d-4379-9f2a-308e5ce71d8a-darwin-packaged-black-box/packaged-smoke-report.json`.
This run uses the existing local 8.5.0 package (app.asar SHA-256
4fd238e22fe97f03bc67b27580129c98dfc337cbd49b79fe60aa66bd49a2302b), so it
verifies the updated external native driver, not a rebuilt current-candidate
package. Exact-candidate macOS package and Windows CI remain pending.
Logs: `/tmp/rion-packaged-ax-*`.


### macOS complete package validation advanced to c0e09041

CI [34019181794](https://github.com/rion-tw/rion-studio-source/actions/runs/34019181794)
macOS Chromium package job 101448473362 completed successfully at
c0e09041173a923abfc291d6ec91452d9bcaf6e6. Its source smoke report records
52 PASS phases, four expected force-termination phases and all 49 journeys PASS
(07:32:48.424–07:53:30.056 UTC). The report records the existing CI fixture
worktree changes; it is bound to the stated commit, not current HEAD. Evidence:
`/tmp/rion-c0-mac-shell-artifacts/2026-09-06T07-32-48-182Z-darwin/report.json`.

The same job passed package construction, exact ABI/runtime and distribution
verification and the Rust-owned packaged updater transaction (08:13:38 UTC).
The final packaged native black-box reports passed, exit code 0, visible OS
accessibility click and appkit-chromium host for version 8.5.0. Artifact
9985570974 contains:
`/tmp/rion-c0-mac-packaged-artifacts/2026-09-06T08-13-40-956Z-5fe61725-ebfb-4389-baa5-a05775d5370d-darwin-packaged-black-box/packaged-smoke-report.json`.
Log: `/tmp/rion-c0-mac-package.log`. Both native validation jobs at c0e09041
also passed. This advances CP-16's latest complete macOS evidence, but does not
verify later changes or close Windows, physical hardware or release gates.

The retired-AX-reference driver correction is committed as c9f94a5b and is
under immutable-ref CI
[34021272996](https://github.com/rion-tw/rion-studio-source/actions/runs/34021272996).
The preceding Windows Chromium stop-admission run 34020983154 remains live in
its shell E2E step at this observation; it is not a passing result yet.


### Windows loading cancellation passes; recovery evidence follows event order

CI 34020983154 at 4bd48816 now passes the complete Windows recovery UI spec at
08:15:53 UTC (one passing test, including visible gated cancellation, both
transport cancellations and final Core tab/Role-status absence). The runner then
fails its post-run recovery-history verifier, so the aggregate journey remains
unverified. Evidence is under
`/tmp/rion-4bd-win-package-artifacts/2026-09-06T08-09-01-957Z-win32/phases/chromium-workspaces-recovery`;
log: `/tmp/rion-4bd-win-package.log`.

The exact observations show Core runtime-crashed in sample 2 while native phase
is still ready/revision 10; sample 3 projects degraded/revision 11 with the same
Role, Core owner and native generation. The verifier incorrectly required the
first Core failure sample itself to contain the later native degraded phase.
It now requires the ordered degraded observation for that same failed Role,
with identical Core owner and native generation, while retaining the first Core
failure, healthy-sibling preservation and explicit relaunch generation checks.
Missing degradation, replacement ownership/native generation and missing
relaunch still fail. No product runtime or E2E user action changes.

Ten platform-explicit behavioral cases cover this ordering and the rejection
boundaries. Replaying both the actual Windows failure artifact and the prior
c0e09041 macOS recovery artifact through the corrected verifier succeeds.
This is internal-only evidence validation; the affected existing journeys are
CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026 and
CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026. Fresh aggregate CI remains pending;
replay does not retroactively change the failed CI verdict.

Validation: all 3,358 Vitest tests, typecheck, lint and complete hygiene pass.
Logs: `/tmp/rion-recovery-phase-*`. No native imports, shared runtime contracts
or product code changed; native Rust checks are not repeated for this verifier.

### Concentrate final CI on the corrected recovery verifier

The ordered recovery verifier is committed as
27deee12689323a5bc45151f874b56939c2eff10 and runs in immutable-ref CI
[34021561250](https://github.com/rion-tw/rion-studio-source/actions/runs/34021561250).
Checks, renderer build and Linux sanitizer/concurrency validation have passed;
Windows Chromium E2E and both platforms' native/desktop/package work remain
in progress. macOS jobs started after freeing occupied runners.

Superseded runs 34019883290, 34020264959, 34020983154 and 34021272996 were
explicitly cancelled after their Windows Chromium failures had been inspected
and their corrections included in the current candidate. All four runs are now
terminal cancelled; this does not change individual completed job results or
turn failed aggregate journeys into passes. Existing artifacts and recorded
commit-specific evidence remain valid only for their stated scope. No current
candidate job was cancelled or restarted.


### Windows recovery aggregate passes; fix scoped toolbar-settings selector

CI 34021561250 at 27deee12 now records WORKSPACES-RECOVERY-026 PASS in the
aggregate report, confirming the ordered verifier as well as actual visible
cancellation and final Core retirement. The Windows source profile advances to
13 passing phases and 16 passing journeys before the next failure; 33 journeys
remain not run. Report:
`/tmp/rion-27d-win-package-artifacts/2026-09-06T08-21-52-165Z-win32/report.json`.

The fullscreen-toolbar seed fails before its preference action because
`.settings-mode-sidebar button=Preferences` is sent as an invalid CSS selector.
The driver now scopes to the sidebar first, then uses WebdriverIO's exact
button-text selector, matching the existing system-settings driver pattern.
The failure screenshot confirms the visible Preferences section and toolbar
switch. The persisted preference assertions and native fullscreen actions are
unchanged. This is an internal-only E2E locator correction affecting
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012; Windows execution remains pending CI.
Typecheck, scoped lint, source hygiene, production E2E isolation and coverage
validation pass. Logs: `/tmp/rion-toolbar-selector-*`,
`/tmp/rion-27d-win-package.log`.

### Remove retired display-performance wording from Preferences

The Windows fullscreen failure screenshot exposed a remaining Preferences
subtitle advertising display performance after CP-02/CP-13 removed those
controls. English, Japanese, Simplified Chinese and Traditional Chinese now
name only theme, interface language and Game Window behavior. The existing
translation key and layout are unchanged; no setting or persistence behavior
changes.

Validation: all 3,358 Vitest tests, typecheck, lint, source hygiene and pure
Electron renderer build pass. All four locale JSON values were checked for
valid syntax and removal of the retired wording. E2E omission reason is
lower-layer-covered: static localized copy only, verified through locale
readback and the production renderer build. Affected existing journeys are
CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013 and
CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013. Their latest exact-candidate native
verification remains pending; this copy-only follow-up does not restart the
live functional CI 34022067330 at 26c4fd4b. Logs:
`/tmp/rion-retired-preference-copy-*`.

### Windows placement respects unsaved runtime-window ownership

The Windows fullscreen seed screenshot at 27deee12 also contains a product
error toast. Native logs identify WINDOWS_RUNTIME_PLACEMENT_SAVED_WINDOW_MISSING;
Core flow shows placement command 62 during launch of a live Role window that
has no saved Game Window definition. The Windows placement writer incorrectly
required every live window to already be saved. Existing Core runtime UI
persistence deliberately skips unsaved definitions, so a new Role window is
not a persistence failure. Evidence: `/tmp/rion-27d-win-package-artifacts/2026-09-06T08-21-52-165Z-win32/phases/chromium-fullscreen-toolbar-seed`.

Core now validates the exact logical generation/revision and commits placement
and native projection for both saved and unsaved windows. Saved definitions
still require the exact durable receipt. Unsaved definitions return the explicit
persistenceStatus notRequired, create no saved Game Window, and can report
applied only after Core projection succeeds. The generated contract comes from
Rust. Both Electron receipt consumers retain their identity, revision, native
and display checks and accept that explicit Core-owned outcome; no shell-side
inference, retry or timer is introduced. Stable Tauri and retained AppKit paths
are unchanged; this follows their existing shared Core saved-definition policy.

Four focused Core tests cover saved persistence, unsaved placement without a
saved definition, stale fences and failed projection. The Electron test now
executes the actual placement-target consumer for both applied and notRequired
receipts, including exact native/display readback. macOS Rust lint and all
1,643 native Rust tests pass (four existing ignored). Affected journeys include
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and Windows window/display recovery.
E2E omission reason is lower-layer-covered: the new saved/unsaved receipt branch
is exercised through real Core command/effect dispatch and the real Electron
target consumer. Windows native/fullscreen execution of this exact revision
remains pending CI; the previous screenshot is failure evidence, not a pass.
Logs: `/tmp/rion-unsaved-placement-*`.
Final verification also passes all 3,359 Vitest tests, typecheck, lint, complete
hygiene and pure Electron build after updating both receipt consumers.

### Fullscreen E2E sends F11 through the retained Windows native hook

CI 34022067330 at 26c4fd4b passes the corrected Settings locator but fails
waiting for fullscreen auto-hide. Its toolbar history contains only the normal
presentation and Core flow contains no fullscreen UI action after the key
submission. The driver used WebDriver key injection for F11 even though CP-07
retains the native Win32 foreground hook as the authoritative Windows routing
boundary. This does not exercise that physical shortcut path. Evidence:
`/tmp/rion-26c-win-package-artifacts/2026-09-06T08-32-52-294Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-26c-win-package.log`.

The shared Role F11 helper now obtains the exact process identity before
focusing the Role page and invokes the existing Windows scan-code shortcut
helper in focused-runtime mode. The native helper checks foreground PID and
visibility and requires SendInput's exact inserted count. The existing caller
still requires fullscreen projection, actual toolbar/content geometry and no
F11 page delivery; input submission alone cannot pass. Both callers use this
helper only in their Windows branch. AppKit controls remain unchanged.

This internal-only desktop driver correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and
CHROMIUM-WINDOWS-NATIVE-DISPLAY-001. The manifest now states native scan-code
input explicitly. The adjacent source boundary check no longer requires the
incorrect WebDriver F11 path. Typecheck, scoped lint, source hygiene, E2E
production isolation, coverage validation and 11 adjacent native-action and
toolbar checks pass. Actual Windows/fullscreen and hardware profile results
remain pending; no macOS execution is claimed for a Windows-only driver change.
Logs: `/tmp/rion-native-f11-*`.

### Native file-name entry uses the visible UI Automation value contract

CI 34022632667 at 75562cc1 fails earlier in Workspace Web upload. The native
helper is killed at its existing deadline; its last checkpoint is
entering-file-name, immediately before SendKeys.SendWait control-A and escaped
path input. This run does not reach fullscreen-toolbar acceptance and therefore
does not verify or contradict the subsequent native F11 correction. Evidence:
`/tmp/rion-755-win-package-artifacts/2026-09-06T08-44-31-184Z-win32/phases/chromium-workspace-web-fullscreen-seed/windows-native-file-dialog-progress.json`;
log: `/tmp/rion-755-win-package.log`.

The Windows chooser driver now obtains ValuePattern from the exact visible,
enabled, uniquely owned file-name Edit control, rejects read-only controls,
sets the literal fixture path, and requires exact case-sensitive native readback
before physically clicking Open. It retains the exact dialog foreground/PID
checks, physical file-input/chooser actions, dialog-close acknowledgement and
page File/byte evidence. It removes SendKeys and its escaping helper, not the
native chooser. No larger deadline, retry or product runtime bypass was added.
The checkpoint alone does not establish which SendKeys call consumed the
remaining deadline; fresh native execution remains required.

This internal-only E2E correction affects
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. The manifest and adjacent source
boundary check now require native value acknowledgement. Eleven adjacent
checks, typecheck, scoped lint, E2E production isolation, source hygiene and
coverage validation pass. Windows execution is pending CI; AppKit file-panel
behavior and its prior evidence are unchanged.
Logs: `/tmp/rion-file-dialog-value-*`.

### Separate independent update-lineage rejection cases

Windows native-validation job 101455086471 in CI 34021561250 fails in Vitest,
not a reported Rust assertion: one readiness test creates and verifies three
independent complete production-evidence fixtures under a single 10-second test
budget. The failure is the grouped test deadline. The artifact digest, running
executable digest and provisional manifest digest checks now have separate test
cases, each retaining the original fixture, mutation, rejection assertion and
unchanged timeout. No production verifier or release gate changes.

All 33 focused readiness tests, scoped lint and source hygiene pass locally.
This is internal-only validation work; no desktop journey changes. Windows
execution of the split cases remains pending CI. Evidence:
`/tmp/rion-27d-win-native.log`; checks: `/tmp/rion-readiness-case-*`.

The same audit identifies separate incomplete macOS evidence: package job
101454984110 at 27deee12 was denied OS assistive access while opening the native
file panel (System Events -25211). Stable Tauri jobs 101454984161 at 27deee12
and 101456344886 at 26c4fd4b time out in native window-control calls, respectively
the fullscreen View-menu action and deminiaturization. These are neither
Chromium parity passes nor evidence to remove AppKit. No permission bypass or
longer timeout is introduced; further native evidence is required. Logs:
`/tmp/rion-27d-mac-package.log`, `/tmp/rion-27d-mac-tauri.log`,
`/tmp/rion-26c-mac-tauri.log`. The latter's artifact root is
`/tmp/rion-26c-mac-tauri-artifacts`.


### Exact Windows foreground identity and native edit acknowledgement

CI 34022924914 at 2dafe73b still records only normal presentation after F11.
The native helper previously checked foreground process identity, which cannot
separate the launcher from a Role host in the same Electron process. The
read-only E2E toolbar inspection now exposes the exact Windows native handle
from the Core-fenced BrowserWindow mapping. The driver activates that visible,
PID-owned HWND and checks it again immediately before native scan-code F11.
The existing fullscreen projection, page suppression and live geometry receipts
remain the success conditions. AppKit does not expose or consume this field.
Affected internal-only journeys: CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and
CHROMIUM-WINDOWS-NATIVE-DISPLAY-001. Twelve focused parser/foreground tests cover
valid Windows identity, absent optional evidence, malformed identities and
native rejection. Full Vitest at this stage passes 3,373 tests; typecheck and
lint pass. Exact Windows native execution is still pending.

CI 34023120346 at 6ae8b6e7 fails before fullscreen in the native file chooser:
the exact visible Edit control reports Unsupported Pattern for ValuePattern.
The driver now uses that control's native handle and Win32 WM_SETTEXT followed
by exact ordinal WM_GETTEXT readback. Both acknowledgements are bounded with
SendMessageTimeoutW; missing acknowledgement is failure. Exact dialog-child and
foreground identity are checked before and after. The visible file-input,
physical Open click, dialog closure and page file bytes remain required.
No retry, larger helper deadline or product chooser bypass is introduced.
This internal-only correction affects
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. Windows execution remains pending.
Evidence: `/tmp/rion-6ae-win-package.log`.
API contracts: [WM_SETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settext),
[WM_GETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettext),
[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw).

The focused macOS AppKit toolbar seed and restart profile passes on this working
tree: `.desktop-e2e-artifacts/2026-09-06T09-15-16-318Z-darwin/report.json`.
Affected macOS journey: CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012.
After the native edit correction, all 22 adjacent checks, typecheck, scoped lint,
source hygiene and coverage validation pass. E2E build passes. Production
isolation must be checked against the restored production build; its initial
invocation correctly rejected the still-installed E2E renderer build.

Final working-tree validation passes all 3,373 Vitest tests, macOS Rust lint
and 1,643 native Rust tests (four existing ignored), complete hygiene, typecheck,
coverage validation, pure Electron production build and production E2E isolation.
The latter now passes after restoring the production renderer. Windows remains
pending a fresh immutable-candidate CI run; no release/cutover gate is waived.
Logs: `/tmp/rion-foreground-*`.


### Complete macOS package evidence advances to 26c4fd4b

CI 34022067330 package job 101456344940 is terminal success at exact commit
26c4fd4b8edcd8ace88a4f77b2f8665079696ec1. Downloaded source report
`/tmp/rion-26c-mac-shell-artifacts/2026-09-06T08-32-17-682Z-darwin/report.json`
confirms all 49 journeys, 52 passing phases and four expected forced exits.
The job verifies the packaged Rust-owned updater transaction for 8.5.0 at
09:06:43 UTC. The final packaged black-box report is passed with exit 0,
visible OS accessibility interaction, retained appkit-chromium hosting and
remoteDebugging=false. Its app.asar SHA-256 is
`dc565c836b34e63e40c467de2f6ed92e6e8208eadfc059adf3c488d2ee400d81`.
Packaged artifact: 9986360142;
report root: `/tmp/rion-26c-mac-packaged-artifacts/2026-09-06T09-06-45-184Z-6f9eeac5-fdb8-4b90-95e4-04835e1778a5-darwin-packaged-black-box`.
Job log: `/tmp/rion-26c-mac-package.log`.

This advances CP-16 macOS evidence; it does not make the aggregate CI run pass:
that candidate's Windows Chromium and stable macOS desktop jobs failed.
The later 75562cc1 stable macOS job 101457881273 repeats the native
setPresentation/deminiaturization timeout at cross-domain-runtime.e2e.ts:1184;
its subsequent screenshot also times out. Exact native thread evidence is still
missing, so no speculative AppKit removal or timeout relaxation is applied.
Log: `/tmp/rion-755-mac-tauri.log`.

Fresh immutable candidate b76e249b93801c11774a0b575320a9a55da7af95 is running in
CI 34024329384. Its Windows Chromium job 101462497385 has reached the shell E2E
step. Latest candidate macOS jobs are queued; these are live/pending evidence,
not passed gates. The worktree is not promoted to the sole production engine.


### Keep optional native handle present in strict PowerShell payloads

CI 34024329384 Windows Chromium job 101462497385 fails at shell-smoke before
file upload or Role fullscreen. Strict PowerShell rejects the absent
nativeWindowHandle property for ordinary launcher shortcuts: JSON serialization
omits undefined object fields. The driver now always sends the optional property
as an empty string when absent. Launcher PID/window selection is unchanged;
provided Role HWNDs still require exact foreground equality before F11. No
strict-mode downgrade or native ownership bypass is introduced.

This internal-only transport correction affects
CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030 and callers of the common native
shortcut driver. It does not establish whether the previous candidate's native
Edit or exact Role focus corrections pass: this run never reaches those phases.
Evidence: `/tmp/rion-b76-win-package.log`. Windows execution remains pending
on the corrected candidate.

All 29 adjacent native-action/transport/foreground/shortcut checks pass locally,
along with typecheck, scoped lint, source hygiene, production E2E isolation and
coverage validation. No native runtime, AppKit behavior, shared contract or
coverage threshold changes. Logs: `/tmp/rion-shortcut-optional-*`.


### Compare toolbar geometry inside one fullscreen extent

CI 34024645026 at c55f05a7 passes the first 13 Windows Chromium phases, including
Workspace Web native file upload and restart. It reaches fullscreen-toolbar-seed
and records exact native F11 entry with the same HWND 1835114. This verifies the
optional shortcut field and native Edit acknowledgement corrections along this
actual Windows path. The toolbar assertion then expects 38px expansion but
receives 166px. The artifact proves normal Role bounds 960x600 at y=40 versus
fullscreen 1024x766 at y=2: the test incorrectly included the 128px increase in
host height when comparing different presentations. This is not evidence of
incorrect toolbar inset.

The visible E2E now compares hidden and revealed Role heights within fullscreen,
requiring the exact 38px delta, equal width and identical bottom edge. The normal
baseline still requires y=40 and fullscreen hidden content requires y=2. The
aggregate verifier additionally requires matching visible Role identities and
exact fullscreen geometry throughout hidden/revealed/hidden/pinned/hidden.
It validates optional Windows HWND evidence without accepting malformed handles
or permitting that field on AppKit records. No product geometry, timing or native
input behavior changes; the full ordered journey remains mandatory.

Sixteen adjacent checks pass, including changed host dimensions, malformed HWNDs,
wrong height in each fullscreen state and changed fullscreen width. Replaying
both actual 26c4fd4b macOS toolbar histories passes. Replaying this incomplete
Windows history parses its HWND but still rejects missing journey ordering.
Affected journey: CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012; internal-only E2E
correction. Windows completion remains pending. Evidence root:
`/tmp/rion-c55-win-package-artifacts/2026-09-06T09-28-18-950Z-win32`;
log: `/tmp/rion-c55-win-package.log`; checks: `/tmp/rion-toolbar-extent-*`.

Final validation passes all 3,386 Vitest tests, typecheck, scoped lint, complete
hygiene, coverage and production E2E isolation. The new verifier declaration
matches the repository's adjacent script declarations. macOS evidence above is
a replay of actual native histories; this Windows-only E2E assertion correction
does not claim a fresh local macOS desktop run or fresh Windows completion.


### Put the visible pointer inside the two-pixel reveal edge

CI 34025263334 at 0d2d437c passes the first 13 Windows phases and enters native
fullscreen, but never observes revealed controls. Its toolbar history contains
normal and fullscreen-hidden only. The E2E pointer used element origin with
x=1, y=1. The production reveal edge is exactly 2 CSS pixels high at y=0;
WebDriver element-origin offsets are relative to its in-view center, so y=1
moves to viewport y=2, outside the reveal edge. The driver now uses zero offsets
to target the center. Product pointerenter behavior, the 2px edge, authoritative
projection and complete revealed/pinned/restart requirements are unchanged.

This internal-only E2E correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. It keeps real WebDriver pointer input;
no synthetic DOM event or runtime command replaces the user action. Native
Windows acceptance remains pending. Evidence:
`/tmp/rion-0d2-win-package-artifacts/2026-09-06T09-40-57-761Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-0d2-win-package.log`.
The offset contract is specified by [WebDriver](https://www.w3.org/TR/webdriver/#dfn-get-coordinates-relative-to-an-origin).

Sixteen adjacent toolbar checks, typecheck, scoped lint, source hygiene,
production E2E isolation and coverage validation pass. This Windows-only driver
correction introduces no shared/native product change; macOS's native pointer
adapter is unchanged. Checks: `/tmp/rion-toolbar-pointer-*`.


### Cross the host/Role boundary with acknowledged OS pointer input

CI 34025834042 at e380920e now reaches revealed toolbar state and passes the
same-fullscreen 38px geometry assertions. Its native history is normal, hidden,
revealed; the later Role WebContents click does not yield hidden state. Moving
WebDriver's target-local pointer in another WebContents is insufficient evidence
of the OS cursor leaving the host toolbar. This observation does not by itself
prove a product pointerleave defect.

The Windows toolbar E2E now uses the existing exact-PID/HWND foreground adapter
for both reveal and content movement. GetClientRect and ClientToScreen bind the
point to the actual native client extent; SetCursorPos performs the system move,
and GetCursorPos plus foreground equality must acknowledge the exact result.
Reveal targets the first client pixel, content targets the client center.
Coordinates are derived by native APIs in one process; no fixed desktop size or
renderer CSS-to-screen assumption is added. Both moves are separated by the
existing authoritative revealed-state wait, so the OS actually crosses the host
and Role boundary. The previous WebDriver host-target search is removed from
this helper. Native submission alone remains insufficient: hidden, revealed,
pinned, reversed and restart projections are still required.

The shared helper always includes its optional pointerTarget payload, preserving
strict PowerShell behavior for ordinary F11 focus calls. This internal-only E2E
correction affects CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. Required AppKit input
is unchanged; no DOM dispatch, direct reveal/hide command, timer or retry replaces
the visible action. Windows execution remains pending.
Evidence: `/tmp/rion-e38-win-package-artifacts/2026-09-06T09-53-44-130Z-win32`;
log: `/tmp/rion-e38-win-package.log`.
Native coordinate contract: [ClientToScreen](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clienttoscreen),
[cursor movement](https://learn.microsoft.com/en-us/windows/win32/menurc/using-cursors).

Final validation passes 30 adjacent checks and all 3,388 Vitest tests, typecheck,
scoped lint, complete hygiene, coverage and production E2E isolation.
No fresh macOS desktop execution is claimed for this Windows-only driver change;
its native Windows run is still required. Logs: `/tmp/rion-toolbar-native-pointer-*`.


### Macro UI setup awaits the native Role observation

macOS package job 101462497267 in CI 34024329384 at b76e249b fails
chromium-macro-ui-seed after logical Role running is visible but before the
E2E native Role observation arrives. The immediate assertion receives null.
The uploaded native topology history later contains the same visible AppKit
window at revision 5 without its Role surface, then the Role at revision 7;
the final session/runtime artifact contains its exact visible appkit-chromium
identity. This proves an observation-order race in the test prerequisite,
not an unavailable final native host.

After the existing visible launch and logical running checks, Macro UI setup now
awaits the exact Role's visible runtime observation and expected platform host,
then performs its existing Role and AppKit identity assertions. Its native
observation is event-fed; no product polling, launch retry or inferred success
is introduced. The E2E wait uses the same 45-second readiness budget as the
adjacent logical-running wait. A host that never arrives still fails.

This internal-only desktop driver correction affects both
CHROMIUM-MACOS-APPKIT-MACROS-UI-017 and CHROMIUM-WINDOWS-MACROS-UI-017.
Evidence: `/tmp/rion-b76-mac-shell-artifacts/2026-09-06T09-23-42-759Z-darwin/phases/chromium-macro-ui-seed`;
log: `/tmp/rion-b76-mac-package.log`.

The focused macOS Chromium AppKit Macro UI seed/restart profile passes on the
working tree, including both entity-persistence prerequisites (four passing
phases). Report: `.desktop-e2e-artifacts/2026-09-06T10-11-50-318Z-darwin/report.json`.
The MACROS-UI-017 aggregate journey passes. Three adjacent source checks,
typecheck through the E2E build, scoped lint, source hygiene and coverage pass.
Windows execution of this common preparation correction remains pending.
Logs: `/tmp/rion-macro-native-ready-*`.

The pure Electron production build and production E2E isolation check also pass
after restoring production assets; documentation validation passes.


### Reuse the visible Settings mode for repeated toolbar updates

Windows job 101468262984 in CI 34026488170 at 9e54640b passes native reveal,
the 38px same-fullscreen geometry checks, and native pointer leave. Its history
contains normal/hidden/revealed/hidden. It then fails looking for app-main-sidebar
while changing the preference to pinned. The failure screenshot shows the main
renderer correctly on Preferences with settings-mode-sidebar. This contradicts
an initial suspicion of an incorrect WebDriver target: the driver simply tries
to navigate through the ordinary app sidebar again after already entering the
separate Settings mode.

The preference helper now opens Settings through the visible app sidebar only
when Settings mode is not mounted. It still selects Preferences visibly when
needed, clicks the same switch, and requires both UI and Core preference
acknowledgement. Repeated pin/unpin operations therefore stay on the actual
Settings screen. Native pointer/foreground helpers and product UI are unchanged.
This internal-only E2E correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. Full pin/unpin/restart acceptance remains
pending on the next candidate.
Evidence: `/tmp/rion-9e5-win-package-artifacts/2026-09-06T10-07-55-728Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-9e5-win-package.log`.

Sixteen adjacent toolbar checks, typecheck, scoped lint, source hygiene,
production E2E isolation and coverage pass. The next immutable candidate also
includes 08f05dc1's locally verified Macro UI native-readiness correction.
Checks: `/tmp/rion-toolbar-settings-mode-*`.


### Windows toolbar parity passes; route Role Quick Access through native focus

CI 34027029016 at ec0c4fb8 passes 17 Windows phases and 18 aggregate journeys.
Both fullscreen-toolbar seed/restart and Game Window UI seed/restart pass.
The complete toolbar evidence includes hidden/revealed/hidden/pinned/hidden,
exact 2px/40px insets and 38px same-fullscreen height deltas, persisted reverse
preference and normal exit. This closes the prior toolbar E2E blockers without
waiving later Windows, hardware or release gates.
Report: `/tmp/rion-ec0-win-package-artifacts/2026-09-06T10-19-35-713Z-win32/report.json`.

The next phase, quick-access-seed, fails to open the palette from the Role.
Native observations show its visible HWND lost foreground while the test only
requires document.hasFocus before WebDriver Ctrl+K. The existing macOS path
already focuses the exact AppKit host and submits a physical application chord.
The Windows path now shares the exact HWND/PID foreground and native scan-code
submission helper with F11; the private helper retains visible Role target
selection and restores the tracked main renderer afterwards. Ctrl+K uses the
existing physical modifier/key-up mechanism, adding only the K command mapping.
The requested window ID comes from the exact native Role inspection.

The page must still receive no K, the palette must actually open, Escape must
restore the exact source tab, and navigation/persistence checks remain mandatory.
No production shortcut routing, globalShortcut registration or synthetic DOM
open event is added. This internal-only E2E correction affects
CHROMIUM-WINDOWS-QUICK-ACCESS-015 and reuses the F11 preparation path covered by
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. AppKit retains its native adapter.
Windows execution remains pending. Log: `/tmp/rion-ec0-win-package.log`.

The focused macOS Chromium AppKit Quick Access seed/restart profile passes on
the working tree, including both entity persistence prerequisites (four passing
phases). QUICK-ACCESS-015 aggregate evidence passes with the retained native
AppKit focus and keyboard path. Report:
`.desktop-e2e-artifacts/2026-09-06T10-31-11-049Z-darwin/report.json`.
Twenty-eight adjacent input/toolbar/Quick Access checks, typecheck, scoped lint,
complete hygiene and coverage pass. Checks: `/tmp/rion-quick-access-native-*`.
This is macOS evidence only; native Windows Ctrl+K still requires the next CI.

Pure Electron production build and production E2E isolation pass after restoring
the production renderer; documentation validation also passes.


### Await transferred native ownership before the target Role click

macOS job 101466512710 in CI 34025834042 at e380920e fails
chromium-macro-cutover-topology-seed waiting for the post-Claim trusted click.
The fixture history instead records visibility, a new session and blur after
the transfer cursor. The test clicks immediately after the visible Claim button,
then checks the new native binding and automation readiness only after expecting
the click. The final artifact shows the transferred Role with native generation
2 and owner generation 3, so the target arrives after the unsafe click window.

The test now awaits the exact new tab/window binding, verifies increased owner
generation, and awaits automation-ready before clicking once. The shared native
binding wait requires the requested tab and window rather than accepting any
non-null prior binding. Existing platform identity assertions remain. Claim,
target click, macro start/stop and tab-close actions stay visible UI; no action
retry or mandatory reload is introduced. Core/Chromium product behavior is
unchanged. Both MACRO-MULTIROLE-005 and MACRO-OWNERSHIP-TRANSFER-010 Chromium
platform journeys are affected. Windows execution remains pending.
Evidence root: `/tmp/rion-e38-mac-shell-artifacts`;
log: `/tmp/rion-e38-mac-package.log`; checks: `/tmp/rion-macro-transfer-ready-*`.

A separate macOS package failure at 0d2d437c (job 101464991913) times out waiting
for the updater install journal acknowledgement in the packaged helper probe.
Its exact cause is not established by the timeout, and no larger timeout or
success-on-unknown rule is applied. It remains failure evidence pending further
native diagnosis; log: `/tmp/rion-0d2-mac-package.log`.

The focused macOS AppKit topology seed/restart profile passes on the working
tree. Report: `.desktop-e2e-artifacts/2026-09-06T10-38-17-594Z-darwin/report.json`.
This verifies the visible ownership-transfer and multirole journey with the
new ordering on macOS; Windows remains independently pending CI.

Pure Electron production build, production E2E isolation, documentation, source
hygiene, coverage and scoped lint pass after the local native run. Five adjacent
source checks pass; the E2E build includes typecheck. No Windows completion is
inferred from this macOS result.


### Windows Quick Access still fails; capture exact keyboard focus

CI 34027741452 at cb453a1a repeats the Windows Quick Access palette failure
(job 101471625005) after the same 17 passing phases and 18 passing journeys.
The fixture records a trusted qa-target click and no subsequent keyboard event;
exact foreground HWND/PID and native SendInput insertion checks pass. These
observations do not establish that the Role owns OS keyboard focus, nor do they
establish a production shortcut-routing defect.

The E2E helper now records the Role document focus immediately after native
foreground activation, plus the exact GUI thread's active/focused/root HWND and
GUI flags immediately before the physical chord. The bounded output contains
only focus identifiers and status; it does not log page contents or credentials.
GetGUIThreadInfo failure stays explicit diagnostic evidence, not successful focus.
No input retry, synthetic palette event or changed production routing is added.
This internal-only evidence improvement covers QUICK-ACCESS-015 and the shared
Windows FULLSCREEN-TOOLBAR-012 helper; native execution remains pending.
API contracts: [GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo),
[GUITHREADINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-guithreadinfo),
and [GetAncestor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor).
Evidence: `/tmp/rion-cb4-win-package-artifacts/2026-09-06T10-34-35-113Z-win32`;
log: `/tmp/rion-cb4-win-package.log`.

Separately, macOS package job 101463341760 in CI 34024645026 at c55f05a7 is
confirmed successful. This newer successful package cohort does not explain or
waive the subsequent 0d2d437c updater acknowledgement failure.

Twenty-five adjacent checks, typecheck, scoped lint, source hygiene, documentation,
coverage and production E2E isolation pass. Checks: `/tmp/rion-quick-access-focus-*`.
The next candidate includes the verified 4c6d396a ownership-transfer ordering fix.


### Share updater journal acknowledgement and eliminate the subscribe/read gap

Source diagnosis of CP-16 finds two duplicate journal-removal waiters: the Darwin
helper probe and the Windows packaged transaction probe both check presence
before subscribing. Removal between that read and subscription can be missed.
The Windows copy additionally catches every access failure as successful removal,
including permission and I/O failures. This is a concrete source defect; the
0d2d437c CI timeout alone does not prove which race or native failure occurred.

Both probes now use electronUpdaterJournalAcknowledgement.mjs. Its synchronous
filesystem watcher is installed before initial readback. Exact-name or unnamed
filesystem events trigger readback; only ENOENT acknowledges removal. Stream
failure/closure, access failures and the existing external deadline reject.
The observer closes on every terminal outcome. There is no polling, retry,
extended timeout or elapsed-time success, and native updater process isolation,
journal authority, signature verification and marker/version checks remain.

Nine focused tests cover initial absence, deletion while the first presence read
is pending, unrelated events, unnamed events, EACCES/EIO, stream error/closure,
deadline failure and real temporary-filesystem deletion. Together with the
Darwin helper and CI fixture suites, 24 adjacent tests pass. This internal-only
probe correction changes no user journey and is not physical Windows evidence.
Checks: `/tmp/rion-updater-journal-*`. Both packaged native transactions remain
subject to their exact-candidate CI gates.

MacOS package job 101468263048 in CI 34026488170 at 9e54640b is now terminal
success, including source Chromium E2E, previous-version fixtures, package
structure, the Rust-owned updater transaction and packaged AppKit Role black-box.
CP-16 records this newer complete package cohort. It predates the current
journal observer correction; it is not verification of that correction.

All 3,397 JavaScript tests pass. Typecheck, complete lint (zero errors, existing
warnings retained), hygiene, the Tauri build, restored pure Electron production
build and production E2E isolation pass. Native packaged acceptance of the new
observer remains pending; no desktop E2E profile ran locally for this tooling-only
change.


### Native Role click before Windows Quick Access; Settings native readiness

CI 34028481131 at 03d80de1 fails Windows Quick Access (job 101473612915).
The new evidence reports document.hasFocus=true with the game canvas active,
but GUI thread keyboard focus equals the top-level host HWND (2097618), with
no child focus. The palette stays closed. WebDriver's trusted DOM click does
not establish the same native keyboard target as an OS pointer click in this
child-host arrangement. F11 can still pass through its retained HWND-level hook.

The Quick Access helper now moves the OS pointer to the exact visible host's
content center, verifies that the hit window's root is the expected HWND, and
submits one native left-button down/up pair. The fixture's exact role and trusted
qa-target click receipt must arrive before physical Ctrl+K. The helper does not
reactivate the parent after the child click. Existing page suppression, palette,
Escape/source restoration and persistence verdicts remain. This internal-only
E2E correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; Windows execution is
still required. Native input insertion remains distinct from the fixture receipt.
Log: `/tmp/rion-03d-win-package.log`.

The same cohort's macOS Settings restart phase (job 101473612891) asserts a null
native runtime immediately after logical running status. Settings now waits for
the exact Role inspection's visible native owner with the expected platform host,
matching the Macro UI readiness boundary. Visible Open, macro Start/Stop and
preference persistence actions remain. Both platform SETTINGS-PERSIST-006 journeys
are affected; this is an internal-only E2E ordering correction.
Log: `/tmp/rion-03d-mac-package.log`; checks: `/tmp/rion-role-native-click-*`.


Further source inspection identifies a product routing gap: Windows Role child
hosts deliberately use focusable=false and WS_EX_NOACTIVATE for the native input
lane, while the focused top-level host's before-input-event handles only F11.
The host now recognizes Ctrl+K with the same shared classifier as Role pages,
suppresses both halves, ignores repeat, and dispatches once to its exact active
Core-projected tab through the existing Quick Access ingress. Current native
owner/lifecycle fences are checked before dispatch; closing/retired hosts cannot
issue requests, and Core errors reach the existing error owner. AppKit, the
Role-page interceptor and the required F11 hook retain their existing paths.
This product correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; it is not
claimed complete until its native E2E passes.

The host behavior suite plus Quick Access source-boundary suite pass 41 checks,
including key lifecycle, modifiers, target identity, ingress rejection and
retired-host suppression. Checks: `/tmp/rion-host-quick-access-*`.
The focused local macOS Settings seed/restart profile passes with all entity
prerequisites: `.desktop-e2e-artifacts/2026-09-06T11-02-57-645Z-darwin/report.json`.


The local Quick Access rerun does not reach its target phases: entity seed fails
waiting for the Workspace Role's fixture session. Core evidence ends with the
Role launching and shutdown pending. The runner records failure; a live-process
sample shows the main thread idle in the AppKit run loop rather than establishing
a synchronous main-thread deadlock. After the runner terminalized, its exact
remaining Electron process was killed; this cleanup is not successful E2E evidence.
Failure root: `.desktop-e2e-artifacts/2026-09-06T11-08-40-401Z-darwin`;
sample: `/tmp/rion-host-quick-access-macos-hang.sample.txt`.
MacOS Quick Access acceptance on this candidate therefore remains pending.

The first full suite catches a test-only destroyed-window getter in the new
retirement case; retaining the original WebContents before closing corrects the
test and all 41 adjacent cases pass. A later full suite hits the real filesystem
journal test's 1s deadline during concurrent package I/O. Thirty independent
native filesystem iterations pass (maximum 14.5ms). That real-I/O test now uses
5s within the existing 10s test budget; the deterministic deadline-failure test
keeps its exact 1s fake clock and production acknowledgement remains 120s.
Native Rust lint and all 1,643 Rust tests pass (four intentional ignored probes).

The final full JavaScript suite passes all 3,399 tests. Typecheck, scoped lint,
complete hygiene, restored pure Electron production build and production E2E
isolation pass. Settings macOS E2E passed before the Windows-only host routing
change; the later macOS Quick Access profile failed in its entity prerequisite as
recorded above. Windows Ctrl+K, the new native click and the shared updater
acknowledgement still require the next immutable CI candidate.


### Clarify the local launch trace while the combined candidate runs

The local 11:08:40 entity failure trace does not establish premature shutdown.
cleanExitDiagnosticsObserver also labels normal placeholder reconcile calls as
cleanExitRolePlaceholders. embeddedFollowRoleOwnership can return an EventBound
continuation, so the executor wrapper's completed observation does not mean the
native transition terminalized or its acknowledgement was lost. The shared
AppKit focus ABI already activates NSApp and makes the exact window key. No
speculative AppKit focus change is justified by this trace. The unresolved local
failure remains recorded; native acceptance of 79ea9b13 is CI 34029657056.

The earlier 03d80de1 cohort now has terminal success for both native validation
jobs and Windows Tauri desktop E2E. Its Chromium package failures and macOS Tauri
failure remain independent failures; those native passes do not close CP-15/18.


### Windows native click acknowledged; remove the incompatible child-focus precondition

CI 34029657056 at 79ea9b13 (Windows job 101476744058) reaches Quick Access after
its prior 17 passing phases. The exact native content click and trusted qa-target
fixture receipt pass; the next wait fails because document.hasFocus remains
false. Ctrl+K has not yet been submitted, so this does not test the new host
routing. This matches the explicitly non-focusable/no-activate child host.

Quick Access now proceeds from the trusted native click to the existing exact
foreground HWND/PID chord submission, without requiring the child document to
own OS keyboard focus. The fullscreen helper keeps its existing document-focus
check. Native focus diagnostics, the real palette-open assertion, K suppression,
Escape source restoration and persistence outcomes remain. This internal-only
E2E precondition correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; it does
not waive the product's host input or Quick Access outcomes. Native Windows
acceptance remains pending. Log: `/tmp/rion-79e-win-package.log`.

Twenty-one adjacent checks, typecheck, scoped lint, source hygiene, coverage,
documentation and production E2E isolation pass. No local desktop profile was
rerun for this Windows-only E2E precondition change.
Checks: `/tmp/rion-quick-access-host-focus-*`.


### Capture macOS failed-test stacks before a potentially unresponsive screenshot

Repeated macOS native failures can also time out during screenshot capture,
leaving no native thread evidence. The Tauri and unpackaged Electron WDIO hooks
now cache the authenticated probe's PID plus its ps parent/start-time/executable
identity at startup. On a failed test, the hook rechecks that identity and takes
one two-second macOS sample before requesting the screenshot. Changed/missing
identity and sampling failure are explicitly unavailable evidence; they do not
sample a replacement process or replace the original test failure. Windows skips
this OS-specific diagnostic. Packaged black-box admission is unchanged.

This is internal-only desktop test evidence, not product performance diagnostics.
No product UI, IPC, sampler, setting or recurring monitor is restored. No retries
or correctness polling is added. The .sample.txt artifact is included in the
existing failure artifact directory. Seven focused tests pass, including identity
change, unavailable/ambiguous identity, sample failure and non-macOS behavior.
A real read-only sample of an agent-owned local child process succeeds and the
child is then terminated. Evidence: `/tmp/rion-native-failure-sample-live.txt`;
checks: `/tmp/rion-native-failure-sample-*`.


### Current candidate progress and failure evidence (cbbf3c9a)

CI 34030205568 Windows Chromium job 101478202246 passes 23 phases and
21 of 50 journeys. Quick Access seed/restart and settings persistence seed/restart
now pass. The next physical trusted-input phase fails, causing ten dependent
journeys to report FAIL and leaving nineteen NOT_RUN; these are not ten
independent root failures. System settings/font application, full Macro and
recovery acceptance, and Windows packaging remain pending.

The physical input probe validates native key-down/key-up submission identities,
ordering and restored keyboard state, then fails the exact trusted DOM sequence.
The previous error omitted whether input was missing, partial or mismatched.
Its failure now includes the pre-dispatch DOM focus state, exact native receipts
and at most eight authenticated receipts for that probe sequence. No deadline,
trust assertion or focus-preservation requirement is relaxed. This is
internal-only evidence for CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its
existing dependent journeys; Windows execution of the new evidence is pending.

The local macOS Quick Access prerequisite still fails entity launch. At
`.desktop-e2e-artifacts/2026-09-06T11-38-34-243Z-darwin`, the failure hook now
successfully captures the admitted Electron process before screenshot cleanup.
The initial config-local sampler was unavailable across hook module instances;
a worker-global symbol registry now carries the admitted sampler, with a
separate-module handoff test. The captured main thread waits in the AppKit event
loop; this does not establish a synchronous main-thread deadlock or resolve the
missing launch receipt. The local profile remains failed, not waived. Product
performance diagnostics and high-refresh settings remain removed.

Validation for the failure-evidence changes: ten focused tests, typecheck,
full lint (23 existing warnings, zero errors), full hygiene, documentation,
coverage manifest, pure Electron build and production E2E isolation pass.
The first full suite reports 3406 passes and one diagnostics-export cleanup
observation timeout; that unchanged file passes all nine tests in isolation,
and the subsequent full suite passes all 3407 tests. This does not erase the
initial timing failure. No production Rust/native implementation changed in
this candidate. The local macOS Chromium Quick Access profile fails its entity
prerequisite as recorded above; Windows and Tauri hook acceptance require CI.
Evidence logs: `/tmp/rion-resume-*`.


### Release the E2E runtime lock before native geometry readback

Downloaded cbbf3c9a Tauri event artifacts narrow the native-control stalls:
Windows records `native-control-submitted` sequence 899 for the real minimize
click and the subsequent visible pointer/control receipts. macOS records the
restore submission (`action: normal`) at sequence 372 after the minimized
observation. Both control helpers then synchronously request a window snapshot;
the native action itself is not simply missing from the event stream.

Source inspection finds the snapshot holds the runtime-state mutex while calling
WebView position/size accessors for divider surfaces on both platforms and Role /
Workspace chrome surfaces on macOS. Those native accessors may wait for the UI
thread while presentation callbacks need the same mutex, contrary to the Tauri
scope's no-lock-across-native-calls invariant. The snapshot now clones the exact
handles and metadata under the lock, ends that statement, then reads native
geometry. The Windows Role/Workspace snapshot already follows this pattern.
This removes a concrete deadlock risk; native E2E must still establish whether
it resolves the observed stalls. No timeout, event fence or assertion is waived.

This internal-only change affects RUNTIME-TAB-TOPOLOGY-009 and
MACRO-OWNERSHIP-TRANSFER-010 through their existing full-profile phase. It adds no
product behavior or E2E omission. Chromium snapshot owners remain separate and
unchanged. Native macOS validation is running; Windows validation is pending CI.
Evidence: `/tmp/rion-cbb-tauri-{mac,win}-artifacts` and
`/tmp/rion-snapshot-lock-*`.

Native validation after the lock correction: macOS Rust lint passes; all 1643
Rust tests pass with four existing ignored tests; the desktop-e2e feature build
passes. The local `full --phase=p1-cross-domain-topology-force` profile records seed PASS and topology EXPECTED_FORCE_TERMINATION after the
spec passes, including the previously failing minimize/restore and Macro
ownership-transfer path. All three selected journeys report PASS. Report:
`.desktop-e2e-artifacts/2026-09-06T11-51-13-828Z-darwin/report.json`.
This is focused native evidence, not a full-profile pass or Windows validation.
Source hygiene, documentation and the unchanged coverage manifest also pass.


### Bound Windows file-dialog control discovery to native child HWNDs

At e9c528f8, CI 34031176626 Windows Chromium job 101480843434 fails earlier
than the trusted-input phase: the visible Workspace Web upload's helper is
terminated at its existing 15-second external deadline. The uploaded
`windows-native-file-dialog-progress.json` records `reading-dialog-controls`.
This run supplies no new keyboard-probe evidence and does not supersede the
previous exact trusted-input failure.

The helper previously searched the entire UIA descendant tree to discover only
the standard filename Edit (1148) and Open Button (1). Discovery now enumerates
real child HWNDs of the already owner-admitted #32770 dialog, with a finite 2048
child bound and exact class/control-ID matching. Only matching handles are
converted into UIA controls. Owner-admitted fallback windows must also be the
common-dialog class before any child lookup. Unique control cardinality, visible
clicks, enabled/offscreen checks, foreground ownership, exact native filename
write/readback, dialog closure and the page's File receipt remain required.
Neither the external deadline nor any product assertion changes. The native
helper still needs Windows CI execution; portable tests cannot prove Win32
control reachability. No product runtime code changes.

This internal-only correction affects CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028
through its existing fullscreen seed/restart profile. Eleven adjacent checks,
typecheck, scoped lint and source hygiene pass. Logs:
`/tmp/rion-native-dialog-controls-*`; native failure artifacts:
`/tmp/rion-e9-win-shell-artifacts`.

The same e9c528f8 CI's macOS Tauri job 101480843494 now reports full success,
without the later snapshot-lock correction. This confirms intermittency; it does
not invalidate the source-local lock violation or establish a single root cause.
The corrected snapshot's local focused pass remains separately recorded above.


### macOS package acceptance now includes the shared updater journal observer

CI 34029657056 at 79ea9b13, macOS Chromium job 101476744017, is terminal
SUCCESS. Its source AppKit Chromium E2E, prior-version updater fixtures, package
structure verification, packaged Rust-owned updater transaction and packaged
AppKit Chromium Role black-box E2E all pass. This candidate includes the
5bfe4c9e shared race-free journal-removal observer, so CP-16 no longer relies only
on the earlier 9e54640b package acceptance that predates that correction.

The job uses the existing ephemeral updater trust fixture; it is native package
and transaction evidence, not production-key acceptance or publication. Windows
package acceptance, the later exact-candidate cohort and CP-17/18 release gates
remain open. Authoritative step results:
`/tmp/rion-run-34029657056.json`.


### Exact Windows native key failure: submitted messages, zero DOM input

CI 34031575054 at 69ee94df, Windows Chromium job 101481944833, reaches the
physical input gate and fails. The new diagnostic records a visible no-activate
child, exact parent ownership and foreground parent; the input element is active
but document.hasFocus is false. Both Win32 key receipts are submitted within
deadline with ordered dispatch sequences and restored keyboard state. The only
preload receipt is the arm acknowledgement: no keydown or keyup is received.
This is missing DOM delivery, not a modifier/order mismatch. Log:
`/tmp/rion-69-win-package.log`.

The failure path now runs a bounded public sendInputEvent comparison on the same
WebContentsView and native child attachment, first visible and then hidden. Each
sample has its own authenticated sequence and records before/after native
projection observations and bounded DOM receipts. This is an experiment only;
the original native-key failure still throws and exits unsuccessfully even if
both public samples work. It does not establish full Role or held-key/ownership
parity, expand Electron's documented focus contract, or change the product
submission owner. CP-08's implementation decision requires reassessment against
actual product-path evidence, and CP-09 native acceptance remains open.

The independent physical input phase now runs immediately after shell smoke in
chromium-windows-smoke, before unrelated CRUD/setup phases. Its spec creates its
own native probe fixture and does not depend on entity-persistence state. No
journey, dependency, assertion or coverage target is removed. This internal-only
probe change affects CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its existing
Macro-dependent journeys; their failure remains a failed profile. Eight adjacent
checks, scoped lint and coverage validation pass; Windows execution of the
comparison remains pending.


### Pinned Electron input source audit and native file-dialog acceptance

The pinned [WebContents implementation](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_web_contents.cc#L3498)
looks up the exact RenderWidgetHostView, converts the supplied event and forwards
keyboard/mouse input to its RenderWidgetHost. That wrapper has no window-focus
check; downstream delivery conditions still require evidence. The pinned
[Windows focusability implementation](https://github.com/electron/electron/blob/v43.4.1/shell/browser/native_window_views.cc#L1332)
sets the no-activate style and removes focus when focusability is disabled.
These sources explain why native HWND-message routing and direct Chromium input
may differ; they do not override the public API's documented focus condition or
establish successful product delivery. The first same-attachment comparison attempt is recorded below.

CI 34031929737 at efd818cf, Windows Chromium job 101482931161, reaches the
physical-input phase after the native-dialog-control correction. Its preceding
visible file-upload phases pass; the new lookup therefore has native Windows
execution evidence, beyond portable source tests. The job still fails native
key input with zero DOM events, independently reproducing the 69ee94df result.
Log: `/tmp/rion-efd-win-package.log`. The parent/child ownership, restored keyboard
state and arm receipt remain valid; none can substitute for the missing DOM
acknowledgement.


### Cancel the failed probe sequence before independent public-input samples

CI 34032327982 at 9e74a2f4, Windows job 101484013474, reproduces missing native
DOM input. Both public comparisons fail preload arm admission: the original
unfulfilled sequence remains pending. No public input was submitted, so this
run is not evidence that sendInputEvent succeeds or fails on that attachment.
Structured report: `/tmp/rion-9e-public-comparison.json`.

The private probe protocol now cancels only the exact requested pending sequence
and returns an authenticated cancellation acknowledgement before another sample
can be armed. Wrong-sequence cancellation is rejected without changing pending
state. Each comparison also cancels its sequence on completion/failure. Native
input uses KeyA, visible public input KeyB, and hidden public input KeyC; delayed
events from an earlier sample cannot satisfy a later sample. The product gate
still fails its original native receipt requirement. No product IPC, input
adapter or deadline changes.

Executable preload-protocol tests cover exact cancellation, rejected overlapping
arms and a delayed native key failing the comparison. Ten focused/adjacent tests,
typecheck, scoped lint, source hygiene and coverage checks pass. This remains
internal-only work for CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009; native comparison
acceptance awaits the corrected candidate. Windows file upload acceptance is
independently confirmed by the efd818cf report: both fullscreen seed/restart
phases and CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028 pass.

Full-suite validation for the cancellation correction: the first run passes 3407
and fails two tests (real journal removal and escaped-helper pipe cleanup) at
existing native I/O deadlines. Both unchanged files pass all 14 tests in an
isolated recheck; the subsequent complete suite passes all 3409 tests. No timeout
or production behavior was modified to obtain that result. The initial failures
remain recorded as intermittent validation limitations. Documentation and
production E2E isolation pass. Logs: `/tmp/rion-input-cancel-*`.


### Same-attachment public input succeeds; replace the failed Win32 submission owner

CI 34032865591 at dffdfb6d, Windows Chromium job 101485549957, reproduces the
native key failure and successfully performs both independent public comparisons.
Visible KeyB and hidden KeyC each produce exact keydown/keyup sequences with
isTrusted true, matching modifiers and matching private frame/sequence identity.
The parent remains foreground and visible; the target remains non-foreground and
without thread focus. The hidden target remains natively invisible. Native
before/after handle tokens and geometry match. Structured evidence:
`/tmp/rion-dffd-public-comparison.json`; full log:
`/tmp/rion-dffd-win-package.log`.

CP-08's earlier decision to retain Win32 submission must therefore be revised:
it selected an implementation that does not deliver DOM events, while the pinned
public API delivers on the same attachment. The replacement will use a single
Chromium submission owner for Windows foreground/hidden input, retain the
required AppKit adapter and preserve Core identity/epoch/document fences plus
trusted DOM acknowledgement. The documentation's focus caveat remains a pinned
compatibility obligation, not a blanket future-version guarantee. Complete
product Role, pointer, held-key, retirement and Macro parity is still required.
The extra Windows child-host arrangement must be audited after submission parity;
its presence is not justified merely by the old HWND-message implementation.

The new `chromiumWebContentsInput.ts` leaf implements common event translation:
exact supported key codes and modifiers; view-local DIP conversion from CSS and
zoom without native parent offsets/display-DPI scaling; bounds rejection before
mouse-down; and propagation of partial submission failures. It returns explicit
webContents.sendInputEvent submission evidence and does not claim OS keyboard
state restoration or domain completion. Nine behavior tests, typecheck and
scoped lint pass. This is an implementation building block, not yet wired to the
product adapter. Next required work is owner/receipt integration, removal of
Win32 key/mouse submission, and the complete native product-path gate. No task
is marked complete from this leaf's tests.

A supplemental macOS native Chromium API sample at zoom 1.25 sends DIP (101,121)
and observes trusted middle-button down/up at integral DOM CSS (80,96), not
(80.8,96.8). The new leaf therefore floors its expected positive CSS readback after
zoom conversion; exact DOM acknowledgement remains required. Evidence:
`/tmp/rion-chromium-fractional-report.json`. This isolated API experiment is not
Windows or product Role acceptance. Pure Electron build and production E2E
isolation also pass for the new leaf's source graph.

- CP-08/09 working-tree continuation after `fad92f6b`: the Windows product
  attachment owner now calls the shared Chromium key/click primitives. Removed
  the 1,044-line Rust Win32 key/mouse submission module and its addon exports.
  ABI v6 adds an opaque read-only foreground/active/focus identity; submission
  compares exact native observations and viewport before every event and after
  delivery. Receipts explicitly name `webContents.sendInputEvent` and no longer
  claim Win32 scan codes or keyboard-state restoration. Trusted DOM completion,
  Core input epochs, cancellation and AppKit remain separate existing gates.
  The Windows physical probe loads these exact product modules through a closed
  E2E-only loader; it no longer maintains an independent native submission path
  or a failure-only public-API comparison. Journey
  CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 reflects the ABI/API change.
  Focused seven-file validation passed 50 tests, including stale identity,
  deadline, focus/viewport changes, hidden delivery and partial mouse submission.
  Native Windows product and full Macro acceptance remain pending. The extra
  per-Role native child attachment still requires a subsequent necessity audit.
- Latest historical CI `34032865591` at `dffdfb6d` completed with failures: both
  native validation jobs, checks, renderer, sanitizer and macOS Tauri desktop
  E2E passed; Windows Tauri desktop E2E and both Chromium package validation
  jobs failed. Earlier successful package/profile evidence is historical and
  does not certify this working-tree input replacement or final cutover.

- CP-08/18 continuation validation: all 441 Vitest files / 3,428 tests passed
  after moving the E2E loader into the existing `scripts/electron*` transition
  scope; the first full run correctly rejected its unscoped filename. Typecheck,
  macOS Rust lint, source hygiene and unchanged E2E coverage targets passed.
  The paired SYSTEM-SETTINGS-013 legal-document action now waits for the actual
  Open button to exist and become clickable after route navigation, instead of
  asserting a transient empty element collection. This addresses the observed
  macOS `dffdfb6d` failure location; native rerun remains required and is not
  inferred from the selector change.

- CP-08/18 final local continuation checks: macOS workspace Rust tests, stable
  `build`, production `build:electron`, and `check:desktop-e2e-isolation` passed.
  Full ESLint passed with the same 23 existing renderer warnings and no errors.
  Final pointer receipt checks compare view-local DIP with the requested zoom
  and integral DOM CSS coordinates rather than mixing native physical pixels;
  the two affected suites passed 23 tests and typecheck passed afterward.
  No macOS or Windows desktop E2E profile ran locally for this batch; paired CI
  and mixed-scale hardware gates remain pending.

- CP-08 child-host necessity audit, working tree after `6b672182`: extended the
  existing native Chromium API experiment with two WebContentsViews attached
  directly to one standard BrowserWindow. A visible sibling retains focus while
  the target stays hidden and unfocused at a nonzero view origin and 125% zoom.
  The experiment executes the same product key/click primitives through the
  closed E2E loader, records their submission receipts, and requires trusted
  Ctrl+Shift+KeyB down/up and middle-button down/up at DOM (80,96) from DIP
  (100,120). Local macOS Electron 43.4.1 / Chromium 150.0.7871.224 passed both
  samples and all 18 recorded scenarios; the native integration test passed.
  Report: `/tmp/rion-direct-host-probe/chromium-input-darwin.json`; log:
  `/tmp/rion-direct-host-native.log`. This is a standard-host experiment, not
  retained AppKit product acceptance or Windows evidence. Windows native probe
  execution and exact Role ownership/retirement parity must precede removal of
  the per-Role Windows child host. Product code and capability claims are unchanged.

- CP-08 exact candidate `6b672182`, CI `34034650727`, Windows Chromium job
  `101490402619`: foreground key and mouse submission passed their exact public
  API/native-fence/trusted-DOM assertions, advancing beyond the old Win32 input
  failure. The physical phase then failed before hidden submission because the
  sibling Role lacked document focus. Inspection found the probe attached its
  sibling native HWND only after checking focus. The continuation moves exact
  native attachment/projection before focus admission, matching product ordering,
  and adds failure-only native/Chromium visibility/focus evidence. It retains the
  strict focus assertions; hidden product parity is still unproven. Log:
  `/tmp/rion-6b-win-package.log`. The other jobs remain independently live.

### CP-08 remaining child-host replacement boundary

The Windows child-host owner is not only an input sender. The source audit at
`f603f190` identifies the following responsibilities that a direct Chromium
View owner must preserve. This is an implementation boundary for the existing
CP-08/09 task, not an additional product mode or permission gate.

| Current responsibility | Direct-View replacement and retained evidence |
| --- | --- |
| `#stageChild`, native attach/project, child HWND/DPI bounds | Attach the exact WebContentsView directly through the existing surface registry callbacks and public `contentView` ownership. Remove per-Role BaseWindow creation and Win32 child style/reparent/project code after native equivalence passes. Keep one exact runtime-parent native identity and read-only OS focus observation. |
| `reparent`, staged child rollback, binding/native generations | Preserve Core-issued logical ownership, exact View membership, binding revisions, cancellation before commit and source restoration on partial failure. Do not treat a parent-window handle as a unique Role identity; multiple Role Views share that handle. |
| `#focusForeground`, `#currentInputDeliveryMode` | Preserve the distinction between visible input admission and hidden input in an already-foreground runtime parent. Hidden submission must neither activate the target nor change the selected sibling. Native/Chromium focus observations and private trusted DOM receipts remain separate. |
| `syncPresentation`, `subscribePresentation`, held-key continuity | Forward committed View visibility changes through the existing presentation event path. `WindowsChromiumHeldKeyContinuityCoordinator` currently consumes child-hide events; it must receive the corresponding exact View-hidden event after child removal. No polling or inferred visibility. |
| `retire`, `dispose`, unexpected child close, quarantine | Detach and retire the exact Role View, revoke pending input and subscriptions, and retain parent-close/WebContents-destruction failure evidence. Quarantine must hide only the affected View; never hide or close the shared runtime parent and sibling Roles. |
| Input ABI and receipt validation | Remove child-style/child-HWND/single-child receipt claims together with their producers and consumers. Keep generation/epoch/frame/request identity, exact parent observation, monotonic submission receipts, view-local DIP conversion and complete trusted DOM event matching. |

The ordinary-host experiment at `f603f190` is evidence for API feasibility on
macOS, not a Windows product acceptance result. The Windows native experiment must establish direct-host feasibility. The
replacement must then satisfy the physical foreground/hidden gate with its actual
owner and receipt path; a failure caused by the old child topology is not a
prerequisite to retain that topology. Required regression scope includes paired Macro
hold/release, hidden continuity, reload, ownership transfer, exact retirement,
topology/recovery and native shortcut journeys. Retained AppKit presentation and
trusted input are outside this Windows child-host removal.

- CP-08 candidate `f603f190`, CI `34035021096`, Windows Chromium job
  `101491393586`: corrected sibling attachment order still failed the exact
  focus precondition. The failure now proves parent foreground/visibility,
  same-process/UI-thread ownership, exact child style and visible sibling HWND,
  while both sibling `webContents.isFocused()` and `document.hasFocus()` are
  false. Hidden target submission was not attempted. Log:
  `/tmp/rion-f603-win-package.log`. This removes attachment ordering as a
  sufficient explanation and motivates the direct-View replacement; it does not
  justify weakening focus assertions. The direct-host Windows native experiment
  remains in the live native-validation job.
- CP-08 direct-parent preparation: the existing read-only runtime-parent API now
  returns the same process/UI-thread-bound focus identity used by child input
  observations. One canonical helper binds foreground, active and focus slots
  without exposing HWND addresses. Parent readback rejects a foreign calling
  thread, and the TypeScript state stream rejects a malformed focus identity.
  No new native activation, window mutation, input API or polling was added.
  The retained child path still uses the helper until its replacement is
  accepted. Focused macOS Rust tests passed 9 cases; paired-platform host mocks
  and submission-owner tests passed before the additional malformed-focus case.

- CP-08/18 parent-focus preparation validation: native macOS `lint:rust`,
  workspace `test:rust` (1,640 passed, 4 ignored), stable build and production
  Electron build/isolation passed. The full 441-file suite passed 3,429 tests
  with two workers after the builds finished. Earlier default-worker runs
  separately hit the existing real filesystem journal-observation deadline and
  macOS escaped-helper cleanup indeterminate boundary. Both failures remain
  recorded; neither deadline nor success condition changed. The journal test
  now includes failure-only watch/access/unlink timestamps for future diagnosis.
- CP-15/16 CI `34035021096` at `f603f190`: Windows native validation stopped at
  `terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner` with
  `UnsafePath`; the Chromium API experiment had not run. CI now schedules that
  addon-independent experiment immediately after dependency installation in
  both native jobs, before unrelated Rust validation. Rust failure remains a
  failing gate. Investigating the updater concurrency failure is still required.
- CP-15 exact macOS Chromium artifact from `f603f190` stored the settings Macro
  delay as 160,000 ms, although its test attempted 60,000 ms. Replaced three
  duplicate clear/set sequences with one visible select-all/type helper using
  WebdriverIO's cross-platform `Key.Ctrl`, and assert the numeric field and
  committed Macro value before proceeding. Affected paired journeys are
  SETTINGS-PERSIST-006, MACROS-UI-017 and MACRO-NATIVE-EFFECT-018. The local
  settings-seed rerun stopped in its entity-restart prerequisite because the
  Open workspace button did not display; it did not validate the numeric fix.
  Report: `.desktop-e2e-artifacts/2026-09-06T13-26-27-224Z-darwin/report.json`;
  log: `/tmp/rion-number-edit-e2e.log`. This remains a failed prerequisite, not
  a passing settings journey.
- CP-08/15/16/18 continuation handoff: final local typecheck, six focused files
  (60 tests), full ESLint (0 errors; 23 existing renderer warnings), hygiene,
  documentation/coverage checks and production Electron build/isolation passed.
  The final full suite passed 441 files / 3,430 tests with two workers. The
  updater concurrency test passed locally on macOS; test-only error output now
  preserves the original ACL rejection reason for the next Windows failure
  without retrying a security mutation or changing the production error type.
  No successful desktop E2E profile is claimed for this working tree. Exact
  Windows direct-host feasibility, current native focus readback, updater
  concurrency and paired settings/Macro journeys remain pending CI.


### Direct-host viewport evidence and independent native gates

- CP-08, candidate `0bb4c9e6`, CI `34037646504`, Windows native job
  `101498649410`: all 18 samples received trusted events. The ordinary parent
  with a hidden Role View preserved the visible sibling focus, and the hidden
  Ctrl+Shift key pair matched exactly. The middle-click assertion failed:
  the hidden renderer still reported 300 by 200 CSS pixels rather than the
  expected 240 by 160 at 125% zoom, and received (100,120), not (80,96).
  This does not establish a platform-specific coordinate conversion rule.
- The revised experiment gives target and sibling separate ephemeral Sessions
  and subscribes to the target renderer resize event before changing zoom while
  visible. It requires the exact 240 by 160 viewport acknowledgement before
  hiding and submitting. The acknowledgement deadline can only report an
  indeterminate failure. macOS passed the revised native test; Windows remains
  pending the next candidate. Production hidden-viewport acknowledgement and
  removal of the per-Role Windows child host are not yet implemented.
- CP-15/18: CI uploads the early API report immediately and continues independent
  Rust validation even when that experiment fails. A final explicit failure
  guard preserves the API gate. Fourteen workflow/probe tests passed locally.
- CP-14/16: the concurrent terminal-receipt publication test now runs 32 fresh
  synchronized two-writer rounds, retaining exactly one winner and exact stored
  bytes. macOS passed all rounds and Rust lint. Windows must still reproduce or
  clear the prior UnsafePath failure with its original diagnostic cause; no
  production ACL handling or security requirement has been weakened.
- CP-15, candidate `0bb4c9e6`, macOS Chromium job `101498541979`: the
  `chromium-fullscreen-toolbar-restart` phase failed because the AppKit terminal
  event did not reach final flush. Previous full-profile success does not close
  this candidate's gate. This failure requires separate investigation; it does
  not provide settings numeric-edit acceptance evidence.
- Follow-up artifact inspection confirms normal presentation in both Core and
  the native host at topology revision 10. Clean-exit observations complete
  AppKit events, navigation, popup and Core-effect drains, then stop with
  `cleanExitRoleSurface` started. The unresolved boundary is Role surface
  cleanup, not missing proof of the fullscreen transition itself.
- Local continuation validation passed source hygiene, documentation and E2E
  coverage checks, plus all 441 test files / 3,430 tests with two workers.
  No new successful desktop E2E profile or Windows native result is claimed.

- CP-15 cleanup diagnosis continuation: added E2E-only observations around popup
  owner retirement, AppKit input-surface retirement and native WebContents close
  invocation/return/error. These distinguish a pending owner lane, a synchronous
  native call and a missing destruction event. Four executable tests cover
  macOS/Windows role paths, original receiver/arguments, unchanged exceptions
  and the distinction between close return and the exact destroyed event.
  Five adjacent source-boundary tests, typecheck, focused ESLint, source hygiene
  and the E2E application build passed. Production code is unchanged; the E2E
  omission classification for the added observer is `internal-only`.
- Candidate `b7e843e5`, CI `34038576176`, remains live. The Windows job reports
  its early direct-input step successful, but its raw report was not available
  from the artifact listing at observation time. Do not close the direct-host
  evidence gate until that report or complete native test log is inspected.

- The early probe step uses `continue-on-error`, so its API-reported successful
  conclusion alone cannot establish its original outcome. The probe now saves
  partial samples and the exact thrown error before cleanup on failure, in
  addition to its existing complete success report. This avoids losing viewport
  acknowledgement failures before the final write. The final CI failure guard
  still checks the original step outcome.
- Candidate `b7e843e5`, Windows Chromium job `101501064854`, failed the existing
  child-host physical probe: parent foreground and visible sibling HWND were
  observed, but the sibling WebContents/document did not own focus. No hidden
  product input was submitted. Direct-View replacement remains required work;
  no focus precondition has been relaxed.


### View-owned input boundary preparation

- CP-08: added `ChromiumViewInputSubmission` for the direct-View replacement.
  Its identity binds Role/surface/native generations, binding revision, exact
  WebContents ID and native parent identity. Admission requires current View
  membership, parent foreground/visibility, matching focused contents and View
  visibility, exact zoom/bounds and an unexpired request. Every individual
  Chromium event and final receipt rechecks the observation. Reentrant delivery
  cannot interleave events. The receipt claims View ownership and API submission,
  never a per-Role HWND, child style or trusted DOM acknowledgement.
- This boundary is prepared source with focused tests, not yet wired into the
  production attachment coordinator. CP-08 stays in progress: replacement of
  child creation/reparent/retirement, receipt consumers and the physical product
  probe is still required. The AppKit product input path is unchanged.
- The focused new/existing input-owner suite passed 46 tests. Paired platform
  cases exercise invalid admission, a different View sharing the same parent,
  focus/binding/bounds/deadline changes after mouseDown, mutable observations and
  reentrant calls. Typecheck, focused ESLint and source hygiene passed.
- Candidate `b8711b59`, CI `34038920943`, Windows raw probe artifact now confirms
  failure before the direct hidden samples: the zoom acknowledgement timed out
  with an actual 300 by 200 viewport. All preceding 12 samples received events.
  Separate Sessions alone did not fix the precondition while the sibling covered
  the target. The next experiment acknowledges zoom while the target is focused
  and uncovered, before adding/focusing the sibling, then tests hidden delivery.
  macOS passed this revised native experiment. Windows remains pending.
- CP-11 retains the separate requirement to handle zoom changes on already hidden
  or occluded product Views. Preconfiguring the experiment while visible does not
  satisfy that product behavior or justify guessing a platform-specific scale.


### Windows direct-View feasibility established

- CP-08, candidate `78690558`, CI `34039248720`, artifact
  `chromium-input-windows-latest-34039248720-1`: all 18 API samples received
  events. The direct hidden target retained its exact 240 by 160 viewport at
  125% zoom; Ctrl+Shift+KeyB down/up and trusted middle down/up at CSS (80,96)
  matched. Both Views remained attached, the target remained hidden and
  unfocused, and the sibling retained focus before and after submission.
  This establishes the Windows API feasibility gate for removing the dedicated
  child host, alongside the prior macOS native experiment. It does not close
  product Role/Macro lifecycle parity or hidden-zoom update handling.
- The native validation suite now exercises `ChromiumViewInputSubmission` against
  the real Windows parent-readback addon in the same direct-View topology.
  The early addon-independent experiment stays separate. The new later test
  requires exact native parent/focus identities, complete trusted DOM events,
  monotonically increasing submission receipts and no child-HWND identity claim.
  CI uploads this later owner report separately, including failed partial samples.
- Local validation: the API experiment passed on macOS; the Windows-specific
  native parent-owner case was explicitly skipped on macOS and remains pending
  Windows CI. Fifty focused owner/workflow tests, typecheck, focused ESLint and
  source hygiene passed. The additional native test is internal verification,
  not a new product journey; E2E omission classification is `internal-only`.
- CI `34038576176` was cancelled after its Windows product probe had conclusively
  failed and newer `34038920943` was confirmed running the identical Windows
  Rust workspace checks plus the added cleanup diagnostics. Cancellation was
  for superseded failed source, not an elapsed observation deadline. Runs
  `34038920943` and `34039248720` remain distinct evidence candidates.

- The View submission owner additionally checks the actual WebContents ID and
  destroyed state independently of the observation adapter, before admission
  and every event. The focused View-owner suite now passes 38 cases.
- The Windows shell E2E job also runs the native View-owner test using its built
  addon after the existing smoke attempt, including when the old child-host
  physical test fails. The existing failure remains a failed job; this only
  prevents that known failure from suppressing independent replacement evidence.

- Windows native job `101502104765` at `b8711b59` reports successful Rust
  formatting/lints and workspace tests, then entered Electron native validation.
  The source includes the 32-round terminal-receipt concurrency regression.
  This run did not reproduce the earlier UnsafePath error; its historical
  failure remains recorded and no unproven ACL root cause or production fix is
  claimed. The new View-owner native test is not part of that older candidate.

- Final local continuation validation passed 443 test files / 3,472 tests with
  two workers, plus typecheck, focused lint, documentation, source hygiene,
  coverage and production E2E isolation checks. No local Windows native result
  or new successful desktop E2E profile is claimed for these changes.


### Direct View attachment and retirement implementation

- Added `ChromiumViewAttachmentCoordinator`, implementing the existing attachment
  port without creating a window, calling SetParent, or assuming one View per
  parent. It rejects aliased WebContents owners, keeps an immutable parent
  binding fence, and supplies the exact `ChromiumViewInputSubmission` owner.
  A move suspends source admission/subscriptions before native mutation, then
  commits the target or restores the exact source and visibility. Failed
  rollback quarantines only the affected View. Exact parent-close and contents
  destruction events revoke admission. Committed visibility changes publish the
  presentation events required by held-key continuity. Disposal revokes this
  adapter's bindings; the registry retains View and shared-parent lifetimes.
- The Windows native owner probe now uses this attachment coordinator before
  submitting hidden input, then checks exact ownership retirement. Product
  bootstrap and the current Windows trusted-input receipt consumer still need
  conversion before the old child-host coordinator can be deleted. This is an
  explicit remaining CP-08 implementation task, not a completed product cutover.
- Candidate `097552bc`, CI `34039832262`, Windows package job `101504456483`:
  the real native View-input-owner test passed in 1.12 seconds after the known
  old child-host product probe failed. This validates native parent/focus
  identities, trusted hidden key/middle events, exact zoom coordinates and
  monotonic View receipts. It predates the new attachment coordinator above;
  that coordinator's native result remains pending the next candidate.
- The earlier `b8711b59` cohort reports successful macOS and Windows Tauri desktop
  E2E jobs (`101501993987` and `101501993926`). These do not establish Chromium
  product parity or exact-current-candidate completion.

- Local attachment continuation validation passed 78 focused owner/lifecycle and
  workflow tests, typecheck, focused ESLint, source hygiene, documentation and
  production E2E isolation. The macOS API experiment passed with the expanded
  closed loader. No new desktop E2E profile or native Windows attachment result
  is claimed. The staged manager has no product route yet; the E2E omission
  classification for this preparation is `internal-only`.


### View receipts accepted by the existing trusted-input consumer

- The Windows trusted-input contract now distinguishes legacy child-HWND and
  direct-View identities/probes/submissions. The existing adapter accepts View
  receipts through its existing pending lane, exact private-frame DOM matching,
  cancellation and terminality path. View validation checks actual parent and
  WebContents identity, focus, membership, visibility, bounds and zoom; it does
  not invent child-HWND fields. The legacy branch remains explicitly typed until
  bootstrap replacement and deletion, not as a user-selectable alternative.
- Shared View identity/observation validation is used by both the producer and
  consumer. The consumer freezes its admission snapshot and compares canonical
  facts before native submission, even if a producer reuses its probe revision.
  Changed admission terminalizes as superseded before events. Mismatched identity
  or focus after submission remains indeterminate. Native submission alone does
  not complete an action without the matching trusted DOM events.
- Added `ChromiumViewTrustedInputHost` to bridge the attachment manager to that
  consumer, preserving stable native-port identity, exact observation revisions
  and revocation of previously resolved bindings. The real Windows probe now uses
  the bridge for key/mouse submission. Visible Core focus admission and product
  bootstrap conversion are still required before deleting the child coordinator.
- Candidate `2de6e0d6`, CI `34040672231`, Windows job `101506723396`: the native
  View attachment/input/retirement probe passed in 1.54 seconds. The old physical
  child-host product test still failed. This result predates the new consumer
  bridge above, whose native validation remains pending the next candidate.
- The same candidate's macOS package job `101506723417` failed in
  `chromium-macro-standby-recovery`: a fixture keydown had arrived, but the test's
  immediate read did not yet find the normal KeyS hold terminal receipt. The
  observer records receipts only after `coordinator.execute` completes, so DOM
  delivery is not a terminality barrier. The test now waits for the exact matching
  terminal record, then asserts its status once; non-applied outcomes are not
  retried toward success. Paired journeys are
  CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023 and
  CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023. Their new desktop runs remain pending.
- Local validation passed 111 focused ownership/adapter tests, then all 445 files
  / 3,512 unit tests with two workers. The subsequent standby E2E correction passed
  its 4 adjacent source checks and typecheck. Native macOS Rust lint and workspace
  tests passed (1,640 passed, 4 ignored), and coverage/source hygiene passed.
  The raw macOS API experiment passed with the expanded loader; no new Windows
  native result or successful local desktop E2E profile is claimed for this tree.

- Follow-up contract audit confirmed Core starts input epochs at zero. The View
  producer now accepts canonical `0` while continuing to reject `00`; 69 focused
  producer/host/consumer tests and final typecheck passed after this correction.
  The production Electron build and E2E isolation check also passed.


### Windows product bootstrap now uses direct View ownership

- Replaced the production `WindowsChromiumInputSurfaceAttachmentCoordinator`
  construction with `ChromiumViewAttachmentCoordinator`,
  `ChromiumViewTrustedInputHost` and exact View focus admission. The main-process
  configuration no longer supplies a per-Role BaseWindow factory. Standard
  Electron View membership and WebContents focus are paired with the existing
  read-only Windows parent-foreground proof; no HWND attachment/projection call
  is made by the new product composition. AppKit composition is unchanged.
- Visible focus admission subscribes before activation and waits for the exact
  View/parent observation. Hidden admission requires an already-foreground parent
  and never activates a parent or View. Core's deadline can fail admission, never
  establish success. Ownership movement, retirement, quarantine, presentation
  hiding and disposal supersede pending focus and release its subscriptions.
  Synchronous native callbacks cannot authorize input on a retired attachment.
- The existing trusted DOM consumer still owns key/mouse terminality. This change
  is `lower-layer-covered` behavior-preserving composition work, with focused
  attachment, focus, parent binding, host and consumer tests. Affected existing
  journeys include CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009,
  CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 and the paired
  MACRO-STANDBY-RECOVERY-023 journeys. No desktop E2E profile has passed for this
  new composition yet; Windows and both hardware-extended profiles remain pending.
- Previous candidate `71cb9fea`, CI `34042033350`, Windows package job
  `101510430478` again failed the legacy child-HWND physical probe because its
  visible sibling WebContents did not own focus. Its subsequent direct-View
  owner probe passed. The old physical probe must be converted to the new product
  mechanism while preserving foreground/background trusted DOM, modifiers,
  mouse coordinates and focus-preservation assertions. That probe and the unused
  child coordinator/native attachment implementation have not yet been deleted.
- Local full Vitest completed 446 files / 3,528 tests with two workers. After the
  subsequent presentation-invalidation addition, the final focused four files
  passed 47 tests. Typecheck, lint (zero errors, existing warnings), hygiene and
  native macOS Rust lint passed. Native Rust tests and production Electron build
  results are recorded after their completion below. No Windows native product
  acceptance or physical hardware evidence is inferred from these portable tests.

- Final local completion: macOS Rust workspace tests passed (1,640 passed,
  4 ignored), the stable build passed, and the production Electron build and
  desktop E2E isolation check passed after restoring Electron renderer output.
  The added product-composition case passed with its three adjacent tests;
  final typecheck and source hygiene passed. No local desktop E2E profile ran
  in this batch. Previous candidate `71cb9fea` also completed both stable desktop
  E2E CI jobs and macOS native validation successfully; its Chromium macOS
  package and Windows native jobs were still running at this checkpoint.

### Direct-View physical gate and empty-main-bundle correction

- The Windows physical probe now loads the same View attachment, parent binding,
  focus admission and input host classes as product composition. It creates one
  runtime parent with two independent Session/WebContentsView owners, removes
  all child-HWND attach/project/probe calls from this gate, and retains the
  private isolated-preload frame/sequence/trusted-DOM checks. The evidence records
  actual View membership, exact parent/WebContents identities, foreground and
  hidden admission, and unchanged foreground sibling ownership.
- The probe waits for a visible renderer resize acknowledgement at 125% zoom
  before checking left-click CSS coordinates. Hidden input now checks Ctrl+Shift+B
  modifier flags and middle-button down/up/auxclick coordinates. Wrong modifiers
  and coordinates are rejected by the private preload. No hidden focus repair or
  hidden viewport acknowledgement is inferred. Journey
  CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its manifest description were
  updated without lowering priority, outcomes or coverage targets. Its native
  Windows result remains pending; the old child coordinator/native implementation
  remains outside product composition until that verification permits deletion.
- Candidate `fb349add`, CI `34042924322`, macOS package job `101512797588`
  exposed an empty `out/main/index.js` before any desktop journey could start.
  The previous local build commands exited zero, but their 0-byte main output
  contradicts executable-build acceptance; the preceding checkpoint must not be
  read as successful runtime validation. The E2E verifier correctly rejected it.
- Local isolation identified the pinned electron-vite CommonJS-shim heuristic:
  the new private method spelling `#require(...)` triggered its textual detector.
  Its static-import scanner inserted the shim into a later string literal and
  the build silently emitted an empty main entry. Omitting only that plugin
  produced 1.43 MB; renaming the private method to `#requireRecord` produced a
  1.43 MB entry with the original complete plugin set. No bundler safety or E2E
  check was disabled. An explicit main-entry output guard now rejects empty or
  missing entries, and tests build both actual production and E2E entry points
  with the pinned Electron plugins and verify their startup code.
- Initial physical-gate/source checks passed 11 tests, the expanded private
  preload passed 4 behavior tests, and the actual bundle/attachment tests passed
  29 tests. A native macOS Chromium API experiment passed with the expanded closed
  loader. These are not Windows physical-input or AppKit desktop parity claims.
  Final local checks and the focused macOS shell phase are recorded below once
  their live processes complete.
- Final unit regression passed 448 files / 3,540 tests with two workers; the last
  focused bundle/probe/preload check passed 10 tests. Typecheck, lint (zero
  errors), hygiene and coverage passed. The local
  `chromium-macos-appkit-smoke --phase=chromium-shell-smoke` run passed its shell
  test with real Chromium and Rust startup (artifact directory
  `.desktop-e2e-artifacts/2026-09-06T15-50-01-589Z-darwin`). This is a focused phase,
  not a new full AppKit profile result. Relevant shell journeys are
  CHROMIUM-MACOS-APPKIT-SHELL-001 and its Windows pair; Windows remains pending.
  Native macOS Rust lint passed; its workspace tests and the subsequent stable /
  restored production Electron builds were still running at commit preparation.
- Completion of those local handles: native macOS Rust workspace tests passed
  (1,640 passed, 4 ignored). Both stable and restored production Electron builds
  passed. The restored executable main entry contains 1,431,638 bytes, and
  production desktop E2E isolation passed. Code candidate `242ab2f9` is being
  validated by CI `34043767144`; no new Windows physical verdict is claimed yet.
  The migration contract and Macro runbook now describe the direct-View ownership
  boundary instead of the superseded WS_CHILD/ABI-v5 gate; eight adjacent
  contract/source checks passed after that documentation update.

### Windows physical View gate passed; production dependency cleanup

- Candidate `242ab2f9`, CI `34043767144`, Windows package job `101515054943`
  passed `chromium-windows-trusted-input-physical` in 1.2 seconds. The raw
  `chromium-shell-e2e-Windows-34043767144-1` artifact confirms two exact sibling
  Views in separate Sessions, a 480x320 renderer acknowledgement for the 600x400
  DIP View at 125% zoom, trusted foreground KeyA/left-click events, hidden
  Ctrl+Shift+B down/up, and hidden middle down/up/auxclick at CSS (80,96).
  Hidden presentation and the foreground sibling were preserved. This proves
  the new physical gate, not every Core Macro/reload/topology journey.
- The same Windows smoke subsequently failed in
  `chromium-fullscreen-toolbar-seed`: the visible Role document did not gain
  focus. Its helper clicked through WebDriver before native foreground admission.
  Both Role-origin shortcut branches now bring the exact native parent forward
  and issue a physical content click, require the exact Role's trusted fixture
  click, then confirm document focus before sending native F11/Ctrl+K. The focus
  requirement is retained. The updated FULLSCREEN-TOOLBAR-012 manifest describes
  this primary-action provenance; native Windows verification remains pending.
- Public parent/presentation ports moved out of the legacy child coordinator.
  Product bootstrap no longer requires the old attachment addon interface.
  E2E attachment observation now wraps the actual View manager, and its loader
  no longer loads the unused legacy submission owner. Actual production and E2E
  bundle tests reject legacy HWND attachment/ABI entry points, while legacy
  implementation tests remain until full replacement parity permits deletion.
- The interrupted local validation had no remaining process handles or live
  compiler/test processes. Its incomplete full-test log included a macOS DMG
  resource error, so it was not accepted. A fresh single-worker full regression
  passed 448 files / 3,540 tests; no timeout or failed assertion was converted to
  success. After the shortcut helper update, five focused files passed 31 tests.
  The native macOS Chromium API experiment also passed with the reduced loader.
  Rust and final build completion are recorded after their active handles finish.

- Final local completion: native macOS Rust lint and workspace tests passed
  (1,640 passed, 4 ignored); typecheck, lint, hygiene, coverage, stable build,
  production Electron build and E2E isolation passed. No new local desktop E2E
  profile ran for the Windows-only native shortcut sequence. Windows smoke and
  both hardware-extended profiles remain pending their exact native execution.

### Retained Windows foreground observation separated from legacy attachment

- Moved `readWindowsRuntimeForeground`, its exact owner/focus/presentation
  classifier and tests to `windows_runtime_foreground.rs`. Shared native handle
  parsing, opaque focus identity and error construction now live in
  `windows_native_handle.rs`; the retained shortcut owner imports those helpers
  directly instead of depending on the legacy child-HWND probe module.
- The seven moved implementation bodies were compared against the prior source
  and preserved. Export names, hash domains, identity fields, statuses and error
  messages are unchanged. The old attachment/probe still uses the same helpers
  while awaiting final deletion; no native input capability or platform fallback
  was added. The stable Tauri path is unaffected by this Node-addon module split.
- Fourteen focused native Rust tests passed, including new pure handle parsing
  cases for exact nonzero addresses and null/wrong-width rejection. Twenty-two
  focused adapter/bundle tests passed. The rebuilt macOS Node addon exports the
  same `readWindowsRuntimeForeground` function and rejects its call off Windows
  with the existing error. This verifies registration and the non-Windows stub,
  not native Windows foreground observation after the split.
- The capability audit now reflects direct View input and the retained read-only
  native boundary. The earlier wording that Windows still retains native input
  submission was obsolete. Current Windows fullscreen/Macro parity remains
  pending CI `34044533718`; this module split requires its own Windows native
  compilation/physical gate after submission.
- Final local validation passed: 448 Vitest files / 3,541 tests with one worker;
  native macOS Rust lint and workspace tests (1,642 passed, 4 ignored); typecheck,
  lint, hygiene, coverage, stable build, production Electron build and desktop
  E2E isolation. No local desktop profile ran for this internal-only module move.
  Windows native compilation and both hardware profiles remain pending.

### Windows direct-View fullscreen pointer boundary follow-up (2026-09-07)

- Candidate `56bbc188`, CI `34044961585`, Windows package job
  `101518279527` reproduced the fullscreen toolbar auto-hide failure. The
  preceding `ad491b29` evidence shows normal content inset 40, fullscreen hidden
  inset 2, and successful native edge reveal back to 40; it does not prove hide.
- The Windows host now consumes Electron's public `before-mouse-event`
  `mouseLeave` event in addition to the existing toolbar DOM pointerleave.
  Native embedded View boundaries need not deliver the latter to the toolbar
  element. The same serialized chrome owner applies auto-hide, retaining pinned
  preferences and exact native-owner/window-generation/topology checks. Closed
  hosts remove the native listener; input is not suppressed or replayed.
- `CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012` now waits for hide directly after
  native pointer motion, before any Role-page click can supply another trigger.
  The retained macOS AppKit path is unchanged. Focused controller, factory and
  journey-source checks passed: 3 files, 62 tests. Windows physical verification
  of this correction remains pending; CP-08/11/12/15/18 are not closed by mocks.
- Local validation for the pointer correction passed: full Vitest 448 files /
  3,543 tests with one worker; macOS Rust lint and workspace tests (1,642 passed,
  4 ignored); TypeScript, ESLint (existing warnings), source hygiene, E2E coverage,
  stable build, production Electron build and production E2E isolation. No local
  desktop E2E profile was run for this Windows-only native event change; both
  exact-candidate desktop profiles, Windows native checks and hardware gates
  remain pending CI/physical execution. Production renderer outputs are restored.


### Exact candidate 3154a542 native acceptance and parent focus ordering

- Local `chromium-macos-appkit-smoke` completed successfully at `3154a542`:
  all 56 configured phases passed. Evidence is in
  `.desktop-e2e-artifacts/2026-09-06T16-30-43-149Z-darwin` and
  `/tmp/rion-3154-macos-smoke.log`. This covers AppKit fullscreen/tab chrome,
  foreground/background Macro input, standby/reload/topology/terminal cleanup,
  system settings/font application, Session isolation/reset/restart and recovery.
  It is not mixed-DPI/hardware or Windows evidence.
- CI `34045623644`, Windows Chromium package job `101520039873` passed 24
  phases, including direct-View physical input, both fullscreen toolbar phases,
  Quick Access, ordinary settings persistence and Macro UI. The native pointer
  event correction is verified. The later `chromium-macro-native-effect` failed:
  fixture focus sequence 327 was followed by blur 328 within 3 ms; Core accepted
  focus `browser-action-2`, then rejected actions 3 and 4 with
  `SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE`. No KeyA receipt arrived.
- Pinned Electron 43.4.1 restores/focuses a BrowserWindow's own WebContents in
  [BrowserWindow::OnWindowFocus](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_browser_window.cc),
  before [BaseWindow's deferred focus event](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_base_window.cc).
  View focus admission now distinguishes that exact parent event from generic
  geometry/state changes. When the parent was not foreground, it waits for that
  event before focusing the Role View; transient View focus cannot complete the
  request first. Already-foreground parents avoid redundant show/focus calls.
  Existing Core deadline, cancellation, hidden-View and ownership checks remain.
- The same CI candidate's stable Windows E2E job `101520039954` failed the
  Game Window move event after sequence 25, while stable macOS E2E job
  `101520039990` returned an indeterminate AppKit tracking-loop fullscreen
  mutation. These remain unresolved gates; earlier green candidates do not
  overwrite these results. System-settings absence/font assertions occur after
  the Windows Macro phase, so CP-02/06/13 remain pending Windows acceptance.
- The physical Windows probe now uses one sandboxed `BrowserWindow` with its own
  isolated host Session and two Role Views, matching the product parent class.
  It no longer uses a root-WebContents-free BaseWindow that cannot exercise this
  focus-restoration boundary. All foreground/hidden trusted-event, modifier,
  coordinate, exact membership and sibling-focus assertions remain required.
- Focus-order correction validation: 4 focused files / 29 tests, then the full
  single-worker Vitest suite (448 files / 3,547 tests); native macOS Rust lint
  and workspace tests (1,642 passed / 4 ignored); TypeScript, ESLint, source
  hygiene, coverage manifest, stable build, production Electron build and E2E
  production isolation all passed. The full macOS desktop run above predates
  this Windows-only focus correction; its Windows physical/product result is
  pending the next candidate. Production outputs are restored.


### Native acceptance at 280027d7 and E2E event-order corrections

- CI `34046674835`: Windows native job `101522937996`, macOS native job
  `101522938005`, Windows Tauri E2E job `101522843120` and macOS Tauri E2E job
  `101522843158` all completed successfully. These are exact-candidate results;
  the earlier Tauri failures remain historical evidence rather than current
  failures. CP-14's native validation gate is satisfied at this source state.
- Windows Chromium job `101522843156` passed the BrowserWindow-backed physical
  input gate and reached Macro native effects. All Core browser actions 2–7
  completed. Fixture evidence records KeyA, all three mouse down/up pairs and
  semantic events; right-down 336 has buttons 2, right-up 337 has buttons 0,
  right auxclick 338 and contextmenu 339 both have buttons 0 and are trusted.
  This verifies the parent-activation focus correction, but the complete Macro
  journey still failed its macOS-only contextmenu buttons expectation.
- The paired Macro E2E now expects Windows contextmenu after right-up with
  buttons 0, and macOS contextmenu before right-up with buttons 2. It retains the
  exact eight trusted key/mouse transitions, semantic target, focus and visible
  Start/Stop assertions. Chromium's
  [mouse-up context-menu branch](https://chromium.googlesource.com/chromium/src/+/d6c4a0cff4b083e7143eb4026351ea8c7450450a/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc)
  documents the platform distinction; the pinned runtime's raw fixture evidence
  above is the Windows acceptance source.
- Separately, the stable native-control E2E helper now returns the cursor captured
  before applying the control. Placement/DPI waiters use that cursor because
  native callbacks may commit before `native-control-submitted` is recorded.
  The `3154a542` Windows artifact already persisted the requested x35/y45,
  width820/height580 bounds despite the waiter timing out after sequence 25.
  Both event orders are covered for both platforms; exact generation, native
  handle, geometry and persistence assertions remain.
- The local stable `full --phase=seed` run at
  `.desktop-e2e-artifacts/2026-09-06T16-53-01-101Z-darwin` passed the initial
  move and repeated close/reopen section, then failed script execution during
  the rapid native maximize transition at line 507. It is not a passing E2E
  result. No product runtime mutation or longer timeout was introduced for it.
- Local checks for these E2E-only corrections passed: focused native-control and
  Macro journey checks (3 files / 8 tests), full single-worker Vitest (449 files /
  3,551 tests), TypeScript, ESLint, source hygiene, coverage manifest, production
  Electron build and E2E production isolation. Rust/product code is unchanged
  from the paired native-green `280027d7`. Revised Windows journey acceptance
  and the local rapid-transition failure remain for the next native run.


### CP-10 actual production helper lifetime and persistence

- A new native integration test bundles the pinned production Electron main
  entry in a private scratch directory and invokes its existing framed helper
  mode. Each apply, verify, rollback and rollback-verify operation runs in a
  separate Electron process; the preceding child must exit cleanly first.
  Verification binds the actual framed response and child exit digest. No
  renderer build output or test-only product bridge is used.
- This exposed a real migration LocalStorage lifetime failure: the codec retained
  WebContents but dropped its owning WebContentsView during asynchronous
  navigation. The actual helper returned LocalStorage readback failure with
  ERR_FAILED for its controlled in-memory origin. The codec now retains the View
  until WebContents closure completes. Session security, data scope and
  authoritative completion boundaries are unchanged.
- macOS native integration passed both plain text and UTF-16 text containing a
  NUL, with one secure HttpOnly cookie and one LocalStorage entry verified across
  fresh processes, then zero entries after rollback. Adjacent migration/helper
  tests passed (3 files / 44 tests). The native test glob already reaches both
  macOS and Windows native CI jobs; Windows execution remains pending.
- E2E omission for this lifecycle correction: `lower-layer-covered`, using the
  actual production helper integration above. This does not establish the
  consented Chrome Profile import UI or Rust journal transaction acceptance,
  and does not replace existing Role Session reset/isolation journeys.

### Windows Chromium acceptance at cbdd80fe

- CI `34048350410`, Windows Chromium job `101527359533`, passed Macro native
  effects after the platform-correct contextmenu assertion. The next background
  tab scenario failed during its initial foreground shortcut, before testing
  hidden hold continuity. Core received `managedShortcutPhase:351`; browser
  action 1 failed with `SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE`. Thus
  the missing Digit2 event is not proof of a hidden-input delivery failure.
- The exact readiness observation at rejection was not included in the artifact.
  Determine which native focus/visibility/ownership predicate failed before
  changing admission or test actions. Keep the current fail-closed input checks
  and full Windows Macro acceptance open.
- Local correction validation passed: full single-worker Vitest (449 files /
  3,551 tests), the two native helper cases, 44 adjacent tests, TypeScript, ESLint
  (existing warnings only), complete hygiene/coverage checks, native macOS Rust
  lint and tests (1,642 passed / 4 ignored), stable and Electron production
  builds, and desktop E2E production isolation. No desktop E2E profile was rerun
  locally for this lower-layer correction. Windows native helper acceptance is
  pending the new candidate.
- At `cbdd80fe`, both stable Tauri desktop CI jobs and macOS native validation
  completed successfully. The Windows native and macOS Chromium package jobs
  were still running when this update was recorded.


### CP-08 exact admission evidence for the pending Windows failure

- The E2E entry now wraps the View attachment resolver's observation function.
  It records the same native sample consumed by admission, including exact View
  identity, parent foreground/visibility, WebContents focus, bounds and zoom.
  It neither rereads native state nor changes the returned sample, input owner,
  exception, delivery mode or product admission rules.
- The bounded artifact `electron-view-input-observations.json` retains the last
  256 samples and is written in a microtask after the synchronous input stack.
  The observer exists only under the E2E entry. Windows acceptance remains open
  until a native candidate supplies the missing rejection-time evidence.
- This is `internal-only` instrumentation for existing
  `CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004` and its retained AppKit counterpart;
  no journey behavior, required assertion or coverage target changes. Focused
  observer/host and actual main-bundle tests passed (3 files / 15 tests), along
  with TypeScript, ESLint, source hygiene and coverage-manifest checks. Product
  runtime, native imports and shared contracts are unchanged from `07ee2675`.
- Local macOS `chromium-macos-appkit-smoke --phase=chromium-macro-background-tab`
  passed (one scenario, 22.9 seconds), with artifacts under
  `.desktop-e2e-artifacts/2026-09-06T17-40-51-986Z-darwin`. This is one targeted
  phase, not a rerun of the full 56-phase profile.
- Production Electron rebuild, E2E production isolation and full hygiene checks
  passed after the targeted native run. Windows observation execution awaits
  the next exact candidate; no native Rust sources changed in this update.


### CP-15/16 completed macOS package acceptance at 280027d7

- CI `34046674835`, macOS Chromium package job `101522843140`, completed
  successfully. Its downloaded report binds commit
  `280027d7248a3af269cfd6dac3b4a310fc00476f` to all 56
  `chromium-macos-appkit-smoke` phases with PASS, exit code 0 and final-flush
  evidence. The report records a dirty worktree because this job applies its
  isolated updater fixture version; this is CI fixture acceptance, not a clean
  production-release receipt.
- The same job passed exact Electron/Chromium/Core/AppKit ABI verification,
  package structure, distribution payload checks, prior-version fixture builds
  and the packaged Rust updater transaction for fixture target version 8.5.0.
  Production trust, published-v22 cutover, Windows installation and physical
  hardware gates remain independent and open.
- Downloaded artifact `packaged-chromium-role-black-box-macOS-34046674835-1`
  (ID `9993943541`) contains a passed black-box receipt: actual host
  `appkit-chromium`, visible OS Accessibility click, remoteDebugging false,
  exitCode 0 and a package manifest covering 601 entries. It binds app.asar
  SHA-256 `4a004846532d32c72e6a00ad9f2958a9b40affc7537ab18850976794da0f9ae8`
  and native addon SHA-256
  `981b274d2ddefd0ce243702819a637f835b6d19aad1ace555144406f8e8bc43f`.
- The downloaded Windows `cbdd80fe` report separately establishes 25 passing
  phases, including `chromium-macro-native-effect`; the following background-tab
  phase failed. CP-15's register now reflects this verified count rather than
  the earlier 24-phase candidate. Neither result closes the full Windows gate.
- This update changes evidence documentation only. It does not restart or replace
  the already-running `b70fd73e` CI (`34049447661`) that will supply the exact
  Windows admission samples.


### CP-11 hidden View experiment: distinguish native and DOM visibility

- A local isolated bundled-Electron macOS experiment changed zoom only after
  `WebContentsView.getVisible()` was false. With backgroundThrottling false,
  document.visibilityState remained visible even after a classified 3-second
  visibility-event boundary. Pinned Electron declarations explicitly state that
  backgroundThrottling affects the Page Visibility API. Therefore a DOM hidden
  event is not an appropriate substitute for native View visibility in this
  probe. The missing DOM event was recorded as indeterminate, never success.
- The same native-hidden View received a resize-event acknowledgement changing
  its renderer viewport from 600x400 to 480x320 at factor 1.25 before reveal.
  Reveal retained the acknowledged size. The native sample and renderer
  acknowledgement were both read; getZoomFactor alone was not the evidence.
- This isolated single-View macOS API experiment is not retained-AppKit product
  acceptance, Windows acceptance, sibling occlusion or a production zoom
  completion fix. CP-11 remains open for those exact cases. The immediate next
  zoom experiment must retain native visibility evidence and use a renderer
  resize receipt, without demanding a DOM visibility transition contradicted
  by the configured Electron behavior.


### CP-08 Windows foreground precondition identified at b70fd73e

- CI `34049447661`, Windows job `101530282243`, produced the missing exact
  admission sample in `electron-view-input-observations.json`. The initial
  background-tab shortcut had parentForeground true, parentVisible true,
  parentMinimized false, viewAttached true and viewVisible true, but
  contentsFocused false and focusedWebContentsId null. Bounds were 904x560 at
  (0,40), zoom 1, and the exact role/generation/View identity was intact.
  Product input admission correctly rejected this non-focused View.
- The shared E2E keyboard helper now receives the exact scenario window ID and
  performs the existing PID/HWND-fenced native content click before a new
  Windows keyboard sequence. ChromeDriver's ability to deliver DOM keys alone
  is not native focus evidence. `focusCanvas: false` continuation sequences
  preserve their existing no-extra-click behavior. The product focus rules,
  background delivery rules, Core deadlines and event assertions are unchanged.
- This targets `CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004` and the shared
  keyboard cutover scenario. Actual Windows acceptance remains pending the
  next candidate; a physical focus precondition must not be used to select a
  hidden target or repair background delivery.
- Separately, CI `34049199222`, macOS native job `101529742726`, passed at
  `07ee2675`. Its raw log explicitly records both new production Session helper
  integration tests passing (10,372 ms), establishing hosted macOS coverage
  beyond the earlier local test. Windows Session helper acceptance remains open.


### CP-10 Windows helper launch parity correction

- Windows native job `101529742770` at `07ee2675` executed both new Session
  integration cases and failed their exact magic check: stdout started with
  CRLF before RCHRES01. No data inventory verification was reached.
- The test's Node child launch omitted the console suppression already used by
  production Rust `rion_platform::background_command` (CREATE_NO_WINDOW). The
  test now sets windowsHide true with all three standard streams piped. Pinned
  [Node 24.18.0 libuv source](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/process.c#L970-L985)
  applies CREATE_NO_WINDOW for this combination. This aligns the launch
  environment; it does not strip stdout, relax framing, change exit evidence,
  or claim that the Windows rerun has passed.
- Local validation of these test-only corrections passed: 5 focused files / 30
  tests, 2 real Session helper cases, TypeScript, ESLint, full hygiene and
  coverage checks, production Electron build and E2E production isolation.
  Product Rust/native imports and shared runtime contracts are unchanged.
- The first local background run caught an E2E bridge read after switching to a
  Role page; that attempt failed and is not acceptance. PID/HWND lookup was
  moved to the main-page boundary before entering the Role target. Subsequent
  macOS `chromium-macos-appkit-smoke` targeted phases passed:
  `chromium-macro-background-tab` (21.4 seconds, artifact
  `.desktop-e2e-artifacts/2026-09-06T18-00-13-455Z-darwin`) and
  `chromium-macro-cutover-keyboard` (28 seconds, artifact
  `.desktop-e2e-artifacts/2026-09-06T18-00-43-415Z-darwin`). These are two targeted
  phases, not another full-profile run.
- Affected paired journey suffixes are MACRO-BACKGROUND-TAB-004,
  MACRO-SHORTCUT-REENTRY-007, MACRO-MODIFIER-CONTINUITY-008 and ROLE-KEY-BLUR-004.
  The keyboard phase also retains its existing MACRO-MIDDLE-BUTTON-013
  assertions. Manifest behavior/coverage targets are unchanged; Windows native
  confirmation of the corrected test actions and helper launch remains pending.


### CP-11 reproducible hidden/occluded viewport probe

- Added an isolated bundled-Electron probe plus a native integration entry,
  automatically included by both native CI jobs. A single BrowserWindow hosts
  two sandboxed Views with separate Sessions. The target is either explicitly
  hidden or covered by the focused sibling before changing its zoom.
- The probe first measures the actual visible viewport at the requested factor,
  resets to an acknowledged 600x400 viewport, then changes zoom while covered.
  It requires unchanged native focus/visibility/attachment facts, records the
  renderer resize acknowledgement and verifies the revealed viewport against
  that same visible calibration. No platform scale or pixel rounding is guessed.
- The first local experiment exposed an incorrect Math.round expectation at
  factor 1.5 (expected height 267, actual 266), including after reveal. That
  failed attempt is not acceptance. Visible calibration replaces the arithmetic
  assumption without adding tolerances or changing the requested zoom factors.
- Local macOS Electron 43.4.1 / Chromium 150.0.7871.224 evidence: native-hidden
  zoom 1.25 acknowledged 480x320; sibling-occluded zoom 1.5 acknowledged 400x266.
  Both retained the focused sibling throughout the covered operation and matched
  their visible calibration before reveal. DOM visibility remained visible with
  backgroundThrottling false; native target visibility was recorded separately.
- Complete JSON is written directly to the native test log, including passing
  runs. A covered response may be explicitly indeterminate in this diagnostic
  probe; green test execution does not certify covered zoom parity. Acceptance
  requires inspecting each actual `whileCovered.status` and exact dimensions.
  Revealed mismatch, invalid native ownership/focus or failed visible calibration
  still fails the probe. No deadline expiry can become an applied response.
- This is `internal-only` evidence preparation for CP-11, not a product zoom
  completion change or retained-AppKit/hardware acceptance. Windows evidence
  remains pending. Local native probe, TypeScript, ESLint and complete hygiene
  checks passed; no product runtime, native Rust or shared contracts changed.


### CP-11 product-default throttling and immediate readback comparison

- Source audit distinguishes ordinary Role Views (Electron's default
  backgroundThrottling true) from Session-maintenance Views (explicit false).
  The viewport probe now runs both configurations; the earlier false-only
  experiment cannot establish ordinary product behavior. Host and both sibling
  Views use the same explicit configuration within each isolated run.
- Each covered zoom now records a single ordered renderer response immediately
  after setZoomFactor, before waiting for the resize event or its deadline.
  There is no polling or retry. The later resize-event result is still recorded
  independently and cannot rewrite an indeterminate result as success.
- macOS at both settings returned matching immediate dimensions for native-hidden
  1.25 (480x320) and sibling-occluded 1.5 (400x266). With throttling true, the
  native-hidden case did not deliver the resize notification within its external
  boundary despite the immediate readback already matching. All other resize
  cases acknowledged. Focus stayed on the visible sibling throughout.
- Therefore the prior resize-only acceptance criterion is insufficient to
  distinguish stale layout from suppressed notification. Future product receipt
  design must bind the exact renderer response and operation/frame identity;
  browser getZoomFactor or a timeout alone remains insufficient. The probe
  runner can pass with an indeterminate resize event, and its JSON must still
  be inspected for exact immediate dimensions, native state and visible
  calibration. These API observations do not close product or Windows parity.


### CP-08 ordinary background selection and current candidate failures

- Windows run 34050457198 at 33dde3dd passed the initial foreground Macro
  shortcut after the physical focus correction. Its next failure was held
  Digit2 continuity after selecting sibling tab B. Both tab identities remained
  in the strip and the selected tab was B; this was not an explicit hide-tab
  operation. Core incorrectly required membership in hidden_tab_ids, which
  describes hidden tab chrome rather than an unselected Chromium View.
- Remove that extra condition while preserving the exact owner, generation,
  capability, membership and selected-sibling checks. A focused regression
  failed before the correction (superseded instead of noHeldKeys) and passed
  afterward. The selected-tab negative case and existing explicit-hide/stale
  owner test also pass. CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 now checks
  both tab identities survive selection. Windows native acceptance is pending.
- Local macOS lint:rust and test:rust passed after the continuity correction:
  1,643 tests passed and four ignored across the workspace. TypeScript, lint
  (existing warnings only), hygiene/coverage, both builds and production E2E
  isolation passed. No new full desktop profile ran on this worktree.
- The full Vitest run recorded 448 passing files and two failures (3,553 passing
  tests, two failing). The new viewport probe lacked its exact product-gate
  allowlist entry; that entry is now added and all eight focused gate tests
  pass. The real updater-journal deletion test missed its filesystem event
  after initial presence readback. That failure remains open; no deadline
  extension, polling or successful rerun is accepted as a repair.
- Newer CI invalidates any current-candidate all-green claim: 33dde3dd macOS
  Chromium failed saved mixed Workspace restore during restart, and Windows
  Session helper tests still received CRLF before the exact response magic.
  The earlier 280027d7 56-phase success remains historical evidence only.

### CP-10 isolate the helper protocol from Electron console routing

- CREATE_NO_WINDOW/windowsHide did not repair the Windows native helper
  response in run 34050457198. Electron 43.4.1 calls RouteStdioToConsole before
  application entry unless ELECTRON_NO_ATTACH_CONSOLE is set (or RunAsNode is
  active): [pinned Electron startup source](https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_win.cc#L153-L163).
- Set ELECTRON_NO_ATTACH_CONSOLE=1 on the dedicated Rust helper command and
  matching fresh-process native test. Do not strip leading bytes or weaken
  exact magic, length, process-exit or response-digest validation. The setting
  is scoped to the helper, not ordinary application launches. Windows native
  proof remains required; this source-based correction is not acceptance.
- The subsequent local validation attempt hit ENOSPC while compiling Rust and
  before native tests loaded. Those attempts are infrastructure failures, not
  passing tests. Rebuildable compiler cache cleanup and revalidation follow.

- Removed only rebuildable target/debug/incremental cache after active compilation
  ended, recovering approximately 39 GiB free space. Source and E2E evidence
  were preserved. The corrected native command then passed both Session cases
  and both viewport configurations (four tests). The default-throttling hidden
  resize event remained indeterminate despite matching immediate dimensions;
  this does not close CP-11. Typecheck, lint, hygiene/coverage, builds and
  production E2E isolation passed after the helper launch change.
- A separate bounded 20-attempt journal-watch reproduction observed every
  deletion. It neither identifies the original failure nor closes it. The full
  suite's earlier filesystem observation failure remains pending diagnosis.
- After cache recovery, required macOS lint:rust and test:rust also completed
  successfully (1,643 passed, four ignored). Windows native execution and both
  current-candidate full Chromium desktop profiles remain CI gates. No physical
  mixed-DPI or Windows hardware profile ran locally.


### CP-04/CP-11 Workspace chrome navigation rejection terminality

- Investigated run 34050457198 macOS Workspace restart artifacts. The Role
  WebContents completed its navigation, while the paired Rion-owned Web chrome
  stayed in its opening state until teardown rejected its unresolved load.
  Core remained launching and the hidden host never became visible. This
  narrows the stalled boundary but does not prove the original navigation error.
- Source inspection found loadURL rejection was swallowed while waiting only
  for did-finish-load/did-fail-load. A rejected exact navigation request can
  therefore leave the paired create pending when no separate failure event is
  delivered. Route that rejection through the existing load-settlement fence
  and cleanup; preserve its original error and ignore later duplicate outcomes.
  No successful receipt, timeout, retry or alternate engine is introduced.
- New explicit darwin/win32 regression cases fail before the correction and
  pass afterward, verifying both paired surfaces are retired and the creation
  rejects with the original error. The Windows fixture uses its native path
  form. All eight adjacent presentation tests pass. This lower-layer-covered
  fix does not itself establish the CI failure's root cause or native parity.
- Related journeys are CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016 and
  CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016. No journey or coverage target is
  removed; focused desktop results are recorded separately below.
- Local macOS focused chromium-macos-appkit-smoke execution passed all four
  selected/dependency phases: entity persistence seed/restart and Workspace Web
  slot seed/restart. Artifact 2026-09-06T18-35-13-399Z-darwin records b8a3d3c9
  plus this dirty worktree, clean native final flushes, paired Session isolation,
  retained 0.55 divider width and restart readback. The earlier hosted stall was
  not reproduced; this run is compatibility evidence, not proof of its root
  cause. Windows and full-profile verification remain pending CI.
- Validation after this change: complete single-worker Vitest passed 450 files
  and 3,557 tests (153.53 seconds); TypeScript, ESLint, hygiene, docs and coverage
  passed. Both production builds and E2E production isolation passed after the
  focused native run. The earlier journal-watch failure did not recur in this
  suite, but no watcher repair has been made and that issue remains open.


### CP-15 Windows native chooser discovery without desktop UIA traversal

- Run 34051980128 at b8a3d3c9 passed Windows Workspace slot persistence but
  failed chromium-workspace-web-fullscreen-seed during visible file upload.
  The native chooser helper was killed at its existing external deadline;
  its durable progress receipt stopped at reading-root, before application
  window enumeration. No chooser absence or product upload failure can be
  inferred from that stalled UI Automation root call.
- Replace UIA RootElement/FindAll desktop enumeration with bounded native
  EnumWindows discovery. Admit only the exact application PID or a window
  whose native owner belongs to that PID. Dialog candidates must be visible
  #32770 HWNDs with exactly one native 1148/Edit and 1/Button descendant before
  asking UIA for the admitted dialog and its two actionable controls.
- Native window enumeration failure or exceeding 4,096 HWNDs throws; neither
  can become an empty-dialog success. Discovery remains the existing bounded
  external test-driver loop. Keep the original 15-second process deadline,
  unique-dialog rule, foreground and visible-control checks, exact filename
  write/readback and remote trusted-file/byte/hash evidence. No product file
  upload bridge or hidden synthetic primary action is introduced.
- Snapshot discovery also uses native ownership so collecting routine evidence
  cannot reintroduce the desktop-root traversal. Removed obsolete UIA root
  conditions and unused owner helpers. This is internal-only E2E driver work;
  Windows native execution remains pending. Adjacent source-boundary and
  PowerShell transport checks are not native dialog acceptance.
- Affected journey: CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028, exercised
  inside CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017. Both macOS and Windows
  CI profiles remain required; no coverage target or journey is removed.
- Local validation: 11 focused source-boundary/PowerShell transport tests,
  TypeScript, ESLint (zero errors), full hygiene, documentation and coverage
  checks pass. macOS E2E was not rerun for this Windows-only test-driver change;
  the prior 266f4abc four-phase macOS run remains separate evidence. No native
  Rust, shared runtime contract or product module changed in this batch.


### CP-15 stable Windows persistence receipt observation

- Run 34051980128 Windows stable Tauri E2E failed force-terminate while waiting
  for alpha's window-state-persisted event. Transcript sequence 214 completed
  alpha activation; 194/222 reported essentialReady/ready. SQLite preserved
  activeTabId 141becfd-f19a-4331-96ed-ac7bb0d44741 (alpha), updated at
  18:44:43.955989900Z, while no matching persisted event appeared. This is
  evidence of saved state without the required observer receipt, not lost data.
- The observer was attached to pending-lane retirement. When a newer queued
  snapshot replaces that lane during the Core commit, the exact older applied
  receipt could not emit because its lane was no longer current. Record the
  event from the submitted snapshot identity and matching Core applied receipt
  instead. Retire only an exactly matching pending lane; a newer request remains
  queued. Superseded receipts do not become applied events.
- Preserve the submitted active tab, window generation and revision in the
  observation. Do not infer persistence from activation, page readiness or a
  later SQLite query, and do not widen the test timeout. Event emission remains
  desktop-e2e-only; persistence authority and actual writes stay in Core.
- Local source-boundary tests pass (23). Required macOS Rust validation and
  native stable recovery execution are running; Windows acceptance remains
  pending. This internal-only observation repair does not close Chromium
  cross-platform parity or the cutover gate.
- macOS lint:rust and test:rust completed successfully (1,643 passed, four
  ignored); the desktop-e2e feature build also compiled successfully. Focused
  full-profile crash-restart execution failed in its seed dependency at the
  maximized-presentation control command, before force-terminate. Artifact
  2026-09-06T18-53-23-677Z-darwin is failed evidence, not recovery acceptance.

### CP-10/CP-11 native Windows evidence at b8a3d3c9

- Native job 101537220504 completed with four failures. Both Session cases
  still received CRLF before RCHRES01 despite windowsHide and
  ELECTRON_NO_ATTACH_CONSOLE. Console routing alone is therefore not a proven
  cause or repair. Keep strict response framing and fresh-process acceptance
  open; no preamble stripping or successful helper outcome is inferred.
- Both viewport configurations recorded hostVisible false while hostFocused
  and siblingFocused were true. These cannot establish visible-host parity.
  Remove windowsHide from the visible viewport probe launcher, matching the
  already-passing direct-input probe's native launch precondition. Retain exact
  host visibility/focus assertions. Local macOS two-configuration execution
  passed afterward; Windows execution remains required. The default-throttling
  hidden resize notification is still indeterminate despite exact dimensions.
- Windows job 101538819689 at e52dd066 progressed past desktop-root discovery
  and compiled the native dialog helper, but UIA FromHandle failed with
  ElementNotAvailableException on an exact native control. This identifies the
  next driver boundary; it is not file-upload acceptance. Native HWND control
  observation remains to be evaluated without relaxing visible primary actions.
- Final local checks for this batch: both production builds, Electron renderer
  verification, E2E production isolation, full hygiene/coverage and targeted
  ESLint passed. The failed macOS recovery run is retained. This batch does not
  claim either current-candidate full desktop profile is green.


### CP-15 use admitted native file-control handles directly

- Follow up the exact-control FromHandle failure from Windows run 34052620782
  at e52dd066. Remove UI Automation from the Windows chooser helper entirely;
  retain bounded EnumWindows/EnumChildWindows discovery and exact PID/owner,
  dialog class and native control ID/class admission. The helper no longer
  needs an accessibility-provider object for already-proven HWND controls.
- Before each real mouse down/up, recheck dialog ownership, child membership,
  visible/enabled state, foreground and nonempty native bounds. Use the center
  only when WindowFromPoint identifies that exact control or its child; an
  occluding window is a failure. Preserve filename write/readback, native
  dialog-close observation and the remote trusted file event/byte/hash checks.
  No DOM file injection, synthetic Open-button message or timeout change is
  introduced. Failure snapshots use native handles/ownership only.
- API references: [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)
  supplies screen bounds and is DPI-virtualized;
  [WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)
  resolves the hit window and excludes hidden/disabled windows. This source
  audit is not physical mixed-DPI acceptance; Windows native CI remains pending.
- Internal-only driver change affects
  CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028 within the existing fullscreen
  journey. The manifest and coverage targets remain unchanged. Local 11 focused
  source/transport tests, TypeScript, ESLint and full hygiene checks pass;
  these checks do not compile or execute the Windows P/Invoke helper on macOS.

### CP-10 bounded diagnostics without accepting a displaced response

- Add a bounded assertion diagnostic to the existing synthetic native Session
  fixtures: response length, header offset, initial header bytes, outcome byte,
  up to 1,024 metadata bytes and bounded stderr. A displaced header is inspected
  only to explain failure; strict offset-zero magic and exact lengths remain
  mandatory, and no secret-bearing real browser profile is used by this fixture.
- Local macOS both fresh-process Session cases pass after the diagnostic change.
  Windows still needs execution to reveal the actual response after its leading
  CRLF. No successful apply/verify/rollback is inferred from finding a header.


### CP-15 AppKit animation reentry outside the Tao callback lock

- Investigated failed local stable recovery artifact
  2026-09-06T18-53-23-677Z-darwin instead of retrying its timeout. The captured
  native sample shows rion_desktop_e2e_control_window calling NSWindow zoom
  inside Tao handle_user_events. AppKit's animated resize enters a nested run
  loop; a display-link redraw then reaches Tao handle_nonuser_event and blocks
  on the same callback mutex on the main thread. Persistence had already emitted
  its exact receipt (sequence 83); this seed failure is a separate native
  reentrancy deadlock, before the recovery activation checks.
- Dispatch the macOS E2E native window control through the existing dispatch2
  main queue rather than Window::run_on_main_thread's Tao user-event handler.
  Preserve the same native AppKit entry point, arguments, completion channel
  and external deadline. Normal correctness still requires its actual response;
  no animation disabling, timer-driven success or synthetic geometry is added.
- Windows control dispatch and product runtime modules remain unchanged.
  This internal-only driver repair is covered by the stable native recovery
  journey; local Rust and recovery verification are recorded below when terminal.
- macOS lint:rust and complete test:rust passed (1,643 passed, four ignored),
  with 23 adjacent source-boundary tests and full hygiene passing. The native
  desktop-e2e feature build succeeded. Focused stable full-profile execution
  then completed seed/restart as PASS and force-terminate/crash-restart as
  EXPECTED_FORCE_TERMINATION, each with exit code zero. Artifact
  2026-09-06T19-09-24-521Z-darwin binds 17431e59 plus this dirty worktree.
  This reproduces the previously failing path after the dispatch correction;
  no timeout was enlarged and no native animation was disabled.
- The focused report verifies GAME-WINDOWS-TABS-001. It does not certify the
  entire full profile or the later crash-discard/final-restart recovery phases.
  Windows and Chromium full-candidate gates remain separate CI requirements.
- Production Tauri and Electron builds and desktop E2E production isolation
  passed after restoring production assets. Documentation, coverage manifest
  and diff checks also passed.
- CI run 34053406711 at 8387a3c9 subsequently completed both macOS and Windows
  stable desktop E2E jobs successfully (101540928663 and 101540928675). This
  supplies paired stable-shell recovery evidence for the persistence receipt
  correction; it does not certify the pending Chromium jobs or this later
  AppKit driver change.

### Windows persistence acceptance and remaining input failure

- Windows Chromium job 101541710883, run 34053711912 at 17431e59, completed
  25 phases as PASS before chromium-macro-background-tab failed. Evidence:
  artifact 9995489407, report 2026-09-06T19-05-58-231Z-win32/report.json.
  Settings seed/restart and CHROMIUM-WINDOWS-SETTINGS-PERSIST-006 passed.
  This validates general preferences only: the separate system-settings phase
  owns retired-control absence and font selection, and was not reached.
  CP-02, CP-06 and CP-13 therefore retain Windows Chromium acceptance pending.
  Previous macOS and native font evidence remains version-qualified; this
  does not close same-candidate full parity.
- The same report verifies native file upload
  CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028, workspace web fullscreen,
  security policy, paired Role/workspace persistence, workspace recovery,
  game-window UI and the foreground Macro effect. The HWND chooser repair
  therefore has native Windows acceptance, beyond its earlier source tests.
- Background continuity now reaches the second hidden start and final stop.
  Fixture sequences 433/434 record trusted hidden Digit2 keydown/consumer
  keydown. After restoring the Role, a pointer-down at sequence 442 precedes
  an untrusted Digit2 keyup/consumer keyup at 443/444. The stop chord follows
  at 450-453, and trusted Digit2 release arrives at 454/455. The strict
  assertion fails on 443 in stopFromShortcut, spec line 425. Do not filter
  away this earlier release or certify uninterrupted ownership from the later
  trusted event. Investigate overlay physical-key classification and focus
  cleanup before changing the test or input behavior.
- Source follow-up: normal Macro dispatch computes suppressOverlayShortcut
  from shortcut collisions, while held-key continuity sets it true. The
  Windows adapter arms the page Macro guard only when that flag is true;
  unguarded trusted keys enter the overlay's physical-key bookkeeping, whose
  blur cleanup can dispatch synthetic keyup. This is a concrete candidate
  mechanism, not yet a proven repair; retain focused reproduction and native
  acceptance requirements.
- Windows native job 101541034613 at 8387a3c9 now passes both viewport probe
  configurations after removing windowsHide from the visible probe. Its two
  remaining native failures are Session response framing (leading CRLF).
  Probe success does not close hidden resize notification or hardware parity.

### CP-08 classify ordinary Windows Macro keys before native delivery

- Reproduced the missing page guard for both hold and release when
  suppressOverlayShortcut is false: two new adapter tests failed with null
  guard envelopes before the repair. The existing page guard identifies Macro
  ownership as well as preventing shortcut recursion. Without it, a normal
  non-colliding Macro key enters physical-key bookkeeping and in-page focus
  cleanup can synthesize a release before the Core-owned stop.
- Arm the same exact code/phase page guard for every key in the Windows Macro
  input lane. Retain private frame/sequence identity, armed acknowledgement,
  native submission and trusted DOM receipt ordering. Core scheduling and the
  physical user-input path remain authoritative and unchanged. Mouse requests
  still do not arm a keyboard guard; macOS retains its native adapter.
- Both new adapter tests pass after the repair. Added an executable overlay
  focus-transfer test proving a guarded ordinary Digit2 receives no early
  release, then exactly its explicit release. The adjacent three-file suite
  passes 61 tests. These portable tests do not replace Windows native evidence.
- CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 now explicitly requires the held
  state after returning to the Role; the stop helper retains its strict first
  release isTrusted assertion, including focus cleanup during the stop click.
  The paired AppKit journey shares the strengthened pre-stop assertion. No
  synthetic event is skipped and no native-input requirement is weakened.

### CP-10 diagnose and correct the Windows native Session fixture

- Job 101541835757 at 17431e59 reports offset 2, outcome 1 and stableErrorCode
  CHROMIUM_SESSION_MIGRATION_SOURCE_EVIDENCE_INVALID for both synthetic cases.
  Thus finding the response header did not mean migration had run successfully.
- The Windows test envelope omitted mandatory sourceEvidence. Supply the same
  synthetic webview2StorageGetCookies runtime/protocol/partition capability
  evidence used by the canonical Windows codec fixtures. Keep it absent on
  macOS, where the codec correctly rejects Windows evidence.
- Strict offset-zero magic, lengths, successful outcome and independent process
  readback/rollback remain required. Leading CRLF is still an open transport
  failure; correcting fixture admission does not claim to remove it. Both
  macOS native Session cases pass with this fixture correction.
- Final local validation for this batch: all 450 Vitest files / 3,560 tests
  passed; macOS lint:rust and test:rust passed (1,643 passed, four ignored).
  TypeScript, ESLint, complete hygiene, coverage, both production builds,
  Electron renderer validation and production E2E isolation passed.
- No new local desktop E2E profile ran for this Windows adapter repair. The
  strengthened paired background-tab profile and Windows Session fixture must
  execute in the new exact-commit CI. Existing AppKit full-profile evidence is
  historical, not evidence for this modified assertion. The macOS adapter also
  uses the collision flag for page guards; audit its ownership behavior and
  shared guard construction next rather than assuming native equivalence from
  the Windows repair.

### CP-08/CP-09 share exact Macro keyboard arming on both native adapters

- The macOS adapter had the same collision-only guard condition as Windows.
  Two new hold/release tests with suppressOverlayShortcut false reproduced
  null page guards there as well. Correct both platforms through the shared
  createTrustedInputArmEnvelope function: exact role/generation/frame/sequence,
  expected events and Macro keyboard ownership now have one construction site.
  Each adapter retains native admission, submission, deadlines and independent
  receipt checks; AppKit presentation and trusted native input remain intact.
- The adjacent macOS/Windows adapter and overlay focus suites pass 85 tests.
  Both new macOS cases failed before the change and pass afterward. Existing
  click cases still require no keyboard guard, and untrusted/stale/cancelled
  inputs retain their original terminal checks.
- Local macOS profile chromium-macos-appkit-smoke, focused phase
  chromium-macro-background-tab, passed with native AppKit evidence and clean
  exit in artifact 2026-09-06T19-30-38-199Z-darwin. The report binds 33da5f3e
  plus this dirty worktree and verifies
  CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004 only. Hidden start, return to
  the Role, retained consumer hold, trusted stop and neutral cleanup all passed.
  It does not certify the entire smoke profile or Windows execution.
- Update the paired journey descriptions to retain ordinary Macro ownership
  across in-page focus cleanup. Source consolidation alone is not native parity;
  the new exact-commit Windows run and full candidate gates remain required.

### CP-10 identify the pinned Electron Windows stdout preamble

- Upstream issue [28072](https://github.com/electron/electron/issues/28072#issuecomment-797141819)
  identifies deliberate browser startup output. Inspection of the downloaded
  pinned Electron 43.4.1 source confirms shell/app/electron_main_delegate.cc
  lines 180-186: under IS_WIN, IsBrowserProcess writes std::wcout << std::endl
  before the application entry. This explains the exact CRLF at offset zero
  independently of the helper's error response and NO_ATTACH_CONSOLE.
- This is distinct from Console attachment in electron_main_win.cc. It cannot
  be prevented by changing helper JavaScript after startup. Source reference:
  [pinned main delegate](https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_delegate.cc#L180-L186).
- Next transport work must explicitly account for the fixed runtime envelope
  or use a separate inherited response channel. Do not scan for magic, trim
  arbitrary whitespace, accept optional/duplicate prefixes or omit any bytes
  from the existing PID/clean-exit/response digest. If adopting the pinned
  Windows envelope, require exactly one CRLF followed immediately by the full
  canonical RCHRES01 frame, retain raw-wire hashing and bounded EOF, and reject
  it on macOS. Add paired malformed/truncated/trailing-prefix cases and actual
  Windows fresh-process storage/rollback acceptance. This is new evidence for
  a precise transport revision, not acceptance of the currently failing wire.

- Final local checks for shared keyboard arming: macOS Rust lint/tests pass
  (1,643 passed, four ignored), both production builds and E2E isolation pass,
  and TypeScript, ESLint, full hygiene and coverage checks pass. Full Vitest
  reports 449 passing files / one failing file, 3,561 passing tests / one
  failing test. The failure is the existing CP-16 real journal watcher case:
  watch returned, access saw the file, unlink completed at 1 ms, and no event
  followed before its five-second external deadline. Log:
  /tmp/rion-shared-key-full-vitest.log. Do not certify a green full suite or
  rerun this failure into acceptance. Focused keyboard/native evidence above
  remains separate from the still-open updater acknowledgement repair.

### CP-10 validate the exact pinned Windows helper transport envelope

- Added the Windows CRLF-plus-canonical-frame case first and observed its
  protocol failure before changing the launcher. The native launcher now selects
  explicit Canonical or ElectronWindows framing from the compiled target.
  ElectronWindows requires exactly one CRLF before RCHRES01; Canonical does not
  permit it. No optional prefix, whitespace trimming or magic scan is used.
- Bounded stdout retention includes the two runtime bytes. The existing clean
  exit digest is still computed over the complete raw response before parsing;
  the frame is borrowed after exact prefix validation and the entire owned
  response is zeroed on success or failure. Cancellation, EOF, length/outcome
  validation and same-child reap semantics remain intact.
- Tests reject absent, partial, duplicated, foreign and trailing preambles;
  every truncated response length fails. Failed/indeterminate helper outcomes
  remain non-success, and macOS rejects the Windows envelope. Eight adjacent
  Rust launcher tests pass, with one existing ignored test. The original
  unprefixed protocol tests continue to pass under Canonical framing.
- Update the native Session fixture to validate the same mandatory envelope
  before exact frame parsing. Exit evidence continues to hash all stdout bytes.
  Both macOS native Session cases pass. Windows fresh-process apply, verify,
  rollback and rollback verification remain required in exact-commit CI.
- This lower-layer-covered transport repair changes no public user journey.
  Native Session and launcher protocol/cancellation tests provide focused
  coverage; the runtime migration contract now documents the pinned envelope.

### CP-08/CP-15 Windows background Macro acceptance at 33da5f3e

- CI job 101545320036 / run 34055031958 completed 26 phases as PASS,
  including CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004, before failing the
  first controlled Role reload. Artifact report
  2026-09-06T19-30-55-975Z-win32/report.json records this exact result. This
  closes the previously failing premature-release path for the Windows fix;
  it does not certify the later shared-arm commit or the whole profile.
- Controlled reload evidence contains one exact Windows reload menu capture,
  Core browserRuntimeTabReload start at sequence 189 and commit effect start
  at 194. The Role navigated, reached dom-ready/did-finish-load/did-stop-loading,
  but the input-ready reload observation is absent before the 45-second test
  failure. Commit completion occurs during cleanup after that failure. Preserve
  this as an unresolved lifecycle receipt boundary, not a native menu failure
  or proof that page loading itself failed.
- Final local validation: macOS lint:rust and test:rust pass (1,645 passed,
  four ignored), both production builds and E2E production isolation pass.
  TypeScript, ESLint, complete hygiene, documentation and coverage pass.
  Eight focused JavaScript helper/codec/transport suites pass 87 tests.
  No desktop E2E profile was rerun for this lower-layer transport change;
  macOS native Session execution passed and Windows is pending CI. The prior
  full Vitest updater journal watcher failure remains open and is not erased
  by these focused checks.
