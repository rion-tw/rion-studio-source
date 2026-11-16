# Game Effect Dimming

Settings → Interface → Game effects lowers the brightness of WebGL skill
effects (Flyff Universe findings, 2026-10) and can thin repeated particle
clouds. It changes how effect draws blend and skips draws that would be
invisible or exceed the chosen density; it never reduces what the game loads.

## Ownership and topology

- Rust owns `GameBrowserSettingsRecord.effects`
  (`enabled`, `level`, `dimBrightSkills`, `hideHitEffects`, `density`).
  Records written before a field existed deserialize to its default (disabled,
  density 100).
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
Hidden `0`. Original leaves ordinary effects, including darkening effects,
untouched and applies only the bright-skill list and hidden hit effects.

## Density

Density is generic, never a skill list: Flyff draws each particle with its own
draw call, so frame cost follows the copies of one texture per frame (Retina
doubles fill cost), not texture size; Elementor Sandstorm's pack is 11.5 KB.
Stops are 100/75/50/25 %.

- Only effect-program draws are counted. A particle texture drawn more than 8
  times per frame (smoothed over earlier frames) is a cloud; a newly appearing
  cloud draws in full for its first frame.
- A cloud draws only its first `max(8, ceil(copies × density))` copies per
  frame, a stable prefix instead of a modulo, so survivors do not flicker as
  particles die.
- Large-area effects stack a few big `TRIANGLES` layers instead (Sandstorm:
  one to seven 360–2,700-vertex layers of one texture per frame). A mesh
  texture drawn more than twice per frame keeps its first
  `max(1, ceil(copies × density))` layers; meshes drawn once or twice are
  untouched. Measured on M3 Max at 3024×1898 (2026-11-09): at 25 % about 70 %
  of Sandstorm's effect draws were skipped and its lowest FPS rose from 61 to
  106 without visible flicker.
- Additive survivors brighten by `copies / drawn` (at most 4×) through a
  negative `fmsFx.y`, keeping the cloud's light; dimmed mesh effects divide by
  the drawn count instead. Undimmed thinning keeps the game's own blending.
- Protected packs are never thinned.
- Monster ground circles and expanding ring waves not on the protected list
  (`UNTHINNED_PREFIXES`: `fly_sfx_red_ringwave`, `fly_sfx_red_mark*`,
  `fly_sfx_circle_red_*`, `sfx_red_fire_ring*`) are never thinned but still
  follow the brightness level. Several monsters share one circle texture and a ring wave
  spawns repeated layers, so thinning made circles flicker, fade, or vanish
  mid-expansion (2026-11-16).

## Draw rules

- Fragment shaders writing `gl_FragColor` gain a `fmsFx` uniform wrapper whose
  zero default is the identity.
- An effect program is one that ever drew additive (`dst = ONE`, `FUNC_ADD`)
  with depth testing. Its additive draws, its alpha draws without depth writes,
  and its `FUNC_REVERSE_SUBTRACT` darkening draws follow the level. Darkening
  draws dim further only when their texture is on the bright list (Gravity
  Well); other dark ground effects are untouched at Original. Sky, sun, water
  and UI programs never qualify; dimming them breaks water reflections.
- Dimmed additive draws use `blendFuncSeparate(ONE_MINUS_DST_COLOR, ONE, ZERO,
  ONE)` with premultiplied output, and the game's blend state is restored
  immediately after the draw.
- Mesh effects (`TRIANGLES`) divide each copy by the smoothed per-frame copy
  count of their texture; Spirit Bomb particles do the same while bright-skill
  dimming is on.
- Texture packs fetched from `client/model/texture*/…/<name>.bin` are
  decompressed beside the game to identify bright-skill textures and protected
  textures. Every new pack rechecks all earlier unidentified uploads because the
  game shares textures by name. Uploads up to 1 MiB are matched: large ground
  and pillar textures exceed 256 KB. A candidate is confirmed by at most about
  4,096 sampled bytes, so noting a large upload costs no more than a small one.
  Hit-effect textures are identified by `length:sampleHash` signatures (every
  7th byte), computed only for the recorded lengths (512, 8,192, 32,768).
