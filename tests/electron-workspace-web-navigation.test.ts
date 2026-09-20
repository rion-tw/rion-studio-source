import { describe, expect, it, vi } from "vitest";
import { ChromiumWorkspaceWebNavigation } from "../src/electron/main/chromiumWorkspaceWebNavigation";
import type { ChromiumRoleSurfaceWebContentsPort } from "../src/electron/main/chromiumRoleSurfacePorts";

function harness() {
  let url = "https://fixture.test/start";
  const failed = vi.fn();
  const changed = vi.fn();
  const navigation = new ChromiumWorkspaceWebNavigation(
    { getURL: () => url } as ChromiumRoleSurfaceWebContentsPort, changed, failed
  );
  return { navigation, failed, changed, setUrl: (next: string) => { url = next; } };
}

describe.each(["darwin", "win32"])("Workspace Web event-bound navigation on %s", () => {
  it.each(["document", "same-document"])("settles a %s commit without a finish-load event", async () => {
    const { navigation, setUrl } = harness();
    const finished = vi.fn();
    const completion = navigation.run(() => undefined).then(finished);
    navigation.started("https://fixture.test/start#next");
    setUrl("https://fixture.test/start#next");
    expect(navigation.committed("https://fixture.test/start#next")).toBe(true);
    await completion;
    expect(finished).toHaveBeenCalledOnce();
    // Navigation committed; the separate load indicator remains event driven.
    expect(navigation.loading).toBe(true);
    navigation.finished();
    expect(navigation.loading).toBe(false);
  });

  it("supersedes a slow page, ignores its late failure/commit, and allows home", async () => {
    const { navigation, setUrl, failed } = harness();
    let rejectOld!: (error: unknown) => void;
    const old = navigation.run(() => new Promise<void>((_, reject) => { rejectOld = reject; }), "https://slow.test/");
    const cancelled = expect(old).rejects.toMatchObject({ code: "ELECTRON_GLOBAL_WEB_NAVIGATION_SUPERSEDED" });
    const home = navigation.run(() => undefined, "rion-start://home/");
    await cancelled;
    rejectOld({ errorCode: -105 });
    navigation.fail(-105, "https://slow.test/", "did-fail-load");
    setUrl("https://slow.test/");
    expect(navigation.committed("https://slow.test/")).toBe(false);
    navigation.started("rion-start://home/");
    setUrl("rion-start://home/");
    expect(navigation.committed("rion-start://home/")).toBe(true);
    await home;
    expect(failed).not.toHaveBeenCalled();
  });

  it("classifies abort as cancellation and allows the next navigation", async () => {
    const { navigation, failed } = harness();
    const cancelled = expect(navigation.run(() => undefined, "https://fixture.test/")).rejects
      .toMatchObject({ code: "ELECTRON_GLOBAL_WEB_NAVIGATION_CANCELLED" });
    navigation.started("https://fixture.test/");
    navigation.fail(-3, "https://fixture.test/", "did-fail-provisional-load");
    await cancelled;
    expect(navigation.errorCode).toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports real failure once, then clears it on a new navigation", async () => {
    const { navigation, failed } = harness();
    const failedLoad = expect(navigation.run(() => undefined, "https://offline.test/")).rejects
      .toMatchObject({ code: "ELECTRON_GLOBAL_WEB_NAVIGATION_FAILED" });
    navigation.started("https://offline.test/");
    navigation.fail(-105, "https://offline.test/", "did-fail-load");
    navigation.fail(-105, "https://offline.test/", "network");
    await failedLoad;
    expect(navigation.errorCode).toBe(-105);
    expect(failed).toHaveBeenCalledOnce();
    navigation.started("https://fixture.test/");
    expect(navigation.errorCode).toBeUndefined();
  });

  it("terminalizes destruction and a crashed renderer without elapsed-time evidence", async () => {
    const { navigation } = harness();
    const destroyed = expect(navigation.run(() => undefined)).rejects
      .toMatchObject({ code: "ELECTRON_GLOBAL_WEB_NAVIGATION_DESTROYED" });
    navigation.cancel("DESTROYED");
    await destroyed;
    const crashed = expect(navigation.run(() => undefined, "https://next.test/")).rejects
      .toMatchObject({ code: "ELECTRON_GLOBAL_WEB_NAVIGATION_FAILED" });
    navigation.fail(0, "https://fixture.test/start", "render-process-gone");
    await crashed;
  });

  it("does not let the prior document's same-URL events settle a new intent before its start", async () => {
    const { navigation, failed } = harness();
    const url = "https://fixture.test/start";
    const completion = navigation.run(() => undefined, url);
    navigation.fail(-3, url, "did-fail-provisional-load");
    navigation.fail(-105, url, "did-fail-load");
    expect(navigation.committed(url)).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    navigation.started(url);
    expect(navigation.committed(url)).toBe(true);
    await completion;
  });

  it("accepts a website history API commit without a new document load", () => {
    const { navigation, setUrl } = harness();
    navigation.started("https://fixture.test/start");
    expect(navigation.committed("https://fixture.test/start")).toBe(true);
    setUrl("https://fixture.test/start#two");
    expect(navigation.committed("https://fixture.test/start#two")).toBe(true);
    expect(navigation.url).toBe("https://fixture.test/start#two");
  });
});
