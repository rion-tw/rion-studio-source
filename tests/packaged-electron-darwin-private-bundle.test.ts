import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { expect, it } from "vitest";

import { createDarwinPrivatePackagedElectronBundle } from
  "../scripts/packagedElectronDarwinPrivateBundle.mjs";

const macosIt = process.platform === "darwin" ? it : it.skip;

macosIt("launches from an exclusive byte-preserving private app bundle copy", async () => {
  const sourceLink = await mkdtemp(join(tmpdir(), "rion-private-source-"));
  const sourceRoot = await realpath(sourceLink);
  const sourceApplication = join(sourceRoot, "Rion Test.app");
  const executableDirectory = join(sourceApplication, "Contents", "MacOS");
  const resourcesDirectory = join(sourceApplication, "Contents", "Resources");
  let privateBundle: Awaited<ReturnType<
    typeof createDarwinPrivatePackagedElectronBundle
  >> | undefined;
  try {
    await Promise.all([
      mkdir(executableDirectory, { recursive: true }),
      mkdir(resourcesDirectory, { recursive: true })
    ]);
    await writeFile(join(executableDirectory, "Rion Test"), "exact executable\n");
    await symlink("../MacOS/Rion Test", join(resourcesDirectory, "current"));

    privateBundle = await createDarwinPrivatePackagedElectronBundle(
      sourceApplication
    );

    expect(privateBundle.applicationPath).not.toBe(sourceApplication);
    expect(privateBundle.exclusiveBundleRoot).toBe(privateBundle.applicationPath);
    expect((await lstat(privateBundle.privateRoot)).mode & 0o777).toBe(0o700);
    await expect(readFile(
      join(privateBundle.applicationPath, "Contents", "MacOS", "Rion Test"),
      "utf8"
    )).resolves.toBe("exact executable\n");
    await expect(readlink(
      join(privateBundle.applicationPath, "Contents", "Resources", "current")
    )).resolves.toBe("../MacOS/Rion Test");

    const privateRoot = privateBundle.privateRoot;
    await privateBundle.cleanup();
    await privateBundle.cleanup();
    await expect(lstat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await privateBundle?.cleanup().catch(() => undefined);
    await rm(sourceRoot, { force: true, recursive: true });
  }
});
