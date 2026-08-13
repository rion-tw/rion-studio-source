export interface WebDriverSession {
  sessionId?: string;
}

export interface WebDriverGlobalRegistry {
  get(key: "browser"): WebDriverSession | undefined;
}

export function detachTerminatedWebDriverSession(registry: WebDriverGlobalRegistry): void {
  const session = registry.get("browser");
  if (!session) throw new Error("WDIO browser session is unavailable");
  session.sessionId = undefined;
}
