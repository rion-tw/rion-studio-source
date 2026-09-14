import type { BaseWindowConstructorOptions } from "electron";

import type { EmbeddedLaunchTargetRecord } from "../../shared/generated";

export function buildMacosAppKitRuntimeWindowOptions(
  target: EmbeddedLaunchTargetRecord
): BaseWindowConstructorOptions {
  return {
    title: target.persistedName ?? "",
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    minWidth: 640,
    minHeight: 480,
    useContentSize: true,
    show: false,
    frame: true,
    focusable: true,
    fullscreenable: true,
    // The Chromium compositor must clear uncovered pixels, as well as the
    // native content View. A clear color alone leaves an opaque compositor.
    transparent: true,
    backgroundColor: "#00000000"
  };
}
