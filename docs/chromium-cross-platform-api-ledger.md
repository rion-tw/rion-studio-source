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
| Fonts, audio, zoom | `src/electron/main/chromiumRoleFontsCoordinator.ts`, `src/electron/main/chromiumRoleSurfaceRegistry.ts`; bounded preload receipt or exact WebContents readback | Shared rendering/effects; native font enumeration remains in `crates/rion-platform/src/system_fonts.rs`. CP-05, CP-06, CP-11 |
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
| CP-03 | P0 / Core + Sessions | implemented; macOS smoke passed, Windows pending | CP-01 | Share Rust Chromium engine-path conversion and Electron canonical-path/ownership helpers across Role, Global Web and maintenance helpers. Reject unsupported device paths consistently without moving stores. Test drive/UNC/case/alias/owner boundaries and persistent restart on Windows. |
| CP-04 | P1 / Runtime projection | implemented; macOS smoke passed, Windows pending | CP-01 | Extract equivalent snapshot, bounds, visibility, zoom, reparent and compensation steps; retain AppKit transaction/geometry and Windows host effects. Test stale revision, partial application, compensation failure and exact quarantine, plus paired topology/recovery journeys. |
| CP-05 | P1 / Fonts | probe; macOS evidence recorded | CP-01 | Evaluate queryLocalFonts on pinned Electron: family/CJK/duplicates, focus/activation, permission, reload, generic fallback and existing automatic settings loading. Allow enumeration only in an authenticated app frame; remote pages remain denied. Produce adopt/retain result with both native runs. |
| CP-06 | P1 / Fonts + bridge | conditional | CP-05 passes | Keep listSystemFonts Promise result, bounded Rust normalization/cache/fallback, and shell enumeration provider. Remove v23 native enumeration only after equivalent settings behavior is proven. Retain v22 reachability until CP-17. If CP-05 fails, close as a documented retained adapter. |
| CP-07 | P1 / Application input | probe | CP-01 | Compare before-input-event and Menu with Windows F11 hook across main, Role, global Web, popup, focused/hidden hosts, repeat and key-up. Remove hook only with exact once-only routing and page suppression; do not substitute globalShortcut. |
| CP-08 | P1 / Trusted input | probe; isolated macOS API evidence recorded | CP-01 | Evaluate sendInputEvent separately for foreground and hidden Role input, modifiers, held keys, middle button, zoom and reload. Preserve focus and owner/generation/epoch/DOM evidence. Partial replacement is permitted only with proven equivalent semantics; retain AppKit input. |
| CP-09 | P1 / Trusted input | implemented; macOS Macro journeys passed, Windows pending | CP-01 | Consolidate genuinely identical pending-sequence, frame, cancellation and retirement coordination around the existing shared coordinator. Preserve independent native evidence validation and Core scheduling. Test stale/duplicate/partial submission and paired Macro journeys. |
| CP-10 | P1 / Session maintenance | shared transport verified; native acceptance pending | CP-03 | Share helper launch, process identity, response validation, drain and cancellation plumbing. Keep reset, migration and Chrome import data scopes/terminality distinct. Fresh-process DOM Storage readback remains required; test tampered/stale helper outcomes and restart persistence. |
| CP-11 | P1 / Browser capability owners | audited; macOS smoke passed, Windows/hardware pending | CP-01 | Trace navigation/reload/popups/audio/zoom/fonts/overlay/security/certificates/download denial/upload/HTML fullscreen from API through consumer and exact receipt to journey. Close shared capabilities with behavior evidence, not source tokens. Preserve distinct Session policies. |
| CP-12 | P2 / Shell | implemented; macOS smoke passed, Windows/hardware pending | CP-01 | Centralize command definitions, shell services, display event and exit-drain coordination where equivalent. Retain Cmd/Ctrl, AppKit, Mica/vibrancy and Windows session-end boundaries. Test cancel/close/drain/focus and paired shell journeys. |
| CP-13 | P1 / Diagnostics + settings | implemented; both Tauri platforms passed, Chromium Windows pending | CP-02 | Owner-directed removal of high-refresh UI, shared settings and WKWebView feature writes. Ignore retired persisted/imported fields without losing other preferences. Preserve unrelated WebGL policy and AppKit hosting. |
| CP-14 | P2 / Platform data | retained adapters audited; Windows validation pending | CP-01 | Record exact retained boundaries for file identity/ACL/atomic replacement/locks, Chrome discovery/quit/decryption and transfer encryption. Keep legacy migration distinct from ongoing consented Chrome import. Audit callers and both cfg targets; no safeStorage format assumption. |
| CP-15 | P1 / Desktop E2E | full macOS smoke passed; Windows/hardware pending | CP-01; alongside behavior tasks | Share fixtures, seed/restart scenarios and receipt assertions; retain native UI drivers. Upload must still click the remote file input and native chooser. Preserve all coverage targets and run paired smoke/hardware profiles where relevant. |
| CP-16 | P2 / Release tooling | shared helpers implemented; native release gates pending | CP-01 | Share manifest/version/hash/signature/job coordination; retain native installer and locked verification. Reuse v22 release environment in final delta audit. No new credentials/infrastructure, no autoUpdater, and no publication inferred from this task. |
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
