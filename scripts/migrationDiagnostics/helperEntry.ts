// Test runner entry only. It is not an Electron application bundle input.
import { readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { app, session, WebContentsView } from "electron";
import { runChromeProfileImportHelperProcess, type ChromeProfileImportHelperProcessPort } from
  "../../src/electron/main/chromeProfileImportHelperProcess";
import { installChromiumSessionSecurityPolicy } from
  "../../src/electron/main/chromiumSecurityPolicy";

import { controlledDocumentAllowed } from "./offlinePolicy";

const rootValue = process.env.RION_MIGRATION_DIAGNOSTIC_ROOT;
if (app.isPackaged || !["darwin", "win32"].includes(process.platform) ||
    process.env.RION_MIGRATION_DIAGNOSTICS !== "1" || !rootValue || !isAbsolute(rootValue)) {
  app.exit(1);
  throw new Error("DIAGNOSTIC_ENTRY_DISABLED");
}
const root = realpathSync(rootValue);
function withinRoot(path: string): void {
  const relation = relative(root, realpathSync(path));
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("DIAGNOSTIC_PATH_ESCAPE");
  }
}
app.setPath("userData", root);
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");

const port: ChromeProfileImportHelperProcessPort = {
  platform: process.platform === "darwin" ? "darwin" : "win32",
  sessions: {
    fromPath: (path, options) => {
      withinRoot(path);
      const handle = session.fromPath(path, options);
      installChromiumSessionSecurityPolicy(handle);
      const handled = new Set<string>();
      const install = handle.protocol.handle.bind(handle.protocol);
      const remove = handle.protocol.unhandle.bind(handle.protocol);
      handle.protocol.handle = (scheme, handler) => {
        install(scheme, handler);
        handled.add(scheme);
      };
      handle.protocol.unhandle = scheme => {
        handled.delete(scheme);
        remove(scheme);
      };
      handle.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !controlledDocumentAllowed(details.url, handled) });
      });
      return handle;
    }
  },
  views: { create: (options: Electron.WebContentsViewConstructorOptions) => new WebContentsView(options) } as unknown as ChromeProfileImportHelperProcessPort["views"],
  readInheritedRequest: () => readFileSync(0),
  ready: async path => {
    withinRoot(path);
    app.setPath("sessionData", path);
    await app.whenReady();
    // Do not instantiate defaultSession: it would open the same sessionData
    // directory as the explicit role session and introduce a second writer.
  },
  writeInheritedResponse: async bytes => {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(1, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("DIAGNOSTIC_RESPONSE_PIPE_CLOSED");
      offset += count;
    }
  },
  exit: code => app.exit(code)
};
// Finish ESM evaluation before awaiting Electron's ready event.
void runChromeProfileImportHelperProcess(port).catch(() => app.exit(1));
