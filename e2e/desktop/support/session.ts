export interface WebDriverSession {
  sessionId?: string;
}

export function detachTerminatedWebDriverSession(session: WebDriverSession): void {
  session.sessionId = undefined;
}
