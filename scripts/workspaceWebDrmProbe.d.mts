export interface WorkspaceWebDrmApi {
  isSecureContext: boolean;
  navigator: { requestMediaKeySystemAccess(key: string, configurations: unknown[]): Promise<{ createMediaKeys(): Promise<unknown> }> };
  document: { createElement(tag: string): { canPlayType(type: string): string } };
  MediaSource?: { isTypeSupported(type: string): boolean };
  fetch(url: string, options: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}
export interface WorkspaceWebDrmEvidence {
  schemaVersion: 1;
  secureContext: boolean;
  emeAvailable: boolean;
  formats: Record<string, { canPlayType: string; mediaSource: boolean }>;
  requests: { id: string; access: string; mediaKeys: string }[];
  publicSample: { asset: string; stage: string; status?: number; widevineSignaled?: boolean; error?: string };
  license: "not-attempted";
  decoding: "not-attempted";
  netflix: "not-tested";
  nextStage: "public-encrypted-playback-required" | "key-system-prerequisite-unmet";
}
export function collectWorkspaceWebDrm(api: WorkspaceWebDrmApi): Promise<WorkspaceWebDrmEvidence>;
export function workspaceWebDrmProbePage(): string;
