import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();

async function startFixture(): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, ["scripts/runtimeAuthorityFixtureServer.mjs", "--port=0"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  const origin = await new Promise<string>((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => reject(new Error("Fixture startup timed out")), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/runtime-authority-fixture (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match) return;
      clearTimeout(deadline);
      resolve(match[1]);
    });
    child.once("error", reject);
  });
  return { child, origin };
}

async function post(origin: string, path: string, value: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  children.clear();
});

describe("runtime authority fixture launch gates", () => {
  it("holds navigation until an explicit release event", async () => {
    const { origin } = await startFixture();
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({
      ok: true,
      port: Number(new URL(origin).port)
    });
    expect((await post(origin, "/api/gate", { roleId: "test-role" })).ok).toBe(true);
    let roleResolved = false;
    const role = fetch(`${origin}/role/test-role`).then((response) => {
      roleResolved = true;
      return response;
    });
    const waiting = await fetch(`${origin}/api/gates/test-role/waiting`);
    expect(await waiting.json()).toEqual({ roleId: "test-role", waiterCount: 1 });
    expect(roleResolved).toBe(false);
    expect((await post(origin, "/api/release", { roleId: "test-role" })).ok).toBe(true);
    expect((await role).status).toBe(200);
  });
});
