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
  styles: Array<{ id: string; textContent: string }>;
}

type RuntimeContext = vm.Context & {
  __rionStudioBrowserFonts?: { refresh: () => Promise<void> };
};

function createRuntimeDocumentFixture(
  invoke: (command: string) => Promise<unknown>,
  FontFace: new (...args: never[]) => unknown
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
    createElement() {
      return { id: "", textContent: "" };
    },
    addEventListener: vi.fn()
  };
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
  vm.createContext(context);
  return { addedFaces, context, styles };
}

describe("browser font document-start runtime", () => {
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
    const fixture = createRuntimeDocumentFixture(invoke, LoadedFontFace);

    vm.runInContext(runtimeSource, fixture.context);
    await vi.waitFor(() => expect(fixture.styles).toHaveLength(1));

    expect(invoke).toHaveBeenCalledWith("rion_browser_font_payload");
    expect(fixture.addedFaces).toHaveLength(3);
    expect(fixture.styles[0].textContent).toContain("Rion Studio numeric inter");
    expect(fixture.styles[0].textContent).toContain("Rion Studio latin inter");
    expect(fixture.styles[0].textContent).toContain("Rion Studio cjk system");
    expect(fixture.styles[0].textContent).toContain(":where(code,kbd,pre,samp)");
    expect(fixture.styles[0].textContent).toContain(":where(math,math *)");
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
          slots: { cjk: { source: "system", family: "PingFang TC" } }
        },
        faces: []
      })
      .mockResolvedValueOnce({
        settings: { mode: "default", cjkVariant: "auto", slots: {} },
        faces: []
      });
    const fixture = createRuntimeDocumentFixture(invoke, DeferredFontFace);

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
});
