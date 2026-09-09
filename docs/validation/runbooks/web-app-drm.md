# Web App DRM permission and playback validation

## Boundary

Electron 43.6.0 remains the runtime. Contract 24 permits `mediaKeySystem` only
in the dedicated global-Web Session with HTTPS requesting and embedding origins.
Journal policy version 2 records the permission callback stage, normalized
origins, result and reason. Roles and local shell sessions keep denying DRM.
No CDM installation, alternate runtime, browser-profile reuse, certificate
exception or signing change is part of this work.

## Automated evidence

Run the DRM permission, global-Web registry and security-journal tests, then the
`chromium-macos-appkit-smoke` and `chromium-windows-smoke` desktop profiles.
The paired `WORKSPACE-WEB-SECURITY-POLICY-027` journeys use a visible DRM button
in a controlled HTTPS popup sharing the exact global-Web session. The reserved
test origin is served through an E2E-only local transport; ordinary Web App
session persistence remains covered by the existing HTTP fixture.

Read `electron-workspace-web-security-policy.json` and fixture `drm-result`
events independently. Every observed HTTPS DRM decision must be allowed.
`NotSupportedError` without a permission callback means Chromium rejected the
key-system request before the Rion permission policy was consulted. It is not
evidence of successful playback. Origin rejection and session isolation have
platform-explicit unit coverage even when the installed runtime has no CDM.

The macOS AppKit host, sibling geometry, controlled-popup ownership and contained
fullscreen remain covered by the paired `WORKSPACE-WEB-FULLSCREEN-017` journeys.
Windows evidence must come from Windows; host-rejection on macOS is a pending
Windows gate, not a passed test.

## Real iq.com playback

The owner supplied [Genius Girlfriend, episode 1](https://www.iq.com/play/genius-girlfriend-episode-1-24fqrcz8kwo?lang=en_us).
Chrome playback has already been confirmed by the owner.
The owner also confirmed that this episode does not require login.

1. Record the Rion build, OS, test time and whether the Web App is signed in.
   Use the same video, account and network for before/after comparisons.
2. Open the URL through visible Rion Web App controls and click the player.
   Record the visible player error or actual rendered video and advancing time.
3. If playback works, test pause/resume, seek, subtitles, quality selection and
   contained fullscreen without changing the owning AppKit window or siblings.
4. If playback fails, separate permission denial, key-system/codec rejection,
   license rejection, navigation/network errors and unresolved website errors.
   Do not classify a generic `NotSupportedError` as proof of a particular CDM
   installation state or as proof that this video requires Widevine.
5. Record only error names, status codes and sanitized origins. Do not export
   cookies, authorization headers, license payloads or token-bearing URLs.

Stop at the evidence report. A subsequent Widevine integration is a separate
decision and is unnecessary if permission repair restores the requested video.

## Initial isolated capability comparison (2026-09-09)

A temporary, hidden Electron window with a local HTTPS fixture tested the same
`com.widevine.alpha` CENC/H.264 configuration before and after the policy change.
Both returned `NotSupportedError`, with no DRM permission callback. H.264
`canPlayType` returned `probably`; this is capability advertisement, not decoding
or playback proof. These isolated probes do not constitute AppKit or iq.com
acceptance. Real-video results must be recorded separately.

## Implementation checks (2026-09-09, macOS arm64)

- Focused Vitest: 94 tests passed; full Vitest: 3,774 passed, 19 skipped.
- Native integration: 14 passed, 2 skipped, executed separately from desktop E2E
  because both suites own visible native windows.
- Rust workspace: 1,126 passed, 5 ignored with
  `pnpm run test:rust -- --test-threads=4`. An initial unrestricted run exposed an
  existing macro cancellation deadline sensitivity; its isolated rerun and the
  complete reduced-concurrency run passed. A schema-attribution fixture now uses
  a current timestamp so the independent 14-day retention rule cannot expire it.
- Rust lint, TypeScript typecheck, ESLint and source hygiene passed. ESLint retains
  23 existing renderer fast-refresh warnings.
- Coverage remained P0 48/48, P1 60/60 and P2 4/4. Windows native and
  `chromium-windows-smoke` remain pending Windows CI; macOS host rejection is not
  Windows validation.

The macOS fullscreen seed and restart phases passed in
`.desktop-e2e-artifacts/2026-09-09T02-07-06-293Z-darwin`. Both recorded a trusted
DRM button click followed by `NotSupportedError`, with no DRM permission callback.
The broader profile later failed in the unrelated controlled-Role Reload native
Accessibility window lookup; the isolated Role Reload rerun passed in
`.desktop-e2e-artifacts/2026-09-09T02-11-48-637Z-darwin`. This does not make the
interrupted full profile green.

## Visible iq.com acceptance (2026-09-09)

The normal local profile could not reach playback because startup rejected a
saved Game Window display identity. The comparison therefore used an isolated
copy of its closed SQLite database. Rust Core disabled startup restoration and
removed saved windows only in that copy. No Chrome profile, Rion browser-profile
directory or login credentials were copied. Both runs used the same resulting
guest Web App session, video and network.

Two temporary copies of the production build provided a controlled policy
comparison. Both used Electron 43.6.0 and contract 24; the before copy changed only
the global-Web `allowWebAppDrm` opt-in to false. Both copies logged only normalized
DRM decisions to diagnostic stdout. This reproduces the old deny policy but is
not a historical contract-23 binary comparison. Repository build output retained
the enabled production policy.

| Evidence | DRM opt-in disabled | DRM opt-in enabled |
| --- | --- | --- |
| Entry | Visible Rion Web App address bar, supplied episode URL | Same visible controls and URL |
| Main episode | Rendered after six preroll ads; 360P then 720P; advanced past 02:20 of 49:16 | Rendered at 720P; resumed at 01:59 and advanced to 02:09 |
| Permission callbacks | None observed | None observed |
| Controls | English subtitles visibly rendered | Visible pause succeeded |

The owner confirmed normal audio and explicitly accepted playback, requesting
commit without further player operation. Seeking, subtitle switching and the
real-site fullscreen control were not separately exercised after that acceptance;
contained fullscreen has the automated AppKit seed/restart evidence above.
Build, production E2E isolation, documentation checks and final lint passed.

**Permission implementation:** focused policy tests and the affected macOS
`WORKSPACE-WEB-SECURITY-POLICY-027` / `WORKSPACE-WEB-FULLSCREEN-017` journeys pass.
**Playback:** the supplied free episode plays in the isolated Rion environment
and is owner-accepted. The original failure was not reproduced, so playback
cannot be attributed to this permission change. No actual-video DRM, license or
codec rejection was observed. The independent Widevine `NotSupportedError`
remains a capability-probe result, not proof that this episode needs a CDM.
No Widevine/Castlabs integration is justified by this successful playback case.
