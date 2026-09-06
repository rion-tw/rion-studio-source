import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForUpdaterJournalRemoval } from
  "../scripts/electronUpdaterJournalAcknowledgement.mjs";

const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
function observation() {
  const directoryWatcher = new EventEmitter() as FSWatcher;
  directoryWatcher.close = vi.fn(() => { directoryWatcher.emit("close"); });
  let notify!: (event: string, filename: string | Buffer | null) => void;
  let fileNotify: typeof notify | undefined;
  const fileWatchers: FSWatcher[] = [];
  const access = vi.fn(async () => undefined);
  const watch = vi.fn((path: string, listener: typeof notify) => {
    if (path === "/fixture") { notify = listener; return directoryWatcher; }
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = vi.fn(() => { watcher.emit("close"); });
    fileWatchers.push(watcher);
    fileNotify = listener;
    return watcher;
  });
  return { access, watch, watcher: directoryWatcher, fileWatchers,
    notify: (name: string | null) => notify("rename", name),
    notifyFile: () => {
      if (!fileNotify) throw new Error("No journal file subscription");
      fileNotify("rename", "journal");
    }
  };
}

afterEach(() => vi.useRealTimers());

describe("updater journal acknowledgement", () => {
  it("subscribes before the initial read, including removal during that read", async () => {
    const io = observation();
    io.access.mockImplementation(async () => {
      expect(io.watch).toHaveBeenCalledTimes(2);
      throw missing();
    });
    await expect(waitForUpdaterJournalRemoval("/fixture/journal", 1000, io)).resolves.toBeUndefined();
    expect(io.watcher.close).toHaveBeenCalledOnce();
  });

  it("observes exact file deletion when the directory stream is silent", async () => {
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.access.mockRejectedValue(missing());
    io.notifyFile();
    await expect(pending).resolves.toBeUndefined();
  });

  it("follows a replaced journal without treating old watcher retirement as failure", async () => {
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.notifyFile();
    expect(io.fileWatchers).toHaveLength(2);
    expect(io.fileWatchers[0]!.close).toHaveBeenCalledOnce();
    io.access.mockRejectedValue(missing());
    io.notifyFile();
    await expect(pending).resolves.toBeUndefined();
    expect(io.fileWatchers.every(watcher => vi.mocked(watcher.close).mock.calls.length === 1)).toBe(true);
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

  it.each(["error", "close"])("fails when the current file stream emits %s", async event => {
    const io = observation();
    const pending = waitForUpdaterJournalRemoval("/fixture/journal", 1000, io);
    io.fileWatchers[0]!.emit(event, new Error("file watch failed"));
    await expect(pending).rejects.toThrow(event === "error" ? "file watch failed" : "file event stream closed");
    expect(io.watcher.close).toHaveBeenCalledOnce();
    expect(io.fileWatchers[0]!.close).toHaveBeenCalledOnce();
  });

  it("observes deletion after a real atomic replacement and inode rebind", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-journal-replace-"));
    const path = join(root, "journal");
    const replacement = join(root, "replacement");
    let fileSubscriptions = 0;
    let rebind!: () => void;
    const rebound = new Promise<void>(resolve => { rebind = resolve; });
    try {
      await writeFile(path, "old");
      await writeFile(replacement, "new");
      let completed = false;
      const pending = waitForUpdaterJournalRemoval(path, 5000, {
        access,
        watch: (target, listener) => {
          const observer = watch(target, listener);
          if (target === path && ++fileSubscriptions === 2) rebind();
          return observer;
        }
      }).then(() => { completed = true; return null; }, error => error as Error);
      await rename(replacement, path);
      await rebound;
      expect(completed).toBe(false);
      await unlink(path);
      const error = await pending;
      if (error) throw error;
      expect(completed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const started = performance.now();
    const trace: Array<{ at: number; event: string }> = [];
    const record = (event: string) => trace.push({ at: Math.round(performance.now() - started), event });
    try {
      await writeFile(path, "pending");
      // This real filesystem check shares workers with native package I/O.
      // The deterministic deadline-failure test above retains its exact 1s clock.
      const pending = waitForUpdaterJournalRemoval(path, 5000, {
        access: async (...args) => {
          record("access:start");
          try { await access(...args); record("access:present"); }
          catch (error) { record(`access:${(error as NodeJS.ErrnoException).code}`); throw error; }
        },
        watch: (directory, listener) => {
          record("watch:start");
          const watcher = watch(directory, (event, filename) => {
            record(`watch:${event}:${String(filename)}`);
            listener(event, filename);
          });
          record("watch:returned");
          return watcher;
        }
      }).then(() => null, error => error as Error);
      record("unlink:start");
      await unlink(path);
      record("unlink:complete");
      const failure = await pending;
      if (failure) throw new Error(`${failure.message}; observation trace: ${JSON.stringify(trace)}`, { cause: failure });
      await waitForUpdaterJournalRemoval(path, 5000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
