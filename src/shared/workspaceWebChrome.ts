import { isWorkspaceStartUrl } from "./workspaceStartPage";
import type { AppLanguage, ResolvedTheme } from "./types";
export const WORKSPACE_WEB_CHROME_ACTION_CHANNEL =
  "rion:workspace-web-chrome:action";
export const WORKSPACE_WEB_CHROME_STATE_CHANNEL =
  "rion:workspace-web-chrome:state";
export const WORKSPACE_WEB_CHROME_SHELL_SESSION =
  "rion-web-chrome-shell:memory";

export type WorkspaceWebChromeActionType =
  | "ready"
  | "back"
  | "forward"
  | "reload"
  | "home"
  | "navigate";

export interface WorkspaceWebChromeAction {
  readonly surfaceId: string;
  readonly generation: number;
  readonly type: WorkspaceWebChromeActionType;
  readonly url?: string;
}

export interface WorkspaceWebChromeState {
  readonly language: AppLanguage;
  readonly labels: WorkspaceWebChromeLabels;
  readonly resolvedTheme: ResolvedTheme;
  readonly surfaceId: string;
  readonly generation: number;
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading?: boolean;
  readonly errorCode?: number;
  readonly statusText?: string;
}

const labelKeys = [
  "navigation", "back", "forward", "reload", "home", "address", "placeholder",
  "website", "loading", "failed", "invalid", "emptyAddress", "invalidAddress"
] as const;

export type WorkspaceWebChromeLabels = Readonly<Record<typeof labelKeys[number], string>>;

function validLabels(value: unknown): value is WorkspaceWebChromeLabels {
  return isRecord(value) && exactKeys(value, labelKeys) && labelKeys.every(key =>
    typeof value[key] === "string" && value[key].trim().length > 0 && value[key].length <= 512);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

export function canonicalWorkspaceWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || new TextEncoder().encode(trimmed).byteLength > 2_048 ||
      /\s/u.test(trimmed)) return null;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function canonicalUrlInput(value: unknown): value is string {
  return typeof value === "string" && canonicalWorkspaceWebUrl(value) === value;
}

export function parseWorkspaceWebChromeAction(
  value: unknown
): WorkspaceWebChromeAction | null {
  if (!isRecord(value)) return null;
  const navigate = value.type === "navigate";
  if (
    !exactKeys(value, navigate
      ? ["surfaceId", "generation", "type", "url"]
      : ["surfaceId", "generation", "type"]) ||
    !validIdentifier(value.surfaceId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !["ready", "back", "forward", "reload", "home", "navigate"]
      .includes(String(value.type)) ||
    (navigate && !canonicalUrlInput(value.url))
  ) return null;
  return Object.freeze({
    surfaceId: value.surfaceId,
    generation: value.generation as number,
    type: value.type as WorkspaceWebChromeActionType,
    ...(navigate ? { url: value.url as string } : {})
  });
}

export function parseWorkspaceWebChromeState(
  value: unknown
): WorkspaceWebChromeState | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "surfaceId", "generation", "url", "canGoBack", "canGoForward", "resolvedTheme", "language", "labels",
      ...("loading" in value ? ["loading"] : []),
      ...("errorCode" in value ? ["errorCode"] : []),
      ...("statusText" in value ? ["statusText"] : [])
    ]) ||
    typeof value.language !== "string" || !["en", "zh-TW", "zh-CN", "ja"].includes(value.language) ||
    !validLabels(value.labels) ||
    !validIdentifier(value.surfaceId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !(canonicalUrlInput(value.url) || (typeof value.url === "string" && isWorkspaceStartUrl(value.url))) ||
    ("loading" in value && typeof value.loading !== "boolean") ||
    ("errorCode" in value && !Number.isSafeInteger(value.errorCode)) ||
    ("statusText" in value && (typeof value.statusText !== "string" || value.statusText.length > 512)) ||
    typeof value.canGoBack !== "boolean" ||
    typeof value.canGoForward !== "boolean" ||
    (value.resolvedTheme !== "light" && value.resolvedTheme !== "dark")
  ) return null;
  return Object.freeze({
    surfaceId: value.surfaceId,
    generation: value.generation as number,
    url: value.url,
    language: value.language as AppLanguage,
    labels: Object.freeze({ ...value.labels }),
    resolvedTheme: value.resolvedTheme,
    canGoBack: value.canGoBack,
    canGoForward: value.canGoForward,
    ...(value.loading === undefined ? {} : { loading: value.loading as boolean }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as number }),
    ...(value.statusText === undefined ? {} : { statusText: value.statusText as string })
  });
}
