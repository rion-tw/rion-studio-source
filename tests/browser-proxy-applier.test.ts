import { describe, expect, it, vi } from "vitest";

import { BrowserProxyApplier } from "../src/main/game-browser/BrowserProxyApplier";
import { DEFAULT_BROWSER_FONT_SETTINGS } from "../src/shared/browserFonts";

describe("BrowserProxyApplier", () => {
  it("applies custom proxy settings to an Electron session", async () => {
    const session = createSession();
    const applier = new BrowserProxyApplier({
      getSettings: vi.fn().mockResolvedValue({
        fonts: DEFAULT_BROWSER_FONT_SETTINGS,
        network: {
          proxy: {
            mode: "custom",
            server: "socks5://127.0.0.1:7890"
          }
        }
      })
    });

    await applier.applyToSession(session as never);

    expect(session.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:7890"
    });
  });

  it("applies system proxy settings from the Rust-normalized domain model", async () => {
    const session = createSession();
    const applier = new BrowserProxyApplier({
      getSettings: vi.fn().mockResolvedValue({
        fonts: DEFAULT_BROWSER_FONT_SETTINGS,
        network: {
          proxy: {
            mode: "system",
            server: ""
          }
        }
      })
    });

    await applier.applyToSession(session as never);

    expect(session.setProxy).toHaveBeenCalledWith({ mode: "system" });
  });
});

function createSession() {
  return {
    setProxy: vi.fn().mockResolvedValue(undefined)
  };
}
