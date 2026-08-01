fn validate_local_storage_sync_contract(
    origin: &str,
    keys: &[String],
    selectors: &[String],
    codec: Option<&str>,
) -> RuntimeResult<()> {
    let parsed = checked_web_url(origin)?;
    if parsed.origin().ascii_serialization() != origin
        || (keys.is_empty() && selectors.is_empty() && codec.is_none())
        || keys.len() + selectors.len() > 32
        || keys.iter().collect::<HashSet<_>>().len() != keys.len()
        || keys
            .iter()
            .any(|key| key.is_empty() || key.len() > 256 || key.trim() != key)
    {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_CONTRACT_INVALID",
            "The localStorage synchronization contract is invalid.",
        ));
    }
    if !matches!(codec, None | Some("flyff-client-settings-v7"))
        || (!selectors.is_empty() && codec != Some("flyff-client-settings-v7"))
    {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_CONTRACT_INVALID",
            "The localStorage synchronization codec is invalid.",
        ));
    }
    validate_flyff_selectors(selectors)?;
    if codec == Some("flyff-client-settings-v7")
        && keys
            .iter()
            .any(|key| matches!(key.as_str(), FLYFF_SETTINGS_KEY | FLYFF_SESSIONS_KEY))
    {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_CONTRACT_INVALID",
            "Flyff settings and session identity cannot be synchronized as whole values.",
        ));
    }
    Ok(())
}

fn local_storage_sync_observer_script(config: &LocalStorageRuntimeConfig) -> RuntimeResult<String> {
    validate_local_storage_sync_contract(
        &config.origin,
        &config.keys,
        &config.selectors,
        config.codec.as_deref(),
    )?;
    let token = serde_json::to_string(&config.token).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let origin = serde_json::to_string(&config.origin).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let keys = serde_json::to_string(&config.keys).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let selectors = serde_json::to_string(&config.selectors).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization selectors could not be encoded.",
        )
    })?;
    let flyff_codec =
        flyff_local_storage_codec_script(&config.selectors, config.codec.as_deref())?;
    let is_source = config.source_role_id.is_none();
    let generation = config.generation;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || globalThis.__rionLocalStorageSyncObserver) return;
  {flyff_codec}
  const state = {{ token: {token}, origin: {origin}, keys: {keys}, selectors: {selectors}, generation: {generation}, disabled: false, identityStatus: null, inFlight: null, lastError: null, nextSequence: 1, previous: null, queued: null, timer: 0 }};
  const capture = () => {{
    const identityStatus = repairFlyffIdentity(state.selectors);
    let diagnosticCode = identityStatus === "repaired" ? "FLYFF_IDENTITY_REPAIRED"
      : identityStatus === "session-missing" ? "FLYFF_SESSION_MISSING"
      : identityStatus === "session-invalid" ? "FLYFF_SESSION_INVALID"
      : identityStatus === "session-ambiguous" ? "FLYFF_SESSION_AMBIGUOUS"
      : identityStatus === "settings-invalid" ? "FLYFF_SETTINGS_INVALID" : null;
    if (state.identityStatus === identityStatus) diagnosticCode = null;
    state.identityStatus = identityStatus;
    let selectorEntries = captureFlyffFields(state.selectors);
    if (selectorEntries === null) {{
      diagnosticCode = "FLYFF_SETTINGS_INVALID";
      selectorEntries = state.selectors.map((selector) => [selector, null]);
    }}
    return {{ diagnosticCode, entries: state.keys.map((key) => [key, localStorage.getItem(key)]), selectorEntries }};
  }};
  function schedule() {{
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(publish, 100);
  }}
  function dispatch(item) {{
    if (item.generation !== state.generation) return;
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {{
      state.queued = item;
      schedule();
      return;
    }}
    const request = {{ ...item, sequence: state.nextSequence++, token: state.token }};
    state.inFlight = request;
    void internals.invoke("rion_local_storage_sync_changed", {{ request: {{
      token: request.token,
      generation: request.generation,
      sequence: request.sequence,
      entries: request.entries,
      selectorEntries: request.selectorEntries,
      diagnosticCode: request.diagnosticCode
    }} }}).then(
      () => {{
        if (request.generation === state.generation) {{
          state.lastError = request.diagnosticCode;
          state.previous = request.serialized;
        }}
      }},
      (error) => {{
        if (request.generation === state.generation) state.lastError = String(error);
      }}
    ).then(() => {{
      if (state.inFlight !== request) return;
      state.inFlight = null;
      if (request.generation !== state.generation) {{
        schedule();
        return;
      }}
      const queued = state.queued;
      state.queued = null;
      if (queued && queued.serialized !== state.previous) dispatch(queued);
      else schedule();
    }});
  }}
  function publish() {{
    state.timer = 0;
    if (location.origin !== state.origin) return;
    const captured = capture();
    if (!captured) return;
    const serialized = JSON.stringify(captured);
    const item = {{ ...captured, generation: state.generation, serialized }};
    if (state.inFlight) {{
      state.queued = serialized === state.inFlight.serialized ? null : item;
      return;
    }}
    if (serialized === state.previous) return;
    dispatch(item);
  }}
  for (const name of ["storage", "pageshow", "visibilitychange"]) addEventListener(name, schedule, true);
  setInterval(schedule, 250);
  if ({is_source}) {{
    const storagePrototype = globalThis.Storage?.prototype;
    if (storagePrototype) {{
      const setItem = storagePrototype.setItem;
      const removeItem = storagePrototype.removeItem;
      const clear = storagePrototype.clear;
      storagePrototype.setItem = function (key, value) {{
        const result = setItem.call(this, key, value);
        if (this === localStorage) publish();
        return result;
      }};
      storagePrototype.removeItem = function (key) {{
        const result = removeItem.call(this, key);
        if (this === localStorage) publish();
        return result;
      }};
      storagePrototype.clear = function () {{
        const result = clear.call(this);
        if (this === localStorage) publish();
        return result;
      }};
    }}
  }}
  globalThis.__rionLocalStorageSyncObserver = Object.freeze({{
    configure(next) {{
      if (!next || (next.token !== state.token && !state.disabled)) return false;
      state.token = next.token;
      state.origin = next.origin;
      state.keys = [...next.keys];
      state.selectors = [...next.selectors];
      state.generation = next.generation;
      state.disabled = false;
      state.nextSequence = 1;
      state.queued = null;
      state.previous = null;
      state.identityStatus = null;
      schedule();
      return true;
    }},
    disable(expectedToken) {{
      if (expectedToken !== state.token) return false;
      if (state.timer) clearTimeout(state.timer);
      state.timer = 0;
      state.generation += 1;
      state.disabled = true;
      state.origin = "null";
      state.keys = [];
      state.selectors = [];
      state.queued = null;
      state.previous = null;
      state.identityStatus = "disabled";
      return true;
    }},
    snapshot() {{ return {{ hasPrevious: state.previous !== null, identityStatus: state.identityStatus, lastError: state.lastError, pending: state.inFlight !== null || state.queued !== null }}; }}
  }});
  schedule();
}})();"#,
    ))
}
