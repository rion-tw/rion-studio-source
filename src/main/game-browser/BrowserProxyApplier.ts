import type { Session } from "electron";

import type { GameBrowserSettings } from "../../shared/types";

export interface BrowserProxyApplierOptions {
  getSettings: () => Promise<GameBrowserSettings>;
}

export class BrowserProxyApplier {
  constructor(private readonly options: BrowserProxyApplierOptions) {}

  async applyToSession(session: Session): Promise<void> {
    const settings = await this.options.getSettings();
    const proxy = settings.network.proxy;

    if (proxy.mode === "custom") {
      await session.setProxy({
        mode: "fixed_servers",
        proxyRules: proxy.server
      });
      return;
    }

    await session.setProxy({ mode: "system" });
  }
}
