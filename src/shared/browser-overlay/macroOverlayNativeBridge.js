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
  bridge.macroKeyObserved = (observation) => {
    if (!nativeInvoke) {
      return Promise.reject(new Error("Rion Studio overlay IPC is unavailable."));
    }
    return nativeInvoke("rion_macro_key_event_observed", { capability, observation });
  };
  bridge.managedShortcutKeyPhase = (request) => {
    if (!nativeInvoke) {
      return Promise.reject(new Error("Rion Studio overlay IPC is unavailable."));
    }
    return nativeInvoke("rion_managed_shortcut_key_phase", { capability, request });
  };
  bridge.inputContextLost = (request) => {
    if (!nativeInvoke) return Promise.resolve({ status: "unavailable" });
    return nativeInvoke("rion_macro_input_context_lost", { capability, request });
  };
  bridge.macroBadgeTiming = (observation) => {
    if (!nativeInvoke) return Promise.resolve();
    return nativeInvoke("rion_macro_badge_timing", { capability, observation });
  };
  bridge.shortcutLifecycle = (event) => {
    if (!nativeInvoke) return Promise.resolve();
    return nativeInvoke("rion_overlay_request", {
      capability,
      payload: { ...event, type: "macro-shortcut-lifecycle" }
    });
  };
  return bridge;
})()
