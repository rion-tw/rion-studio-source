# Shared Contract Scope

- Generated TypeScript under `generated` comes from `rion-core`; do not edit it by hand.
- Hand-written aliases and API types must remain thin and browser-safe.
- Contract changes update Rust, generated output, Tauri, bridge, renderer, and tests together.
- Browser-overlay scripts execute inside remote pages and may communicate only
  through the bounded authenticated native bridge.
