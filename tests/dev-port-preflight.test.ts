import { EventEmitter } from "node:events";
import type { Server } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { assertDevRendererPortAvailable } from "../scripts/devPortPreflight.mjs";

function serverFactory(result: "available" | "occupied") {
  const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
  const server = new EventEmitter() as EventEmitter & {
    close: typeof close;
    listen: (options: unknown, callback: () => void) => void;
    unref: () => void;
  };
  server.close = close;
  server.unref = vi.fn();
  server.listen = vi.fn((_options, callback) => {
    queueMicrotask(() => {
      if (result === "available") {
        callback();
      } else {
        server.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
      }
    });
  });
  return {
    close,
    create: () => server as unknown as Server
  };
}

describe("dev renderer port preflight", () => {
  it("accepts an available loopback port", async () => {
    const fake = serverFactory("available");

    await expect(assertDevRendererPortAvailable("127.0.0.1", 5173, fake.create))
      .resolves.toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("fails with a clear message when the loopback port is occupied", async () => {
    const fake = serverFactory("occupied");

    await expect(assertDevRendererPortAvailable("127.0.0.1", 5173, fake.create)).rejects.toThrow(
      "http://127.0.0.1:5173 is already in use"
    );
  });
});
