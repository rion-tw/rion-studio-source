(() => {
  const version = "rion-runtime-indicators-1";
  if (globalThis.__rionStudioRuntimeIndicators?.version === version) return;

  try {
    if (globalThis.top !== globalThis) return;
  } catch {
    return;
  }

  const indicatorCss = "__RION_STUDIO_RUNTIME_INDICATOR_CSS__";
  const hostId = "rion-studio-runtime-indicators-v1";
  const hostStyleEntries = [
    ["all", "initial"],
    ["bottom", "auto"],
    ["display", "block"],
    ["left", "50%"],
    ["pointer-events", "none"],
    ["position", "fixed"],
    ["right", "auto"],
    ["top", "16px"],
    ["transform", "translateX(-50%)"],
    ["width", "max-content"],
    ["z-index", "2147483647"]
  ];
  let host;
  let stack;
  let resizeIndicator;
  let zoomIndicator;
  let zoomTimer;

  function ensureHost() {
    if (!host) {
      host = document.createElement("div");
      host.id = hostId;
      for (const [property, value] of hostStyleEntries) {
        host.style.setProperty(property, value, "important");
      }
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = indicatorCss;
      stack = document.createElement("div");
      stack.className = "stack";
      root.append(style, stack);
    }
    if (!host.isConnected) {
      (document.body || document.documentElement)?.append(host);
    }
    return stack;
  }

  function ensureIndicator(kind) {
    const current = kind === "resize" ? resizeIndicator : zoomIndicator;
    if (current?.isConnected) return current;
    const element = document.createElement("div");
    element.className = "indicator";
    element.dataset.kind = kind;
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    ensureHost()?.append(element);
    if (kind === "resize") resizeIndicator = element;
    else zoomIndicator = element;
    return element;
  }

  function showWorkspaceResizeIndicator(payload) {
    if (payload?.type === "hide") {
      resizeIndicator?.remove();
      resizeIndicator = undefined;
      return;
    }
    ensureIndicator("resize").textContent = String(payload?.label || "");
  }

  function showZoomIndicator(label) {
    const element = ensureIndicator("zoom");
    element.textContent = String(label || "");
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      element.remove();
      if (zoomIndicator === element) zoomIndicator = undefined;
    }, 1200);
  }

  const controller = Object.freeze({ version });
  globalThis.__rionStudioRuntimeIndicators = controller;
  globalThis.__rionStudioWorkspaceResizeIndicator = showWorkspaceResizeIndicator;
  globalThis.__rionStudioZoomIndicator = showZoomIndicator;
})();
