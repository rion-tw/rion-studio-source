import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface FailureEvents {
  on(event: "uncaughtExceptionMonitor", listener: (error: Error, origin: string) => void): unknown;
  removeListener(event: "uncaughtExceptionMonitor", listener: (error: Error, origin: string) => void): unknown;
}

/** Record before Electron's default error dialog blocks automation; do not handle the failure. */
export function installMainProcessFailureObserver(
  directory: string | undefined,
  events: FailureEvents = process
): () => void {
  if (!directory || !isAbsolute(directory)) return () => undefined;
  const observe = (error: Error, origin: string): void => {
    writeFileSync(join(directory, "electron-uncaught-main-error.json"), JSON.stringify({
      origin, name: error.name, message: error.message, stack: error.stack
    }, null, 2));
  };
  events.on("uncaughtExceptionMonitor", observe);
  return () => { events.removeListener("uncaughtExceptionMonitor", observe); };
}
