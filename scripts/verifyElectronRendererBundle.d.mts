export interface ElectronRendererSource {
  path: string;
  source: Buffer | string;
}

export interface ElectronRendererBundleVerification {
  entryCount: number;
  rendererRoot: string;
  sourceBytes: number;
  sourceCount: number;
}

export const ELECTRON_RENDERER_DOCUMENTS: readonly string[];
export const TAURI_COMPATIBILITY_RENDERER_DOCUMENTS: readonly string[];
export const FORBIDDEN_ELECTRON_RENDERER_MARKERS: readonly string[];

export function assertElectronRendererSources(
  sources: readonly ElectronRendererSource[]
): void;

export function verifyElectronRendererBundle(
  rendererRoot?: string
): Promise<ElectronRendererBundleVerification>;