- Identification runs on the game's main thread when a Boss warning or skill
  first appears, so it must stay linear: each pack is indexed once per document
  into a typed-array hash chain, candidates are rejected by 16 byte probes
  before hashing, chains are capped, and uploads hold their textures weakly.
  A quadratic match once froze the game for the whole lookup.
- A draw whose coefficient cancels it completely (Hidden level, hidden hit
  effects, fully faded darkening effects) is skipped instead of drawn;
  protected textures always draw. Stacked particles draw at most 48 copies of one texture
  per frame, each divided by the capped count.
- Pass-through settings (Original level with both extras off) and unblended
  draws skip classification; they only clear a coefficient the program kept
  from an earlier effect draw. The bound program's uniform location and last
  coefficient are cached at `useProgram`, not looked up per draw (the game
  issues 40,000–170,000 blended draws per second). Re-linking a program resets
  its uniforms, so its cached coefficient is dropped.
- Every wrapper forwards the game's call even when bookkeeping throws.

## Protected packs

Effects players read during play are never dimmed, thinned or hidden at any
level, including Hidden. The runtime lists them by exact pack name or prefix
(`PROTECTED_FILES`, `PROTECTED_PREFIXES`), chosen from a 2026-11 audit of packs
the game downloaded:

- Boss ground warnings (`sfx_attackcast`) and monster cast rings and ground
  pools (`fly_sfx_sk_bg_*`, dark green and bright violet circles,
  `sfx_npcrisemsign`).
- Monster skills, red circles and ground marks that no player skill uses,
  taken from the original author's game-data list of non-skill packs
  (2026-10-31): red fire and fatal circles, red auras and magic circles, red and
  violet command circles (`sfx_move_*_command_cir`), green poison dots, blue
  fire rings, guardian marks, attack arrows, `magiccircle`, Behemoth fire and
  similar monster packs. Item, weapon and system entries of that list are not
  copied.
- Blinkwing teleport (`sfx_blinkwing*`), warp points, gates and exits.
- System notices: level up, upgrade success/failure/enchant (`sfx_genint*`),
  character system (`sfx_chrsys*`), tutorial.

Item glow (weapon enchant glow, element upgrades, weapon effects) is not
protected: it is dimmed with other effects at the owner's request (2026-11-16).

A protected texture shared with a skill keeps that skill's copy undimmed too.

Entaness (Queen of Thorns) draws its purple outer cast ring with `t_ring001`,
a pack player skills share. That pack is undimmed only while a Boss warning
(`sfx_attackcast`) was drawn within the last 500 ms; the puddle left after the
cast and player skills using the pack dim as usual.

The click-to-move marker (`texbase`) is not protected yet. Ground poison pools
(Water Totem Pole, Twinstrike Den Mother, Monument of Death) share Gravity
Well's textures and can only be told apart by nearby monster names in game
memory, which this runtime does not read, so they dim with Gravity Well. Shared packs such as
`sfx_genref` stay unprotected because most skills draw from them.

## Render targets

Copy counts are kept per bound framebuffer, so a reflection or other offscreen
pass that redraws the same particles never spends the main pass's budget.

## Development draw trace

Unpackaged builds trace every blended draw on pages where effect dimming is
enabled (any level, including Original). Once per second, the page sends one
JSON line to `<userData>/diagnostics/effects-trace.jsonl` (capped at 32 MB per
session): canvas size and the 64 heaviest groups by vertex count, grouped by
render target, texture (with its upload shape and any bright/warning/hit
identity), draw mode, blend function and equation, and depth test/write. Each
group records draws, vertices, the largest single draw, the most draws in one
frame, and how many draws the rules applied or skipped. The trace only reads
GL state; packaged builds never install it.

## Changing the rules

After a game update, enable the development draw trace, cast the skill, and
compare its groups with the frames before it. Skip a whole group to find what it
draws, then bisect.
