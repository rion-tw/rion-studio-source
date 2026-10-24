import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync,
  utimesSync, existsSync, rmSync, symlinkSync, chmodSync, openSync, closeSync, linkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRustRetention } from "./rust-storage-retention.mjs";

const supported = ["darwin", "linux"].includes(process.platform);
const now = Date.now() / 1000;
const DAY = 86400;
const GIB = 1024 ** 3;
const idle = { available: true, open: [], working: [] };
const defaults = { version: 1, maxGiB: 12, maxAgeDays: 14, incrementalMaxGiB: 2, incrementalMaxAgeDays: 7, quietHours: 24 };
const locks = [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"];
const safeTest = (name, fn) => test(name, { skip: !supported }, fn);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rion-rust-retention-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "target/\n");
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname="retention-fixture"\nversion="0.1.0"\nedition="2021"\n');
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target/.rustc_info.json"), "{}");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, relative, age = 20, bytes = 16) {
  const path = join(root, "target", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  const time = new Date((now - age * DAY) * 1000);
  utimesSync(path, time, time);
  let parent = join(path, "..");
  while (parent !== join(root, "target") && parent.startsWith(join(root, "target"))) {
    utimesSync(parent, time, time);
    parent = join(parent, "..");
  }
  return path;
}
function profile(root, name = "debug", age = 20, bytes = 16) {
  for (const lock of locks) file(root, `${name}/${lock}`, age, 0);
  return file(root, `${name}/deps/cached.rlib`, age, bytes);
}
function run(root, { policy = {}, ...options } = {}) {
  return runRustRetention(root, { policy: { ...defaults, ...policy }, now, activity: idle, ...options });
}

