(() => {
  "use strict";

  const RUNTIME_KEY = "__rionStudioBrowserFonts";
  const INJECTED_PAYLOAD_KEY = "__rionStudioBrowserFontsInjectedPayloadV1";
  const STYLE_ID = "rion-studio-browser-fonts";
  const CANVAS_HOOK_KEY = "__rionStudioBrowserFontsCanvasHook";
  const VERSION = 8;
  const CANVAS_FONT_CACHE_CAPACITY = 256;
  const SLOT_RANGES = Object.freeze({
    cjk: [
      [0x2e80, 0x2fff],
      [0x3000, 0x303f],
      [0x3040, 0x30ff],
      [0x31f0, 0x31ff],
      [0x3400, 0x4dbf],
      [0x4e00, 0x9fff],
      [0xf900, 0xfaff],
      [0xff00, 0xffef],
      [0x20000, 0x3ffff]
    ],
    latin: [
      [0x0000, 0x002f],
      [0x003a, 0x024f],
      [0x1e00, 0x1eff],
      [0x2000, 0x206f],
      [0x20a0, 0x20cf]
    ],
    numeric: [[0x0030, 0x0039]]
  });
  const GENERIC_FAMILIES = new Set([
    "cursive",
    "emoji",
    "fangsong",
    "fantasy",
    "math",
    "monospace",
    "sans-serif",
    "serif",
    "system-ui",
    "ui-monospace",
    "ui-rounded",
    "ui-sans-serif",
    "ui-serif"
  ]);

  const CANVAS_TEXT_QUALITY = Object.freeze([
    Object.freeze({
      desired: "optimizeLegibility",
      name: "textRendering",
      values: new Set(["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"])
    }),
    Object.freeze({
      desired: "normal",
      name: "fontKerning",
      values: new Set(["auto", "normal", "none"])
    })
  ]);

  const injectedDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    INJECTED_PAYLOAD_KEY
  );
  const hasInjectedPayload = Boolean(
    injectedDescriptor &&
    Object.prototype.hasOwnProperty.call(injectedDescriptor, "value") &&
    injectedDescriptor.configurable
  );
  const injectedPayload = hasInjectedPayload ? injectedDescriptor.value : undefined;
  if (hasInjectedPayload) delete globalThis[INJECTED_PAYLOAD_KEY];

  const previous = globalThis[RUNTIME_KEY];
  if (previous?.version === VERSION && typeof previous.refresh === "function") {
    return hasInjectedPayload
      ? previous.refresh(injectedPayload)
      : previous.refresh();
  }

  const state = {
    canvasFontsActive: false,
    canvasFontCache: new Map(),
    canvasRevision: 0,
    canvasStacks: { general: [], math: [], monospace: [] },
    canvasTextQualityActive: false,
    failedFaceCount: 0,
    faces: [],
    loadedCatalogIds: new Set(),
    refreshSequence: 0,
    sourceMode: hasInjectedPayload ? "injected" : "tauri",
    version: VERSION
  };
  const canvasContexts = new WeakMap();
  const canvasQualityRecords = new WeakMap();
  const canvasFontParser = (() => {
    try {
      return document.createElement("span").style;
    } catch {
      return undefined;
    }
  })();

  function quoteFamily(value) {
    const family = String(value || "").trim();
    if (GENERIC_FAMILIES.has(family.toLowerCase())) return family;
    return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }

  function splitFontFamilies(value) {
    const families = [];
    let current = "";
    let escaped = false;
    let quote = "";
    for (const character of String(value || "")) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        current += character;
        escaped = true;
        continue;
      }
      if (quote) {
        current += character;
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        current += character;
        quote = character;
        continue;
      }
      if (character === ",") {
        if (current.trim()) families.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim()) families.push(current.trim());
    return families;
  }

  function fontFamilyKey(value) {
    let family = String(value || "").trim();
    if (
      family.length >= 2 &&
      ((family.startsWith('"') && family.endsWith('"')) ||
        (family.startsWith("'") && family.endsWith("'")))
    ) {
      family = family.slice(1, -1);
    }
    return family.replace(/\\([\\"'])/g, "$1").toLowerCase();
  }

  function canvasStackForFamily(fontFamily) {
    const families = splitFontFamilies(fontFamily).map(fontFamilyKey);
    const stack = families.includes("math")
      ? state.canvasStacks.math
      : families.includes("monospace") || families.includes("ui-monospace")
        ? state.canvasStacks.monospace
        : state.canvasStacks.general;
    // Chromium Canvas accepts ui-monospace syntax but can resolve it as a
    // proportional fallback. Keep DOM's UI family; supply the interoperable
    // monospace generic for Canvas text drawing and measurement.
    return stack.flatMap((family) =>
      fontFamilyKey(family) === "ui-monospace" ? [family, "monospace"] : [family]
    );
  }

  function prependCanvasFamilies(fontFamily, customFamilies) {
    const existing = new Set(splitFontFamilies(fontFamily).map(fontFamilyKey));
    const prepended = [];
    for (const family of customFamilies) {
      const key = fontFamilyKey(family);
      if (!key || existing.has(key)) continue;
      existing.add(key);
      prepended.push(family);
    }
    return prepended.length > 0 ? `${prepended.join(",")},${fontFamily}` : fontFamily;
  }

  function rewriteCanvasFont(value) {
    const font = String(value || "");
    if (!state.canvasFontsActive || !canvasFontParser) return font;
    if (state.canvasFontCache.has(font)) return state.canvasFontCache.get(font);
    let rewritten = font;
    try {
      canvasFontParser.cssText = "";
      canvasFontParser.font = font;
      const parsedFont = canvasFontParser.font;
      const fontFamily = canvasFontParser.fontFamily;
      if (parsedFont && fontFamily) {
        const customFamilies = canvasStackForFamily(fontFamily);
        if (customFamilies.length > 0) {
          canvasFontParser.fontFamily = prependCanvasFamilies(fontFamily, customFamilies);
          rewritten = canvasFontParser.font || font;
        }
      }
    } catch {
      rewritten = font;
    }
    if (state.canvasFontCache.size >= CANVAS_FONT_CACHE_CAPACITY) {
      state.canvasFontCache.clear();
    }
    state.canvasFontCache.set(font, rewritten);
    return rewritten;
  }

  function canvasFontTracked(context) {
    return state.canvasFontsActive || canvasContexts.has(context);
  }

  function synchronizeCanvasContext(
    context,
    fontDescriptor,
    nativeFont = fontDescriptor.get.call(context)
  ) {
    let record = canvasContexts.get(context);
    if (!record) {
      record = {
        effectiveFont: nativeFont,
        originalFont: nativeFont,
        requestedFont: nativeFont,
        revision: -1,
        savedFonts: []
      };
      canvasContexts.set(context, record);
      return record;
    }
    if (nativeFont !== record.effectiveFont) {
      record.effectiveFont = nativeFont;
      record.originalFont = nativeFont;
      record.requestedFont = nativeFont;
      record.revision = -1;
      record.savedFonts = [];
    }
    return record;
  }

  function applyCanvasFont(
    context,
    fontDescriptor,
    record,
    nativeFont = fontDescriptor.get.call(context)
  ) {
    if (record.revision === state.canvasRevision && nativeFont === record.effectiveFont) {
      return record;
    }
    const desiredFont = rewriteCanvasFont(record.originalFont);
    if (nativeFont === desiredFont) {
      record.effectiveFont = nativeFont;
    } else {
      fontDescriptor.set.call(context, desiredFont);
      record.effectiveFont = fontDescriptor.get.call(context);
    }
    record.revision = state.canvasRevision;
    return record;
  }

  // Default font mode never rewrites Canvas text. Once a context holds neither
  // a rewritten font nor a saved font frame, forget it so every later font,
  // draw, save, and restore call takes the native path without serializing
  // the Canvas font.
  function releaseInactiveCanvasContext(context, record) {
    if (
      !state.canvasFontsActive &&
      record.savedFonts.length === 0 &&
      record.effectiveFont === record.originalFont
    ) {
      canvasContexts.delete(context);
    }
  }

  function prepareCanvasContext(context, fontDescriptor) {
    try {
      const nativeFont = fontDescriptor.get.call(context);
      const record = applyCanvasFont(
        context,
        fontDescriptor,
        synchronizeCanvasContext(context, fontDescriptor, nativeFont),
        nativeFont
      );
      releaseInactiveCanvasContext(context, record);
      return record;
    } catch {
      return undefined;
    }
  }

  function canvasTextQualityHooks(prototype) {
    const hooks = [];
    for (const quality of CANVAS_TEXT_QUALITY) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, quality.name);
      if (
        typeof descriptor?.get === "function" &&
        typeof descriptor?.set === "function" &&
        descriptor.configurable !== false
      ) {
        hooks.push({ descriptor, quality, supported: true });
      }
    }
    return hooks;
  }

  // Text quality stays applied in native Canvas state instead of being set and
  // restored around every draw: each native textRendering/fontKerning change
  // rebuilds the context font and discards its shaping cache, which made
  // text-heavy scenes reshape every glyph run on every frame. The page keeps
  // observing its own values through virtual accessors. A native value other
  // than the applied one means Canvas reset its state (resize or reset()), so
  // native state is the page's value again.
  function synchronizeCanvasQuality(context, hooks) {
    const record = canvasQualityRecords.get(context);
    if (!record?.applied) return record;
    for (const hook of hooks) {
      if (!hook.supported || hook.descriptor.get.call(context) === hook.quality.desired) {
        continue;
      }
      for (const current of hooks) {
        if (current.supported) {
          record.values[current.quality.name] = current.descriptor.get.call(context);
        }
      }
      record.applied = false;
      record.savedQuality = [];
      break;
    }
    return record;
  }

  function prepareCanvasQuality(context, hooks) {
    try {
      let record = synchronizeCanvasQuality(context, hooks);
      if (!state.canvasTextQualityActive) {
        if (!record) return;
        if (record.applied) {
          for (const hook of hooks) {
            if (hook.supported) {
              hook.descriptor.set.call(context, record.values[hook.quality.name]);
            }
          }
          record.applied = false;
        }
        if (record.savedQuality.length === 0) canvasQualityRecords.delete(context);
        return;
      }
      if (record?.applied) return;
      if (!record) {
        record = { applied: false, savedQuality: [], values: {} };
        canvasQualityRecords.set(context, record);
      }
      for (const hook of hooks) {
        if (!hook.supported) continue;
        const pageValue = hook.descriptor.get.call(context);
        record.values[hook.quality.name] = pageValue;
        if (pageValue === hook.quality.desired) continue;
        hook.descriptor.set.call(context, hook.quality.desired);
        if (hook.descriptor.get.call(context) !== hook.quality.desired) {
          hook.supported = false;
          hook.descriptor.set.call(context, pageValue);
        }
      }
      record.applied = true;
    } catch {
      // Optional typography must not block native text drawing.
    }
  }

  function canvasQualityFrame(context, hooks) {
    if (hooks.length === 0 || !canvasQualityRecords.has(context)) return undefined;
    try {
      const record = synchronizeCanvasQuality(context, hooks);
      return { record, values: record.applied ? { ...record.values } : null };
    } catch {
      return undefined;
    }
  }

  function restoreCanvasQuality(context, hooks, frame) {
    if (!frame) return;
    try {
      const { record } = frame;
      if (record.savedQuality.length > 0) {
        const values = record.savedQuality.pop();
        if (values) {
          record.values = values;
          record.applied = true;
        } else {
          record.applied = false;
        }
      }
      synchronizeCanvasQuality(context, hooks);
    } catch {
      // Native restore already completed; optional typography stays native.
    }
  }

  function installCanvasContextHook(Context) {
    const prototype = Context?.prototype;
    if (!prototype || Object.prototype.hasOwnProperty.call(prototype, CANVAS_HOOK_KEY)) return;
    const fontDescriptor = Object.getOwnPropertyDescriptor(prototype, "font");
    const methodNames = ["fillText", "strokeText", "measureText", "save", "restore"];
    const methodDescriptors = new Map(
      methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)])
    );
    if (
      typeof fontDescriptor?.get !== "function" ||
      typeof fontDescriptor?.set !== "function" ||
      fontDescriptor.configurable === false ||
      methodNames.some((name) => {
        const descriptor = methodDescriptors.get(name);
        return (
          typeof descriptor?.value !== "function" ||
          (descriptor.configurable === false && descriptor.writable === false)
        );
      })
    ) {
      return;
    }

    const qualityHooks = canvasTextQualityHooks(prototype);
    const originals = new Map([
      ["font", fontDescriptor],
      ...methodDescriptors,
      ...qualityHooks.map((hook) => [hook.quality.name, hook.descriptor])
    ]);
    const prepareCanvasQualityIfTracked = (context) => {
      if (
        qualityHooks.length > 0 &&
        (state.canvasTextQualityActive || canvasQualityRecords.has(context))
      ) {
        prepareCanvasQuality(context, qualityHooks);
      }
    };
    const applied = [];
    try {
      Object.defineProperty(prototype, "font", {
        ...fontDescriptor,
        get() {
          if (!canvasFontTracked(this)) return fontDescriptor.get.call(this);
          try {
            return synchronizeCanvasContext(this, fontDescriptor).originalFont;
          } catch {
            return fontDescriptor.get.call(this);
          }
        },
        set(value) {
          if (!canvasFontTracked(this)) {
            fontDescriptor.set.call(this, value);
            return;
          }
          let record;
          try {
            record = synchronizeCanvasContext(this, fontDescriptor);
            // synchronizeCanvasContext proves native state equals the
            // effective font whenever the record keeps its revision.
            if (
              record.revision === state.canvasRevision &&
              record.requestedFont === String(value)
            ) {
              return;
            }
            // Reapply the page font first so an invalid value keeps the page
            // font rather than a rewritten one; skip it when nothing is rewritten.
            if (record.effectiveFont !== record.originalFont) {
              fontDescriptor.set.call(this, record.originalFont);
            }
          } catch {
            fontDescriptor.set.call(this, value);
            return;
          }
          fontDescriptor.set.call(this, value);
          record.originalFont = fontDescriptor.get.call(this);
          record.requestedFont = String(value);
          record.effectiveFont = record.originalFont;
          record.revision = -1;
          applyCanvasFont(this, fontDescriptor, record, record.originalFont);
          releaseInactiveCanvasContext(this, record);
        }
      });
      applied.push("font");

      for (const hook of qualityHooks) {
        const name = hook.quality.name;
        Object.defineProperty(prototype, name, {
          ...hook.descriptor,
          get() {
            try {
              const record = synchronizeCanvasQuality(this, qualityHooks);
              if (record?.applied && hook.supported) return record.values[name];
            } catch {
              // Report the native value or native error below.
            }
            return hook.descriptor.get.call(this);
          },
          set(value) {
            try {
              const record = synchronizeCanvasQuality(this, qualityHooks);
              if (record?.applied && hook.supported) {
                // Canvas enum attributes ignore unknown values.
                const next = String(value);
                if (hook.quality.values.has(next)) record.values[name] = next;
                return;
              }
            } catch {
              // Let the native setter apply or report the value below.
            }
            hook.descriptor.set.call(this, value);
          }
        });
        applied.push(name);
      }

      for (const name of ["fillText", "strokeText", "measureText"]) {
        const descriptor = methodDescriptors.get(name);
        const nativeMethod = descriptor.value;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value(...args) {
            if (canvasFontTracked(this)) prepareCanvasContext(this, fontDescriptor);
            prepareCanvasQualityIfTracked(this);
            return nativeMethod.apply(this, args);
          }
        });
        applied.push(name);
      }

      const saveDescriptor = methodDescriptors.get("save");
      const nativeSave = saveDescriptor.value;
      Object.defineProperty(prototype, "save", {
        ...saveDescriptor,
        value(...args) {
          const record = canvasFontTracked(this)
            ? prepareCanvasContext(this, fontDescriptor)
            : undefined;
          // Apply before the native frame is saved, so the matching restore
          // keeps native state applied for save/draw/restore render loops.
          prepareCanvasQualityIfTracked(this);
          const qualityFrame = canvasQualityFrame(this, qualityHooks);
          const result = nativeSave.apply(this, args);
          if (record && canvasContexts.get(this) === record) {
            record.savedFonts.push(record.originalFont);
          }
          qualityFrame?.record.savedQuality.push(qualityFrame.values);
          return result;
        }
      });
      applied.push("save");

      const restoreDescriptor = methodDescriptors.get("restore");
      const nativeRestore = restoreDescriptor.value;
      Object.defineProperty(prototype, "restore", {
        ...restoreDescriptor,
        value(...args) {
          const fontTracked = canvasFontTracked(this);
          const qualityFrame = canvasQualityFrame(this, qualityHooks);
          if (!fontTracked && !qualityFrame) return nativeRestore.apply(this, args);
          let record;
          if (fontTracked) {
            try {
              record = synchronizeCanvasContext(this, fontDescriptor);
            } catch {
              // Let the native method report invalid receivers or state.
            }
          }
          const result = nativeRestore.apply(this, args);
          if (record?.savedFonts.length) {
            try {
              record.originalFont = record.savedFonts.pop();
              record.requestedFont = record.originalFont;
              record.effectiveFont = fontDescriptor.get.call(this);
              record.revision = -1;
              applyCanvasFont(this, fontDescriptor, record, record.effectiveFont);
              releaseInactiveCanvasContext(this, record);
            } catch {
              // Native restore already completed; the next draw resynchronizes.
            }
          } else if (fontTracked) {
            prepareCanvasContext(this, fontDescriptor);
          }
          restoreCanvasQuality(this, qualityHooks, qualityFrame);
          return result;
        }
      });
      applied.push("restore");

      Object.defineProperty(prototype, CANVAS_HOOK_KEY, {
        configurable: true,
        value: VERSION
      });
    } catch {
      for (const name of applied.reverse()) {
        try {
          Object.defineProperty(prototype, name, originals.get(name));
        } catch {
          // A partially unhookable engine must keep the remaining native behavior intact.
        }
      }
    }
  }

  function installCanvasHooks() {
    installCanvasContextHook(globalThis.CanvasRenderingContext2D);
    installCanvasContextHook(globalThis.OffscreenCanvasRenderingContext2D);
  }

  function parseUnicodeRange(value) {
    const ranges = [];
    for (const item of String(value || "").split(",")) {
      const token = item.trim().toUpperCase();
      const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/.exec(token);
      if (!match) continue;
      const start = Number.parseInt(match[1].replaceAll("?", "0"), 16);
      const end = match[2]
        ? Number.parseInt(match[2], 16)
        : Number.parseInt(match[1].replaceAll("?", "F"), 16);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) ranges.push([start, end]);
    }
    return ranges;
  }

  function intersectUnicodeRanges(source, target) {
    const sourceRanges = parseUnicodeRange(source);
    const effectiveSource = sourceRanges.length > 0 ? sourceRanges : [[0, 0x10ffff]];
    const intersections = [];
    for (const [sourceStart, sourceEnd] of effectiveSource) {
      for (const [targetStart, targetEnd] of target) {
        const start = Math.max(sourceStart, targetStart);
        const end = Math.min(sourceEnd, targetEnd);
        if (start <= end) intersections.push([start, end]);
      }
    }
    return intersections
      .map(([start, end]) => `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`)
      .join(",");
  }

  function slotUnicodeRange(slot, sourceRange) {
    const target = SLOT_RANGES[slot];
    if (!target) return String(sourceRange || "U+0-10FFFF");
    return intersectUnicodeRanges(sourceRange, target);
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function removeAppliedFonts() {
    state.canvasFontsActive = false;
    state.canvasRevision += 1;
    state.canvasFontCache.clear();
    state.canvasStacks = { general: [], math: [], monospace: [] };
    state.canvasTextQualityActive = false;
    state.failedFaceCount = 0;
    state.loadedCatalogIds.clear();
    document.getElementById(STYLE_ID)?.remove();
    for (const face of state.faces) {
      try {
        document.fonts?.delete(face);
      } catch {
        // Some engine versions may reject deleting an already-detached face.
      }
    }
    state.faces = [];
    document.documentElement?.removeAttribute("data-rion-studio-fonts");
  }

  async function registerSelection(slot, selection, facesByCatalog, sequence) {
    if (!selection || typeof selection !== "object") return undefined;
    if (selection.source === "system") {
      const family = String(selection.family || "").trim();
      if (!family) return undefined;
      if (GENERIC_FAMILIES.has(family.toLowerCase())) return quoteFamily(family);
      const alias = `Rion Studio ${slot} system`;
      const unicodeRange = slotUnicodeRange(slot, "");
      try {
        const face = new FontFace(alias, `local(${quoteFamily(family)})`, { unicodeRange });
        await face.load();
        if (sequence !== state.refreshSequence) return undefined;
        document.fonts.add(face);
        state.faces.push(face);
        return quoteFamily(alias);
      } catch {
        return quoteFamily(family);
      }
    }
    if (selection.source !== "google") return undefined;

    const catalogId = String(selection.catalogId || "");
    const assets = facesByCatalog.get(catalogId) || [];
    if (assets.length === 0) return undefined;
    const alias = `Rion Studio ${slot} ${catalogId}`;
    const pendingFaces = [];
    for (const asset of assets) {
      const unicodeRange = slotUnicodeRange(slot, asset.unicodeRange);
      if (!unicodeRange) continue;
      try {
        const bytes = decodeBase64(asset.dataBase64);
        const face = new FontFace(alias, bytes.buffer, {
          style: String(asset.style || "normal"),
          unicodeRange,
          weight: String(asset.weight || "400")
        });
        pendingFaces.push(face.load().then(() => face).catch(() => {
          if (sequence === state.refreshSequence) state.failedFaceCount += 1;
          return undefined;
        }));
      } catch {
        if (sequence === state.refreshSequence) state.failedFaceCount += 1;
      }
    }
    const loadedFaces = await Promise.all(pendingFaces);
    if (sequence !== state.refreshSequence) return undefined;
    let loaded = 0;
    for (const face of loadedFaces) {
      if (!face) continue;
      try {
        document.fonts.add(face);
        state.faces.push(face);
        loaded += 1;
      } catch {
        state.failedFaceCount += 1;
      }
    }
    if (loaded > 0) state.loadedCatalogIds.add(catalogId);
    return loaded > 0 ? quoteFamily(alias) : undefined;
  }

  function applicationEvidence(sequence, settings) {
    return Object.freeze({
      canvasFontsActive: state.canvasFontsActive,
      canvasTextQualityActive: state.canvasTextQualityActive,
      failedFaceCount: state.failedFaceCount,
      fontMode: settings?.mode === "custom" ? "custom" : "default",
      fontSmoothingEnabled: settings?.fontSmoothingEnabled !== false,
      loadedCatalogIds: Object.freeze([...state.loadedCatalogIds].sort()),
      loadedFaceCount: state.faces.length,
      runtimeVersion: VERSION,
      sequence,
      status: "applied",
      styleInstalled: Boolean(document.getElementById(STYLE_ID))
    });
  }

  async function installPayload(payload, sequence) {
    if (sequence !== state.refreshSequence) return undefined;
    removeAppliedFonts();
    const settings = payload?.settings;
    if (!settings) throw new Error("The browser-font payload has no settings.");
    const fontsActive = settings.mode === "custom";
    const textQualityActive = settings.fontSmoothingEnabled !== false;
    if (!fontsActive && !textQualityActive) {
      return applicationEvidence(sequence, settings);
    }

    const facesByCatalog = new Map();
    if (fontsActive) {
      for (const face of Array.isArray(payload.faces) ? payload.faces : []) {
        const id = String(face?.catalogId || "");
        if (!id) continue;
        const faces = facesByCatalog.get(id) || [];
        faces.push(face);
        facesByCatalog.set(id, faces);
      }
    }
    const slots = settings.slots && typeof settings.slots === "object" ? settings.slots : {};
    const resolved = {};
    if (fontsActive) {
      for (const slot of ["numeric", "latin", "cjk", "monospace", "math"]) {
        resolved[slot] = await registerSelection(slot, slots[slot], facesByCatalog, sequence);
        if (sequence !== state.refreshSequence) return undefined;
      }
    }

    // Fallbacks are presentation data derived by the preload from Core's exact
    // selection. Keep them after all explicit slots so CJK cannot steal Latin
    // or numeric glyphs, but before the page/app's unrelated sans-serif default.
    const serifFallback = (slot) => resolved[slot] && payload.fallbacks?.[slot] === "serif"
      ? "serif" : undefined;
    const bodyFallback = serifFallback(slots.cjk ? "cjk" : "latin");
    const monoFallback = serifFallback("monospace");
    // A generic has no unicode-range restriction. In particular, the default
    // numeric system-ui must not consume CJK/Latin before their selected faces.
    const generalFamilies = [resolved.numeric, resolved.latin, resolved.cjk].filter(Boolean);
    const namedFamilies = generalFamilies.filter((family) => !GENERIC_FAMILIES.has(family));
    const genericFamilies = generalFamilies.filter((family) => GENERIC_FAMILIES.has(family));
    const generalStack = [...new Set([...namedFamilies, bodyFallback, ...genericFamilies].filter(Boolean))];
    const bodyStack = [...generalStack, "system-ui", "sans-serif"]
      .filter(Boolean)
      .join(",");
    const monospaceStack = [resolved.monospace, monoFallback, "ui-monospace", "monospace"].filter(Boolean).join(",");
    const mathStack = [resolved.math, "math", resolved.latin, resolved.cjk, "serif"].filter(Boolean).join(",");
    state.canvasFontsActive = fontsActive;
    state.canvasRevision += 1;
    state.canvasStacks = {
      general: generalStack,
      math: [...new Set([resolved.math, resolved.latin, resolved.cjk].filter(Boolean))],
      monospace: [...new Set([resolved.monospace, monoFallback].filter(Boolean))]
    };
    state.canvasTextQualityActive = textQualityActive;
    const generalSelector = [
      ":where(html,body,button,input,select,textarea)",
      ":where(body *):not(svg):not(svg *):not([class*='icon' i]):not([class^='fa-' i]):not(.fa):not(.fas):not(.far):not(.fab)"
    ].join(",");
    const generalDeclarations = [];
    if (fontsActive) generalDeclarations.push(`font-family:${bodyStack}!important`);
    if (textQualityActive) {
      generalDeclarations.push(
        "-webkit-font-smoothing:antialiased!important",
        "text-rendering:optimizeLegibility!important",
        "font-kerning:normal!important",
        "font-optical-sizing:auto!important"
      );
    }
    const css = [`${generalSelector}{${generalDeclarations.join(";")};}`];
    if (fontsActive) {
      css.push(
        `:where(code,kbd,pre,samp){font-family:${monospaceStack}!important;}`,
        `:where(math,math *){font-family:${mathStack}!important;}`
      );
    }
    const styleText = css.join("\n");
    const installStyle = () => {
      if (sequence !== state.refreshSequence) return "superseded";
      if (document.getElementById(STYLE_ID)) return "installed";
      const root = document.documentElement;
      if (!root) return "pending";
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = styleText;
      (document.head || root).appendChild(style);
      root.dataset.rionStudioFonts = "custom";
      return "installed";
    };
    let styleOutcome = installStyle();
    if (styleOutcome === "pending") {
      styleOutcome = await new Promise((resolve, reject) => {
        const cleanup = () => {
          document.removeEventListener("readystatechange", continueInstallation);
          document.removeEventListener("DOMContentLoaded", continueInstallation);
          globalThis.removeEventListener?.("pagehide", documentRetired);
        };
        const continueInstallation = () => {
          const outcome = installStyle();
          if (outcome === "pending") return;
          cleanup();
          resolve(outcome);
        };
        const documentRetired = () => {
          cleanup();
          reject(new Error("The browser-font document retired before style installation."));
        };
        document.addEventListener("readystatechange", continueInstallation);
        document.addEventListener("DOMContentLoaded", continueInstallation);
        globalThis.addEventListener?.("pagehide", documentRetired, { once: true });
        continueInstallation();
      });
    }
    if (styleOutcome === "superseded") return undefined;
    if (!document.getElementById(STYLE_ID)) {
      throw new Error("The browser-font style was not installed.");
    }
    return applicationEvidence(sequence, settings);
  }

  async function refresh(payloadOverride) {
    const hasPayloadOverride = arguments.length > 0;
    const sequence = ++state.refreshSequence;
    try {
      let payload = payloadOverride;
      if (!hasPayloadOverride) {
        if (state.sourceMode !== "tauri") {
          throw new Error("The injected browser-font runtime requires an exact payload.");
        }
        const internals = globalThis.__TAURI_INTERNALS__;
        if (!internals || typeof internals.invoke !== "function") return undefined;
        payload = await internals.invoke("rion_browser_font_payload");
      } else {
        state.sourceMode = "injected";
      }
      return await installPayload(payload, sequence);
    } catch (error) {
      if (sequence === state.refreshSequence) removeAppliedFonts();
      if (hasPayloadOverride || state.sourceMode === "injected") throw error;
      return undefined;
    }
  }

  const runtime = Object.freeze({
    refresh,
    version: VERSION
  });
  Object.defineProperty(globalThis, RUNTIME_KEY, {
    configurable: false,
    enumerable: false,
    value: runtime,
    writable: false
  });
  installCanvasHooks();
  return hasInjectedPayload ? refresh(injectedPayload) : refresh();
})();
