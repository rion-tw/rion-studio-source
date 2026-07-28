(() => {
  "use strict";

  const RUNTIME_KEY = "__rionStudioBrowserFonts";
  const STYLE_ID = "rion-studio-browser-fonts";
  const CANVAS_HOOK_KEY = "__rionStudioBrowserFontsCanvasHook";
  const VERSION = 4;
  const CANVAS_TEXT_QUALITY = Object.freeze([
    ["textRendering", "optimizeLegibility"],
    ["fontKerning", "normal"]
  ]);
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

  const previous = globalThis[RUNTIME_KEY];
  if (previous?.version === VERSION && typeof previous.refresh === "function") {
    void previous.refresh();
    return;
  }

  const state = {
    canvasActive: false,
    canvasRevision: 0,
    canvasStacks: { general: [], math: [], monospace: [] },
    faces: [],
    refreshSequence: 0,
    version: VERSION
  };
  const canvasContexts = new WeakMap();
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
    if (families.includes("math")) return state.canvasStacks.math;
    if (families.includes("monospace") || families.includes("ui-monospace")) {
      return state.canvasStacks.monospace;
    }
    return state.canvasStacks.general;
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
    if (!state.canvasActive || !canvasFontParser) return font;
    try {
      canvasFontParser.cssText = "";
      canvasFontParser.font = font;
      const parsedFont = canvasFontParser.font;
      const fontFamily = canvasFontParser.fontFamily;
      if (!parsedFont || !fontFamily) return font;
      const customFamilies = canvasStackForFamily(fontFamily);
      if (customFamilies.length === 0) return font;
      canvasFontParser.fontFamily = prependCanvasFamilies(fontFamily, customFamilies);
      return canvasFontParser.font || font;
    } catch {
      return font;
    }
  }

  function synchronizeCanvasContext(context, fontDescriptor) {
    const nativeFont = fontDescriptor.get.call(context);
    let record = canvasContexts.get(context);
    if (!record) {
      record = {
        effectiveFont: nativeFont,
        originalFont: nativeFont,
        revision: -1,
        savedFonts: []
      };
      canvasContexts.set(context, record);
      return record;
    }
    if (nativeFont !== record.effectiveFont) {
      record.effectiveFont = nativeFont;
      record.originalFont = nativeFont;
      record.revision = -1;
      record.savedFonts = [];
    }
    return record;
  }

  function applyCanvasFont(context, fontDescriptor, record) {
    const nativeFont = fontDescriptor.get.call(context);
    if (record.revision === state.canvasRevision && nativeFont === record.effectiveFont) {
      return record;
    }
    const desiredFont = rewriteCanvasFont(record.originalFont);
    if (nativeFont !== desiredFont) fontDescriptor.set.call(context, desiredFont);
    record.effectiveFont = fontDescriptor.get.call(context);
    record.revision = state.canvasRevision;
    return record;
  }

  function prepareCanvasContext(context, fontDescriptor) {
    try {
      return applyCanvasFont(
        context,
        fontDescriptor,
        synchronizeCanvasContext(context, fontDescriptor)
      );
    } catch {
      return undefined;
    }
  }

  function applyCanvasTextQuality(context) {
    const previous = [];
    if (!state.canvasActive) return previous;
    for (const [property, desired] of CANVAS_TEXT_QUALITY) {
      let captured = false;
      let original;
      try {
        if (!(property in context)) continue;
        original = context[property];
        captured = true;
        if (original === desired) continue;
        context[property] = desired;
        previous.push([property, original]);
      } catch {
        if (!captured) continue;
        try {
          context[property] = original;
        } catch {
          // An optional typography property must never block the native text operation.
        }
      }
    }
    return previous;
  }

  function restoreCanvasTextQuality(context, previous) {
    for (const [property, value] of previous.reverse()) {
      try {
        context[property] = value;
      } catch {
        // Preserve the native result even if an engine refuses to restore an optional property.
      }
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

    const originals = new Map([["font", fontDescriptor], ...methodDescriptors]);
    const applied = [];
    try {
      Object.defineProperty(prototype, "font", {
        ...fontDescriptor,
        get() {
          try {
            return synchronizeCanvasContext(this, fontDescriptor).originalFont;
          } catch {
            return fontDescriptor.get.call(this);
          }
        },
        set(value) {
          let record;
          try {
            record = synchronizeCanvasContext(this, fontDescriptor);
            fontDescriptor.set.call(this, record.originalFont);
          } catch {
            fontDescriptor.set.call(this, value);
            return;
          }
          fontDescriptor.set.call(this, value);
          record.originalFont = fontDescriptor.get.call(this);
          record.effectiveFont = record.originalFont;
          record.revision = -1;
          applyCanvasFont(this, fontDescriptor, record);
        }
      });
      applied.push("font");

      for (const name of ["fillText", "strokeText", "measureText"]) {
        const descriptor = methodDescriptors.get(name);
        const nativeMethod = descriptor.value;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value(...args) {
            prepareCanvasContext(this, fontDescriptor);
            const previousQuality = applyCanvasTextQuality(this);
            try {
              return nativeMethod.apply(this, args);
            } finally {
              restoreCanvasTextQuality(this, previousQuality);
            }
          }
        });
        applied.push(name);
      }

      const saveDescriptor = methodDescriptors.get("save");
      const nativeSave = saveDescriptor.value;
      Object.defineProperty(prototype, "save", {
        ...saveDescriptor,
        value(...args) {
          const record = prepareCanvasContext(this, fontDescriptor);
          const result = nativeSave.apply(this, args);
          if (record) record.savedFonts.push(record.originalFont);
          return result;
        }
      });
      applied.push("save");

      const restoreDescriptor = methodDescriptors.get("restore");
      const nativeRestore = restoreDescriptor.value;
      Object.defineProperty(prototype, "restore", {
        ...restoreDescriptor,
        value(...args) {
          let record;
          try {
            record = synchronizeCanvasContext(this, fontDescriptor);
          } catch {
            // Let the native method report invalid receivers or state.
          }
          const result = nativeRestore.apply(this, args);
          if (record?.savedFonts.length) {
            record.originalFont = record.savedFonts.pop();
            record.effectiveFont = fontDescriptor.get.call(this);
            record.revision = -1;
            applyCanvasFont(this, fontDescriptor, record);
          } else {
            prepareCanvasContext(this, fontDescriptor);
          }
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
    state.canvasActive = false;
    state.canvasRevision += 1;
    state.canvasStacks = { general: [], math: [], monospace: [] };
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
        pendingFaces.push(face.load().then(() => face).catch(() => undefined));
      } catch {
        // One unavailable shard should fall through to the next face or fallback font.
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
        // One unavailable shard should fall through to the next face or fallback font.
      }
    }
    return loaded > 0 ? quoteFamily(alias) : undefined;
  }

  async function installPayload(payload, sequence) {
    if (sequence !== state.refreshSequence) return;
    removeAppliedFonts();
    const settings = payload?.settings;
    if (!settings || settings.mode !== "custom") return;

    const facesByCatalog = new Map();
    for (const face of Array.isArray(payload.faces) ? payload.faces : []) {
      const id = String(face?.catalogId || "");
      if (!id) continue;
      const faces = facesByCatalog.get(id) || [];
      faces.push(face);
      facesByCatalog.set(id, faces);
    }
    const slots = settings.slots && typeof settings.slots === "object" ? settings.slots : {};
    const resolved = {};
    for (const slot of ["numeric", "latin", "cjk", "monospace", "math"]) {
      resolved[slot] = await registerSelection(slot, slots[slot], facesByCatalog, sequence);
      if (sequence !== state.refreshSequence) return;
    }

    const bodyStack = [resolved.numeric, resolved.latin, resolved.cjk, "system-ui", "sans-serif"]
      .filter(Boolean)
      .join(",");
    const monospaceStack = [resolved.monospace, "ui-monospace", "monospace"].filter(Boolean).join(",");
    const mathStack = [resolved.math, "math", resolved.latin, resolved.cjk, "serif"].filter(Boolean).join(",");
    state.canvasActive = true;
    state.canvasRevision += 1;
    state.canvasStacks = {
      general: [...new Set([resolved.numeric, resolved.latin, resolved.cjk].filter(Boolean))],
      math: [...new Set([resolved.math, resolved.latin, resolved.cjk].filter(Boolean))],
      monospace: [...new Set([resolved.monospace].filter(Boolean))]
    };
    const generalSelector = [
      ":where(html,body,button,input,select,textarea)",
      ":where(body *):not(svg):not(svg *):not([class*='icon' i]):not([class^='fa-' i]):not(.fa):not(.fas):not(.far):not(.fab)"
    ].join(",");
    const css = [
      `${generalSelector}{font-family:${bodyStack}!important;-webkit-font-smoothing:antialiased!important;text-rendering:optimizeLegibility!important;font-kerning:normal!important;font-optical-sizing:auto!important;}`,
      `:where(code,kbd,pre,samp){font-family:${monospaceStack}!important;}`,
      `:where(math,math *){font-family:${mathStack}!important;}`
    ].join("\n");
    const installStyle = () => {
      if (sequence !== state.refreshSequence || document.getElementById(STYLE_ID)) return;
      const root = document.documentElement;
      if (!root) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      (document.head || root).appendChild(style);
      root.dataset.rionStudioFonts = "custom";
    };
    installStyle();
    if (!document.getElementById(STYLE_ID)) {
      document.addEventListener("readystatechange", installStyle, { once: true });
      document.addEventListener("DOMContentLoaded", installStyle, { once: true });
    }
  }

  async function refresh() {
    const sequence = ++state.refreshSequence;
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return;
    try {
      const payload = await internals.invoke("rion_browser_font_payload");
      await installPayload(payload, sequence);
    } catch {
      if (sequence === state.refreshSequence) removeAppliedFonts();
    }
  }

  Object.defineProperty(state, "refresh", { enumerable: false, value: refresh });
  Object.defineProperty(globalThis, RUNTIME_KEY, {
    configurable: true,
    enumerable: false,
    value: state
  });
  installCanvasHooks();
  void refresh();
})();
