/**
 * Main-world WebGL effect dimming for game pages (Flyff Universe findings,
 * 2026-10). `contextBridge.executeInMainWorld` serializes this function, so it
 * must stay self-contained: no imports, module constants, or outer closures.
 *
 * Rules (see docs/game-effects.md):
 * - Fragment shaders that write `gl_FragColor` get a `fmsFx` uniform wrapper;
 *   its zero default is the identity, so non-effect draws are untouched.
 * - An effect program is one that ever drew additive (dst ONE, FUNC_ADD) with
 *   depth testing. Its additive draws, its non-depth-writing alpha draws, and
 *   its REVERSE_SUBTRACT darkening draws are effect draws. Sky, water and UI
 *   never qualify, and Boss ground warnings (sfx_attackcast) are excluded.
 * - Additive effect draws switch to screen blending while dimmed so dozens of
 *   stacked particles cannot saturate to white; the game's blend state is
 *   restored immediately after the draw.
 * - Every wrapper forwards the game's call even when bookkeeping fails; a
 *   throwing wrapper once stopped the game from presenting frames.
 *
 * - Density: an effect texture drawn more than DENSITY_THRESHOLD times in the
 *   previous frames is a particle cloud. Only its first copies per frame draw
 *   (a stable prefix, never a modulo), and additive survivors brighten to keep
 *   the cloud's total light. Effects drawn a few times are untouched.
 *
 * Returns a setter for live changes. Brightness and density 1 with both
 * extras off is a pure pass-through.
 */
