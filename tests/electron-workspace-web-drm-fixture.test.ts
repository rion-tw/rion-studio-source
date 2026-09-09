import { beforeEach, describe, expect, it, vi } from "vitest";
const { fetch } = vi.hoisted(() => ({ fetch: vi.fn(async () => new Response("ok")) }));
vi.mock("electron", () => ({ net: { fetch } }));
import { installWorkspaceWebDrmFixture } from "../src/electron/e2e/workspaceWebDrmFixture";
import { parseElectronDesktopE2eWorkspaceWebSecurityPolicyInspection as parse }
  from "../src/electron/e2e/workspaceWebSecurityPolicyInspection";

beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("RION_STUDIO_E2E_FIXTURE_ORIGIN", "http://127.0.0.1:41739");
  vi.stubEnv("RION_STUDIO_E2E_SESSION_TOKEN", "fixture-token");
});

describe.each(["darwin", "win32"] as const)("DRM E2E evidence on %s", (platform) => {
  it("maps only the reserved HTTPS fixture and preserves POST requests", async () => {
    const handle = vi.fn();
    const session = { protocol: { handle } };
    installWorkspaceWebDrmFixture(session as never);
    installWorkspaceWebDrmFixture(session as never);
    expect(handle).toHaveBeenCalledOnce();
    const handler = handle.mock.calls[0]![1];
    await handler(new Request("https://rion-drm.fixture.test/api/event", {
      method: "POST", body: "fixture-body", keepalive: true,
      headers: { host: "rion-drm.fixture.test" }
    }));
    const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe("http://127.0.0.1:41739/api/event");
    expect(await new Response(init.body).text()).toBe("fixture-body");
    expect(new Headers(init.headers).get("host")).toBe("127.0.0.1:41739");
    const remote = new Request("https://www.iq.com/");
    await handler(remote);
    expect(fetch).toHaveBeenLastCalledWith(remote, { bypassCustomProtocolHandlers: true });
  });

  it("rejects non-local fixture transports", () => {
    vi.stubEnv("RION_STUDIO_E2E_FIXTURE_ORIGIN", "https://www.iq.com");
    expect(() => installWorkspaceWebDrmFixture({ protocol: { handle: vi.fn() } } as never))
      .toThrow("authenticated local E2E server");
  });

  it("parses versioned DRM evidence and rejects inconsistent success", () => {
    const path = platform === "darwin" ? "/web/chromium" : "C:\\web\\chromium";
    const decision = {
      allowed: true, kind: "drm-permission", stage: "check", permission: "mediaKeySystem",
      origin: "https://iq.com", embeddingOrigin: "https://iq.com",
      reason: "https-web-app", sequence: 1
    };
    const inspection = {
      contentProfilePath: path, sessionStoragePath: path, generation: 1,
      observations: [decision], policyVersion: 2, surfaceId: "web-1",
      windowId: "00000000-0000-4000-8000-000000000001"
    };
    expect(parse(inspection)).toEqual(inspection);
    expect(() => parse({ ...inspection, policyVersion: 1 })).toThrow();
    expect(() => parse({ ...inspection, observations: [{ ...decision,
      origin: "http://iq.com" }] })).toThrow();
    expect(() => parse({ ...inspection, observations: [{ ...decision,
      reason: "drm-disabled" }] })).toThrow();
    expect(parse({ ...inspection, observations: [{ ...decision, allowed: false,
      origin: "null", reason: "invalid-requesting-origin" }] })).toBeDefined();
  });
});
