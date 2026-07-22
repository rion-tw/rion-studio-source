import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ChromeProfileSessionImporter,
  type ImportedChromeCookie
} from "../src/main/browser/ChromeProfileSessionImporter";

describe("ChromeProfileSessionImporter", () => {
  it("applies Rust-normalized cookies to the Electron session", async () => {
    const readCookies = vi.fn(async (): Promise<ImportedChromeCookie[]> => [{
      domain: ".example.test",
      httpOnly: true,
      name: "session",
      path: "/",
      sameSite: "lax",
      secure: true,
      url: "https://example.test/",
      value: "from-rust"
    }]);
    const session = createSession();
    const importer = new ChromeProfileSessionImporter({ readCookies });

    await importer.importSession({ id: "role-1" } as never, "/profile", session);

    expect(readCookies).toHaveBeenCalledWith("/profile");
    expect(session.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ value: "from-rust" }));
    expect(session.flushStorageData).toHaveBeenCalledOnce();
  });

  it("skips only cookies rejected by Electron for disallowed characters", async () => {
    const cookies: ImportedChromeCookie[] = ["invalid", "valid"].map((name) => ({
      httpOnly: true,
      name,
      path: "/",
      sameSite: "lax",
      secure: true,
      url: "https://example.test/",
      value: "value"
    }));
    const session = createSession(async (cookie) => {
      if (cookie.name === "invalid") {
        throw new Error(
          "Failed to set cookie - The cookie contains ASCII control characters "
          + "EXCLUDE_DISALLOWED_CHARACTER, DO_NOT_WARN, NO_EXEMPTION"
        );
      }
    });
    const importer = new ChromeProfileSessionImporter({ readCookies: async () => cookies });

    await importer.importSession({ id: "role-1" } as never, "/profile", session);

    expect(session.cookies.set).toHaveBeenCalledTimes(2);
    expect(session.flushStorageData).toHaveBeenCalledOnce();
  });

  it("propagates Rust reader and Electron storage failures", async () => {
    const readFailure = new ChromeProfileSessionImporter({
      readCookies: async () => { throw new Error("cookie decode failed"); }
    });
    const session = createSession();
    await expect(readFailure.importSession({ id: "role-1" } as never, "/profile", session))
      .rejects.toThrow("cookie decode failed");
    expect(session.cookies.set).not.toHaveBeenCalled();

    const writeFailure = new ChromeProfileSessionImporter({
      readCookies: async () => [{
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "lax",
        secure: true,
        url: "https://example.test/",
        value: "value"
      }]
    });
    const failingSession = createSession(async () => { throw new Error("disk write failed"); });
    await expect(writeFailure.importSession({ id: "role-1" } as never, "/profile", failingSession))
      .rejects.toThrow("disk write failed");
    expect(failingSession.flushStorageData).not.toHaveBeenCalled();
  });
});

function createSession(
  setCookie: (cookie: Parameters<Session["cookies"]["set"]>[0]) => Promise<void> = async () => undefined
): Session {
  return {
    cookies: { set: vi.fn(setCookie) },
    flushStorageData: vi.fn()
  } as unknown as Session;
}
