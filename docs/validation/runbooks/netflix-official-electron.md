# Netflix feasibility with official Electron

## Scope and reproduction

This is a capability investigation, not Netflix playback certification. Keep
the pinned official Electron runtime, the AppKit/Windows hosts, existing HTTPS DRM permissions,
and current platform signing policies. No public API, Rust contract or database
migration is introduced. No external browser profiles, CDM extraction, ECS or EVS
are used.

The current runtime is Electron 44.4.3. The results below were recorded on
43.7.0 and are not playback certification for the upgraded engine.

On a native macOS or Windows checkout with desktop E2E prerequisites:

```bash
node scripts/probeWorkspaceWebDrm.mjs
```

The runner builds the E2E app and runs the entity prerequisites followed by
`chromium-workspace-web-fullscreen-seed` and `-restart`. Each phase creates a
temporary workspace containing two running Roles and one Web slot, enters native
fullscreen and clicks the visible diagnostic button. The normal profile retains
the separate navigation recovery journey. The diagnostic checks that both
Roles remain running and recovers through the visible Home button. The original
single-Role geometry journal remains separate.

Results are in the printed artifact directory, under
`phases/chromium-workspace-web-fullscreen-{seed,restart}/workspace-web-drm-capability.json`.
An exit code of zero means the diagnostic harness completed; it does **not** mean
Widevine or Netflix playback passed. Inspect `capability.nextStage` and the
explicit `not-tested` acceptance fields. An interrupted run is not a pass.

The local test page uses the existing E2E-only reserved HTTPS origin and local
transport. There is no certificate bypass or production HTTPS interception.
Public manifest requests use real HTTPS. The opt-in network
probe does not make the ordinary desktop suite depend on external services.

## Evidence and interpretation

| Stage | Recorded evidence | Limit |
| --- | --- | --- |
| Runtime | Actual `process.versions`, OS/architecture, `app.isPackaged`, switch names and relevant switch presence | E2E command-line switches are not production configuration |
| Distribution | Widevine/ClearKey/FFmpeg matching component filenames under the launched binary distribution | Filename inventory does not prove compiled or dynamically loaded CDM state |
| Session | Exact global-Web storage equality, isolated runner user-data equality, policy version | Does not inspect another browser's data |
| Permission | New DRM callback allow/reason values from the exact live surface generation | No callback is not an observed permission denial or grant |
| Key system | Minimal Widevine, AVC, AVC/AAC, VP9/Opus; separate ClearKey control; access and MediaKeys creation | `NotSupportedError` does not identify one particular installation, policy or codec cause |
| Formats | AVC/AAC/VP9/Opus `canPlayType` and MediaSource support | Advertisements are not actual decoding |
| Public media | Angel One Widevine manifest HTTP status and Widevine signaling | No media segments, license exchange or decrypted frames are implied |
| Playback | License, decoding, Netflix, audio, resolution and player controls explicitly marked | Capability success alone does not satisfy any playback acceptance |

Reports omit raw errors, argv values, absolute user paths, Cookie/storage contents,
license payloads, keys, PSSH and token-bearing URLs. Only fixed error categories
and known public asset identifiers are serialized. E2E runtime profiles are local
test state, not diagnostic exports; do not distribute profile directories or raw
driver logs. No Netflix account is accessed during a blocked prerequisite run.

## Playback gate and manual acceptance

If `nextStage` is `key-system-prerequisite-unmet`, stop before Netflix sign-in.
Record the failed configurations, permission observations and component scope.
Do not assign a license-server or Netflix rejection without a license attempt.

