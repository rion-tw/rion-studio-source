export interface ChromiumRuntimePopupZoomInput {
  readonly windowId: string;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly previousZoomFactor: number;
  readonly nextZoomFactor: number;
}

export interface ChromiumRuntimePopupZoomTransaction {
  readonly popupSurfaceCount: number;
  apply: () => void;
  /** Release the admission lease after the outer native transaction commits. */
  commit: () => void;
  rollback: () => void;
}

/** Typed port owned by the controlled popup lifecycle coordinator. */
export interface ChromiumRuntimePopupZoomPort {
  prepareWindowZoomTransaction: (
    input: ChromiumRuntimePopupZoomInput
  ) => Promise<ChromiumRuntimePopupZoomTransaction>;
}
