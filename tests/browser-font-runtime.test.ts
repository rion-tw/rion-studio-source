import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const runtimeSource = await readFile(
  new URL("../src/shared/browser-overlay/browserFontsRuntime.js", import.meta.url),
  "utf8"
);

interface RuntimeDocumentFixture {
  addedFaces: unknown[];
  context: RuntimeContext;
  createCanvasContext: () => TestCanvasContext;
  createOffscreenCanvasContext: () => TestCanvasContext;
  styles: Array<{ id: string; textContent: string }>;
}

type RuntimeContext = vm.Context & {
  __rionStudioBrowserFonts?: { refresh: () => Promise<void> };
  CanvasRenderingContext2D?: new () => TestCanvasContext;
  OffscreenCanvasRenderingContext2D?: new () => TestCanvasContext;
};

interface TestCanvasCall {
  font: string;
  fontKerning?: string;
  method: "fillText" | "measureText" | "strokeText";
  text: string;
  textRendering?: string;
}

interface TestCanvasContext {
  calls: TestCanvasCall[];
  font: string;
  fontSetCount: number;
  fontKerning?: string;
  fillText: (text: string) => void;
  measureText: (text: string) => { width: number };
  resetState: () => void;
  restore: () => void;
  save: () => void;
  strokeText: (text: string) => void;
  textRendering?: string;
}

interface RuntimeFixtureOptions {
  canvas?: boolean;
  canvasFontConfigurable?: boolean;
  canvasTextMethodThrows?: TestCanvasCall["method"];
  canvasTextQualityAccessorsThrow?: boolean;
  offscreenCanvas?: boolean;
  platform: "macos" | "windows";
}

type CanvasTextQualityProperty = "fontKerning" | "textRendering";

function readCanvasTextQuality(
  context: TestCanvasContext,
  property: CanvasTextQualityProperty
): string | undefined {
  try {
    return context[property];
  } catch {
    return undefined;
  }
}

function writeCanvasTextQuality(
  context: TestCanvasContext,
  property: CanvasTextQualityProperty,
  value: string | undefined
): void {
  if (value === undefined) return;
  try {
    context[property] = value;
  } catch {
    // Fixtures can model an engine exposing an unusable optional property.
  }
}

function createFontStyleFixture(): {
  cssText: string;
  font: string;
  fontFamily: string;
} {
  let font = "";
  let fontFamily = "";
  let fontPrefix = "";
  return {
    get cssText() {
      return font ? `font: ${font};` : "";
    },
    set cssText(value: string) {
      if (!value) {
        font = "";
        fontFamily = "";
        fontPrefix = "";
      }
    },
    get font() {
      return font;
    },
    set font(value: string) {
      const match = /^(.*?\b\d+(?:\.\d+)?(?:px|pt|em|rem|%)(?:\s*\/\s*[^\s]+)?)\s+(.+)$/iu.exec(
        String(value).trim()
      );
      if (!match) return;
      fontPrefix = match[1].replace(/\s*\/\s*/u, " / ").replace(/\s+/gu, " ");
      fontFamily = match[2].trim();
      font = `${fontPrefix} ${fontFamily}`;
    },
    get fontFamily() {
      return fontFamily;
    },
    set fontFamily(value: string) {
      if (!fontPrefix || !value.trim()) return;
      fontFamily = value.trim();
      font = `${fontPrefix} ${fontFamily}`;
    }
  };
}

