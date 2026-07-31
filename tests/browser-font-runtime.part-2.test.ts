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

it("covers main-thread OffscreenCanvas glyph sources and installs hooks idempotently", async () => {
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
        slots: { latin: { source: "system", family: "Helvetica Neue" } }
      },
      faces: []
    }));
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace, {
      canvas: true,
      offscreenCanvas: true,
      platform: "windows"
    });

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
    const hookedFillText = fixture.context.OffscreenCanvasRenderingContext2D?.prototype.fillText;
    vm.runInContext(runtimeSource, fixture.context);
    expect(fixture.context.OffscreenCanvasRenderingContext2D?.prototype.fillText).toBe(hookedFillText);

    const glyphSurface = fixture.createOffscreenCanvasContext();
    glyphSurface.font = '24px "WebGL Glyph Source", sans-serif';
    glyphSurface.fillText("texture glyph");
    const uploadedTextureFont = glyphSurface.calls.at(-1)?.font;
    expect(uploadedTextureFont).toContain('"Rion Studio latin system"');
    expect(uploadedTextureFont).toContain('"WebGL Glyph Source", sans-serif');
    expect(glyphSurface.calls.at(-1)?.fontKerning).toBe("normal");
    expect(glyphSurface.calls.at(-1)?.textRendering).toBe("optimizeLegibility");
    expect(glyphSurface.fontKerning).toBe("auto");
    expect(glyphSurface.textRendering).toBe("auto");
  });

it("restores Canvas quality after native errors and ignores inaccessible properties", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const payload = async () => ({
      settings: {
        mode: "custom",
        cjkVariant: "auto",
        fontSmoothingEnabled: true,
        slots: { latin: { source: "system", family: "system-ui" } }
      },
      faces: []
    });
    const throwingFixture = createRuntimeDocumentFixture(payload, LoadedFontFace, {
      canvas: true,
      canvasTextMethodThrows: "fillText",
      platform: "windows"
    });

    vm.runInContext(runtimeSource, throwingFixture.context);
    await vi.waitFor(() => expect(throwingFixture.styles).toHaveLength(1));
    const throwingCanvas = throwingFixture.createCanvasContext();
    throwingCanvas.fontKerning = "none";
    throwingCanvas.textRendering = "optimizeSpeed";

    expect(() => throwingCanvas.fillText("failure")).toThrow("fixture fillText failure");
    expect(throwingCanvas.calls.at(-1)?.fontKerning).toBe("normal");
    expect(throwingCanvas.calls.at(-1)?.textRendering).toBe("optimizeLegibility");
    expect(throwingCanvas.fontKerning).toBe("none");
    expect(throwingCanvas.textRendering).toBe("optimizeSpeed");

    const inaccessibleFixture = createRuntimeDocumentFixture(payload, LoadedFontFace, {
      canvas: true,
      canvasTextQualityAccessorsThrow: true,
      platform: "macos"
    });
    vm.runInContext(runtimeSource, inaccessibleFixture.context);
    await vi.waitFor(() => expect(inaccessibleFixture.styles).toHaveLength(1));
    const inaccessibleCanvas = inaccessibleFixture.createCanvasContext();

    expect(() => inaccessibleCanvas.fillText("native fallback")).not.toThrow();
    expect(inaccessibleCanvas.calls.at(-1)?.fontKerning).toBeUndefined();
    expect(inaccessibleCanvas.calls.at(-1)?.textRendering).toBeUndefined();
  });

it("leaves Canvas native behavior intact when its font descriptor cannot be hooked", async () => {
    class LoadedFontFace {
      async load(): Promise<this> {
        return this;
      }
    }
    const fixture = createRuntimeDocumentFixture(
      async () => ({
        settings: {
          mode: "custom",
          cjkVariant: "tc",
          fontSmoothingEnabled: true,
          slots: { latin: { source: "system", family: "Helvetica Neue" } }
        },
        faces: []
      }),
      LoadedFontFace,
      { canvas: true, canvasFontConfigurable: false, platform: "macos" }
    );

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));
    const canvas = fixture.createCanvasContext();
    canvas.font = '16px "Game UI", sans-serif';
    canvas.fillText("native");

    expect(canvas.calls.at(-1)?.font).toBe('16px "Game UI", sans-serif');
  });
});
