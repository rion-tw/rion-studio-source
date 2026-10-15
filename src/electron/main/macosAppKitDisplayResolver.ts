import { projectElectronDisplay, type ElectronDisplayDescriptor } from "./appSnapshotProjection";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { MacosAppKitDisplayResolverPort } from "./macosAppKitRuntimePorts";

interface NativeDisplaySource {
  getDisplayMatching(bounds: ChromiumRoleSurfaceBounds): ElectronDisplayDescriptor;
  getPrimaryDisplay(): Readonly<{ id: number }>;
}

/** Match and normalize the current native display, without saved metadata or a cache. */
export function appKitDisplays(source: NativeDisplaySource): MacosAppKitDisplayResolverPort {
  return Object.freeze({
    displayMatching: (bounds: ChromiumRoleSurfaceBounds) => projectElectronDisplay(
      source.getDisplayMatching(bounds), source.getPrimaryDisplay().id
    )
  });
}