safeTest("preview does not create locks, remove files or change timestamps", t => {
  const root = fixture(t);
  const artifact = profile(root);
  rmSync(join(root, "target/debug/.cargo-build-lock"));
  const before = statSync(artifact);
  const result = run(root);
  assert.ok(result.plannedBytes > 0);
  assert.equal(statSync(artifact).mtimeMs, before.mtimeMs);
  assert.ok(!existsSync(join(root, "target/debug/.cargo-build-lock")));
  assert.ok(!existsSync(join(root, ".git/rust-storage-retention.lock")));
});
safeTest("expiry removes a coherent profile but preserves directory, Cargo locks and Spotlight marker", t => {
  const root = fixture(t), artifact = profile(root);
  file(root, "debug/.metadata_never_index", 20, 0);
  const directory = statSync(join(root, "target/debug")).ino;
  const inodes = locks.map(name => statSync(join(root, "target/debug", name)).ino);
  const result = run(root, { apply: true });
  assert.equal(result.errors.length, 0);
  assert.ok(!existsSync(artifact));
  assert.equal(statSync(join(root, "target/debug")).ino, directory);
  assert.deepEqual(locks.map(name => statSync(join(root, "target/debug", name)).ino), inodes);
  assert.ok(existsSync(join(root, "target/debug/.metadata_never_index")));
  assert.ok(existsSync(join(root, "target/.rustc_info.json")));
  assert.ok(!existsSync(join(root, ".git/rust-storage-retention.lock")));
});
safeTest("capacity eviction prefers oldest incremental groups and retains dependencies", t => {
  const root = fixture(t), dependency = profile(root, "debug", 3, 100);
  for (let i = 0; i < 3; i++) file(root, `debug/incremental/crate-${i}/cache.bin`, 5 - i, 100);
  const result = run(root, { apply: true, policy: { maxGiB: 250 / GIB, incrementalMaxGiB: 150 / GIB } });
  assert.equal(result.removedBytes, 200);
  assert.ok(existsSync(dependency));
  assert.ok(existsSync(join(root, "target/debug/incremental/crate-2")));
  assert.ok(!existsSync(join(root, "target/debug/incremental/crate-0")));
  assert.ok(!result.overBudget);
});
safeTest("seven-day incremental expiry applies under the size target without expiring a recent profile", t => {
  const root = fixture(t), dependency = profile(root, "debug", 1, 100);
  const old = file(root, "debug/incremental/obsolete/cache.bin", 8, 100);
  const result = run(root, { apply: true });
  assert.equal(result.removedBytes, 100);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(dependency));
});
safeTest("an idle profile can be evicted when incremental eviction is insufficient", t => {
  const root = fixture(t), artifact = profile(root, "debug", 3, 500);
  const result = run(root, { apply: true, policy: { maxGiB: 300 / GIB } });
  assert.ok(!existsSync(artifact));
  assert.ok(result.entries.some(e => e.reason === "profile-budget" && e.removed));
});
safeTest("hardlinked incremental files count once and remain counted until their final target link is removed", t => {
  const root = fixture(t);
  profile(root, "debug", 3, 100);
  const first = file(root, "debug/incremental/first/cache.bin", 3, 100);
  const second = file(root, "debug/incremental/second/cache.bin", 3, 100);
  rmSync(second);
  linkSync(first, second);
  const time = new Date((now - 3 * DAY) * 1000);
  utimesSync(join(second, ".."), time, time);
  let result = run(root, { apply: true, policy: { maxGiB: 250 / GIB, incrementalMaxGiB: 150 / GIB } });
  assert.equal(result.totalBytes, 202);
  assert.equal(result.removedBytes, 0);
  result = run(root, { apply: true, policy: { incrementalMaxAgeDays: 2 } });
  assert.equal(result.removedBytes, 100);
  assert.ok(!existsSync(first));
  assert.ok(!existsSync(second));
});
safeTest("recent output and recent use markers outrank the soft capacity target and expiry", t => {
  const root = fixture(t), artifact = profile(root, "debug", 20, 500);
  file(root, "debug/.storage-last-used", 0, 0);
  const result = run(root, { apply: true, policy: { maxGiB: 100 / GIB } });
  assert.equal(result.removedBytes, 0);
  assert.ok(result.overBudget);
  assert.ok(existsSync(artifact));
});
safeTest("protected incremental output reports its own exceeded budget", t => {
  const root = fixture(t);
  profile(root, "debug", 1, 100);
  file(root, "debug/incremental/recent/cache.bin", 0, 100);
  const result = run(root, { apply: true, policy: { incrementalMaxGiB: 50 / GIB } });
  assert.equal(result.removedBytes, 0);
  assert.equal(result.overBudget, false);
  assert.equal(result.incrementalOverBudget, true);
  assert.equal(result.incrementalRetainedBytes, 100);
});
safeTest("pins and raw assets protect the whole containing profile", t => {
  for (const name of [".keep", ".retain", ".storage-keep", "source.blend", ".env.local"]) {
    const root = fixture(t), artifact = profile(root);
    file(root, `debug/incremental/saved/${name}`);
    assert.equal(run(root, { apply: true }).removedBytes, 0);
    assert.ok(existsSync(artifact));
  }
});
safeTest("target-level pins and tracked artifacts are retained", t => {
  const root = fixture(t), artifact = profile(root);
  writeFileSync(join(root, "target/.keep"), "");
  assert.equal(run(root, { apply: true }).removedBytes, 0);
  rmSync(join(root, "target/.keep"));
  execFileSync("git", ["-C", root, "add", "-f", "target/debug/deps/cached.rlib"]);
  assert.match(run(root, { apply: true }).skipped, /tracked/u);
  assert.ok(existsSync(artifact));
});
safeTest("active checkout, open target and unavailable inspection all fail closed", t => {
  const root = fixture(t), artifact = profile(root);
  for (const activity of [
    { ...idle, working: [root] },
    { ...idle, open: [artifact] },
    { available: false, reason: "inspection failed" }
  ]) {
    assert.equal(run(root, { apply: true, activity }).removedBytes, 0);
    assert.ok(existsSync(artifact));
  }
});
safeTest("a real open artifact is detected by native process inspection", t => {
  const root = fixture(t), artifact = profile(root);
  const fd = openSync(artifact, "r");
  try {
    const result = run(root, { apply: true, activity: undefined });
    assert.equal(result.removedBytes, 0);
    assert.ok(result.entries.some(e => e.blocked === "open-target-file"));
  } finally { closeSync(fd); }
});
for (const lock of locks) {
  safeTest(`native Cargo lock ${lock} blocks cleanup without replacing the lock`, async t => {
    const root = fixture(t), artifact = profile(root);
    const path = join(root, "target/debug", lock), inode = statSync(path).ino;
    const child = spawn("python3", ["-u", "-c", "import fcntl,sys; f=open(sys.argv[1],'r+b'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()", path]);
    try {
      await once(child.stdout, "data");
      const result = run(root, { apply: true });
      assert.equal(result.removedBytes, 0);
      assert.ok(result.entries.some(e => e.blocked === "cargo-locked-or-unavailable"));
      assert.ok(existsSync(artifact));
      assert.equal(statSync(path).ino, inode);
    } finally {
      child.stdin.end();
      await once(child, "exit");
    }
  });
}
safeTest("read-only and symlink trees preserve original content", t => {
  const root = fixture(t), artifact = profile(root);
  const readonly = join(root, "target/debug/deps");
  chmodSync(readonly, 0o555);
  try { assert.equal(run(root, { apply: true }).removedBytes, 0); }
  finally { chmodSync(readonly, 0o755); }
  symlinkSync(join(root, "Cargo.toml"), join(root, "target/debug/source-link"));
  assert.equal(run(root, { apply: true }).removedBytes, 0);
  assert.ok(existsSync(artifact));
  assert.ok(readFileSync(join(root, "Cargo.toml"), "utf8").includes("retention-fixture"));
});
safeTest("cross-target profiles share one checkout budget and retain target directories", t => {
  const root = fixture(t), native = profile(root, "debug", 3, 200);
  const cross = profile(root, "x86_64-pc-windows-msvc/release", 5, 200);
  const result = run(root, { apply: true, policy: { maxGiB: 300 / GIB } });
  assert.ok(existsSync(native));
  assert.ok(!existsSync(cross));
  assert.ok(existsSync(join(root, "target/x86_64-pc-windows-msvc/release/.cargo-lock")));
  assert.ok(!result.overBudget);
});
safeTest("unknown output and a symlink target are not treated as disposable Cargo output", t => {
  const root = fixture(t), artifact = profile(root);
  rmSync(join(root, "target/.rustc_info.json"));
  assert.match(run(root, { apply: true }).skipped, /unrecognized/u);
  assert.ok(existsSync(artifact));
  rmSync(join(root, "target"), { recursive: true });
  symlinkSync(root, join(root, "target"), "dir");
  assert.match(run(root, { apply: true }).skipped, /local directory/u);
});
safeTest("another cleaner's lock is preserved without deleting artifacts", t => {
  const root = fixture(t), artifact = profile(root);
  mkdirSync(join(root, ".git/rust-storage-retention.lock"));
  assert.match(run(root, { apply: true }).skipped, /another cleaner/u);
  assert.ok(existsSync(artifact));
  assert.ok(existsSync(join(root, ".git/rust-storage-retention.lock")));
});
safeTest("pre-build use is recorded without changing Cargo lock identity", t => {
  const root = fixture(t);
  profile(root, "debug", 3, 100);
  const inode = statSync(join(root, "target/debug/.cargo-lock")).ino;
  run(root, { apply: true, markProfile: "debug" });
  assert.ok(existsSync(join(root, "target/debug/.storage-last-used")));
  assert.equal(statSync(join(root, "target/debug/.cargo-lock")).ino, inode);
});
safeTest("native inspection does not mistake the cleaner's own Cargo locks for an active build", t => {
  const root = fixture(t), artifact = profile(root);
  const result = run(root, { apply: true, activity: undefined });
  assert.equal(result.errors.length, 0);
  assert.ok(!existsSync(artifact));
});
safeTest("a nested linked worktree remains intact and has its own cache policy", t => {
  const root = fixture(t), artifact = profile(root);
  execFileSync("git", ["-C", root, "add", ".gitignore", "Cargo.toml"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const worktree = join(root, ".worktrees/active");
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", "-q", worktree]);
  const result = run(root, { apply: true, activity: { ...idle, working: [worktree] } });
  assert.equal(result.errors.length, 0);
  assert.ok(!existsSync(artifact));
  assert.ok(existsSync(join(worktree, ".git")));
  assert.ok(existsSync(join(worktree, "Cargo.toml")));
});
safeTest("a real offline Cargo build survives retention and rebuilds with the same lock inodes", t => {
  const root = fixture(t);
  if (spawnSync("cargo", ["--version"]).status !== 0) {
    t.skip("Cargo unavailable for native rebuild smoke test");
    return;
  }
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.rs"), 'fn main() { println!("retention fixture"); }\n');
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, "target"), CARGO_BUILD_BUILD_DIR: join(root, "target") };
  const build = () => execFileSync("cargo", ["build", "--offline", "--manifest-path", join(root, "Cargo.toml")], { env, stdio: "pipe" });
  build();
  const path = join(root, "target/debug/retention-fixture");
  const inode = statSync(join(root, "target/debug/.cargo-lock")).ino;
  function age(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) age(child);
      else if (entry.isFile()) {
        const time = new Date((now - 20 * DAY) * 1000);
        utimesSync(child, time, time);
      }
    }
    const time = new Date((now - 20 * DAY) * 1000);
    utimesSync(directory, time, time);
  }
  age(join(root, "target"));
  const result = run(root, { apply: true, activity: undefined });
  assert.equal(result.errors.length, 0);
  assert.ok(!existsSync(path));
  assert.equal(statSync(join(root, "target/debug/.cargo-lock")).ino, inode);
  build();
  assert.equal(execFileSync(path, { encoding: "utf8" }).trim(), "retention fixture");
  assert.equal(statSync(join(root, "target/debug/.cargo-lock")).ino, inode);
});
test("unsupported platforms preserve artifacts without invoking Python", () => {
  assert.match(runRustRetention("unneeded", { platform: "win32" }).skipped, /retained/u);
});
test("automatic helper failure does not prevent the following command or change its exit code", () => {
  const script = join(import.meta.dirname, "rust-storage-retention.mjs");
  const result = spawnSync(process.execPath, [script, "--before-build", "--auto"], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /retained outputs/u);
  const manual = spawnSync(process.execPath, [script, "--apply"], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  assert.equal(manual.status, 1);
});
