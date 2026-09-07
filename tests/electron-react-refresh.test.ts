import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { electronReactRefresh } from "../scripts/electronReactRefresh.mjs";
import { buildMainRendererContentSecurityPolicy } from "../src/electron/main/security";

describe("Electron development React startup", () => {
  it("serves the Vite React preamble externally under the strict script policy", async () => {
    const server = await createServer({
      configFile: false,
      plugins: [react(), electronReactRefresh()],
      server: { middlewareMode: true, hmr: { port: 0 } },
      appType: "custom"
    });
    try {
      const html = await server.transformIndexHtml("/", "<html><head></head><body></body></html>");
      expect(html).toContain('src="/@rion-react-refresh-preamble"');
      const preamble = await server.transformRequest("/@rion-react-refresh-preamble");
      expect(preamble?.code).toContain("injectIntoGlobalHook(window)");
      expect(preamble?.code).toContain('from "/@react-refresh"');
      expect(html).not.toMatch(/<script type="module">/);
    } finally {
      await server.close();
    }
    expect(buildMainRendererContentSecurityPolicy("http://127.0.0.1:5173"))
      .toContain("script-src 'self';");
  });
});
