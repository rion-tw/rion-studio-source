# Chromium capability ownership audit

This is CP-11's source and behavior audit for the
[cross-platform API ledger](chromium-cross-platform-api-ledger.md), dated
2026-09-06. It describes the current worktree, not an immutable release verdict.
Both hosts consume the implementations below. AppKit presentation remains a
required native boundary. Each row distinguishes browser effects from Core
terminality and native acceptance; a shared method alone is not parity evidence.

## Capability and receipt chains

Paths below are relative to `src/electron/main` unless otherwise qualified.
Journey suffixes refer to both `CHROMIUM-MACOS-APPKIT-` and `CHROMIUM-WINDOWS-`
entries in the coverage manifest.

| Capability | Entry, effect and authoritative completion | Behavior evidence and journey |
| --- | --- | --- |
| Role navigation | Runtime effect -> ChromiumRoleSurfaceRegistry -> WebContents.loadURL. Permanent did-start-navigation rotates document identity; main-frame did-finish-load/did-fail-load drives ChromiumRoleNavigationLifecycleOwner. The loadURL Promise is not the domain completion source. | Role surface and navigation-failure suites exercise terminal events and stale ownership. ROLE-PERSIST-003 and RUNTIME-TAB-RELOAD-031. |
| Role reload | Core intent -> ChromiumRoleReloadCoordinator -> exact prepared WebContents.reload. The role/document/navigation fence, popup admission fence, native input quiescence, preload reinstallation and input resumption compose the inputReady receipt. Retirement and supersede terminalize the exact attempt. | Reload coordinator suite and controlled-role-reload desktop spec exercise two successful native menu actions, injected failure and recovery. RUNTIME-TAB-RELOAD-031. |
| Global Web navigation | Local chrome action -> ChromiumGlobalWebPresentationRegistry -> ChromiumGlobalWebSurfaceRegistry. URL policy and exact active handle precede loadURL; main-frame load/failure events settle the request. Core remains the owner of configured start URL and layout. | Global Web surface/presentation and navigation-failure suites. WORKSPACE-WEB-SLOT-016 and WORKSPACE-WEB-FULLSCREEN-017. |
| Popups | setWindowOpenHandler -> ChromiumPopupLifecycleCoordinator -> Core admission and isolated-noopener policy -> native host attachment. Exact source owner, document, generation and admission identity fence every native follow-up. Nested unadmitted opens are denied. | Popup lifecycle suite covers stale admission and native release. POPUP-012; AppKit popup hosting and Windows hosting remain separate effects. |
| Audio | Core tab mute action -> ChromiumRuntimeEffectExecutor -> Role/global Web setAudioMuted plus isAudioMuted readback. Exact role owner generations and Web slot identities precede mutation; partial failure compensates attempted surfaces and cannot commit unknown state. | Runtime-effect-executor tests cover Role and Web-only tabs, stale owners, divergence and rollback. Paired RUNTIME-TAB-AUDIO-032 journeys now click the visible menu, compare Core and exact Chromium mute readback, and retain mute through Reload success/failure/recovery. macOS passed; Windows native execution remains pending. The audit also found and repaired the absent Windows menu command, using the existing Core action and projection-fenced host bridge. |
| Zoom | Focused application command -> Core window zoom effect -> ChromiumRuntimeWindowZoomController -> setZoomFactor/getZoomFactor on Role, global Web and popup surfaces. Base factor times Core-owned window factor is bounded; exact receipt counts, native identity checks and rollback preserve atomicity. | Window-zoom and executor suites cover failed preparation, late host changes and compensation uncertainty. APPLICATION-SHORTCUTS-030 exercises real focused shortcut routing and exact zoom receipts. |
| Font application | Typed font/settings mutation -> ChromiumRoleFontApiDispatcher -> Core mutation -> ChromiumRoleFontsCoordinator FIFO refresh -> isolated preload/main-world font runtime. The exact frame/application/payload revision and loaded-face evidence must match before acknowledgement; document retirement rejects pending work. | Font coordinator/preload and browser-font-runtime suites verify face-loading rejection and stale/queued refreshes. SYSTEM-SETTINGS-013 covers controls, not a live Role's chosen-font appearance; paired FONT-APPLICATION-033 now verifies visible apply/cancel/reset against live DOM and main-world Canvas glyph widths. macOS passed; Windows native execution remains pending. The journey now also waits for automatic inventory loading and verifies Courier New through loaded Latin/numeric FontFace aliases and glyph metrics on macOS. Downloaded-font coverage remains distinct. Enumeration is the distinct CP-05/06 experiment. |
| Macro overlay | Core view model -> ChromiumRoleOverlayCoordinator -> isolated world 1004. The authorized sender/frame token, generation, document and refresh ID bind the returned input-context revision. Navigated/retired frames cannot acknowledge new work. | Overlay coordinator/preload suites cover authenticated receipt and retirement. MACRO-NATIVE-EFFECT-018 and RUNTIME-TAB-RELOAD-031 exercise the surrounding input-ready behavior. |
| Permissions/devices | Session creation -> installChromiumSessionSecurityPolicy -> Electron permission-check/request, device, display-media and Bluetooth callbacks. Denial is synchronous and recorded in the exact Session journal. No native-platform permission implementation is duplicated. | Security-policy suite verifies callback denial and Session installation identity. WORKSPACE-WEB-SECURITY-POLICY-027 observes the actual denied browser request. |
| Certificates | Application startup -> installChromiumCertificatePolicy -> certificate-error prevents default and rejects; select-client-certificate returns no certificate. The one App identity owns installation. | Security-policy suite executes both callbacks and verifies one registration. This is lower-layer certificate evidence; the security journey must not be claimed to test TLS/client-certificate negotiation. |
| Downloads | Session will-download -> preventDefault -> exact Session observation journal. A denied download is not delegated to shell.openExternal or an OS-specific download manager. | Security-policy suite and WORKSPACE-WEB-SECURITY-POLICY-027 check denial; the native journey checks the browser attempt and policy evidence. |
| File upload | Real remote file input -> Chromium-owned native chooser -> user selection -> page File metadata and content digest. The runtime adds no custom Windows/macOS chooser implementation. Only the desktop test driver's native chooser navigation differs. | WORKSPACE-WEB-FILE-UPLOAD-028 requires a visible page click, native chooser selection and exact file digest. A driver failure cannot be replaced by assigning the input's file list or invoking a debug chooser. |
| Contained HTML fullscreen | Global Web main-frame permission -> WebContents enter/leave-html-full-screen -> ChromiumGlobalWebPresentationRegistry paired viewport projection. disableHtmlFullscreenWindowResize keeps the transition in its native slot. Exact active record, generation, visibility/bounds readback and compensation fence the projection. | Security and global Web presentation suites exercise main-frame policy and paired bounds. WORKSPACE-WEB-FULLSCREEN-017 tests unchanged neighboring Role/native host, popup behavior and restart. Native window fullscreen is separate. |

