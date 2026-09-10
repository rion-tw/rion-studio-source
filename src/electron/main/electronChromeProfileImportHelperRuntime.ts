import { mkdtempSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, session, WebContentsView } from "electron";

import {
  runChromeProfileImportHelperProcess,
  type ChromeProfileImportHelperProcessPort
} from "./chromeProfileImportHelperProcess";
import { electronPlatform as platform } from "./electronCoreBootstrap";
import { installChromiumSessionSecurityPolicy } from "./chromiumSecurityPolicy";

export async function runInternalChromeProfileImportHelper(): Promise<void> {
  app.setPath(
    "userData",
    mkdtempSync(join(tmpdir(), "rion-chrome-profile-import-helper-"))
  );
  const helperPort: ChromeProfileImportHelperProcessPort = {
    platform: platform(),
    sessions: {
      fromPath: (path, options) => {
        const chromiumSession = session.fromPath(path, options);
        installChromiumSessionSecurityPolicy(chromiumSession);
        return chromiumSession;
      }
    },
    views: {
      create: (options: Electron.WebContentsViewConstructorOptions) =>
        new WebContentsView(options)
    } as unknown as ChromeProfileImportHelperProcessPort["views"],
    readInheritedRequest: () => readFileSync(0),
    ready: (chromiumUserDataDir) => {
      if (process.platform === "darwin") {
        if (app.isReady()) {
          throw new Error("The helper storage root must be selected before ready.");
        }
        // Electron grants its macOS network service access under sessionData.
        // The helper's temporary userData is outside the Rust-owned role store.
        app.setPath("sessionData", chromiumUserDataDir);
      }
      return app.whenReady();
    },
    writeInheritedResponse: async (bytes) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(1, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) {
          throw new Error(
            "The inherited helper response pipe closed before acknowledgement."
          );
        }
        offset += written;
      }
    },
    exit: (code) => app.exit(code)
  };
  await runChromeProfileImportHelperProcess(helperPort);
}
