import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCrossShellActivationServer,
  forwardActivationToRunningShell
} from "../src/main/shell/CrossShellActivation";

const temporaryDirectories: string[] = [];

async function createUserDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rion-activation-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("cross-shell activation", () => {
  it.each(["darwin", "win32"] as const)(
    "forwards one authenticated activation on %s",
    async () => {
      const userDataDir = await createUserDataDir();
      const onActivate = vi.fn();
      const server = await createCrossShellActivationServer(userDataDir, onActivate);

      await expect(forwardActivationToRunningShell(userDataDir)).resolves.toBe(true);
      expect(onActivate).toHaveBeenCalledOnce();

      await server.close();
      await expect(forwardActivationToRunningShell(userDataDir)).resolves.toBe(false);
    }
  );

  it("rejects a valid-looking endpoint whose token does not authenticate", async () => {
    const userDataDir = await createUserDataDir();
    const endpointPath = join(userDataDir, "rion-studio.activation.json");
    const server = await createCrossShellActivationServer(userDataDir, vi.fn());
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as {
      token: string;
    };
    endpoint.token = "0".repeat(64);
    await writeFile(endpointPath, JSON.stringify(endpoint), "utf8");

    await expect(forwardActivationToRunningShell(userDataDir)).resolves.toBe(false);

    await server.close();
  });

  it("ignores malformed or over-sized endpoint records", async () => {
    const userDataDir = await createUserDataDir();
    const endpointPath = join(userDataDir, "rion-studio.activation.json");

    await writeFile(endpointPath, "{not-json", "utf8");
    await expect(forwardActivationToRunningShell(userDataDir)).resolves.toBe(false);

    await writeFile(endpointPath, "x".repeat(16 * 1024 + 1), "utf8");
    await expect(forwardActivationToRunningShell(userDataDir)).resolves.toBe(false);
  });

  it("writes owner-only endpoint metadata where permission modes are supported", async () => {
    const userDataDir = await createUserDataDir();
    const endpointPath = join(userDataDir, "rion-studio.activation.json");
    const server = await createCrossShellActivationServer(userDataDir, vi.fn());

    if (process.platform !== "win32") {
      expect((await stat(endpointPath)).mode & 0o777).toBe(0o600);
    }

    await server.close();
  });
});