If it becomes `public-encrypted-playback-required`, open the
[official Shaka demo](https://shaka-project.github.io/shaka-player/demo/) in the
same Web slot and select **Angel One (multicodec, multilingual, Widevine)** from
[the official asset catalog](https://github.com/shaka-project/shaka-player/blob/main/demo/common/assets.js).
Use its published Widevine license configuration. Record player error category
and numeric code, license HTTP status without content, rendered frames/advancing
time, actual video dimensions and audible audio. A ClearKey clip does not qualify.

Only after this public encrypted sample works should the user sign into Netflix
through the visible Web slot. Do not automate credentials or export account data.
For a full title, observe at least two continuous minutes, normal picture/audio,
pause/resume, seek, subtitle switching and fullscreen entry/exit. Repeat with two
Roles plus Web, confirm Roles continue and navigation remains usable, then quit
and restart. Record actual resolution; no minimum resolution is required.

Repeat on a verified production package with an isolated OS/user-data profile
and visible native controls. Never enable E2E preload, remote debugging or alter
the production archive/fuses to collect evidence. Build with
`pnpm run package:electron:dir`, verify with `pnpm run verify:electron-package -- --app <app-path>`,
and follow the isolation procedure in [the desktop E2E strategy](../../e2e-strategy.md).
For a repeatable isolated production workspace containing two Roles and the public
Shaka support page, run:

```bash
node scripts/preparePackagedWorkspaceDrm.mjs --app '<absolute app bundle path>'
```

The package must contain the existing release updater endpoint and legitimate
public verification key at build time. Use an existing release-configured build;
do not generate replacement trust material for this test. The launcher validates
that embedded updater configuration without checking/downloading updates,
verifies the immutable package, seeds only isolated data using the
packaged Core, opens the workspace through native Quick Access, and waits for the
operator to quit the visible app. Record native page evidence before quitting.
Its launch report is not playback proof. macOS uses a private unmodified bundle
copy and fixed test home; Windows requires the repository's verified isolated OS
profile. It never launches the user's ordinary profile. The two Roles load the
public `example.com` page, so their presence proves coexistence only, not a game
or Macro workload.

Each platform/build combination needs its own result; Windows is not proven by
macOS and a development result is not production playback evidence.

## Official interface limits

[Electron's Session API](https://www.electronjs.org/docs/latest/api/session)
documents `mediaKeySystem` as a permission. It does not promise an installed CDM,
successful license exchange or acceptance by Netflix.
[Electron upstream source](https://github.com/electron/electron/blob/main/shell/app/electron_content_client.cc)
contains build-conditional Widevine registration using CDM path/version switches.
That is not proof that this exact release includes compatible registration, nor
that a compatible redistributable CDM or Netflix host verification is available.
Therefore this investigation does not claim that every official Electron
integration is impossible. A valid integration would require a legitimately
supplied compatible CDM, exact release/build verification and service acceptance;
none is supplied or validated here. Do not copy one from the user's Chrome.

[Netflix's M7701-1003 guidance](https://help.netflix.com/en/node/27451) directs
Chrome users to `chrome://settings/content/protectedContent`, and separately
directs unsupported Chromium-browser users to supported browsers. Adding that
setting to Rion would not establish playback capability.

## Native results (2026-09-21)

Host: macOS 27.0 (26A428), arm64. The successful development run is
`.desktop-e2e-artifacts/drm-2026-09-21T00-06-52-655Z/2026-09-21T00-06-52-692Z-darwin`.
Both seed and restart phases, including their evidence validators, passed.

| Observation | Before restart | After restart |
| --- | --- | --- |
| Actual Electron / Chromium / Node | 43.7.0 / 150.0.7871.250 / 24.21.0 | Same |
| Official development binary, exact isolated global-Web Session | Verified | Verified |
| Widevine path/version switches | Both absent | Both absent |
| Named distribution CDM artifacts | None; `libffmpeg.dylib` present | Same |
| HTTPS secure context / EME API | Both present | Both present |
| Four Widevine configurations | All `NotSupportedError`; no MediaKeys | Same |
| ClearKey control | Access granted; MediaKeys created | Same |
| AVC/AAC/VP9/Opus advertisements | `probably`; MediaSource `true` | Same |
| DRM policy callbacks during probe | None; no observed denial | Same |
| Public Angel One Widevine manifest | HTTP 200, Widevine signaling present | Same |
| Two Roles / new shell errors | Both running / none | Same |
| Visible Home recovery and native fullscreen exit | Passed | Passed |
| License / encrypted decoding / Netflix full title | Not attempted: prerequisite unmet | Same |

These combined observations identify unavailable Widevine access in the tested
configuration, while the secure EME environment, ClearKey control, advertised
codecs and public manifest transport function. They do not independently prove
the precise compiled CDM state, a decoder defect, a permission denial, a license
rejection or Netflix service-side rejection. No Netflix login was requested.
Resolution, audible protected audio, two-minute full-title playback and player
controls remain unverified.

Earlier diagnostic runs exposed two harness issues: the paired-workspace
inspection rejected a two-Role fixture, and mixing that fixture's journal into
the paired permission/download evidence broke its validator. The final observer
retains exact native/Core ownership and keeps these journals separate; focused
tests cover stale identities and journal isolation. A separate public Shaka
support-page attempt did not complete within the observation window; one driver
run also timed out during document targeting after navigation recovery. These
interrupted runs are not passes and do not establish a DRM cause. The final
diagnostic opens the capability page as its initial Web slot, while the normal
profile retains the separate navigation recovery test.

The macOS full profile was attempted separately and stopped in the unrelated
`chromium-extensions-seed` journey: the external Buster Chrome Web Store title
did not become visible within 30 seconds. Smoke/full are aliases of the same
platform phase set; neither complete profile is reported green. Windows native
development, production and Netflix playback remain pending a Windows host/CI.

Implementation validation: full Vitest 4,748 passed / 19 skipped (525 passing
files); Rust workspace 1,246 passed / 5 ignored; Rust lint, TypeScript, source and
documentation hygiene, coverage manifest and ESLint passed. ESLint retains 23
existing React fast-refresh warnings. Coverage remains P0 54/54, P1 74/74 and
P2 4/4. Production packaging and native package observations are tracked below;
they do not convert the blocked Netflix acceptance into a pass.

### Production package result

`pnpm run package:electron:dir` completed on macOS arm64 using official Electron
43.7.0, ad-hoc identity `-` and explicitly disabled notarization. Package
verification and production E2E isolation passed; the distribution contains
`libffmpeg.dylib` and no named Widevine component. The immutable package was
launched in a private copy with a fixed isolated test home. Its native startup
alert was **`UPDATE_ENDPOINT_MISSING`**, before the workspace could open.

The current build environment supplies neither `RION_STUDIO_UPDATER_ENDPOINT`
nor `RION_STUDIO_UPDATER_PUBLIC_KEY`. These are embedded by the existing release
workflow, not runtime settings. The diagnostic now checks the packaged native
updater factory before launching, and reproduces the same code in the sanitized
artifact
`.desktop-e2e-artifacts/packaged-drm-2026-09-21T00-14-50-657Z/packaged-drm-failure.json`.
It does not install/check updates, bypass validation or create a replacement key.
The failed private process tree was verified gone and its temporary bundle copy
removed. No ordinary Rion profile was opened.

Production Web/DRM, restart, audio/video and Netflix controls therefore remain
**blocked by package startup configuration**, not failed DRM acceptance. An
existing release-configured package is needed for that native pass. This local
directory build is not a release candidate or a signed updater distribution.
The separate older packaged-role seed helper still requests contract 43; this
diagnostic seeds the current contract-47 package directly through its Core
factory, without changing any product contract or database schema.

### Acceptance rerun (2026-09-21, 08:26–08:27 Asia/Taipei)

The requested acceptance rerun used the current working tree based on
`8e7f67d279e55ba364e339c66c63bf22076932da`. Fresh evidence is under
`.desktop-e2e-artifacts/drm-2026-09-21T00-26-27-178Z/2026-09-21T00-26-27-219Z-darwin`.
The runner exited zero. Its `report.json` records all four selected phases
(entity seed/restart and Web fullscreen seed/restart) as `PASS`, with final
flush and process exit confirmed. This is a selected-phase result, not a pass
for the entire desktop profile or the separate navigation recovery journey.

Both capability reports independently reproduce the results above: actual
Electron 43.7.0 / Chromium 150.0.7871.250, isolated exact Web Session, four
Widevine `NotSupportedError` results, successful ClearKey MediaKeys creation,
and public manifest HTTP 200. Two Roles remain running, no new shell errors
are recorded, and the visible Home recovery and fullscreen exit assertions
complete in both phases. No permission callback is observed; the result does
not establish a permission denial. No license or encrypted decoding is attempted.

The five focused probe, owner, policy, Chromium DRM permission and DRM fixture
test files were rerun: **46 tests passed**. The current production bundle passed
static package verification again, but its packaged native updater preflight
still returned `UPDATE_ENDPOINT_MISSING` in a fresh temporary data directory.
No replacement trust key or startup bypass was introduced.

Acceptance verdict: the macOS development diagnostic and its restart path pass;
**Netflix playback acceptance remains blocked and is not passed**. Full-title
video/audio, two-minute playback, resolution and player controls remain
untested because the Widevine prerequisite fails. Production playback remains
blocked by startup configuration. Windows native acceptance remains pending.
The previously reported whole-suite checks were not rerun for this documentation
record, and the unrelated full-profile extension-store failure remains open.
