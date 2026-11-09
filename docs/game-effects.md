# Game Effect Dimming

Settings → Interface → Game effects lowers the brightness of WebGL skill
effects (Flyff Universe findings, 2026-10). It changes how effect draws blend
and skips draws that would be invisible; it never reduces what the game loads.

## Ownership and topology

- Rust owns `GameBrowserSettingsRecord.effects`
  (`enabled`, `level`, `dimBrightSkills`, `hideHitEffects`). Records written
  before the field existed deserialize to the disabled default.
- Electron main follows Core `stateChanged` events through one coalescing
  `gameBrowserSettingsGet` lane and caches the page projection
  (`src/shared/gameEffects.ts`).
- The role preload asks for that projection synchronously at document start.
  Shader source is rewritten only while the game compiles its shaders, so a page
  loaded with dimming off is never hooked. Enabling therefore applies after the
  game page reloads; level and option changes on an already hooked page apply
  live, and disabling turns its hooks into a pass-through.
- `contextBridge.executeInMainWorld` installs
  `src/electron/preload/chromiumRoleGameEffectsRuntime.ts` in the main world.
  The runtime is serialized, so it stays self-contained. Its setter remains in
  the preload's isolated world; the page receives no callable bridge.

## Levels

Screen blending saturates stacked effects, so the setting uses discrete stops
instead of a percentage: Original `1`, Light `0.7`, Medium `0.25`, Heavy `0.08`,
Hidden `0`. Original leaves ordinary effects untouched and applies only the
bright-skill list, darkening effects, and hidden hit effects.

## Draw rules

- Fragment shaders writing `gl_FragColor` gain a `fmsFx` uniform wrapper whose
  zero default is the identity.
- An effect program is one that ever drew additive (`dst = ONE`, `FUNC_ADD`)
  with depth testing. Its additive draws, its alpha draws without depth writes,
  and its `FUNC_REVERSE_SUBTRACT` darkening draws are dimmed. Sky, sun, water
  and UI programs never qualify; dimming them breaks water reflections.
- Dimmed additive draws use `blendFuncSeparate(ONE_MINUS_DST_COLOR, ONE, ZERO,
  ONE)` with premultiplied output, and the game's blend state is restored
  immediately after the draw.
- Mesh effects (`TRIANGLES`) divide each copy by the smoothed per-frame copy
  count of their texture; Spirit Bomb particles do the same while bright-skill
  dimming is on.
- Texture packs fetched from `client/model/texture*/…/<name>.bin` are
  decompressed beside the game to identify bright-skill textures and the
  `sfx_attackcast` Boss ground warnings, which are never dimmed. Every new pack
  rechecks all earlier unidentified uploads because the game shares textures by
  name. Hit-effect textures are identified by `length:sampleHash` signatures.
- Identification runs on the game's main thread when a Boss warning or skill
  first appears, so it must stay linear: each pack is indexed once per document
  into a typed-array hash chain, candidates are rejected by 16 byte probes
  before hashing, chains are capped, and uploads hold their textures weakly.
  A quadratic match once froze the game for the whole lookup.
- A draw whose coefficient cancels it completely (Hidden level, hidden hit
  effects, fully faded darkening effects) is skipped instead of drawn; Boss
  warnings always draw. Stacked particles draw at most 48 copies of one texture
  per frame, each divided by the capped count.
- Pass-through settings (Original level with both extras off) skip
  classification; draws only clear a coefficient left from before.
- Every wrapper forwards the game's call even when bookkeeping throws.

## Changing the rules

After a game update, record a few frames of GL calls read-only, group draws by
program, blend mode, depth test/write and draw mode/vertex count, and compare
groups before and after casting a skill. Skip a whole group to find what it
draws, then bisect.
