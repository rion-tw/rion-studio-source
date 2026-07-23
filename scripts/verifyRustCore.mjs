import { access, chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
let core;
try {
  const legacyGames = {
    games: [{
      browserLaunchMode: "inherit",
      createdAt: "2026-01-01T00:00:00Z",
      defaultLaunchUrl: "https://fixture.rion.test/play",
      id: "fixture-game",
      name: "Fixture Game",
      source: "custom",
      updatedAt: "2026-01-01T00:00:00Z"
    }]
  };
  await Promise.all([
    writeFile(join(userDataDir, "games.json"), JSON.stringify(legacyGames), "utf8"),
    writeFile(join(userDataDir, "roles.json"), JSON.stringify({
      roles: [{
        createdAt: "2026-01-01T00:00:00Z",
        gameId: "fixture-game",
        id: "fixture-role",
        launchUrl: "https://fixture.rion.test/play",
        name: "Fixture Role",
        notes: "packaged migration smoke",
        updatedAt: "2026-01-01T00:00:00Z"
      }]
    }), "utf8"),
    writeFile(join(userDataDir, "launch-workspaces.json"), JSON.stringify({
      schemaVersion: 7,
      workspaces: [{
        id: "fixture-workspace",
        name: "Fixture Workspace",
        slots: [{ id: "fixture-slot", roleId: "fixture-role" }]
      }]
    }), "utf8"),
    writeFile(join(userDataDir, "macros.json"), JSON.stringify({
      macros: [{
        id: "fixture-macro",
        name: "Fixture Macro",
        profileId: "fixture-role",
        steps: [{ code: "KeyA", id: "fixture-step", type: "key" }]
      }]
    }), "utf8")
  ]);

  core = await addon.createAppCore({
    appVersion: "addon-verification",
    platform: process.platform === "win32" ? "win32" : "darwin",
    userDataDir
  });
  const health = JSON.parse(await core.invoke(JSON.stringify({ type: "health" })));
  if (
    health.coreVersion !== version ||
    typeof core.subscribeCoreEvents !== "function" ||
    typeof core.dispatchCoreEffectResults !== "function" ||
    typeof core.connectExternalChromeCdp !== "function" ||
    typeof core.prepareExternalChromeProfile !== "function" ||
    typeof core.prepareEmbeddedKeyTransition !== "function" ||
    typeof core.completeEmbeddedKeyTransition !== "function" ||
    typeof core.reassertEmbeddedKeys !== "function" ||
    typeof core.resolveRolePaths !== "function"
  ) {
    throw new Error("Rust core addon failed its create/invoke integration check.");
  }
  const effectDispatchReport = JSON.parse(await core.dispatchCoreEffectResults(JSON.stringify([{
    effectId: "verification-unknown-effect",
    operationId: "verification-operation",
    ok: true,
    valueJson: null,
    error: null
  }])));
  if (effectDispatchReport.unknown?.[0] !== "verification-unknown-effect") {
    throw new Error(
      `Rust core effect result dispatch returned an invalid report: ${JSON.stringify(effectDispatchReport)}.`
    );
  }
  const effectMetrics = JSON.parse(await core.invoke(JSON.stringify({ type: "coreEffectMetrics" })));
  if (
    effectMetrics.pendingEffectCount !== 0 ||
    !Number.isSafeInteger(effectMetrics.pendingEffectCapacity)
  ) {
    throw new Error(`Rust core effect metrics are invalid: ${JSON.stringify(effectMetrics)}.`);
  }
  if (typeof health.migrationBackup !== "string") {
    throw new Error("Rust core did not report a legacy migration backup.");
  }
  await Promise.all([
    access(join(health.migrationBackup, "games.json")),
    access(join(userDataDir, "rion-studio.sqlite3")),
    access(join(userDataDir, "logs.sqlite3"))
  ]);
  if (await readFile(join(userDataDir, "games.json"), "utf8") !== JSON.stringify(legacyGames)) {
    throw new Error("Rust migration modified the legacy source JSON.");
  }
  const migrated = JSON.parse(await core.invoke(JSON.stringify({ type: "stateSnapshot" })));
  if (
    !migrated.games.some((game) => game.id === "fixture-game") ||
    !migrated.roles.some((role) => role.id === "fixture-role") ||
    !migrated.launchWorkspaces.some((workspace) => workspace.id === "fixture-workspace") ||
    !migrated.macros.some((macro) => macro.id === "fixture-macro")
  ) {
    throw new Error("Rust core failed the packaged legacy migration snapshot check.");
  }
  const firstHold = JSON.parse(core.prepareEmbeddedKeyTransition(
    "fixture-role",
    "hold",
    "KeyW",
    JSON.stringify(["ControlLeft"]),
    "owner-1"
  ));
  if (
    firstHold.effects.map((effect) => `${effect.phase}:${effect.code}`).join(",") !==
    "rawKeyDown:ControlLeft,rawKeyDown:KeyW"
  ) {
    throw new Error(`Rust embedded key ownership returned invalid effects: ${JSON.stringify(firstHold)}.`);
  }
  core.completeEmbeddedKeyTransition(firstHold.transitionId, true);
  const secondHold = JSON.parse(core.prepareEmbeddedKeyTransition(
    "fixture-role",
    "hold",
    "KeyW",
    JSON.stringify(["ControlLeft"]),
    "owner-2"
  ));
  if (secondHold.effects.length !== 0 || !core.hasEmbeddedHeldKeys("fixture-role")) {
    throw new Error("Rust embedded key ownership did not reference-count duplicate holds.");
  }
  core.completeEmbeddedKeyTransition(secondHold.transitionId, true);
  for (const ownerId of ["owner-1", "owner-2"]) {
    const release = JSON.parse(core.prepareEmbeddedKeyTransition(
      "fixture-role",
      "release",
      "KeyW",
      JSON.stringify(["ControlLeft"]),
      ownerId
    ));
    if (ownerId === "owner-1" && release.effects.length !== 0) {
      throw new Error("Rust embedded key ownership released a shared key too early.");
    }
    if (
      ownerId === "owner-2" &&
      release.effects.map((effect) => `${effect.phase}:${effect.code}`).join(",") !==
        "keyUp:KeyW,keyUp:ControlLeft"
    ) {
      throw new Error("Rust embedded key ownership did not release the final owner.");
    }
    core.completeEmbeddedKeyTransition(release.transitionId, true);
  }
  if (core.hasEmbeddedHeldKeys("fixture-role")) {
    throw new Error("Rust embedded key ownership leaked held keys.");
  }
  const rolePaths = JSON.parse(core.resolveRolePaths("fixture-role"));
  if (rolePaths.browserUserDataDir !== join(userDataDir, "roles", "fixture-role", "browser")) {
    throw new Error(`Rust role path resolver returned an invalid path: ${JSON.stringify(rolePaths)}.`);
  }
  const processRoleId = "fixture-process";
  const exit = new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(
      () => rejectExit(new Error("Rust process supervisor did not report exit.")),
      5_000
    );
    core.subscribeCoreEvents((eventsJson) => {
      const event = JSON.parse(eventsJson).find(
        (candidate) => candidate.type === "externalProcessExited" && candidate.roleId === processRoleId
      );
      if (event) {
        clearTimeout(timeout);
        resolveExit(event);
      }
    });
  });
  const launched = JSON.parse(await core.invoke(JSON.stringify({
    type: "externalProcessLaunch",
    roleId: processRoleId,
    executablePath: process.execPath,
    arguments: ["-e", "process.exit(7)"]
  })));
  if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0) {
    throw new Error("Rust process supervisor returned an invalid process id.");
  }
  const processExit = await exit;
  if (processExit.exitCode !== 7 || processExit.terminated !== false) {
    throw new Error(`Rust process supervisor returned an invalid exit: ${JSON.stringify(processExit)}.`);
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
    const cdp = await core.connectExternalChromeCdp(
      "fixture-role",
      userDataDir,
      launchUrl,
      2_000,
      false
    );
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
  core = undefined;
  const restarted = await addon.createAppCore({
    appVersion: "addon-verification",
    platform: process.platform === "win32" ? "win32" : "darwin",
    userDataDir
  });
  try {
    const persisted = JSON.parse(await restarted.invoke(JSON.stringify({ type: "stateSnapshot" })));
    if (!persisted.roles.some((role) => role.id === "fixture-role")) {
      throw new Error("Rust core did not preserve migrated state across restart.");
    }
  } finally {
    await restarted.shutdown();
  }
} finally {
  if (core) await core.shutdown().catch(() => undefined);
  await makeWritableRecursive(userDataDir);
  await rm(userDataDir, { recursive: true, force: true });
}
console.log(`Verified Rust core Node-API ${version}: ${addonPath}`);

async function makeWritableRecursive(path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    const children = await readdir(path);
    await Promise.all(children.map((child) => makeWritableRecursive(join(path, child))));
    return;
  }
  if (metadata.isFile()) await chmod(path, 0o600);
}
