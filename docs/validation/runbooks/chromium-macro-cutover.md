# Chromium Macro cutover parity

This runbook covers only these paired replacements:

- `MACRO-INPUT-RECOVERY-011`
- `MACRO-BACKGROUND-TAB-004`
- `MACRO-MIDDLE-BUTTON-013`
- `MACRO-MODIFIER-CONTINUITY-008`
- `MACRO-MULTIROLE-005`
- `MACRO-OWNERSHIP-TRANSFER-010`
- `MACRO-SHORTCUT-REENTRY-007`
- `MACRO-TERMINAL-CLEANUP-006`
- `ROLE-KEY-BLUR-004`

## Required phases

The paired macOS and Windows profiles run the same product scenarios:

1. `chromium-macro-cutover-input-recovery`
2. `chromium-macro-cutover-keyboard`
3. `chromium-macro-cutover-topology-seed`
4. `chromium-macro-cutover-topology-restart`
5. `chromium-macro-cutover-terminal-cleanup-seed`
6. `chromium-macro-cutover-terminal-cleanup-restart`
7. `chromium-macro-background-tab`

The topology and cleanup pairs use separate persistent namespaces. Their restart
phase is not valid without the matching seed phase. Windows must complete
`chromium-windows-trusted-input-physical` before these phases. Its direct-View
evidence must prove exact sibling View identities in separate Sessions under one
foreground parent, trusted foreground key and mouse DOM delivery, and a visible
renderer acknowledgement of 125% zoom. Hidden Ctrl+Shift+B and middle-button
DOM coordinates must remain exact while the target stays hidden and unfocused
behind the visible sibling and the same foreground owner is preserved. Input
submission uses the product View owners and the native parent check is read-only.

## Authority and visible actions

The scenarios create deterministic entities through the typed application bridge,
then perform the actions under test through visible controls:

- Quick Access launches the managed Role or Workspace into the selected window.
- Macro Start and Stop use the visible Macro row.
- WebDriver sends key and middle-button lifecycles to the exact visible managed
  Role WebContents, and the fixture independently requires trusted DOM events.
- Native tab and window actions use retained AppKit controls on macOS and the
  bundled Windows runtime host controls on Windows.
- Application cleanup invokes the exact native AppKit Quit item or Windows UI
  Automation Close control.
- The background-tab phase starts and stops through visible shortcuts in Roles A
  and B. Post-operation topology evidence is read-only: it must not activate,
  show, select, or focus the hidden target to make the assertion pass.

No debug input submission is accepted. Fixture controls may reset local evidence
or arm the navigation failure, and Electron E2E controls may only read exact Role,
window, and trusted-input receipts.

## Evidence gates

Every phase writes one phase-local JSON artifact. Runtime validation requires:

- `appkit-chromium` with a retained AppKit identity on macOS;
- `bundled-chromium` plus the physical ABI-v3 foreground-and-hidden artifact on
  Windows;
- positive exact owner and surface generations;
- trusted DOM key/mouse effects and applied native receipts;
- confirmed input neutrality for terminal held-key cleanup;
- the exact mixed Role/Workspace/Web cohort and ownership transfer generation;
- `runtimeRestoreSession.cleanExit === true` after every normal lifecycle terminal.

Success is event-bound. Fixture events, renderer projections, native receipts, or
process termination decide completion; elapsed time, polling, and sleeps do not.

## Local validation

Source-only development may run:

```bash
pnpm exec vitest run tests/chromium-macro-cutover-e2e-source.test.ts
pnpm exec vitest run tests/chromium-macro-background-tab-e2e-source.test.ts
pnpm run typecheck
pnpm run check:source-hygiene
```

The macOS profile must run on a host with Accessibility permission for retained
AppKit controls. The Windows paired verdict and ABI-v3 physical input capability
remain pending `windows-latest` CI when no Windows host is available locally.
