(() => {
  "use strict";

  const RUNTIME_KEY = "__rionStudioBrowserFonts";
  const INJECTED_PAYLOAD_KEY = "__rionStudioBrowserFontsInjectedPayloadV1";
  const STYLE_ID = "rion-studio-browser-fonts";
  const CANVAS_HOOK_KEY = "__rionStudioBrowserFontsCanvasHook";
  const VERSION = 7;
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

  function synchronizeCanvasContext(context, fontDescriptor) {
    const nativeFont = fontDescriptor.get.call(context);
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
            if (
              record.revision === state.canvasRevision &&
              record.requestedFont === String(value) &&
              fontDescriptor.get.call(this) === record.effectiveFont
            ) {
              return;
            }
            fontDescriptor.set.call(this, record.originalFont);
          } catch {
            fontDescriptor.set.call(this, value);
            return;
          }
          fontDescriptor.set.call(this, value);
          record.originalFont = fontDescriptor.get.call(this);
          record.requestedFont = String(value);
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
            let restoreTextRendering = false;
            let previousTextRendering;
            let restoreFontKerning = false;
            let previousFontKerning;
            if (state.canvasTextQualityActive) {
              try {
                if ("textRendering" in this) {
                  previousTextRendering = this.textRendering;
                  if (previousTextRendering !== "optimizeLegibility") {
                    this.textRendering = "optimizeLegibility";
                    restoreTextRendering = true;
                  }
                }
              } catch {
                if (restoreTextRendering) {
                  try {
                    this.textRendering = previousTextRendering;
                  } catch {
                    // An optional typography property must not block native text drawing.
                  }
                  restoreTextRendering = false;
                }
              }
              try {
                if ("fontKerning" in this) {
                  previousFontKerning = this.fontKerning;
                  if (previousFontKerning !== "normal") {
                    this.fontKerning = "normal";
                    restoreFontKerning = true;
                  }
                }
              } catch {
                if (restoreFontKerning) {
                  try {
                    this.fontKerning = previousFontKerning;
                  } catch {
                    // An optional typography property must not block native text drawing.
                  }
                  restoreFontKerning = false;
                }
              }
            }
            try {
              return nativeMethod.apply(this, args);
            } finally {
              if (restoreFontKerning) {
                try {
                  this.fontKerning = previousFontKerning;
                } catch {
                  // Preserve the native result when an optional property cannot be restored.
                }
              }
              if (restoreTextRendering) {
                try {
                  this.textRendering = previousTextRendering;
                } catch {
                  // Preserve the native result when an optional property cannot be restored.
                }
              }
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
            record.requestedFont = record.originalFont;
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

    const bodyStack = [resolved.numeric, resolved.latin, resolved.cjk, "system-ui", "sans-serif"]
      .filter(Boolean)
      .join(",");
    const monospaceStack = [resolved.monospace, "ui-monospace", "monospace"].filter(Boolean).join(",");
    const mathStack = [resolved.math, "math", resolved.latin, resolved.cjk, "serif"].filter(Boolean).join(",");
    state.canvasFontsActive = fontsActive;
    state.canvasRevision += 1;
    state.canvasStacks = {
      general: [...new Set([resolved.numeric, resolved.latin, resolved.cjk].filter(Boolean))],
      math: [...new Set([resolved.math, resolved.latin, resolved.cjk].filter(Boolean))],
      monospace: [...new Set([resolved.monospace].filter(Boolean))]
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
