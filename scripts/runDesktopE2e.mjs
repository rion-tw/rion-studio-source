import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const artifactRoot = resolve(
  process.env.RION_STUDIO_E2E_ARTIFACT_ROOT ?? resolve(root, ".desktop-e2e-artifacts"),
  `${runId}-${process.platform}`
);
const userDataDir = resolve(artifactRoot, "user-data");
const token = randomBytes(32).toString("hex");
const binary = resolve(root, "target", "debug", process.platform === "win32"
  ? "rion-tauri.exe"
  : "rion-tauri");
const node = process.execPath;
const wdio = resolve(root, "node_modules", "@wdio", "cli", "bin", "wdio.js");
const phases = ["seed", "restart", "force-terminate", "crash-restart"];
if (process.env.RION_STUDIO_E2E_PROFILE === "extended") phases.push("extended-native");
const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8"
}).trim();
const worktreeDirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8"
}).trim().length > 0;
const requestedCommit = process.env.RION_STUDIO_E2E_COMMIT;
const windowIds = {
  a: "e2e00000-0000-4000-8000-00000000000a",
  b: "e2e00000-0000-4000-8000-00000000000b",
  c: "e2e00000-0000-4000-8000-00000000000c",
  fullscreen: "e2e00000-0000-4000-8000-000000000012",
  maximized: "e2e00000-0000-4000-8000-000000000011",
  normal: "e2e00000-0000-4000-8000-000000000010"
};
let seedBounds;
let previousSessionGeneration = 0;

await mkdir(userDataDir, { recursive: true });
await mkdir(resolve(artifactRoot, "phases"), { recursive: true });

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: options.logPath ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  let output = "";
  const stream = options.logPath ? createWriteStream(options.logPath) : undefined;
  for (const source of [child.stdout, child.stderr]) {
    source?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      stream?.write(text);
      process.stdout.write(text);
    });
  }
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`${command} ended with signal ${signal}`));
      else resolveExit(exitCode ?? 1);
    });
  });
  if (stream) await new Promise((resolveEnd) => stream.end(resolveEnd));
  return { code, output };
}

