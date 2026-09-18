import { useRef } from "react";

export interface RetainedEntity<Entity> {
  /** The live entity, or the one this editor opened with once it disappears. */
  readonly entity: Entity | undefined;
  /** True once a retained entity is no longer present in the live projection. */
  readonly isRemoved: boolean;
}

/**
 * Retains the entity an editor opened with so a projection push that deletes it
 * cannot unmount the form before the user is told.
 *
 * The renderer replaces its whole projection on every Core state change, so an
 * editor route that derives its entity from live props loses the user's typing
 * the instant that entity disappears. `useUnsavedChangesGuard` cannot cover
 * this: it intercepts router navigation and window close, never an unmount
 * driven by data.
 *
 * The retained value is keyed by id because editor route wrappers are not
 * keyed — navigating from one entity's editor to another reuses the same
 * component instance, so an unkeyed cache would render the previous entity for
 * an id that never existed.
 */
export function useRetainedEntity<Entity>(
  id: string | undefined,
  live: Entity | undefined
): RetainedEntity<Entity> {
  const openedWith = useRef<{ id: string; entity: Entity } | null>(null);
  if (id && live) {
    openedWith.current = { id, entity: live };
  }
  const retained = id && openedWith.current?.id === id
    ? openedWith.current.entity
    : undefined;
  const entity = live ?? retained;
  return { entity, isRemoved: Boolean(id) && !live && Boolean(retained) };
}
