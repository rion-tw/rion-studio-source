import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyDesktopE2eBuild } from "../scripts/verifyDesktopE2eBuild.mjs";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rion-desktop-e2e-build-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(resolve(root, "out/main"), { recursive: true }),
    mkdir(resolve(root, "out/preload"), { recursive: true })
  ]);
  return root;
}

async function writePreloads(root: string, indexSource: string): Promise<void> {
  await Promise.all([
    writeFile(resolve(root, "out/preload/index.cjs"), indexSource),
    writeFile(resolve(root, "out/preload/role.cjs"), "module.exports = {};"),
    writeFile(
      resolve(root, "out/preload/runtimeWindowsHost.cjs"),
      "module.exports = {};"
    ),
    writeFile(
      resolve(root, "out/preload/workspaceWebChrome.cjs"),
      "module.exports = {};"
    )
  ]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("desktop E2E build verifier", () => {
  it("accepts the distinct Electron E2E main and preload signatures", async () => {
    const root = await temporaryRoot();
    await writeFile(
      resolve(root, "out/main/index.js"),
      "rion:e2e:invoke retainedV22Precondition"
    );
    await writePreloads(root, "rionStudioDesktopE2e retainedV22Precondition");

    await expect(verifyDesktopE2eBuild({
      driver: "electron",
      repositoryRoot: root
    })).resolves.toBeUndefined();
  });

  it("rejects a production Electron bundle before WebDriver starts", async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, "out/main/index.js"), "production main");
    await writePreloads(root, "production preload");

    await expect(verifyDesktopE2eBuild({
      driver: "electron",
      repositoryRoot: root
    })).rejects.toThrow(/not an E2E build.*SKIP_BUILD/u);
  });

  it("does not impose Electron bundle signatures on the Tauri driver", async () => {
    const root = await temporaryRoot();

    await expect(verifyDesktopE2eBuild({
      driver: "tauri",
      repositoryRoot: root
    })).resolves.toBeUndefined();
  });

  it("rejects a split sandbox preload before WebDriver starts", async () => {
    const root = await temporaryRoot();
    await writeFile(
      resolve(root, "out/main/index.js"),
      "rion:e2e:invoke retainedV22Precondition"
    );
    await writePreloads(
      root,
      "rionStudioDesktopE2e retainedV22Precondition require('./chunks/shared.cjs')"
    );

    await expect(verifyDesktopE2eBuild({
      driver: "electron",
      repositoryRoot: root
    })).rejects.toThrow("not self-contained");
  });

  it("fails closed in the runner before starting the fixture", async () => {
    const source = await readFile("scripts/runDesktopE2e.mjs", "utf8");
    const verify = source.indexOf("await verifyDesktopE2eBuild({");
    const fixture = source.indexOf("fixture = await startFixture();");

    expect(verify).toBeGreaterThan(-1);
    expect(fixture).toBeGreaterThan(verify);
  });
});