async function startFixture() {
  const child = spawn(node, [resolve(root, "scripts/runtimeAuthorityFixtureServer.mjs"), "--port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const log = createWriteStream(resolve(artifactRoot, "fixture.log"));
  child.stderr.pipe(log, { end: false });
  const origin = await new Promise((resolveOrigin, reject) => {
    let pending = "";
    const deadline = setTimeout(() => reject(new Error("Runtime fixture did not report its origin")), 15_000);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      log.write(text);
      pending += text;
      const match = pending.match(/runtime-authority-fixture (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match) return;
      clearTimeout(deadline);
      resolveOrigin(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime fixture exited early (${code})`)));
  });
  return {
    child,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolveExit) => child.once("exit", resolveExit));
      }
      await new Promise((resolveEnd) => log.end(resolveEnd));
    },
    origin
  };
}

async function copyIfPresent(source, destination) {
  try {
    await access(source);
    await copyFile(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSqliteEvidence(phase, gameWindows, settings, blocked) {
  const byId = new Map(gameWindows.map((window) => [window.id, window]));
  const expectedWindows = [
    [windowIds.a, "E2E Window A", "normal"],
    [windowIds.b, "E2E Window B", "normal"],
    [windowIds.c, "E2E Three Tabs", "normal"],
    [windowIds.normal, "E2E Mode 1 Normal", "normal"],
    [windowIds.maximized, "E2E Mode 2 Maximized", "maximized"],
    [windowIds.fullscreen, "E2E Mode 3 Fullscreen", "fullscreen"]
  ];
  for (const [id, name, presentation] of expectedWindows) {
    const record = byId.get(id);
    requireEvidence(record, `${phase}: missing permanent window ${id}`);
    requireEvidence(record.name === name, `${phase}: ${id} lost its permanent name`);
    requireEvidence(
      record.payload?.placement?.presentation === presentation,
      `${phase}: ${name} persisted an unexpected mode`
    );
  }

  const bounds = byId.get(windowIds.a)?.payload?.placement?.normalBounds;
  requireEvidence(
    [bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite),
    `${phase}: Window A has invalid normal bounds`
  );
  requireEvidence(bounds.width > 0 && bounds.height > 0, `${phase}: Window A has empty bounds`);
  if (phase === "seed") seedBounds = structuredClone(bounds);
  else if (phase !== "extended-native") {
    requireEvidence(
      sameValue(bounds, seedBounds),
      `${phase}: Window A normal bounds drifted from the seed phase`
    );
  }

  const windowC = byId.get(windowIds.c)?.payload;
  requireEvidence(
    sameValue(windowC?.tabs?.map((tab) => tab.name), ["E2E alpha", "E2E beta", "E2E gamma"]),
    `${phase}: Window C did not retain its ordered three-tab topology`
  );
  requireEvidence(
    windowC?.activeTabId === windowC?.tabs?.at(-1)?.id,
    `${phase}: Window C did not retain its active tab`
  );

  const session = settings.find((setting) => setting.key === "runtimeRestoreSession")?.payload;
  requireEvidence(session, `${phase}: runtime restore session is missing`);
  if (!blocked) {
    requireEvidence(
      session.cleanExit === (phase !== "force-terminate"),
      `${phase}: runtime restore session has the wrong clean-exit state`
    );
  }
  requireEvidence(
    sameValue(session.liveWindowIds, [windowIds.a]),
    `${phase}: restart cohort must contain only open Window A`
  );
  requireEvidence(
    sameValue(session.restoreInProgressWindowIds, []),
    `${phase}: restore-in-progress cohort was not terminalized`
  );
  requireEvidence(
    session.lastFocusedWindowId === windowIds.a,
    `${phase}: Window A was not retained as the last focused window`
  );
  requireEvidence(
    Number.isSafeInteger(session.sessionGeneration)
      && session.sessionGeneration > previousSessionGeneration,
    `${phase}: session generation did not advance`
  );
  previousSessionGeneration = session.sessionGeneration;

  return {
    cleanExit: session.cleanExit,
    sessionGeneration: session.sessionGeneration,
    windowABounds: bounds,
    windowCount: gameWindows.length,
    windowCTabCount: windowC.tabs.length
  };
}

async function captureSqlite(phase, blocked) {
  const phaseDir = resolve(artifactRoot, "phases", phase);
  await mkdir(phaseDir, { recursive: true });
  const databasePath = resolve(userDataDir, "rion-studio.sqlite3");
  await copyIfPresent(databasePath, resolve(phaseDir, "rion-studio.sqlite3"));
  await copyIfPresent(`${databasePath}-wal`, resolve(phaseDir, "rion-studio.sqlite3-wal"));
  await copyIfPresent(`${databasePath}-shm`, resolve(phaseDir, "rion-studio.sqlite3-shm"));
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const gameWindows = database.prepare(
      "SELECT id, name, payload_json AS payloadJson FROM game_windows ORDER BY ordinal"
    ).all().map((row) => ({
      ...row,
      payload: JSON.parse(String(row.payloadJson))
    }));
    const settings = database.prepare(
      "SELECT key, payload_json AS payloadJson FROM settings ORDER BY key"
    ).all().map((row) => ({
      ...row,
      payload: JSON.parse(String(row.payloadJson))
    }));
    database.close();
    await writeFile(
      resolve(phaseDir, "sqlite-query.json"),
      `${JSON.stringify({ gameWindows, settings }, null, 2)}\n`
    );
    return validateSqliteEvidence(phase, gameWindows, settings, blocked);
  } catch (error) {
    await writeFile(resolve(phaseDir, "sqlite-query-error.txt"), `${String(error)}\n`);
    throw error;
  }
}

async function expectedForcedTermination(phaseDir) {
  const markerPath = resolve(phaseDir, "forced-termination.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) {
    throw new Error("Forced-termination marker did not contain a valid PID");
  }
  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return marker;
    throw error;
  }
  throw new Error(`Desktop E2E PID ${marker.pid} survived its forced-termination phase`);
}

function blockedReason(output) {
  const matches = [...output.matchAll(/BLOCKED:[^\r\n]*/gu)];
  return matches.at(-1)?.[0];
}

const report = {
  artifactRoot,
  binary,
  commit: checkoutCommit,
  phases: [],
  requestedCommit,
  startedAt: new Date().toISOString(),
  worktreeDirty
};
let fixture;
let failure;
try {
  if (requestedCommit && requestedCommit.toLowerCase() !== checkoutCommit.toLowerCase()) {
    throw new Error(
      `Desktop E2E checkout ${checkoutCommit} does not match requested commit ${requestedCommit}`
    );
  }
  if (requestedCommit && worktreeDirty) {
    throw new Error("Desktop E2E immutable-SHA validation requires a clean worktree");
  }
  if (process.env.RION_STUDIO_E2E_SKIP_BUILD !== "1") {
    const build = await run(node, [resolve(root, "scripts/buildDesktopE2e.mjs")]);
    if (build.code !== 0) throw new Error(`Desktop E2E build failed (${build.code})`);
  }
  await access(binary);
  fixture = await startFixture();
  for (const phase of phases) {
    const phaseDir = resolve(artifactRoot, "phases", phase);
    await mkdir(phaseDir, { recursive: true });
    const result = await run(node, [wdio, "run", resolve(root, "e2e/desktop/wdio.conf.ts")], {
      env: {
        RION_STUDIO_E2E_APP_BINARY: binary,
        RION_STUDIO_E2E_ARTIFACT_DIR: phaseDir,
        RION_STUDIO_E2E_FIXTURE_ORIGIN: fixture.origin,
        RION_STUDIO_E2E_PHASE: phase,
        RION_STUDIO_E2E_SESSION_TOKEN: token,
        RION_STUDIO_USER_DATA_DIR: userDataDir
      },
      logPath: resolve(phaseDir, "runner.log")
    });
    const forcedTermination = phase === "force-terminate"
      ? await expectedForcedTermination(phaseDir)
      : undefined;
    const blocked = blockedReason(result.output);
    const sqliteEvidence = await captureSqlite(phase, blocked);
    report.phases.push({
      blockedReason: blocked,
      exitCode: result.code,
      expectedForcedTermination: forcedTermination ? true : undefined,
      phase,
      sqliteEvidence,
      status: blocked
        ? "BLOCKED"
        : forcedTermination
          ? "EXPECTED_FORCE_TERMINATION"
          : result.code === 0 ? "PASS" : "FAIL"
    });
    if (result.code !== 0 && !forcedTermination) {
      throw new Error(
        blocked ?? `Desktop E2E phase ${phase} failed (${result.code})`
      );
    }
  }
} catch (error) {
  failure = error;
} finally {
  if (fixture) await fixture.close();
  report.finishedAt = new Date().toISOString();
  report.failure = failure ? String(failure) : undefined;
  await writeFile(resolve(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`Desktop E2E artifacts: ${artifactRoot}\n`);
if (failure) throw failure;
