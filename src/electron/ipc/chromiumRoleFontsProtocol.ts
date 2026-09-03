import type { BrowserFontRuntimePayloadRecord } from "../../shared/generated";

export const CHROMIUM_ROLE_FONTS_CHANNEL = "rion:chromium-role-fonts:v1";
export const CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL =
  "rion:chromium-role-fonts-refresh:v1";
export const CHROMIUM_ROLE_FONTS_RUNTIME_VERSION = 7;

export type ChromiumRoleFontsMethod = "payload" | "receipt" | "failure";

export interface ChromiumRoleFontsEnvelope {
  readonly frameToken: string;
  readonly method: ChromiumRoleFontsMethod;
  readonly payload: unknown;
}

export interface ChromiumRoleFontsPayloadRequest {
  readonly refreshId: string | null;
}

export interface ChromiumRoleFontsPayloadResponse {
  readonly applicationId: string;
  readonly frameToken: string;
  readonly generation: number;
  readonly payload: BrowserFontRuntimePayloadRecord;
  readonly payloadRevision: number;
  readonly refreshId: string | null;
  readonly roleId: string;
}

export interface ChromiumRoleFontsRefreshControl {
  readonly frameToken: string;
  readonly generation: number;
  readonly refreshId: string;
  readonly roleId: string;
}

export interface ChromiumRoleFontsRefreshSubmissionReceipt
  extends ChromiumRoleFontsRefreshControl {
  readonly status: "submitted";
}

export interface ChromiumRoleFontsApplicationEvidence {
  readonly canvasFontsActive: boolean;
  readonly canvasTextQualityActive: boolean;
  readonly failedFaceCount: number;
  readonly fontMode: "default" | "custom";
  readonly fontSmoothingEnabled: boolean;
  readonly loadedCatalogIds: readonly string[];
  readonly loadedFaceCount: number;
  readonly runtimeVersion: 7;
  readonly sequence: number;
  readonly status: "applied";
  readonly styleInstalled: boolean;
}

export interface ChromiumRoleFontsReceiptPayload {
  readonly applicationId: string;
  readonly evidence: ChromiumRoleFontsApplicationEvidence;
  readonly payloadRevision: number;
  readonly refreshId: string | null;
  readonly status: "applied";
}

export interface ChromiumRoleFontsFailurePayload {
  readonly code: string;
  readonly refreshId: string | null;
  readonly status: "failed";
}