function createRuntimeDocumentFixture(
  invoke: (command: string) => Promise<unknown>,
  FontFace: new (...args: never[]) => unknown,
  options: RuntimeFixtureOptions
): RuntimeDocumentFixture {
  const styles: Array<{ id: string; textContent: string }> = [];
  const addedFaces: unknown[] = [];
  const documentElement = {
    dataset: {} as Record<string, string>,
    removeAttribute(name: string) {
      if (name === "data-rion-studio-fonts") delete this.dataset.rionStudioFonts;
    }
  };
  const document = {
    documentElement,
    fonts: {
      add(face: unknown) {
        addedFaces.push(face);
      },
      delete(face: unknown) {
        const index = addedFaces.indexOf(face);
        if (index >= 0) addedFaces.splice(index, 1);
        return index >= 0;
      }
    },
    head: {
      appendChild(style: { id: string; textContent: string }) {
        styles.push(style);
      }
    },
    getElementById(id: string) {
      const style = styles.find((candidate) => candidate.id === id);
      return style ? { ...style, remove: () => styles.splice(styles.indexOf(style), 1) } : null;
    },
    createElement(tagName: string) {
      return tagName === "span"
        ? { style: createFontStyleFixture() }
        : { id: "", textContent: "" };
    },
    addEventListener: vi.fn()
  };
  const createCanvasContextConstructor = (): (new () => TestCanvasContext) => {
    const fontKerningValues = new WeakMap<object, string>();
    const textRenderingValues = new WeakMap<object, string>();
    class FixtureCanvasContext implements TestCanvasContext {
      readonly calls: TestCanvasCall[] = [];
      fontSetCount = 0;
      private nativeFont = "10px sans-serif";
      private readonly nativeStack: Array<{
        font: string;
        fontKerning?: string;
        textRendering?: string;
      }> = [];

      get font(): string {
        return this.nativeFont;
      }

      set font(value: string) {
        this.fontSetCount += 1;
        const parser = createFontStyleFixture();
        parser.font = String(value);
        if (parser.font) this.nativeFont = parser.font;
      }

      fillText(text: string): void {
        this.recordTextCall("fillText", text);
      }

      strokeText(text: string): void {
        this.recordTextCall("strokeText", text);
      }

      measureText(text: string): { width: number } {
        this.recordTextCall("measureText", text);
        return { width: text.length * 8 };
      }

      save(): void {
        this.nativeStack.push({
          font: this.nativeFont,
          fontKerning: readCanvasTextQuality(this, "fontKerning"),
          textRendering: readCanvasTextQuality(this, "textRendering")
        });
      }

      restore(): void {
        const restored = this.nativeStack.pop();
        if (!restored) return;
        this.nativeFont = restored.font;
        writeCanvasTextQuality(this, "fontKerning", restored.fontKerning);
        writeCanvasTextQuality(this, "textRendering", restored.textRendering);
      }

      resetState(): void {
        this.nativeFont = "10px sans-serif";
        this.nativeStack.length = 0;
        writeCanvasTextQuality(this, "fontKerning", "auto");
        writeCanvasTextQuality(this, "textRendering", "auto");
      }

      private recordTextCall(method: TestCanvasCall["method"], text: string): void {
        this.calls.push({
          font: this.nativeFont,
          fontKerning: readCanvasTextQuality(this, "fontKerning"),
          method,
          text,
          textRendering: readCanvasTextQuality(this, "textRendering")
        });
        if (options.canvasTextMethodThrows === method) {
          throw new Error(`fixture ${method} failure`);
        }
      }
    }

    if (options.canvasTextQualityAccessorsThrow) {
      for (const property of ["fontKerning", "textRendering"] as const) {
        Object.defineProperty(FixtureCanvasContext.prototype, property, {
          configurable: true,
          get() {
            throw new Error(`${property} getter is unavailable`);
          },
          set() {
            throw new Error(`${property} setter is unavailable`);
          }
        });
      }
    } else if (options.platform === "windows") {
      Object.defineProperties(FixtureCanvasContext.prototype, {
        fontKerning: {
          configurable: true,
          get() {
            return fontKerningValues.get(this) ?? "auto";
          },
          set(value: string) {
            fontKerningValues.set(this, String(value));
          }
        },
        textRendering: {
          configurable: true,
          get() {
            return textRenderingValues.get(this) ?? "auto";
          },
          set(value: string) {
            textRenderingValues.set(this, String(value));
          }
        }
      });
    }

    if (options.canvasFontConfigurable === false) {
      const descriptor = Object.getOwnPropertyDescriptor(FixtureCanvasContext.prototype, "font");
      Object.defineProperty(FixtureCanvasContext.prototype, "font", {
        ...descriptor,
        configurable: false
      });
    }
    return FixtureCanvasContext;
  };
  const CanvasContext = createCanvasContextConstructor();
  const OffscreenCanvasContext = createCanvasContextConstructor();
  const context: RuntimeContext = {
    ArrayBuffer,
    FontFace,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    Uint8Array,
    __TAURI_INTERNALS__: { invoke },
    atob,
    document
  };
  if (options.canvas) context.CanvasRenderingContext2D = CanvasContext;
  if (options.offscreenCanvas) context.OffscreenCanvasRenderingContext2D = OffscreenCanvasContext;
  vm.createContext(context);
  return {
    addedFaces,
    context,
    createCanvasContext: () => new CanvasContext(),
    createOffscreenCanvasContext: () => new OffscreenCanvasContext(),
    styles
  };
}