export function installChromiumRoleGameEffectsRuntime(initial: {
  brightness: number;
  dimBrightSkills: boolean;
  hideHitEffects: boolean;
  density?: number;
}): (brightness: number, dimBrightSkills: boolean, hideHitEffects: boolean, density?: number) => void {
  const ADD = 0x8006, REVERSE_SUBTRACT = 0x800b, SRC_ALPHA = 0x302, ONE = 1, ONE_MINUS_DST_COLOR = 0x307;
  const TRIANGLES = 4;
  const BRIGHT_FACTOR = 0.3;
  const MAX_UPLOADS = 5000;
  // Texture packs per skill (file names do not match skill names).
  const BRIGHT_FILES = ["sfx_sklelefirfirbrd", "sfx_sklelemulmeteos", "sfx_sklpsypsychicbomb", "sfx_sklpsydnolgy"];
  const WARNING_FILES = ["sfx_attackcast"];
  // Spirit Bomb stacks hundreds of particles of one texture in one place.
  const PARTICLE_STACK: Record<string, number> = { sfx_sklpsypsychicbomb: 1 };
  // Copies of a stacked particle texture drawn per frame; the rest are skipped.
  const PARTICLE_STACK_LIMIT = 48;
  // Copies of one effect texture per frame that always draw; only clouds
  // repeating beyond this are thinned by the density setting.
  const DENSITY_THRESHOLD = 8;
  // Largest brightening of a thinned cloud's survivors (1 / lowest density).
  const MAX_GAIN = 4;
  // `length:sampleHash` of hit-effect textures (Firebird 13, Spirit Bomb 6).
  const HIDDEN_TEXTURES = new Set([
    "8192:1704021625", "8192:139922809", "8192:660439607", "8192:898630727", "8192:1311350170",
    "8192:1424226234", "8192:1133458182", "8192:1341196607", "8192:2149481921", "8192:4031175103",
    "8192:3415324948", "8192:1745768880", "8192:2971518904",
    "8192:3330499170", "8192:1791505304", "32768:1750721461", "8192:3914982811", "32768:552330890",
    "512:2389195545"
  ]);
  // Recorded Boss warning textures, kept for packs that bypass fetch.
  const WARNING_TEXTURES = new Set(["8192:2489650850", "8192:1964578292", "8192:214041403", "8192:1728369378"]);
  const MARK = Symbol.for("rion-studio.game-effects.v1");

  const prototypes = [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]
    .filter(Boolean)
    .map(type => type.prototype as unknown as Record<PropertyKey, unknown>);
  // One install per document realm; the marker carries no callable state.
  if (prototypes.length === 0 || prototypes.some(prototype => prototype[MARK] === true)) {
    return () => undefined;
  }

  type Gl = WebGLRenderingContext;
  type Upload = {
    texture: WeakRef<WebGLTexture>; length: number; anchor: number;
    words: number[]; probes: Uint8Array; hash: number;
  };
  // Aligned 32-bit words of a pack in an allocation-free chained hash table.
  type Pack = { name: string; bytes: Uint8Array; head: Int32Array; next: Int32Array; shift: number };

  let brightness = 1;
  let dimBrightSkills = true;
  let hideHitEffects = false;
  let density = 1;
  const clamp = (value: number, low: number) => Number.isFinite(value) ? Math.min(1, Math.max(low, value)) : 1;
  let passThrough = true;
  const apply = (nextBrightness: number, nextDim: boolean, nextHide: boolean, nextDensity?: number) => {
    brightness = clamp(Number(nextBrightness), 0);
    dimBrightSkills = nextDim === true;
    hideHitEffects = nextHide === true;
    density = clamp(Number(nextDensity ?? 1), 0.25);
    passThrough = brightness >= 1 && !dimBrightSkills && !hideHitEffects && density >= 1;
  };
  apply(initial.brightness, initial.dimBrightSkills, initial.hideHitEffects, initial.density);

  // ---- Texture identification (bright list, Boss warnings, hidden hits) ----
  // Identification runs on the game's main thread while a skill or Boss
  // warning first appears, so every step is linear and allocation-free per
  // candidate: a quadratic match once froze the game for the whole lookup.
  const PROBES = 16;
  // Hash-chain entries walked per anchor word; longer chains are repeated
  // flat texture regions that cannot identify anything.
  const CHAIN_LIMIT = 256;
  // Anchor positions tried per upload (flat regions have no usable anchor).
  const ANCHOR_SEARCH = 2048;
  const brightTextures = new WeakMap<WebGLTexture, string>();
  const hiddenTextures = new WeakSet<WebGLTexture>();
  const warningTextures = new WeakSet<WebGLTexture>();
  const packs: Pack[] = [];
  let uploads: Upload[] = [];

  const sampleHash = (bytes: Uint8Array, offset: number, length: number) => {
    let hash = 2166136261;
    for (let i = 0; i < length; i += 7) hash = Math.imul(hash ^ bytes[offset + i]!, 16777619);
    return hash >>> 0;
  };
  const word = (bytes: Uint8Array, at: number) =>
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
  const plain = (value: number) => (value & 0xff) * 0x01010101 === value;
  const probeAt = (length: number, index: number) => Math.floor(index * (length - 1) / (PROBES - 1));
  const indexPack = (name: string, bytes: Uint8Array): Pack => {
    const count = bytes.length >> 2;
    let bits = 4;
    while ((1 << bits) < count * 2 && bits < 24) bits++;
    const head = new Int32Array(1 << bits).fill(-1);
    const next = new Int32Array(Math.max(count, 1));
    const shift = 32 - bits;
    for (let index = 0; index < count; index++) {
      const value = word(bytes, index << 2);
      if (plain(value)) { next[index] = -1; continue; }
      const slot = Math.imul(value, 0x9e3779b1) >>> shift;
      next[index] = head[slot]!;
      head[slot] = index;
    }
    return { name, bytes, head, next, shift };
  };
  // A texture is not necessarily 4-byte aligned inside its pack: four
  // consecutive anchor words guarantee one aligned lookup.
  const inPack = (pack: Pack, upload: Upload) => {
    const { bytes, head, next, shift } = pack;
    for (let i = 0; i < 4; i++) {
      const value = upload.words[i]!;
      let steps = 0;
      for (let index = head[Math.imul(value, 0x9e3779b1) >>> shift]!; index >= 0 && steps < CHAIN_LIMIT;
        index = next[index]!, steps++) {
        if (word(bytes, index << 2) !== value) continue;
        const offset = (index << 2) - upload.anchor - i;
        if (offset < 0 || offset + upload.length > bytes.length) continue;
        let probe = 0;
        while (probe < PROBES && bytes[offset + probeAt(upload.length, probe)] === upload.probes[probe]) probe++;
        if (probe === PROBES && sampleHash(bytes, offset, upload.length) === upload.hash) return true;
      }
    }
    return false;
  };
  /** True once the upload no longer needs matching (identified or collected). */
  const settle = (pack: Pack, upload: Upload) => {
    const texture = upload.texture.deref();
    if (!texture) return true;
    if (!inPack(pack, upload)) return false;
    if (WARNING_FILES.includes(pack.name)) warningTextures.add(texture);
    else brightTextures.set(texture, pack.name);
    return true;
  };
  const fileName = (url: string) =>
    /\/model\/texture\w*\/(?:\w+\/)?(\w+)\.bin(?:[?#]|$)/iu.exec(url)?.[1]?.toLowerCase() ?? null;
  const unpack = async (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    // "%CJS" + version byte + two 4-byte lengths + zlib.
    if (bytes[0] !== 0x25 || bytes[1] !== 0x43 || bytes[2] !== 0x4a || bytes[3] !== 0x53) return bytes;
    const stream = new Blob([bytes.subarray(13)]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  // Usable anchor: four non-flat words over at least four distinct bytes.
  const anchorAt = (view: Uint8Array, at: number) => {
    let distinct = 0;
    for (let a = 0; a < 8; a++) {
      let b = 0;
      while (b < a && view[at + b] !== view[at + a]) b++;
      if (b === a) distinct++;
    }
    if (distinct < 4) return false;
    for (let i = 0; i < 4; i++) if (plain(word(view, at + i))) return false;
    return true;
  };
  const noteUpload = (texture: WebGLTexture | null | undefined, data: ArrayBufferView | null | undefined) => {
    // Effect textures are 2–32 KB; terrain-sized uploads are never effects.
    if (!texture || !data || data.byteLength < 64 || data.byteLength > 256 * 1024) return;
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hash = sampleHash(view, 0, view.length);
    const signature = `${view.length}:${hash}`;
    if (HIDDEN_TEXTURES.has(signature)) hiddenTextures.add(texture);
    if (WARNING_TEXTURES.has(signature)) warningTextures.add(texture);
    let anchor = -1;
    const limit = Math.min(view.length - 8, (view.length >> 1) + ANCHOR_SEARCH);
    for (let at = view.length >> 1; at <= limit && anchor < 0; at++) if (anchorAt(view, at)) anchor = at;
    if (anchor < 0) return;
    const probes = new Uint8Array(PROBES);
    for (let probe = 0; probe < PROBES; probe++) probes[probe] = view[probeAt(view.length, probe)]!;
    const upload: Upload = {
      texture: new WeakRef(texture), length: view.length, anchor,
      words: [word(view, anchor), word(view, anchor + 1), word(view, anchor + 2), word(view, anchor + 3)],
      probes, hash
    };
    for (const pack of packs) if (settle(pack, upload)) return;
    uploads.push(upload);
    // Trim in batches so a long session never copies the backlog per upload.
    if (uploads.length > MAX_UPLOADS * 2) uploads = uploads.slice(-MAX_UPLOADS);
  };
  // The game shares loaded textures by name, so every newly unpacked pack is
  // matched against all earlier unidentified uploads, not only recent ones.
  // Each pack is indexed once per document even when the game fetches it again.
  const requested = new Set<string>();
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const promise = nativeFetch.call(this, input, init);
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        const name = url ? fileName(url) : null;
        if (name && !requested.has(name) && (BRIGHT_FILES.includes(name) || WARNING_FILES.includes(name))) {
          requested.add(name);
          // Clone before the game reads the body: this reaction is attached first.
          void promise
            .then(response => (response.ok ? response.clone().arrayBuffer() : null))
            .then(buffer => (buffer ? unpack(buffer) : null))
            .then(bytes => {
              if (!bytes) {
                requested.delete(name);
                return;
              }
              const pack = indexPack(name, bytes);
              packs.push(pack);
              uploads = uploads.filter(upload => !settle(pack, upload));
            })
            .catch(() => requested.delete(name));
        }
      } catch {
        // Identification is optional; the game's request is never affected.
      }
      return promise;
    } as typeof fetch;
  }

  // ---- GL state mirror and per-draw coefficient ----
  const shaderTypes = new WeakMap<WebGLShader, number>();
  const locations = new WeakMap<WebGLProgram, WebGLUniformLocation | null>();
  // Last coefficient set per program: [alphaOnly, reduce, screen].
  const applied = new WeakMap<WebGLProgram, Float64Array>();
  const effectPrograms = new WeakSet<WebGLProgram>();
  const state = {
    units: [] as (WebGLTexture | null)[], unit: 0, program: null as WebGLProgram | null,
    blendOn: false, src: ONE, dst: 0, srcAlpha: ONE, dstAlpha: 0, equation: ADD,
    depthTest: false, depthMask: true
  };

  const patchFragment = (source: string) => {
    if (typeof source !== "string" || !/\bgl_FragColor\b/u.test(source) ||
        !/\bvoid\s+main\s*\(/u.test(source) || source.includes("fmsFx")) return source;
    return source.replace(/\bvoid\s+main\s*\(/u, "void fms_main(") + `
uniform mediump vec3 fmsFx;
void main() {
  fms_main();
  if (fmsFx.y != 0.0 || fmsFx.z > 0.5) {
    mediump float b = 1.0 - fmsFx.y;
    if (b > 1.0) gl_FragColor.rgb *= b;
    else if (fmsFx.x > 0.5) gl_FragColor.a *= b; else gl_FragColor *= b;
    if (fmsFx.z > 0.5 && fmsFx.x > 0.5) gl_FragColor.rgb *= gl_FragColor.a;
  }
}
`;
  };

  // Copies of one mesh texture per frame: each copy is divided by the count.
  let counts = new Map<WebGLTexture, number>();
  let lastCounts = new Map<WebGLTexture, number>();
  const smoothed = new Map<WebGLTexture, number>();
  let frameEffects = 0;
  const smoothTexture = (texture: WebGLTexture) => {
    const target = Math.max(lastCounts.get(texture) ?? 1, 1);
    const current = smoothed.get(texture) ?? 1;
    // Rise quickly, fall slowly: avoids flicker as counts jitter per frame.
    const next = current + (target - current) * (target > current ? 0.5 : 0.08);
    if (next < 1.02 && target === 1) smoothed.delete(texture);
    else smoothed.set(texture, next);
  };
  const smoothCounts = () => {
    // Walk both maps without allocating a merged key set every frame.
    for (const texture of smoothed.keys()) smoothTexture(texture);
    for (const texture of lastCounts.keys()) if (!smoothed.has(texture)) smoothTexture(texture);
  };
  const nextFrame = () => {
    try {
      // The game often renders below display refresh: a refresh without any
      // effect draw is not a game frame.
      if (frameEffects) {
        lastCounts = counts;
        counts = new Map();
        smoothCounts();
        frameEffects = 0;
      }
    } catch {
      // Frame accounting is presentation-only.
    }
    // event-topology: presentation (frame boundary for per-frame copy counts)
    requestAnimationFrame(nextFrame);
  };

  // Per-draw output of `effectValue`; plain numbers avoid per-draw allocation.
  let fxAlphaOnly = 0, fxReduce = 0, fxScreen = 0;
  // IDENTITY: no coefficient. APPLY: use the fx* values. SKIP: invisible draw.
  const IDENTITY = 0, APPLY = 1, SKIP = 2;
  const effectValue = (drawMode: number): number => {
    const program = state.program;
    const darken = state.equation === REVERSE_SUBTRACT;
    if (!program || !state.blendOn || (state.equation !== ADD && !darken)) return IDENTITY;
    const additive = state.dst === ONE;
    if (additive && state.depthTest && !darken) effectPrograms.add(program);
    if (!effectPrograms.has(program) || !(additive || !state.depthMask)) return IDENTITY;
    // One pass over the bound units: hit, bright, warning and the main texture.
    let hidden = false, brightTexture = false, warning = false;
    let texture: WebGLTexture | null = null;
    for (let index = 0; index < state.units.length; index++) {
      const unit = state.units[index];
      if (!unit) continue;
      if (!texture) texture = unit;
      if (warningTextures.has(unit)) warning = true;
      if (hideHitEffects && hiddenTextures.has(unit)) hidden = true;
      if (dimBrightSkills && brightTextures.has(unit)) brightTexture = true;
    }
    // Boss ground warnings always draw exactly as the game intends.
    if (warning) return IDENTITY;
    const bright = dimBrightSkills && (darken || brightTexture);
    const dimming = brightness < 1 || bright;
    const thin = density < 1 && texture !== null;
    if (!dimming && !hidden && !thin) return IDENTITY;
    if (hidden) return SKIP;
    let level = brightness;
    frameEffects++;
    if (bright) level *= BRIGHT_FACTOR;
    const stackPower = drawMode === TRIANGLES || !dimBrightSkills
      ? undefined
      : PARTICLE_STACK[(texture && brightTextures.get(texture)) ?? ""];
    // Copy division belongs to dimming; undimmed effects keep their light.
    const power = !dimming ? undefined : drawMode === TRIANGLES ? 1 : stackPower;
    if (texture && (power || thin)) {
      const sofar = (counts.get(texture) ?? 0) + 1;
      counts.set(texture, sofar);
      // Stacked particles: only the first copies draw, and together they keep
      // the total brightness the whole stack had.
      if (stackPower && sofar > PARTICLE_STACK_LIMIT) return SKIP;
      // A newly appearing effect has no previous count yet and draws in full.
      const previous = smoothed.get(texture) ?? 1;
      let kept = Infinity;
      if (thin && previous > DENSITY_THRESHOLD) {
        kept = Math.max(DENSITY_THRESHOLD, Math.ceil(previous * density));
        if (sofar > kept) return SKIP;
      }
      let copies = Math.max(previous, sofar);
      if (stackPower) copies = Math.min(copies, PARTICLE_STACK_LIMIT);
      const drawn = Math.min(copies, kept);
      if (power) {
        if (drawn > 1) level *= drawn ** -power;
      } else if (additive && drawn < copies) {
        // Survivors carry the skipped copies' light.
        level *= Math.min(copies / drawn, MAX_GAIN);
      }
    }
    // 1/4096 precision: stacked particles are dimmed to ~1/1000 each.
    fxReduce = Math.round((1 - level) * 4096) / 4096;
    // A fully cancelled draw contributes no colour; skipping it also keeps an
    // invisible effect from writing depth over the scene behind it.
    if (fxReduce >= 1) return SKIP;
    fxAlphaOnly = state.src === SRC_ALPHA ? 1 : 0;
    // Darkening effects only fade their alpha; they never switch to screen,
    // and undimmed effects keep the game's own additive blending.
    fxScreen = additive && !darken && dimming ? 1 : 0;
    return APPLY;
  };

  for (const prototype of prototypes) {
    // GL entry points are forwarded verbatim with the game's own arguments.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type GlFunction = (this: Gl, ...args: any[]) => unknown;
    const nativeBlend = prototype.blendFuncSeparate as GlFunction;
    const wrap = (name: string, replace: (original: GlFunction) => GlFunction) => {
      const original = prototype[name];
      if (typeof original === "function") prototype[name] = replace(original as GlFunction);
    };
    const quietly = (task: () => void) => {
      try { task(); } catch { /* bookkeeping never blocks the game's GL call */ }
    };
    wrap("createShader", original => function (this: Gl, type: number) {
      const shader = original.call(this, type);
      quietly(() => { if (shader) shaderTypes.set(shader, type); });
      return shader;
    });
    wrap("shaderSource", original => function (this: Gl, shader: WebGLShader, source: string) {
      let next = source;
      quietly(() => { if (shaderTypes.get(shader) === this.FRAGMENT_SHADER) next = patchFragment(source); });
      return original.call(this, shader, next);
    });
    wrap("linkProgram", original => function (this: Gl, program: WebGLProgram) {
      const result = original.call(this, program);
      quietly(() => locations.set(program, this.getUniformLocation(program, "fmsFx")));
      return result;
    });
    wrap("useProgram", original => function (this: Gl, program: WebGLProgram | null) {
      state.program = program;
      return original.call(this, program);
    });
    wrap("enable", original => function (this: Gl, cap: number) {
      if (cap === this.BLEND) state.blendOn = true;
      else if (cap === this.DEPTH_TEST) state.depthTest = true;
      return original.call(this, cap);
    });
    wrap("disable", original => function (this: Gl, cap: number) {
      if (cap === this.BLEND) state.blendOn = false;
      else if (cap === this.DEPTH_TEST) state.depthTest = false;
      return original.call(this, cap);
    });
    wrap("blendFunc", original => function (this: Gl, src: number, dst: number) {
      state.src = state.srcAlpha = src;
      state.dst = state.dstAlpha = dst;
      return original.call(this, src, dst);
    });
    wrap("blendFuncSeparate", original => function (
      this: Gl, src: number, dst: number, srcAlpha: number, dstAlpha: number
    ) {
      state.src = src; state.dst = dst; state.srcAlpha = srcAlpha; state.dstAlpha = dstAlpha;
      return original.call(this, src, dst, srcAlpha, dstAlpha);
    });
    wrap("blendEquation", original => function (this: Gl, mode: number) {
      state.equation = mode;
      return original.call(this, mode);
    });
    wrap("blendEquationSeparate", original => function (this: Gl, mode: number, modeAlpha: number) {
      state.equation = mode;
      return original.call(this, mode, modeAlpha);
    });
    wrap("activeTexture", original => function (this: Gl, texture: number) {
      state.unit = texture - this.TEXTURE0;
      return original.call(this, texture);
    });
    wrap("bindTexture", original => function (this: Gl, target: number, texture: WebGLTexture | null) {
      if (target === this.TEXTURE_2D) state.units[state.unit] = texture;
      return original.call(this, target, texture);
    });
    wrap("compressedTexImage2D", original => function (this: Gl, ...args: unknown[]) {
      quietly(() => { if (args[1] === 0) noteUpload(state.units[state.unit], args[6] as ArrayBufferView); });
      return original.apply(this, args);
    });
    wrap("texImage2D", original => function (this: Gl, ...args: unknown[]) {
      quietly(() => {
        if (args[1] === 0 && args.length >= 9 && ArrayBuffer.isView(args[8])) {
          noteUpload(state.units[state.unit], args[8] as ArrayBufferView);
        }
      });
      return original.apply(this, args);
    });
    wrap("depthMask", original => function (this: Gl, flag: boolean) {
      state.depthMask = !!flag;
      return original.call(this, flag);
    });
    // FORWARD: the game's draw as is. SCREEN: the draw with screen blending.
    const FORWARD = 0, SCREEN = 1;
    const prepare = (gl: Gl, mode: number): number => {
      try {
        const program = state.program;
        const location = program && locations.get(program);
        if (!program || !location) return FORWARD;
        const last = applied.get(program);
        // Pass-through settings skip classification; they only clear a
        // coefficient a program kept from before dimming was turned off.
        if (passThrough) {
          if (last && (last[0] || last[1] || last[2])) {
            gl.uniform3f(location, 0, 0, 0);
            last.fill(0);
          }
          return FORWARD;
        }
        const outcome = effectValue(mode);
        if (outcome === SKIP) return SKIP;
        const alphaOnly = outcome === APPLY ? fxAlphaOnly : 0;
        const reduce = outcome === APPLY ? fxReduce : 0;
        const screen = outcome === APPLY ? fxScreen : 0;
        if (!last || last[0] !== alphaOnly || last[1] !== reduce || last[2] !== screen) {
          gl.uniform3f(location, alphaOnly, reduce, screen);
          if (last) { last[0] = alphaOnly; last[1] = reduce; last[2] = screen; }
          else applied.set(program, Float64Array.of(alphaOnly, reduce, screen));
        }
        return screen === 1 ? SCREEN : FORWARD;
      } catch {
        // Bookkeeping never blocks the game's GL call.
        return FORWARD;
      }
    };
    // Colour only: the alpha channel keeps the destination value.
    const screenBlend = (gl: Gl) => nativeBlend.call(gl, ONE_MINUS_DST_COLOR, ONE, 0, ONE);
    const restoreBlend = (gl: Gl) => nativeBlend.call(gl, state.src, state.dst, state.srcAlpha, state.dstAlpha);
    // Fixed parameters: draws run thousands of times per frame, so the
    // wrappers allocate no argument arrays.
    wrap("drawArrays", original => function (this: Gl, mode: number, first: number, count: number) {
      const outcome = prepare(this, mode);
      if (outcome === SKIP) return undefined;
      if (outcome === FORWARD) return original.call(this, mode, first, count);
      screenBlend(this);
      try {
        return original.call(this, mode, first, count);
      } finally {
        restoreBlend(this);
      }
    });
    wrap("drawElements", original => function (this: Gl, mode: number, count: number, type: number, offset: number) {
      const outcome = prepare(this, mode);
      if (outcome === SKIP) return undefined;
      if (outcome === FORWARD) return original.call(this, mode, count, type, offset);
      screenBlend(this);
      try {
        return original.call(this, mode, count, type, offset);
      } finally {
        restoreBlend(this);
      }
    });
  }

  // event-topology: presentation (frame boundary for per-frame copy counts)
  requestAnimationFrame(nextFrame);
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, MARK, { configurable: false, enumerable: false, writable: false, value: true });
  }
  return apply;
}
