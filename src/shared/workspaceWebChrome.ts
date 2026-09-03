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
  readonly surfaceId: string;
  readonly generation: number;
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
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
  if (!trimmed || /\s/u.test(trimmed)) return null;
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
      "surfaceId", "generation", "url", "canGoBack", "canGoForward"
    ]) ||
    !validIdentifier(value.surfaceId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !canonicalUrlInput(value.url) ||
    typeof value.canGoBack !== "boolean" ||
    typeof value.canGoForward !== "boolean"
  ) return null;
  return Object.freeze({
    surfaceId: value.surfaceId,
    generation: value.generation as number,
    url: value.url,
    canGoBack: value.canGoBack,
    canGoForward: value.canGoForward
  });
}