## Boundaries retained deliberately

Role Sessions deny fullscreen and other permissions by default. Global Web may
upgrade only its own Session's main-frame HTML fullscreen policy. The dedicated
local chrome Session and the application renderer are separate from remote
Role/global Web contents. Session ownership/path checks, sender authorization,
protocol policy and certificate rejection must remain intact when sharing code.

There is no Windows/macOS branch in these browser-effect coordinators to replace
with another browser API. The remaining duplication between Role and global Web
registries represents distinct identity, preload and navigation ownership. Merging
those registries into one permissive surface owner would weaken the product's
separate security domains. Shared path and projection mechanics are already
handled by CP-03/04; application shortcut replacement remains CP-07. CP-08 retains native trusted
input submission because the pinned sendInputEvent API requires a focused
containing BrowserWindow while background Role macros must not acquire focus.
The cross-platform pending lane, DOM receipt decoder and Core coordinator are
shared under CP-09; native submission still proves exact target identity and
input neutrality. The ledger records the successful isolated probes separately
from the supported API contract and production Role acceptance.

## Verification and remaining acceptance

The first focused run passed nine files / 118 tests, covering both surface
registries, popup lifecycle, fonts, overlay, zoom, security and navigation failure.
An additional five receipt/executor/preload/presentation files passed 72 tests
(`/tmp/rion-cp11-receipts.log`), for 190 focused tests in total.
See `/tmp/rion-cp11-tests.log`. Native results are tracked in the execution ledger;
Windows requires its own run. Explicit live-font and mute desktop assertions are
CP-15 coverage work. macOS tab audio is now verified; Windows audio/font application remain pending. macOS FONT-APPLICATION-033 now
verifies local generic-font application and Canvas metrics. These unit tests and settings control visibility
do not establish native coverage. The audit therefore does not close all of CP-11's acceptance.
