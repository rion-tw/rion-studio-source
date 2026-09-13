import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyElectronExtensionCompatibilityBundle } from
  "../scripts/verifyElectronExtensionCompatibilityBundle.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

async function fixture(main: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rion-extension-bundle-"));
  roots.push(root);
  await mkdir(join(root, "out/main"), { recursive: true });
  await mkdir(join(root, "out/preload"), { recursive: true });
  await writeFile(join(root, "out/main/index.js"), main);
  await writeFile(join(root, "out/preload/extensionCompat.cjs"), [
    "RION_EXTENSION_API_UNAVAILABLE",
    "compatibility.ready",
    "permissions.onRemoved",
    "webNavigation.onCompleted"
  ].join("\n"));
  return root;
}

describe("extension compatibility bundle verification", () => {
  it("accepts the audited API surface", async () => {
    await expect(verifyElectronExtensionCompatibilityBundle(
      await fixture("bounded extension host")
    )).resolves.toMatchObject({ mainBytes: 22 });
  });

  it("rejects a native messaging transport in Electron main", async () => {
    await expect(verifyElectronExtensionCompatibilityBundle(
      await fixture("runtime.connectNative")
    )).rejects.toThrow("runtime.connectNative");
  });
});
