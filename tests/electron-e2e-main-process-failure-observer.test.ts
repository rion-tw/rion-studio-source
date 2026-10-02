import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMainProcessFailureObserver } from "../src/electron/e2e/mainProcessFailureObserver";

const write = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ writeFileSync: write }));

describe("E2E main-process failure evidence", () => {
  it("records the original error without replacing Electron's uncaught-exception handling", () => {
    const events = new EventEmitter();
    const stop = installMainProcessFailureObserver(resolve("e2e-artifacts"), events);
    const error = new Error("exact native owner was destroyed");
    events.emit("uncaughtExceptionMonitor", error, "uncaughtException");
    expect(JSON.parse(write.mock.calls.at(-1)![1])).toEqual({
      origin: "uncaughtException", name: error.name, message: error.message, stack: error.stack
    });
    expect(events.listenerCount("uncaughtException")).toBe(0);
    stop();
    expect(events.listenerCount("uncaughtExceptionMonitor")).toBe(0);
  });

  it("does not install without an absolute artifact destination", () => {
    const events = new EventEmitter();
    installMainProcessFailureObserver(undefined, events);
    installMainProcessFailureObserver("relative", events);
    expect(events.listenerCount("uncaughtExceptionMonitor")).toBe(0);
  });
});
