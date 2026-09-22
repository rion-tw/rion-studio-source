/** Serialized into the E2E fixture. This never returns license bytes, URLs,
 * request headers, CDM identifiers, or raw Shaka error data. */
export async function playWorkspaceWebDrm(api, video, signal, readPlatformStatus) {
  const result = { schemaVersion: 1, asset: "shaka-angel-one-widevine", state: "loading",
    licenseResponses: 0, licenseStatus: null, keySystem: null, mediaKeys: false,
    renderedFrames: 0, mediaSeconds: 0, width: 0, height: 0, audioTrack: false,
    audibleAudio: "not-tested", netflix: "not-tested", vmpProduction: "not-tested", vmpUatStatus: null, error: null };
  const player = new api.shaka.Player();
  let frameRequest;
  let terminal = false;
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const finish = state => {
    if (terminal) return;
    terminal = true; result.state = state;
    if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
    video.pause();
    complete();
  };
  const cancel = () => finish("cancelled");
  const fail = error => {
    if (terminal) return;
    result.error = { code: Number.isSafeInteger(error?.code) ? error.code : null,
      category: Number.isSafeInteger(error?.category) ? error.category : null };
    finish("failed");
  };
  player.addEventListener("error", event => fail(event.detail));
  video.addEventListener("error", fail);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    if (!terminal) {
      await player.attach(video);
      if (!terminal) {
        player.configure({ drm: { servers: { "com.widevine.alpha": "https://proxy.uat.widevine.com/proxy" },
          retryParameters: { maxAttempts: 1 } }, manifest: { retryParameters: { maxAttempts: 1 } },
          streaming: { retryParameters: { maxAttempts: 1 } } });
        player.getNetworkingEngine().registerResponseFilter((type, response) => {
          if (!terminal && type === api.shaka.net.NetworkingEngine.RequestType.LICENSE) {
            result.licenseResponses += 1;
            result.licenseStatus = Number.isInteger(response.status) ? response.status : null;
            result.vmpUatStatus = readPlatformStatus(response.data) ?? result.vmpUatStatus;
          }
        });
        await player.load("https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd");
      }
      if (!terminal) {
        result.keySystem = player.drmInfo()?.keySystem === "com.widevine.alpha" ? "com.widevine.alpha" : null;
        result.mediaKeys = video.mediaKeys !== null;
        result.audioTrack = player.getVariantTracks().some(track => track.active && Boolean(track.audioCodec));
        let firstMediaTime;
        const frame = (_now, metadata) => {
          if (terminal) return;
          firstMediaTime ??= metadata.mediaTime;
          result.renderedFrames += 1;
          result.mediaSeconds = Math.max(0, metadata.mediaTime - firstMediaTime);
          result.width = video.videoWidth; result.height = video.videoHeight;
          if (result.mediaSeconds >= 10 && result.renderedFrames >= 2 && result.width > 0 && result.height > 0 &&
              result.keySystem && result.mediaKeys && result.licenseResponses > 0) finish("played");
          else frameRequest = video.requestVideoFrameCallback(frame);
        };
        frameRequest = video.requestVideoFrameCallback(frame);
        await video.play();
      }
    }
  } catch (error) { fail(error); }
  await completed;
  signal.removeEventListener("abort", cancel);
  video.removeEventListener("error", fail);
  await player.destroy();
  return result;
}
