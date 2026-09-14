import type { ChromiumWebContentsViewFactoryPort, ChromiumRoleWebContentsViewPort } from "./chromiumRoleSurfacePorts";

/** Set native transparency before attachment or navigation; page paint stays intact. */
export function createTransparentRuntimeView(
  factory: ChromiumWebContentsViewFactoryPort,
  options: Parameters<ChromiumWebContentsViewFactoryPort["create"]>[0]
): ChromiumRoleWebContentsViewPort {
  const view = factory.create(options);
  try {
    view.setBackgroundColor("#00000000");
    return view;
  } catch (error) {
    try { view.webContents.close({ waitForBeforeUnload: false }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Transparent runtime view initialization and cleanup failed", { cause: cleanup }); }
    throw error;
  }
}
