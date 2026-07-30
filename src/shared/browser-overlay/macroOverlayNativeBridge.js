(() => {
  const capability = "__RION_STUDIO_MACRO_OVERLAY_CAPABILITY__";
  const internals = globalThis.__TAURI_INTERNALS__;
  const nativeInvoke = typeof internals?.invoke === "function"
    ? internals.invoke.bind(internals)
    : undefined;

  const bridge = (payload) => {
    if (!nativeInvoke) {
      return Promise.reject(new Error("Rion Studio overlay IPC is unavailable."));
    }
    return nativeInvoke("rion_overlay_request", { capability, payload });
  };
  bridge.ready = () => {
    if (!nativeInvoke) return Promise.resolve();
    return nativeInvoke("rion_overlay_ready", { capability });
  };
  return bridge;
})()
