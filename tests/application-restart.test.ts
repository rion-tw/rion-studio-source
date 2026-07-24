import { describe, expect, it, vi } from "vitest";

import {
  DEVELOPMENT_RESTART_ERROR,
  restartApplication
} from "../src/main/applicationRestart";

describe("application restart", () => {
  it.each(["darwin", "win32"] as const)(
    "uses Electron relaunch for a built renderer on %s",
    () => {
      const application = {
        exit: vi.fn(),
        relaunch: vi.fn()
      };

      restartApplication(application, undefined);

      expect(application.relaunch).toHaveBeenCalledOnce();
      expect(application.exit).toHaveBeenCalledWith(0);
    }
  );

  it.each(["darwin", "win32"] as const)(
    "keeps the current app open when the renderer development server owns the lifecycle on %s",
    () => {
      const application = {
        exit: vi.fn(),
        relaunch: vi.fn()
      };

      expect(() => restartApplication(application, "http://localhost:5173/"))
        .toThrow(DEVELOPMENT_RESTART_ERROR);
      expect(application.relaunch).not.toHaveBeenCalled();
      expect(application.exit).not.toHaveBeenCalled();
    }
  );
});
