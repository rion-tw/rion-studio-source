# Rion Studio Design System

Rion Studio uses a compact glass desktop interface. All product-owned surfaces
share [`src/shared/designTokens.css`](../src/shared/designTokens.css). The React
renderer, launch screen, Windows runtime tab strip, and Shadow DOM overlays
injected into game pages must not maintain separate palettes or dimensions.

## Visual principles

- Primary calls to action use neutral black/white `primary`; brand color does
  not represent every action.
- `activity` blue represents selection, focus, toggles, drop targets, running
  work, and live state only.
- `success`, `warning`, and `destructive` represent successful results,
  warnings, and errors or destructive actions respectively.
- Disabled, inactive, and secondary information uses `muted`; green never means
  merely “running.”
- Standard controls and floating hit targets are 30px. Standard icon-button
  icons are 14px.
- All numbers use lining and tabular figures so counts, times, and diagnostics
  do not shift.

## Token categories

### Typography

| Meaning | Token | Size/line height | Use |
| --- | --- | --- | --- |
| Page title | `--type-page-title-*` | 30/36 | Route title |
| Title | `--type-title-*` | 17/24 | Dialog and primary-card title |
| Heading | `--type-heading-*` | 15/20 | Section and secondary heading |
| Body | `--type-body-*` | 13/20 | General content |
| Control | `--type-control-*` | 12/16 | Navigation, buttons, fields, menus, settings rows, tables |
| Caption | `--type-caption-*` | 11/16 | Supporting information and badges |
| Micro | `--type-micro-*` | 10/12 | Space-constrained metadata |

React should prefer `text-page-title`, `text-title`, `text-heading`, `text-body`,
`text-control`, `text-caption`, and `text-micro`. Existing `text-xs` through
`text-2xl` map to the same type ramp, but new code should use semantic names.
Register semantic names in the renderer `tailwind-merge` theme; otherwise merging
with color classes such as `text-foreground` can remove them and fall back to the
browser default 16px size.

Navigation labels and 30px Button, Input, Select, menu, and segmented controls in
the compact shell use `control` at 12px. Badges and supporting information use
`caption` at 11px; constrained counters use `micro` at 10px. Do not shrink body
text to compensate for layout problems.

### Spacing, controls, and radius

- Use only `2/4/6/8/10/12/16/20/24/32/40/56px` spacing. The required segmented
  control inset uses `--segmented-inset: 3px`.
- Control dimensions use `--control-height`, `--control-hit-size`,
  `--control-min-size`, and `--icon-button-icon-size`.
- Radius uses `--radius-xs/sm/md/lg/pill` (`4/6/8/12px/pill`). Tailwind
  `rounded-*` utilities read the same variables.

### Color

Base semantics include canvas/background, sidebar, card/surface, popover, muted,
control, text, border, ring, scrim, and on-media. State colors are `activity`,
`success`, `warning`, and `destructive`, paired with their matching foreground
tokens. Components must not use raw Tailwind palette values such as `blue-500`
or raw hex, rgb, or hsl colors.

The shared token stylesheet defines both light and dark palettes. `system` is a
preference, not a resolved palette; the renderer passes only `light | dark` to
the runtime after resolution.

### Elevation and materials

General content, selection, toast, modal, popover, and tooltip use the ordered
`--layer-*` tokens. Browser overlays use a separate highest-layer token. Do not
introduce numeric `z-index` values.

Glass surfaces use `.glass-panel`, `.glass-panel-strong`, `.glass-modal`,
`.glass-popover`, `.glass-control`, and `.glass-inset`. Tokens and `styles.css`
provide their border, shadow, blur, and reduced-transparency fallback.

## Shared components

- `Surface`: panel, strong, modal, popover, control, and inset materials.
- `Button`: default neutral CTA, outline, secondary, ghost, subtle, destructive,
  and `media`. The role-cover `media` variant uses fixed on-media liquid glass so
  light and dark images retain a visible boundary and highlight.
- `Badge`: default, secondary, outline, activity, success, warning, destructive.
- `Field` / `FieldHeader`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`,
  and `Slider`: shared 30px rhythm, focus, and disabled states.
- `SegmentedControl` and `NavItem`: selection uses `activity`.
- `DialogLayer`: modal shell and backdrop outside React portal/dialog ownership.
- `StatusCallout`: muted, activity, success, warning, and destructive messages.
- `SettingsSection` / `SettingsRow`: settings sections, dividers, titles,
  descriptions, and control alignment.
- `PageFrame` / `PageHeader`, `EmptyState`, and `IconTile`: base rhythm for
  routes and empty, error, or loading states.

New features compose these components first. Add a variant only when a state
cannot be expressed consistently across screens.

## Theme and runtime

- The renderer preserves the `light | dark | system` preference and existing
  localStorage/portable behavior.
- `ResolvedTheme = "light" | "dark"` is a shared contract. The renderer calls
  `setRuntimeTheme` whenever the resolved theme changes; runtime state is memory-only.
- The Windows runtime tab document updates `data-theme` and `color-scheme` from
  the projection, so open windows update immediately.
- The macOS native tab controller does not receive theme; its appearance and API
  remain unchanged.
- Shadow DOM overlays use the same token names, but `:host` fixes a high-contrast
  dark palette and does not inherit the game page font, root font size, or background.

## Allowed exceptions

- A role cover dominant color is dynamic user/image-derived data passed through
  `--role-cover-accent`; fallback and masks still use tokens.
- Cover/canvas image generation may use pixel colors because it is not a
  component palette.
- Image masks, normalized workspace rectangles, pointer coordinates, visible
  viewports, and media aspect ratios are layout/media geometry and may use
  computed values or dynamic inline styles.
- `rounded-[inherit]` may let a selection overlay inherit its host shape; it must
  not create a new arbitrary radius.

## Adding a token

1. Confirm that no existing semantic token or component variant expresses the need.
2. Name the token by purpose in `src/shared/designTokens.css`, not by one page or
   literal color.
3. Define both light and dark values; when overlays need it, verify contrast in
   the `:host` dark palette.
4. Map the token in the `styles.css` `@theme` block without duplicating its raw value.
5. Update affected components, this document, and focused tests. Validate token
   governance, light/dark, reduced motion/transparency, and the 960×640 layout.