describe("browser font document-start runtime", () => {
it.each([
    { platform: "windows" as const, expectedKerning: "normal", expectedRendering: "optimizeLegibility" },
    { platform: "macos" as const, expectedKerning: undefined, expectedRendering: undefined }
  ])(
    "feature-detects Canvas text quality on $platform",
    async ({ platform, expectedKerning, expectedRendering }) => {
      class LoadedFontFace {
        async load(): Promise<this> {
          return this;
        }
      }
      const fixture = createRuntimeDocumentFixture(
        async () => ({
          settings: {
            mode: "custom",
            cjkVariant: "auto",
            fontSmoothingEnabled: true,
            slots: { latin: { source: "system", family: "system-ui" } }
          },
          faces: []
        }),
        LoadedFontFace,
        { canvas: true, platform }
      );

      vm.runInContext(runtimeSource, fixture.context);
      await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
      const canvas = fixture.createCanvasContext();
      canvas.fillText("platform text");

      expect(canvas.calls.at(-1)?.fontKerning).toBe(expectedKerning);
      expect(canvas.calls.at(-1)?.textRendering).toBe(expectedRendering);
    }
  );

it("loads cached faces and routes numbers, Latin, CJK, monospace, and math separately", async () => {
    class LoadedFontFace {
      constructor(
        readonly family: string,
        readonly source: string | ArrayBuffer,
        readonly descriptors: Record<string, string>
      ) {}

      async load(): Promise<this> {
        return this;
      }
    }
    const invoke = vi.fn(async () => ({
      settings: {
        mode: "custom",
        cjkVariant: "tc",
        fontSmoothingEnabled: true,
        slots: {
          cjk: { source: "system", family: "PingFang TC" },
          latin: { source: "google", catalogId: "inter" },
          numeric: { source: "google", catalogId: "inter" },
          monospace: { source: "system", family: "ui-monospace" },
          math: { source: "system", family: "math" }
        }
      },
      faces: [
        {
          catalogId: "inter",
          family: "Inter",
          style: "normal",
          weight: "400",
          unicodeRange: "U+0000-024F",
          dataBase64: btoa("wOF2fixture")
        }
      ]
    }));
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, { platform: "macos" });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));

    expect(invoke).toHaveBeenCalledWith("rion_browser_font_payload");
    expect(fixture.addedFaces).toHaveLength(3);
    expect(fixture.styles[0].textContent).toContain("Rion Studio numeric inter");
    expect(fixture.styles[0].textContent).toContain("Rion Studio latin inter");
    expect(fixture.styles[0].textContent).toContain("Rion Studio cjk system");
    expect(fixture.styles[0].textContent).toContain(":where(code,kbd,pre,samp)");
    expect(fixture.styles[0].textContent).toContain(":where(math,math *)");
    expect(fixture.styles[0].textContent).toContain(
      "-webkit-font-smoothing:antialiased!important"
    );
    expect(fixture.styles[0].textContent).toContain(
      "text-rendering:optimizeLegibility!important"
    );
    expect(fixture.styles[0].textContent).toContain("font-kerning:normal!important");
    expect(fixture.styles[0].textContent).toContain("font-optical-sizing:auto!important");
  });

it("does not attach a stale face after a newer refresh wins", async () => {
    let resolveLoad: (() => void) | undefined;
    let signalLoadStarted: (() => void) | undefined;
    const loadStarted = new Promise<void>((resolve) => {
      signalLoadStarted = resolve;
    });
    class DeferredFontFace {
      async load(): Promise<this> {
        signalLoadStarted?.();
        await new Promise<void>((resolve) => {
          resolveLoad = resolve;
        });
        return this;
      }
    }
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        settings: {
          mode: "custom",
          cjkVariant: "tc",
          fontSmoothingEnabled: true,
          slots: { cjk: { source: "system", family: "PingFang TC" } }
        },
        faces: []
      })
      .mockResolvedValueOnce({
        settings: {
          mode: "default",
          cjkVariant: "auto",
          fontSmoothingEnabled: false,
          slots: {}
        },
        faces: []
      });
    const fixture = createRuntimeDocumentFixture(invoke, DeferredFontFace, { platform: "macos" });

    vm.runInContext(runtimeSource, fixture.context);
    await loadStarted;
    await fixture.context.__rionStudioBrowserFonts?.refresh();
    resolveLoad?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(fixture.addedFaces).toHaveLength(0);
    expect(fixture.styles).toHaveLength(0);
  });

