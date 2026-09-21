/** Browser-only capability probe. Returns fixed fields, never exception messages,
 * URLs, keys, license bodies, headers, device identifiers or credentials. */
export async function collectWorkspaceWebDrm(api) {
  const errorName = error => ["NotSupportedError", "NotAllowedError", "SecurityError",
    "InvalidStateError", "TypeError", "AbortError"].includes(error?.name) ? error.name : "OtherError";
  const formats = {
    avc: 'video/mp4; codecs="avc1.42E01E"',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    vp9: 'video/webm; codecs="vp9"',
    opus: 'audio/webm; codecs="opus"'
  };
  const result = { schemaVersion: 1, secureContext: api.isSecureContext,
    emeAvailable: typeof api.navigator.requestMediaKeySystemAccess === "function",
    formats: {}, requests: [], publicSample: { asset: "shaka-angel-one-widevine", stage: "not-requested" },
    license: "not-attempted", decoding: "not-attempted", netflix: "not-tested" };
  for (const [name, type] of Object.entries(formats)) {
    result.formats[name] = { canPlayType: api.document.createElement("video").canPlayType(type),
      mediaSource: api.MediaSource?.isTypeSupported(type) ?? false };
  }
  const cases = [
    ["widevine-minimal", "com.widevine.alpha", {}],
    ["widevine-avc", "com.widevine.alpha", { initDataTypes: ["cenc"],
      videoCapabilities: [{ contentType: formats.avc }] }],
    ["widevine-avc-aac", "com.widevine.alpha", { initDataTypes: ["cenc"],
      videoCapabilities: [{ contentType: formats.avc }], audioCapabilities: [{ contentType: formats.aac }] }],
    ["widevine-vp9-opus", "com.widevine.alpha", { initDataTypes: ["webm"],
      videoCapabilities: [{ contentType: formats.vp9 }], audioCapabilities: [{ contentType: formats.opus }] }],
    ["clearkey-control", "org.w3.clearkey", { initDataTypes: ["cenc"],
      videoCapabilities: [{ contentType: formats.avc }] }]
  ];
  if (result.emeAvailable && result.secureContext) {
    for (const [id, keySystem, configuration] of cases) {
      const entry = { id, access: "not-attempted", mediaKeys: "not-attempted" };
      result.requests.push(entry);
      try {
        const access = await api.navigator.requestMediaKeySystemAccess(keySystem, [{
          distinctiveIdentifier: "optional", persistentState: "optional", sessionTypes: ["temporary"],
          ...configuration
        }]);
        entry.access = "granted";
        try { await access.createMediaKeys(); entry.mediaKeys = "created"; }
        catch (error) { entry.mediaKeys = errorName(error); }
      } catch (error) { entry.access = errorName(error); }
    }
  }
  // This is the public Shaka project's test asset, not a Netflix title. Fetch
  // only its manifest, with no credentials; never log the response or PSSH.
  try {
    const response = await api.fetch("https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd",
      { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    result.publicSample = { asset: "shaka-angel-one-widevine", stage: "manifest-response", status: response.status,
      widevineSignaled: response.ok && (await response.text()).toLowerCase().includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed") };
  } catch (error) { result.publicSample = { asset: "shaka-angel-one-widevine", stage: "manifest-error", error: errorName(error) }; }
  result.nextStage = result.requests.some(entry => entry.id.startsWith("widevine-") && entry.mediaKeys === "created")
    ? "public-encrypted-playback-required" : "key-system-prerequisite-unmet";
  return result;
}

export function workspaceWebDrmProbePage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Workspace DRM capability probe</title>
    <body><h1>Workspace DRM capability probe</h1><p>Capability advertisements are not playback evidence.</p>
    <button id="run-drm-probe">Run capability probe</button><pre id="drm-result" data-state="idle"></pre>
    <script>const collect = ${collectWorkspaceWebDrm.toString()};
    document.querySelector('#run-drm-probe').addEventListener('click', async event => {
      const output = document.querySelector('#drm-result');
      output.dataset.state = 'running'; event.currentTarget.disabled = true;
      const result = await collect(globalThis); result.trustedClick = event.isTrusted;
      output.textContent = JSON.stringify(result, null, 2); output.dataset.state = 'complete';
    });</script></body></html>`;
}
