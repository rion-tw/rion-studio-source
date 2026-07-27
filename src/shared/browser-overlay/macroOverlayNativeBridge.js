(() => {
  const version = "rion-tauri-overlay-1";
  if (globalThis.__rionStudioNativeOverlayBridge?.version === version) return;
  const invoke = (payload) => {
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("Rion Studio overlay IPC is unavailable."));
    }
    return internals.invoke("rion_overlay_request", { payload });
  };
  globalThis.__rionStudioNativeOverlayBridge = Object.freeze({ version });
  Object.defineProperty(globalThis, "rionStudioMacroOverlay", {
    configurable: true,
    value: invoke
  });
})();
