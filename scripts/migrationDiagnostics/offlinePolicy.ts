// Only requests served by the currently installed local protocol handler may pass.
export function controlledDocumentAllowed(url: string, handled: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && handled.has(parsed.protocol.slice(0, -1)) &&
      parsed.pathname === "/.__rion_session_migration__" && !parsed.search && !parsed.hash &&
      !parsed.username && !parsed.password;
  } catch { return false; }
}
