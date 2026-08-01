import { useCallback, useEffect, useState } from "react";

import type { BrowserProxySettings } from "../../../../shared/types";

const DEFAULT_BROWSER_PROXY_SETTINGS: BrowserProxySettings = {
  mode: "system"
};

interface UseBrowserProxySettingsOptions {
  enabled: boolean;
  onError: (error: unknown) => void;
}

export function useBrowserProxySettings({
  enabled,
  onError
}: UseBrowserProxySettingsOptions) {
  const [browserProxySettings, setBrowserProxySettings] =
    useState<BrowserProxySettings>(DEFAULT_BROWSER_PROXY_SETTINGS);

  useEffect(() => {
    if (!enabled || !window.rionStudio) return;
    let disposed = false;
    void window.rionStudio
      .getBrowserProxySettings()
      .then((settings) => {
        if (!disposed) setBrowserProxySettings(settings);
      })
      .catch(onError);
    return () => {
      disposed = true;
    };
  }, [enabled, onError]);

  const onBrowserProxySettingsChange = useCallback(
    async (settings: BrowserProxySettings): Promise<BrowserProxySettings> => {
      if (!window.rionStudio) {
        throw new Error(
          "Rion Studio desktop bridge is unavailable. Restart the app after rebuilding."
        );
      }
      const updated = await window.rionStudio.updateBrowserProxySettings(settings);
      setBrowserProxySettings(updated);
      return updated;
    },
    []
  );

  return { browserProxySettings, onBrowserProxySettingsChange };
}
