import { describe, expect, it, vi } from "vitest";

import {
  CHROMIUM_ROLE_FONTS_CHANNEL,
  CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL,
  type ChromiumRoleFontsEnvelope,
  type ChromiumRoleFontsRefreshControl
} from "../src/electron/ipc/chromiumRoleFontsProtocol";
import {
  validateChromiumRoleFontPayload
} from "../src/electron/preload/chromiumRoleFontPayload";
import { assembleChromiumRoleFontSource } from
  "../src/electron/preload/chromiumRoleFontSource";
import { installChromiumRoleFonts } from
  "../src/electron/preload/installChromiumRoleFonts";

const FACE_BASE64 = "d09GMmZpeHR1cmU=";
const PAYLOAD = Object.freeze({
  settings: Object.freeze({
    mode: "custom" as const,
    fontSmoothingEnabled: true,
    presetId: "balanced",
    cjkVariant: "auto" as const,
    slots: Object.freeze({
      latin: Object.freeze({ source: "google" as const, catalogId: "inter" })
    })
  }),
  faces: Object.freeze([Object.freeze({
    catalogId: "inter",
    family: "Inter",
    style: "normal",
    weight: "400",
    unicodeRange: "U+0000-024F",
    dataBase64: FACE_BASE64
  })])
});

const EVIDENCE = Object.freeze({
  canvasFontsActive: true,
  canvasTextQualityActive: true,
  failedFaceCount: 0,
  fontMode: "custom" as const,
  fontSmoothingEnabled: true,
  loadedCatalogIds: Object.freeze(["inter"]),
  loadedFaceCount: 1,
  runtimeVersion: 7 as const,
  sequence: 1,
  status: "applied" as const,
  styleInstalled: true
});

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function harness(options: { executeFailure?: boolean } = {}) {
  let refreshListener:
    | ((event: unknown, control: unknown) => void)
    | null = null;
  let applicationSequence = 0;
  let payloadRevision = 0;
  const envelopes: ChromiumRoleFontsEnvelope[] = [];
  const invoke = vi.fn(async (channel: string, envelope: ChromiumRoleFontsEnvelope) => {
    expect(channel).toBe(CHROMIUM_ROLE_FONTS_CHANNEL);
    envelopes.push(envelope);
    if (envelope.method === "payload") {
      applicationSequence += 1;
      payloadRevision += 1;
      const request = envelope.payload as { refreshId: string | null };
      return {
        applicationId: id(applicationSequence),
        frameToken: "frame-token-1",
        generation: 4,
        payload: PAYLOAD,
        payloadRevision,
        refreshId: request.refreshId,
        roleId: "role-1"
      };
    }
    if (envelope.method === "receipt") {
      return {
        applicationId: (envelope.payload as { applicationId: string }).applicationId,
        status: "accepted"
      };
    }
    return { status: "accepted" };
  });
  const executeJavaScript = options.executeFailure
    ? vi.fn(async () => Promise.reject(new Error("main-world failure")))
    : vi.fn(async () => EVIDENCE);
  const subject = installChromiumRoleFonts(
    {
      invoke,
      on: (channel, listener) => {
        expect(channel).toBe(CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL);
        refreshListener = listener;
      }
    },
    { executeJavaScript, frameToken: "frame-token-1" },
    true
  );
  return {
    emitRefresh: (refreshId: string) => {
      const control: ChromiumRoleFontsRefreshControl = {
        frameToken: "frame-token-1",
        generation: 4,
        refreshId,
        roleId: "role-1"
      };
      refreshListener?.({}, control);
    },
    envelopes,
    executeJavaScript,
    invoke,
    subject
  };
}

describe("Chromium role browser-font preload", () => {
  it("accepts and freezes only a bounded canonical Core payload", () => {
    const payload = validateChromiumRoleFontPayload(PAYLOAD);

    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.settings.slots)).toBe(true);
    expect(Object.isFrozen(payload.faces)).toBe(true);
    expect(payload.faces[0]?.dataBase64).toBe(FACE_BASE64);
    expect(() => validateChromiumRoleFontPayload({
      ...PAYLOAD,
      extra: true
    })).toThrow("unsupported fields");
    expect(() => validateChromiumRoleFontPayload({
      ...PAYLOAD,
      faces: [{ ...PAYLOAD.faces[0], dataBase64: btoa("not-a-font") }]
    })).toThrow("WOFF2");
    expect(() => validateChromiumRoleFontPayload({
      ...PAYLOAD,
      faces: [{
        ...PAYLOAD.faces[0],
        dataBase64: FACE_BASE64.replace(/U=$/u, "V=")
      }]
    })).toThrow("canonical WOFF2");
    expect(() => validateChromiumRoleFontPayload({
      ...PAYLOAD,
      faces: [{ ...PAYLOAD.faces[0], catalogId: "not-selected" }]
    })).toThrow("not selected");
  });

  it("assembles a one-shot main-world data application without a privileged API", () => {
    const source = assembleChromiumRoleFontSource(
      validateChromiumRoleFontPayload(PAYLOAD)
    );

    expect(source).toContain("__rionStudioBrowserFontsInjectedPayloadV1");
    expect(source).toContain(FACE_BASE64);
    expect(source).toContain("__rionStudioBrowserFonts");
    expect(source).not.toContain("ipcRenderer");
    expect(source).not.toContain("contextBridge");
    expect(source).not.toContain("require(");
    expect(source).not.toContain("process.");
  });

  it("applies initial and refresh payloads through exact sandboxed receipts", async () => {
    const state = harness();
    await expect(state.subject).resolves.toBe(true);

    expect(state.envelopes.map((entry) => entry.method)).toEqual([
      "payload",
      "receipt"
    ]);
    expect(state.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__rionStudioBrowserFontsInjectedPayloadV1"),
      false
    );

    const refreshId = id(90);
    state.emitRefresh(refreshId);
    await vi.waitFor(() => {
      expect(state.envelopes.filter((entry) => entry.method === "receipt"))
        .toHaveLength(2);
    });
    expect(state.envelopes.at(-2)).toMatchObject({
      method: "payload",
      payload: { refreshId }
    });
    expect(state.envelopes.at(-1)).toMatchObject({
      method: "receipt",
      payload: { refreshId, status: "applied" }
    });
  });

  it("reports main-world failure instead of silently completing installation", async () => {
    const state = harness({ executeFailure: true });

    await expect(state.subject).rejects.toThrow("main-world failure");
    expect(state.envelopes.map((entry) => entry.method)).toEqual([
      "payload",
      "failure"
    ]);
    expect(state.envelopes.at(-1)).toMatchObject({
      payload: {
        code: "ELECTRON_ROLE_FONT_PRELOAD_FAILED",
        refreshId: null,
        status: "failed"
      }
    });
  });

  it("does not install or subscribe in child frames", async () => {
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const executeJavaScript = vi.fn(async () => undefined);

    await expect(installChromiumRoleFonts(
      { invoke, on },
      { executeJavaScript, frameToken: "child-frame" },
      false
    )).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(executeJavaScript).not.toHaveBeenCalled();
  });
});
