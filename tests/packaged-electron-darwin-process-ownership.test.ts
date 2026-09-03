import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  assertPackagedElectronProcessTreeGone,
  buildDarwinPackagedProcessInventory,
  createPackagedElectronPrivateBundleContainment,
  createPackagedElectronProcessOwner,
  packagedElectronSpawnOptions,
  terminatePackagedElectronProcessTree,
  terminatePackagedElectronPrivateBundleContainment,
  waitForPackagedElectronProcessClose,
  waitForPackagedElectronProcessOwnership
} from "../scripts/packagedElectronProcessCleanup.mjs";
import {
  createDarwinPackagedProcessOwnership,
  parseDarwinProcessInventory
} from
  "../scripts/packagedElectronDarwinProcessOwnership.mjs";
import { createDarwinPrivatePackagedElectronBundle } from
  "../scripts/packagedElectronDarwinPrivateBundle.mjs";

const executeFile = promisify(execFile);

describe.skipIf(process.platform === "win32")(
  "packaged Electron macOS process ownership",
  () => {
  it("parses exact bounded process identities and rejects duplicate or unsafe records", () => {
    const pathHex = Buffer.from("/Applications/Rion Studio.app/Contents/MacOS/Rion Studio")
      .toString("hex");
    const auditToken = "00".repeat(32);
    const record = `120\t1\t120\t501\t100\t7\t500\t1\t${auditToken}\t${pathHex}\n`;

    const parsed = parseDarwinProcessInventory(record);

    expect(parsed).toEqual([{
      auditToken,
      executablePath: "/Applications/Rion Studio.app/Contents/MacOS/Rion Studio",
      parentProcessId: 1,
      parentProcessUniqueId: "1",
      processGroupId: 120,
      processId: 120,
      processUniqueId: "500",
      startMicroseconds: 7,
      startSeconds: 100,
      userId: 501
    }]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(() => parseDarwinProcessInventory(`${record}${record}`))
      .toThrow("unsafe identity");
    expect(() => parseDarwinProcessInventory(
      `1\t0\t1\t0\t100\t0\t501\t1\t${auditToken}\t${pathHex}\n`
    )).toThrow("unsafe identity");
    expect(() => parseDarwinProcessInventory(
      `120\t1\t120\t501\t100\t7\t502\t1\t${auditToken}\t2f746d7\n`
    )).toThrow("malformed record");
    expect(() => parseDarwinProcessInventory(
      `120\t1\t120\t501\t100\t7\t503\t1\t${auditToken}\t${Buffer.from("relative").toString("hex")}\n`
    )).toThrow("unsafe executable path");
  });

  it("rejects a caller-asserted shared bundle without a private capability", () => {
    expect(() => createDarwinPackagedProcessOwnership({
      executablePath: "/tmp/Rion Test.app/Contents/MacOS/Rion Test",
      inventoryExecutablePath: "/tmp/packaged-process-inventory",
      privateBundle: {
        applicationPath: "/tmp/Rion Test.app"
      } as never,
      processGroupId: 919_191,
      processId: 919_191,
      spawnedAtMilliseconds: Date.now()
    })).toThrow("factory-issued private bundle capability");
  });

  const macosIt = process.platform === "darwin" ? it : it.skip;
  macosIt(
    "kills a same-bundle helper after it escapes and reparents outside the root process group",
    async () => {
      const temporaryLink = await mkdtemp(join(tmpdir(), "rion-packaged-owner-"));
      const temporaryRoot = await realpath(temporaryLink);
      const sourceApplicationRoot = join(temporaryRoot, "Rion Test.app");
      const sourceExecutableDirectory = join(
        sourceApplicationRoot,
        "Contents",
        "MacOS"
      );
      const sourceFrameworkDirectory = join(
        sourceApplicationRoot,
        "Contents",
        "Frameworks"
      );
      const sourceExecutablePath = join(sourceExecutableDirectory, "Rion Test");
      const sourceHelperPath = join(
        sourceFrameworkDirectory,
        "Rion Detached Helper"
      );
      const fixtureSource = resolve(
        import.meta.dirname,
        "fixtures",
        "macos",
        "packaged-process-owner.c"
      );
      let helperProcessId: number | undefined;
      let owner: ReturnType<typeof createPackagedElectronProcessOwner> | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let inventoryExecutablePath: string | undefined;
      let spawnedAtMilliseconds: number | undefined;
      let applicationRoot: string | undefined;
      let rootProcessUniqueId: string | undefined;
      let helperProcessUniqueId: string | undefined;
      let exactCleanupFailure: unknown;
      let privateBundle: Awaited<ReturnType<
        typeof createDarwinPrivatePackagedElectronBundle
      >> | undefined;

      try {
        await Promise.all([
          mkdir(sourceExecutableDirectory, { recursive: true }),
          mkdir(sourceFrameworkDirectory, { recursive: true })
        ]);
        await executeFile("/usr/bin/xcrun", [
          "clang",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-mmacosx-version-min=14.0",
          fixtureSource,
          "-o",
          sourceExecutablePath
        ]);
        await copyFile(sourceExecutablePath, sourceHelperPath);
        await chmod(sourceHelperPath, 0o755);
        privateBundle = await createDarwinPrivatePackagedElectronBundle(
          sourceApplicationRoot
        );
        applicationRoot = privateBundle.applicationPath;
        const executablePath = join(
          applicationRoot,
          "Contents",
          "MacOS",
          "Rion Test"
        );
        const helperPath = join(
          applicationRoot,
          "Contents",
          "Frameworks",
          "Rion Detached Helper"
        );
        inventoryExecutablePath = await buildDarwinPackagedProcessInventory(
          join(temporaryRoot, "native-tools")
        );

        spawnedAtMilliseconds = Date.now();
        child = spawn(executablePath, [helperPath], {
          ...packagedElectronSpawnOptions("darwin"),
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (!child.stdout) {
          throw new Error("The macOS ownership fixture did not expose stdout.");
        }
        const lines = createInterface({ input: child.stdout });
        const readyLine = once(lines, "line");
        await once(child, "spawn");
        const admittedOwner = createPackagedElectronProcessOwner({
          child,
          executablePath,
          inventoryExecutablePath,
          platform: "darwin",
          privateBundle,
          spawnedAtMilliseconds
        });
        owner = admittedOwner;
        await waitForPackagedElectronProcessOwnership(admittedOwner);
        const [line] = await readyLine;
        const match = /^ready (\d+)$/u.exec(String(line));
        if (!match) throw new Error(`Unexpected ownership fixture output: ${line}`);
        helperProcessId = Number(match[1]);

        const before = parseDarwinProcessInventory(
          (await executeFile(inventoryExecutablePath, [], {
            env: fixtureInventoryEnvironment(
              applicationRoot,
              spawnedAtMilliseconds,
              admittedOwner.processId
            )
          })).stdout
        );
        const helper = before.find((entry) => entry.processId === helperProcessId);
        const root = before.find(
          (entry) => entry.processId === admittedOwner.processId
        );
        if (!root || !helper) {
          throw new Error("The ownership fixture identities were not observable.");
        }
        rootProcessUniqueId = root.processUniqueId;
        helperProcessUniqueId = helper.processUniqueId;
        expect(helper).toMatchObject({
          executablePath: helperPath,
          parentProcessId: admittedOwner.processId,
          processGroupId: helperProcessId
        });
        expect(helper?.processGroupId).not.toBe(admittedOwner.processGroupId);

        await unlink(helperPath);
        await expect(waitForExactFixtureProcess(
          inventoryExecutablePath,
          applicationRoot,
          spawnedAtMilliseconds,
          admittedOwner.processId,
          helper.processUniqueId,
          (entry) => entry.executablePath === undefined
        )).resolves.toMatchObject({
          executablePath: undefined,
          processUniqueId: helper.processUniqueId
        });

        await executeFile(inventoryExecutablePath, [
          "--signal",
          root.auditToken,
          "9"
        ]);
        const reparentedHelper = await waitForExactFixtureProcess(
          inventoryExecutablePath,
          applicationRoot,
          spawnedAtMilliseconds,
          admittedOwner.processId,
          helper.processUniqueId,
          (entry) => entry.parentProcessId === 1
        );
        expect(reparentedHelper).toMatchObject({
          parentProcessId: 1,
          parentProcessUniqueId: root.processUniqueId,
          processGroupId: helperProcessId
        });
        await expect(executeFile(inventoryExecutablePath, [
          "--signal",
          root.auditToken,
          "9"
        ])).rejects.toMatchObject({ code: 44 });
        await expect(waitForExactFixtureProcess(
          inventoryExecutablePath,
          applicationRoot,
          spawnedAtMilliseconds,
          admittedOwner.processId,
          helper.processUniqueId,
          () => true
        )).resolves.toMatchObject({ processId: helperProcessId });

        await terminatePackagedElectronProcessTree(admittedOwner);
        await expect(waitForPackagedElectronProcessClose(admittedOwner, 2_000))
          .resolves.toMatchObject({ signal: "SIGKILL" });
        await expect(assertPackagedElectronProcessTreeGone(admittedOwner))
          .resolves.toBeUndefined();
      } finally {
        if (owner) {
          await terminatePackagedElectronProcessTree(owner).catch(() => undefined);
          await waitForPackagedElectronProcessClose(owner, 2_000)
            .catch(() => undefined);
        }
        if (
          inventoryExecutablePath && spawnedAtMilliseconds && child?.pid &&
          applicationRoot
        ) {
          try {
            await killExactFixtureProcesses(
              inventoryExecutablePath,
              applicationRoot,
              spawnedAtMilliseconds,
              child.pid,
              new Set([
                ...(rootProcessUniqueId ? [rootProcessUniqueId] : []),
                ...(helperProcessUniqueId ? [helperProcessUniqueId] : [])
              ])
            );
          } catch (error) {
            exactCleanupFailure = error;
          }
        }
        if (!exactCleanupFailure) await privateBundle?.cleanup();
        await rm(temporaryRoot, { force: true, recursive: true });
      }
      if (exactCleanupFailure) throw exactCleanupFailure;
    },
    30_000
  );

  macosIt(
    "terminates an escaped helper through the pre-admission private containment",
    async () => {
      const temporaryLink = await mkdtemp(join(tmpdir(), "rion-contained-owner-"));
      const temporaryRoot = await realpath(temporaryLink);
      const sourceApplicationRoot = join(temporaryRoot, "Rion Test.app");
      const executableDirectory = join(
        sourceApplicationRoot,
        "Contents",
        "MacOS"
      );
      const frameworkDirectory = join(
        sourceApplicationRoot,
        "Contents",
        "Frameworks"
      );
      const fixtureSource = resolve(
        import.meta.dirname,
        "fixtures",
        "macos",
        "packaged-process-owner.c"
      );
      let applicationRoot: string | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let containment: ReturnType<
        typeof createPackagedElectronPrivateBundleContainment
      > | undefined;
      let inventoryExecutablePath: string | undefined;
      let spawnedAtMilliseconds: number | undefined;
      let terminal = false;
      let privateBundle: Awaited<ReturnType<
        typeof createDarwinPrivatePackagedElectronBundle
      >> | undefined;

      try {
        await Promise.all([
          mkdir(executableDirectory, { recursive: true }),
          mkdir(frameworkDirectory, { recursive: true })
        ]);
        const sourceExecutablePath = join(executableDirectory, "Rion Test");
        const sourceHelperPath = join(frameworkDirectory, "Rion Detached Helper");
        await executeFile("/usr/bin/xcrun", [
          "clang",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-mmacosx-version-min=14.0",
          fixtureSource,
          "-o",
          sourceExecutablePath
        ]);
        await copyFile(sourceExecutablePath, sourceHelperPath);
        await chmod(sourceHelperPath, 0o755);
        privateBundle = await createDarwinPrivatePackagedElectronBundle(
          sourceApplicationRoot
        );
        applicationRoot = privateBundle.applicationPath;
        const executablePath = join(
          applicationRoot,
          "Contents",
          "MacOS",
          "Rion Test"
        );
        const helperPath = join(
          applicationRoot,
          "Contents",
          "Frameworks",
          "Rion Detached Helper"
        );
        inventoryExecutablePath = await buildDarwinPackagedProcessInventory(
          join(temporaryRoot, "native-tools")
        );
        spawnedAtMilliseconds = Date.now();
        child = spawn(executablePath, [helperPath], {
          ...packagedElectronSpawnOptions("darwin"),
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (!child.stdout) {
          throw new Error("The containment fixture did not expose stdout.");
        }
        const lines = createInterface({ input: child.stdout });
        const readyLine = once(lines, "line");
        await once(child, "spawn");
        const rootProcessId = child.pid;
        if (!rootProcessId) {
          throw new Error("The containment fixture did not expose its root PID.");
        }
        containment = createPackagedElectronPrivateBundleContainment({
          child,
          inventoryExecutablePath,
          platform: "darwin",
          privateBundle,
          spawnedAtMilliseconds
        });
        await expect(readyLine).resolves.toEqual([
          expect.stringMatching(/^ready \d+$/u)
        ]);

        await terminatePackagedElectronPrivateBundleContainment(containment);
        expect(child.signalCode).toBe("SIGKILL");
        await killExactFixtureProcesses(
          inventoryExecutablePath,
          applicationRoot,
          spawnedAtMilliseconds,
          rootProcessId,
          new Set()
        );
        terminal = true;
      } finally {
        if (!terminal && containment) {
          try {
            await terminatePackagedElectronPrivateBundleContainment(containment);
            terminal = true;
          } catch {
            // The audit-token fallback below remains the final active-zero proof.
          }
        }
        if (
          !terminal && inventoryExecutablePath && spawnedAtMilliseconds &&
          child?.pid && applicationRoot
        ) {
          try {
            await killExactFixtureProcesses(
              inventoryExecutablePath,
              applicationRoot,
              spawnedAtMilliseconds,
              child.pid,
              new Set()
            );
            terminal = true;
          } catch {
            // Retain the private root when exact process terminality is unknown.
          }
        }
        if (terminal) await privateBundle?.cleanup();
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    },
    30_000
  );

  macosIt(
    "bounds the public cleanup when an audit-token signal never acknowledges",
    async () => {
      const temporaryLink = await mkdtemp(join(tmpdir(), "rion-owner-deadline-"));
      const temporaryRoot = await realpath(temporaryLink);
      const sourceApplicationRoot = join(temporaryRoot, "Rion Test.app");
      let privateBundle: Awaited<ReturnType<
        typeof createDarwinPrivatePackagedElectronBundle
      >> | undefined;
      try {
        await mkdir(sourceApplicationRoot, { recursive: true });
        privateBundle = await createDarwinPrivatePackagedElectronBundle(
          sourceApplicationRoot
        );
        const processId = 919_291;
        const helperProcessId = 919_292;
        const spawnedAtMilliseconds = Date.now();
        const startSeconds = Math.floor(spawnedAtMilliseconds / 1_000);
        const startMicroseconds =
          (spawnedAtMilliseconds - startSeconds * 1_000) * 1_000;
        const executablePath = join(
          privateBundle.applicationPath,
          "Contents",
          "MacOS",
          "Rion Test"
        );
        const rootIdentity = Object.freeze({
          auditToken: "11".repeat(32),
          executablePath,
          parentProcessId: process.pid,
          parentProcessUniqueId: "1",
          processGroupId: processId,
          processId,
          processUniqueId: "9001",
          startMicroseconds,
          startSeconds,
          userId: process.getuid?.() ?? 501
        });
        const helperIdentity = Object.freeze({
          auditToken: "22".repeat(32),
          executablePath: join(
            privateBundle.applicationPath,
            "Contents",
            "Frameworks",
            "Rion Helper"
          ),
          parentProcessId: processId,
          parentProcessUniqueId: rootIdentity.processUniqueId,
          processGroupId: helperProcessId,
          processId: helperProcessId,
          processUniqueId: "9002",
          startMicroseconds,
          startSeconds,
          userId: rootIdentity.userId
        });
        let inventoryReads = 0;
        const darwinOperations = {
          epochMilliseconds: () => Date.now(),
          now: () => Date.now(),
          readInventory: vi.fn(async () => {
            inventoryReads += 1;
            return inventoryReads === 1
              ? [rootIdentity]
              : [rootIdentity, helperIdentity];
          }),
          signalAuditToken: vi.fn(async (
            _executablePath: string,
            _auditToken: string,
            _signal: "SIGTERM" | "SIGKILL",
            timeoutMilliseconds: number
          ) => new Promise<never>((_resolvePromise, reject) => {
            setTimeout(
              () => reject(new Error("injected signal acknowledgement stall")),
              timeoutMilliseconds
            );
          })),
          sleep: vi.fn(async (milliseconds: number) =>
            new Promise<void>((resolvePromise) => {
              setTimeout(resolvePromise, milliseconds);
            }))
        };
        const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          pid: processId,
          signalCode: null
        });
        const owner = createPackagedElectronProcessOwner({
          child,
          executablePath,
          inventoryExecutablePath: "/tmp/rion-injected-inventory",
          platform: "darwin",
          privateBundle,
          spawnedAtMilliseconds
        }, darwinOperations);
        await waitForPackagedElectronProcessOwnership(owner);
        const publicOperations = {
          now: () => Date.now(),
          readWindowsOwnedTree: vi.fn(async () => []),
          sleep: vi.fn(async () => undefined),
          terminateWindowsTree: vi.fn(async () => undefined)
        };
        const startedAt = Date.now();
        const deadline = startedAt + 150;

        await expect(terminatePackagedElectronProcessTree(
          owner,
          publicOperations,
          deadline
        )).rejects.toBeInstanceOf(AggregateError);

        expect(Date.now() - startedAt).toBeLessThan(750);
        expect(darwinOperations.signalAuditToken).toHaveBeenCalled();
      } finally {
        await privateBundle?.cleanup();
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    },
    5_000
  );
  }
);

async function killExactFixtureProcesses(
  inventoryExecutablePath: string,
  applicationRoot: string,
  spawnedAtMilliseconds: number,
  rootProcessId: number,
  knownProcessUniqueIds: ReadonlySet<string>
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inventory = parseDarwinProcessInventory(
      (await executeFile(inventoryExecutablePath, [], {
        env: fixtureInventoryEnvironment(
          applicationRoot,
          spawnedAtMilliseconds,
          rootProcessId
        )
      })).stdout
    );
    const owned = inventory.filter((entry) =>
      (typeof entry.executablePath === "string" &&
       entry.executablePath.startsWith(`${applicationRoot}/`)) ||
      knownProcessUniqueIds.has(entry.processUniqueId)
    );
    if (owned.length === 0) return;
    for (const entry of owned) {
      try {
        await executeFile(inventoryExecutablePath, [
          "--signal",
          entry.auditToken,
          "9"
        ]);
      } catch (error) {
        if ((error as { code?: number }).code !== 44) throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const remaining = parseDarwinProcessInventory(
    (await executeFile(inventoryExecutablePath, [], {
      env: fixtureInventoryEnvironment(
        applicationRoot,
        spawnedAtMilliseconds,
        rootProcessId
      )
    })).stdout
  ).filter((entry) =>
    (typeof entry.executablePath === "string" &&
     entry.executablePath.startsWith(`${applicationRoot}/`)) ||
    knownProcessUniqueIds.has(entry.processUniqueId)
  );
  if (remaining.length > 0) {
    throw new Error(
      `${remaining.length} exact private-bundle fixture process(es) survived cleanup.`
    );
  }
}

async function waitForExactFixtureProcess(
  inventoryExecutablePath: string,
  applicationRoot: string,
  spawnedAtMilliseconds: number,
  rootProcessId: number,
  processUniqueId: string,
  predicate: (
    entry: ReturnType<typeof parseDarwinProcessInventory>[number]
  ) => boolean
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const inventory = parseDarwinProcessInventory(
      (await executeFile(inventoryExecutablePath, [], {
        env: fixtureInventoryEnvironment(
          applicationRoot,
          spawnedAtMilliseconds,
          rootProcessId
        )
      })).stdout
    );
    const processEntry = inventory.find(
      (entry) => entry.processUniqueId === processUniqueId
    );
    if (processEntry && predicate(processEntry)) return processEntry;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    "The exact private-bundle fixture process did not reach its expected state."
  );
}

function fixtureInventoryEnvironment(
  applicationRoot: string,
  spawnedAtMilliseconds: number,
  rootProcessId: number
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RION_STUDIO_PACKAGED_PROCESS_BUNDLE_ROOT: applicationRoot,
    RION_STUDIO_PACKAGED_PROCESS_KNOWN_FENCES: "",
    RION_STUDIO_PACKAGED_PROCESS_MINIMUM_START: String(
      Math.max(1, Math.floor(spawnedAtMilliseconds / 1_000) - 2)
    ),
    RION_STUDIO_PACKAGED_PROCESS_ROOT_PID: String(rootProcessId)
  };
}
