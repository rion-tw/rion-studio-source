import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { LogCaptureRecord } from "../src/shared/generated";
import { installElectronOperationalLogHooks } from
  "../src/electron/main/electronOperationalLogHooks";
import {
  ElectronOperationalLogger,
  type ElectronOperationalLogCorePort
} from "../src/electron/main/electronOperationalLogger";

describe("Electron operational log hooks", () => {
  it("maps navigation and process errors without retaining private navigation fields", async () => {
    const app = new EventEmitter();
    const processPort = new EventEmitter();
    const contents = new EventEmitter() as EventEmitter & {
      id: number;
      getType: () => string;
    };
    contents.id = 41;
    contents.getType = () => "window";
    const invoke = vi.fn(async (_command: { entries: LogCaptureRecord[] }) => ({
      inserted: 1
    }));
    const logger = new ElectronOperationalLogger();
    logger.bindCore({
      invoke,
      subscribeCoreEvents: () => () => undefined
    } as unknown as ElectronOperationalLogCorePort);
    const dispose = installElectronOperationalLogHooks(
      app as never,
      processPort as never,
      logger
    );

    app.emit("web-contents-created", {}, contents);
    contents.emit(
      "did-start-navigation",
      {},
      "https://private.example/path?token=secret",
      false,
      true
    );
    contents.emit(
      "did-fail-load",
      {},
      -105,
      "private DNS description",
      "https://private.example/path?token=secret",
      true
    );
    contents.emit(
      "preload-error",
      {},
      "/Users/private/preload.cjs",
      new Error("preload boom")
    );
    app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 9 });
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 8 });
    processPort.emit("unhandledRejection", new Error("rejected"));
    await logger.flush();

    const entries = invoke.mock.calls.flatMap(
      ([command]) => command.entries as LogCaptureRecord[]
    );
    expect(entries.map((entry) => entry.event)).toEqual([
      "main_frame_navigation_started",
      "main_frame_navigation_failed",
      "preload_error",
      "render_process_gone",
      "child_process_gone",
      "unhandled_rejection"
    ]);
    const encoded = JSON.stringify(entries);
    expect(encoded).not.toContain("private.example");
    expect(encoded).not.toContain("private DNS description");
    expect(encoded).not.toContain("preload.cjs");

    dispose();
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed" });
    await logger.flush();
    expect(invoke).toHaveBeenCalledTimes(6);
  });
});
