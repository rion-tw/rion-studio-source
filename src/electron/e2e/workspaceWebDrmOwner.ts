/** Read-only diagnostic ownership independent of the single-Role geometry
 * journal. It never records a mixed fixture as paired-workspace evidence. */
export function resolveWorkspaceWebDrmOwner(
  windowId: string,
  tabs: readonly { windowId: string; id: string; webSurfaces: readonly { surfaceId: string; slotId: string }[] }[],
  surfaces: readonly { windowId: string; tabId: string; surfaceId: string; slotId: string; generation: number }[],
  owners: ReadonlyMap<string, { slotId: string; generation: number;
    registry: { runtimeEvidence(id: string, generation: number): { contentProfilePath: string } } }>
): { windowId: string; web: { surfaceId: string; generation: number; contentProfilePath: string } } {
  const matchingTabs = tabs.filter(tab => tab.windowId === windowId && tab.webSurfaces.length > 0);
  const native = surfaces.filter(surface => surface.windowId === windowId);
  const identity = matchingTabs[0]?.webSurfaces[0];
  const surface = native[0];
  const owner = identity && owners.get(identity.surfaceId);
  if (matchingTabs.length !== 1 || matchingTabs[0]!.webSurfaces.length !== 1 || native.length !== 1 ||
      !identity || !surface || !owner || surface.tabId !== matchingTabs[0]!.id ||
      surface.surfaceId !== identity.surfaceId || surface.slotId !== identity.slotId ||
      owner.slotId !== identity.slotId || owner.generation !== surface.generation) {
    throw new Error("DRM probe lost its exact Core/native Web surface owner");
  }
  return { windowId, web: { surfaceId: identity.surfaceId, generation: owner.generation,
    contentProfilePath: owner.registry.runtimeEvidence(identity.surfaceId, owner.generation).contentProfilePath } };
}
