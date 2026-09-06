import type { ChromiumRuntimeSurfacePort } from "./chromiumRuntimeEffectPorts";
import type { ChromiumRuntimeSurfaceProjection } from "./chromiumRuntimeProjectionTransaction";

type ProjectionPort = Pick<ChromiumRuntimeSurfacePort,
  "readProjection" | "setZoomFactor" | "setBounds" | "setVisible">;

export interface CapturedChromiumSurfaceProjection extends ChromiumRuntimeSurfaceProjection {
  readonly generation: number;
}

/** Capture the exact generation before a host transaction can mutate ownership. */
export function captureChromiumSurfaceProjections(
  port: ProjectionPort,
  identities: Iterable<readonly [string, number]>
): ReadonlyMap<string, CapturedChromiumSurfaceProjection> {
  const snapshots = new Map<string, CapturedChromiumSurfaceProjection>();
  for (const [id, generation] of identities) {
    const current = port.readProjection(id, generation);
    snapshots.set(id, Object.freeze({
      ...current,
      bounds: Object.freeze({ ...current.bounds }),
      generation
    }));
  }
  return snapshots;
}

/** Apply only changed Chromium properties; native host commits stay with their owner. */
export function applyChromiumSurfaceProjection(
  port: ProjectionPort,
  id: string,
  generation: number,
  next: ChromiumRuntimeSurfaceProjection,
  current?: ChromiumRuntimeSurfaceProjection
): void {
  if (next.zoomFactor !== undefined && current?.zoomFactor !== next.zoomFactor) {
    port.setZoomFactor(id, generation, next.zoomFactor);
  }
  if (!current || current.bounds.x !== next.bounds.x || current.bounds.y !== next.bounds.y ||
      current.bounds.width !== next.bounds.width || current.bounds.height !== next.bounds.height) {
    port.setBounds(id, generation, next.bounds);
  }
  if (!current || current.visible !== next.visible) {
    port.setVisible(id, generation, next.visible);
  }
}

/** Best-effort restoration never substitutes a newer surface generation. */
export function restoreChromiumSurfaceProjections(
  port: ProjectionPort,
  snapshots: ReadonlyMap<string, CapturedChromiumSurfaceProjection>,
  failures: unknown[]
): void {
  for (const [id, snapshot] of snapshots) {
    for (const restore of [
      () => {
        if (snapshot.zoomFactor !== undefined) {
          port.setZoomFactor(id, snapshot.generation, snapshot.zoomFactor);
        }
      },
      () => port.setBounds(id, snapshot.generation, snapshot.bounds),
      () => port.setVisible(id, snapshot.generation, snapshot.visible)
    ]) {
      try { restore(); } catch (error) { failures.push(error); }
    }
  }
}

export interface ChromiumSurfaceReparent {
  readonly kind: "role" | "web";
  readonly id: string;
  readonly generation: number;
  readonly sourceWindowId: string;
}

type SurfacePorts = Pick<import("./chromiumRuntimeEffectPorts").ChromiumRuntimeEffectExecutorInput,
  "surfaces" | "webSurfaces">;
type Host = import("./chromiumRuntimeHostPorts").ChromiumRuntimeHostPort;

async function reparentSurface(
  ports: SurfacePorts, move: ChromiumSurfaceReparent, target: Host
): Promise<void> {
  if (move.kind === "role") {
    await ports.surfaces.reparentRole!(move.id, move.generation, target);
  } else {
    await ports.webSurfaces.reparentSurface!(move.id, move.generation, target);
  }
}

export async function applyChromiumSurfaceReparent(
  ports: SurfacePorts, move: ChromiumSurfaceReparent, target: Host,
  completed: ChromiumSurfaceReparent[]
): Promise<void> {
  await reparentSurface(ports, move, target);
  completed.push(Object.freeze({ ...move }));
}

export async function restoreChromiumSurfaceReparents(
  ports: SurfacePorts,
  windows: ReadonlyMap<string, Readonly<{ host: Host }>>,
  completed: readonly ChromiumSurfaceReparent[],
  failures: unknown[],
  sourceUnavailable: () => unknown
): Promise<void> {
  for (const move of [...completed].reverse()) {
    try {
      const source = windows.get(move.sourceWindowId);
      if (!source || source.host.isDestroyed()) throw sourceUnavailable();
      await reparentSurface(ports, move, source.host);
    } catch (error) { failures.push(error); }
  }
}
