import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPath = join(
  repositoryRoot,
  "build",
  "native",
  `${process.platform}-${process.arch}`,
  "rion-core.node"
);
const addonPath = process.argv[2] ? resolve(repositoryRoot, process.argv[2]) : defaultPath;
await access(addonPath);
const require = createRequire(import.meta.url);
const addon = require(addonPath);
if (typeof addon.createAppCore !== "function" || typeof addon.coreVersion !== "function") {
  throw new Error("Rust core addon does not expose the required Node-API surface.");
}
const version = addon.coreVersion();
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(`Rust core addon returned an invalid version: ${JSON.stringify(version)}.`);
}
const userDataDir = await mkdtemp(join(tmpdir(), "rion-core-verify-"));
try {
  const core = await addon.createAppCore({
    appVersion: "addon-verification",
    platform: process.platform === "win32" ? "win32" : "darwin",
    userDataDir
  });
  const health = JSON.parse(await core.invoke(JSON.stringify({ type: "health" })));
  if (
    health.coreVersion !== version ||
    typeof core.subscribeCoreEvents !== "function" ||
    typeof core.connectExternalChromeCdp !== "function" ||
    typeof core.launchExternalChrome !== "function" ||
    typeof core.prepareExternalChromeProfile !== "function"
  ) {
    throw new Error("Rust core addon failed its create/invoke integration check.");
  }
  const child = core.launchExternalChrome(process.execPath, ["-e", "process.exit(7)"]);
  if (!Number.isSafeInteger(child.pid()) || child.pid() <= 0) {
    throw new Error("Rust process supervisor returned an invalid process id.");
  }
  const exit = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(
      () => rejectExit(new Error("Rust process supervisor did not report exit.")),
      5_000
    );
    child.subscribeExit((eventJson) => {
      clearTimeout(timeout);
      resolveExit(JSON.parse(eventJson));
    });
  });
  if (exit.exitCode !== 7 || exit.terminated !== false) {
    throw new Error(`Rust process supervisor returned an invalid exit: ${JSON.stringify(exit)}.`);
  }
  const launchUrl = "https://fixture.rion.test/play";
  await core.prepareExternalChromeProfile(userDataDir);
  const server = createServer((request, response) => {
    if (request.url === "/json/list") {
      const { port } = server.address();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        id: "fixture-page",
        type: "page",
        url: launchUrl,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fixture-page`
      }]));
      return;
    }
    response.writeHead(404).end();
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });
  webSockets.on("connection", (webSocket) => {
    webSocket.send(JSON.stringify({ method: "Runtime.executionContextCreated", params: { context: { id: 1 } } }));
    webSocket.on("message", (data) => {
      const command = JSON.parse(data.toString());
      webSocket.send(JSON.stringify({ id: command.id, result: { method: command.method } }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port.");
    await writeFile(join(userDataDir, "DevToolsActivePort"), `${address.port}\n`, "utf8");
    const cdp = await core.connectExternalChromeCdp(userDataDir, launchUrl, 2_000);
    const notification = new Promise((resolveNotification, rejectNotification) => {
      const timeout = setTimeout(
        () => rejectNotification(new Error("Rust CDP client did not forward a notification.")),
        2_000
      );
      cdp.subscribeEvents((eventJson) => {
        const event = JSON.parse(eventJson);
        if (event.type === "notification") {
          clearTimeout(timeout);
          resolveNotification(event);
        }
      });
    });
    const reply = JSON.parse(await cdp.send("Runtime.evaluate", "{}", 1_000));
    if (reply.method !== "Runtime.evaluate") {
      throw new Error(`Rust CDP client returned an invalid reply: ${JSON.stringify(reply)}.`);
    }
    const event = await notification;
    if (event.method !== "Runtime.executionContextCreated") {
      throw new Error(`Rust CDP client returned an invalid event: ${JSON.stringify(event)}.`);
    }
    cdp.close();
  } finally {
    for (const client of webSockets.clients) client.terminate();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  await core.shutdown();
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}
console.log(`Verified Rust core Node-API ${version}: ${addonPath}`);
