import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForUpdaterJournalRemoval } from
  "../scripts/electronUpdaterJournalAcknowledgement.mjs";

const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
function observation() {
  const watcher = new EventEmitter() as FSWatcher;
  watcher.close = vi.fn(() => { watcher.emit("close"); });
  let notify!: (event: string, filename: string | Buffer | null) => void;
  const access = vi.fn(async () => undefined);
  const watch = vi.fn((_path: string, listener: typeof notify) => {
    notify = listener;
    return watcher;
  });
  return { access, watch, watcher, notify: (name: string | null) => notify("rename", name) };
}

afterEach(() => vi.useRealTimers());

describe("updater journal acknowledgement", () => {
  it("subscribes before the initial read, including removal during that read", async () => {
    const io = observation();
    io.access.mockImplementation(async () => {
      expect(io.watch).toHaveBeenCalledOnce();
      throw missing();
    });
    await expect(waitForUpdaterJournalRemoval("/fixture/journal", 1000, io)).resolves.toBeUndefined();
    expect(io.watcher.close).toHaveBeenCalledOnce();
  });

  it("observes a removal event even while an older presence read is pending", async () => {
    const io = observation();
    let completeInitial!: () => void;
    io.access.mockImplementationOnce(() => new Promise(resolve => { completeInitial = () => resolve(undefined); }));
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.access.mockRejectedValue(missing());
    io.notify("journal");
    await expect(pending).resolves.toBeUndefined();
    completeInitial();
    expect(io.watcher.close).toHaveBeenCalledOnce();
  });

  it("ignores unrelated changes and requires absence after an exact or unnamed event", async () => {
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.notify("unrelated");
    expect(io.access).toHaveBeenCalledTimes(1);
    io.notify("journal");
    expect(io.access).toHaveBeenCalledTimes(2);
    io.access.mockRejectedValue(missing());
    io.notify(null);
    await expect(pending).resolves.toBeUndefined();
  });

  it.each(["EACCES", "EIO"])("never treats %s as a successful removal", async code => {
    const io = observation();
    const error = Object.assign(new Error(code), { code });
    io.access.mockRejectedValue(error);
    await expect(waitForUpdaterJournalRemoval("/fixture/journal", 1000, io)).rejects.toBe(error);
    expect(io.watcher.close).toHaveBeenCalledOnce();
  });

  it.each(["error", "close"])("fails if the event stream emits %s", async event => {
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.watcher.emit(event, new Error("watch failed"));
    await expect(pending).rejects.toThrow(event === "error" ? "watch failed" : "stream closed");
  });

  it("fails at the external deadline and closes the observer", async () => {
    vi.useFakeTimers();
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    const rejected = expect(pending).rejects.toThrow("Timed out waiting");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(io.watcher.close).toHaveBeenCalledOnce();
  });

  it("observes real filesystem deletion with the same platform-neutral owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-journal-ack-"));
    const path = join(root, "journal");
    try {
      await writeFile(path, "pending");
      const pending = waitForUpdaterJournalRemoval(path, 1000);
      await unlink(path);
      await pending;
      await waitForUpdaterJournalRemoval(path, 1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