it("routes Canvas 2D text while preserving font shorthand, page fallbacks, and context state", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const invoke = vi.fn(async () => ({
      settings: {
        mode: "custom",
        cjkVariant: "tc",
        fontSmoothingEnabled: true,
        slots: {
          cjk: { source: "system", family: "PingFang TC" },
          latin: { source: "system", family: "Helvetica Neue" },
          numeric: { source: "system", family: "DIN Alternate" },
          monospace: { source: "system", family: "JetBrains Mono" },
          math: { source: "system", family: "STIX Two Math" }
        }
      },
      faces: []
    }));
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, {
      canvas: true,
      platform: "windows"
    });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));

    const canvas = fixture.createCanvasContext();
    canvas.fontKerning = "none";
    canvas.textRendering = "optimizeSpeed";
    canvas.font = 'italic 700 16px/1.5 "Game UI", sans-serif';
    const pageFont = canvas.font;
    canvas.fillText("Rion 123 飛");
    canvas.strokeText("outline");
    canvas.measureText("measure");

    expect(pageFont).toBe('italic 700 16px / 1.5 "Game UI", sans-serif');
    expect(canvas.font).toBe(pageFont);
    for (const call of canvas.calls) {
      expect(call.font).toContain('"Rion Studio numeric system"');
      expect(call.font).toContain('"Rion Studio latin system"');
      expect(call.font).toContain('"Rion Studio cjk system"');
      expect(call.font).toContain('"Game UI", sans-serif');
      expect(call.font.indexOf("Rion Studio numeric system")).toBeLessThan(
        call.font.indexOf("Rion Studio latin system")
      );
      expect(call.font.indexOf("Rion Studio latin system")).toBeLessThan(
        call.font.indexOf("Rion Studio cjk system")
      );
      expect(call.fontKerning).toBe("normal");
      expect(call.textRendering).toBe("optimizeLegibility");
    }
    expect(canvas.fontKerning).toBe("none");
    expect(canvas.textRendering).toBe("optimizeSpeed");

    canvas.font = '12px "Game Body", serif';
    canvas.save();
    canvas.font = '14px "Game Mono", ui-monospace, monospace';
    canvas.fontKerning = "auto";
    canvas.textRendering = "geometricPrecision";
    canvas.fillText("code");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio monospace system"');
    expect(canvas.calls.at(-1)?.font).toContain('"Game Mono", ui-monospace, monospace');
    canvas.restore();
    expect(canvas.font).toBe('12px "Game Body", serif');
    expect(canvas.fontKerning).toBe("none");
    expect(canvas.textRendering).toBe("optimizeSpeed");
    canvas.fillText("body");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin system"');
    expect(canvas.calls.at(-1)?.font).not.toContain('"Rion Studio monospace system"');

    canvas.font = '18px "math", serif';
    canvas.fillText("x²");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio math system"');
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin system"');
    expect(canvas.calls.at(-1)?.font).toContain('"math", serif');

    canvas.resetState();
    canvas.fillText("after reset");
    expect(canvas.font).toBe("10px sans-serif");
    expect(canvas.fontKerning).toBe("auto");
    expect(canvas.textRendering).toBe("auto");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin system"');
    expect(canvas.calls.at(-1)?.font).toContain("sans-serif");
  });

it("skips native font rewrites when a game repeats the same font every frame", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        settings: {
          mode: "custom",
          cjkVariant: "auto",
          fontSmoothingEnabled: true,
          slots: { latin: { source: "system", family: "system-ui" } }
        },
        faces: []
      })
      .mockResolvedValueOnce({
        settings: {
          mode: "custom",
          cjkVariant: "auto",
          fontSmoothingEnabled: true,
          slots: { latin: { source: "system", family: "Arial" } }
        },
        faces: []
      });
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, {
      canvas: true,
      platform: "windows"
    });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
    const canvas = fixture.createCanvasContext();
    const requestedFont = '16px "Game UI", sans-serif';
    canvas.font = requestedFont;
    const firstSetCount = canvas.fontSetCount;

    for (let frame = 0; frame < 120; frame += 1) {
      canvas.font = requestedFont;
      canvas.fillText(String(frame));
    }

    expect(canvas.fontSetCount).toBe(firstSetCount);
    expect(canvas.calls).toHaveLength(120);
    expect(canvas.calls.at(-1)?.font).toContain("system-ui");

    await fixture.context.__rionStudioBrowserFonts?.refresh();
    canvas.font = requestedFont;
    expect(canvas.fontSetCount).toBeGreaterThan(firstSetCount);
    canvas.fillText("refreshed");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin system"');
  });

