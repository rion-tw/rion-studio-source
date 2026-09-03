# Native Validation

Active runbooks describe procedures that remain valid for current code. Archive
artifacts record what happened at an exact historical source state and must not
be treated as current evidence.

## Active runbooks

- [Windows Game Window Placement](runbooks/windows-game-window-placement.md):
  W1-W11 placement, persistence, display, DPI, and generation-fence acceptance.
- [macOS WKWebView Game Mode A/B](runbooks/macos-wkwebview-game-mode.md):
  isolated fullscreen Game Mode eligibility, workload controls, and FPS gates.
- [macOS Flyff Brave/Rion Same-Scene A/B](runbooks/macos-flyff-brave-rion-same-scene.md):
  matched Effects-on scene controls, interleaved sampling, and stability gates.

Desktop smoke, full, and extended profile policy remains in
[Desktop E2E Strategy](../e2e-strategy.md). Journey and phase membership remains
in `docs/e2e-coverage.json`.

The Chromium Macro native-effect contract has a focused portable source/unit
gate:

```bash
pnpm exec vitest run tests/chromium-macro-native-effect-e2e-source.test.ts \
  tests/electron-windows-chromium-input-surface-attachment.test.ts \
  tests/electron-windows-chromium-trusted-input-adapter.test.ts \
  tests/electron-windows-chromium-trusted-input-runtime.test.ts \
  tests/electron-windows-chromium-native-input-probe.test.ts
```

Its live `chromium-macro-native-effect` and `chromium-macro-background-tab`
phases remain pending their respective macOS/Windows desktop runners. Windows
also runs the ABI-v3 foreground-and-hidden physical probe in
`chromium-windows-trusted-input-physical`; portable or macOS results cannot
substitute for that Windows evidence.

## Immutable archive

`archive/manifest.json` lists every retained file, its original location,
capture commit or tested SHA when available, and SHA-256 digest. Archived files
retain their original language, internal paths, prompts, and conclusions. Those
historical references may name paths that no longer exist at current `HEAD`.

To add evidence, create a new dated directory and manifest entry. Never revise
an existing archived artifact to make it appear current.
