# Native Validation

Active runbooks describe procedures that remain valid for current code. Archive
artifacts record what happened at an exact historical source state and must not
be treated as current evidence.

## Active runbooks

- [Windows Game Window Placement](runbooks/windows-game-window-placement.md):
  W1-W11 placement, persistence, display, DPI, and generation-fence acceptance.
- [macOS WKWebView Game Mode A/B](runbooks/macos-wkwebview-game-mode.md):
  isolated fullscreen Game Mode eligibility, workload controls, and FPS gates.

Desktop smoke, full, and extended profile policy remains in
[Desktop E2E Strategy](../e2e-strategy.md). Journey and phase membership remains
in `docs/e2e-coverage.json`.

## Immutable archive

`archive/manifest.json` lists every retained file, its original location,
capture commit or tested SHA when available, and SHA-256 digest. Archived files
retain their original language, internal paths, prompts, and conclusions. Those
historical references may name paths that no longer exist at current `HEAD`.

To add evidence, create a new dated directory and manifest entry. Never revise
an existing archived artifact to make it appear current.
