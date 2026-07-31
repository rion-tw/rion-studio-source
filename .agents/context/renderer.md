# Renderer

The renderer is a compact desktop app with a 960x640 minimum window. Reuse local
primitives in `src/renderer/src/components/ui` and patterns in `patterns.tsx`.

- Route-level features live under `features`; workflow state belongs in hooks or
  feature controllers; presentation-only utilities stay browser-safe.
- Use Tailwind v4 tokens and `lucide-react` for icon controls.
- Add user-facing text for `en`, `zh-TW`, `zh-CN`, and `ja`; translation namespaces
  must have identical keys and placeholders.
- Keep route-level React lazy loading. Do not add fine-grained dynamic loading
  solely to compensate for oversized source files.