it("applies refreshes on the next Canvas draw without reloading or hiding the page font", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const payload = (
      catalogId: string,
      mode: "custom" | "default",
      fontSmoothingEnabled: boolean
    ) => ({
      settings: {
        mode,
        cjkVariant: mode === "custom" ? "tc" : "auto",
        fontSmoothingEnabled,
        slots: mode === "custom" ? { latin: { source: "google", catalogId } } : {}
      },
      faces:
        mode === "custom"
          ? [
              {
                catalogId,
                family: catalogId,
                style: "normal",
                weight: "400",
                unicodeRange: "U+0000-024F",
                dataBase64: btoa("wOF2fixture")
              }
            ]
          : []
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(payload("inter", "custom", true))
      .mockResolvedValueOnce(payload("roboto", "custom", true))
      .mockResolvedValueOnce(payload("unused", "default", false));
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, {
      canvas: true,
      platform: "windows"
    });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
    const canvas = fixture.createCanvasContext();
    canvas.font = '16px "Game UI", sans-serif';
    canvas.fillText("first");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin inter"');
    expect(canvas.calls.at(-1)?.fontKerning).toBe("normal");
    expect(canvas.calls.at(-1)?.textRendering).toBe("optimizeLegibility");

    await fixture.context.__rionStudioBrowserFonts?.refresh();
    expect(canvas.font).toBe('16px "Game UI", sans-serif');
    canvas.fillText("second");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin roboto"');
    expect(canvas.calls.at(-1)?.font).not.toContain('"Rion Studio latin inter"');

    await fixture.context.__rionStudioBrowserFonts?.refresh();
    canvas.fillText("default");
    expect(canvas.calls.at(-1)?.font).toBe('16px "Game UI", sans-serif');
    expect(canvas.calls.at(-1)?.fontKerning).toBe("auto");
    expect(canvas.calls.at(-1)?.textRendering).toBe("auto");
    expect(canvas.font).toBe('16px "Game UI", sans-serif');
    expect(fixture.styles).toHaveLength(0);
  });

it("toggles font replacement and text quality independently on the next Canvas operation", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        settings: {
          mode: "custom",
          cjkVariant: "auto",
          fontSmoothingEnabled: false,
          slots: { latin: { source: "system", family: "Arial" } }
        },
        faces: []
      })
      .mockResolvedValueOnce({
        settings: {
          mode: "default",
          cjkVariant: "auto",
          fontSmoothingEnabled: true,
          slots: {}
        },
        faces: []
      })
      .mockResolvedValueOnce({
        settings: {
          mode: "default",
          cjkVariant: "auto",
          fontSmoothingEnabled: false,
          slots: {}
        },
        faces: []
      });
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, {
      canvas: true,
      platform: "windows"
    });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
    expect(fixture.styles[0].textContent).toContain("font-family:");
    expect(fixture.styles[0].textContent).not.toContain("font-kerning:");

    const canvas = fixture.createCanvasContext();
    canvas.font = '16px "Game UI", sans-serif';
    canvas.fontKerning = "none";
    canvas.textRendering = "optimizeSpeed";
    canvas.fillText("font only");
    expect(canvas.calls.at(-1)?.font).toContain('"Rion Studio latin system"');
    expect(canvas.calls.at(-1)?.fontKerning).toBe("none");
    expect(canvas.calls.at(-1)?.textRendering).toBe("optimizeSpeed");

    await fixture.context.__rionStudioBrowserFonts?.refresh();
    expect(fixture.styles).toHaveLength(1);
    expect(fixture.styles[0].textContent).not.toContain("font-family:");
    expect(fixture.styles[0].textContent).toContain("font-kerning:normal!important");
    canvas.measureText("quality only");
    expect(canvas.calls.at(-1)?.font).toBe('16px "Game UI", sans-serif');
    expect(canvas.calls.at(-1)?.fontKerning).toBe("normal");
    expect(canvas.calls.at(-1)?.textRendering).toBe("optimizeLegibility");
    expect(canvas.fontKerning).toBe("none");
    expect(canvas.textRendering).toBe("optimizeSpeed");

    await fixture.context.__rionStudioBrowserFonts?.refresh();
    expect(fixture.styles).toHaveLength(0);
    canvas.strokeText("native");
    expect(canvas.calls.at(-1)?.font).toBe('16px "Game UI", sans-serif');
    expect(canvas.calls.at(-1)?.fontKerning).toBe("none");
    expect(canvas.calls.at(-1)?.textRendering).toBe("optimizeSpeed");
  });
});
