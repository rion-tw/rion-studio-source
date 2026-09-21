import { describe, expect, it, vi } from "vitest";
import { collectWorkspaceWebDrm, workspaceWebDrmProbePage } from "../scripts/workspaceWebDrmProbe.mjs";

function environment(errorName = "NotSupportedError") {
  return { isSecureContext: true, navigator: { requestMediaKeySystemAccess: vi.fn(async (key: string) => {
    if (key === "org.w3.clearkey") return { createMediaKeys: async () => ({}) };
    throw Object.assign(new Error("https://secret.test/?token=PRIVATE license=SECRET"), { name: errorName });
  }) }, document: { createElement: () => ({ canPlayType: () => "probably" }) },
  MediaSource: { isTypeSupported: () => true },
  fetch: vi.fn(async () => ({ ok: true, status: 200,
    text: async () => '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">SECRET</ContentProtection>' })) };
}

describe("Workspace Web DRM capability evidence", () => {
  it("does not confuse ClearKey or codec advertisements with Widevine playback", async () => {
    const api = environment();
    const result = await collectWorkspaceWebDrm(api);
    expect(result.requests).toHaveLength(5);
    expect(result.requests[4]).toMatchObject({ mediaKeys: "created" });
    expect(result).toMatchObject({ nextStage: "key-system-prerequisite-unmet", license: "not-attempted",
      decoding: "not-attempted", netflix: "not-tested", publicSample: { status: 200, widevineSignaled: true } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|secret.test|license=/);
    expect(api.fetch.mock.calls[0]).toEqual([
      "https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd",
      { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }
    ]);
  });
  it.each(["NotSupportedError", "NotAllowedError", "SecurityError", "SomethingPrivate"])(
    "preserves useful error categories without raw details: %s", async error => {
      const result = await collectWorkspaceWebDrm(environment(error));
      expect(result.requests[0].access).toBe(error === "SomethingPrivate" ? "OtherError" : error);
      expect(result.license).toBe("not-attempted");
    });
  it("requires MediaKeys creation and still does not claim decoding or license success", async () => {
    const api = environment();
    api.navigator.requestMediaKeySystemAccess.mockResolvedValue({ createMediaKeys: async () => ({}) });
    expect(await collectWorkspaceWebDrm(api)).toMatchObject({ nextStage: "public-encrypted-playback-required",
      decoding: "not-attempted", license: "not-attempted", netflix: "not-tested" });
    api.navigator.requestMediaKeySystemAccess.mockResolvedValue({ createMediaKeys: async () => {
      throw Object.assign(new Error("private"), { name: "NotSupportedError" });
    } });
    expect(await collectWorkspaceWebDrm(api)).toMatchObject({ nextStage: "key-system-prerequisite-unmet" });
  });
  it("skips EME on an insecure origin and records network failure separately", async () => {
    const api = environment(); api.isSecureContext = false;
    api.fetch.mockRejectedValue(new TypeError("token=PRIVATE"));
    const result = await collectWorkspaceWebDrm(api);
    expect(api.navigator.requestMediaKeySystemAccess).not.toHaveBeenCalled();
    expect(result.publicSample).toMatchObject({ stage: "manifest-error", error: "TypeError" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("ships the same tested probe behind an explicit visible action", () => {
    expect(workspaceWebDrmProbePage()).toContain(collectWorkspaceWebDrm.toString());
    expect(workspaceWebDrmProbePage()).toContain('id="run-drm-probe"');
  });
});
