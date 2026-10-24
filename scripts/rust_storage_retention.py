"""Local Cargo cache retention. Preserve profile directories and Cargo lock inodes."""
import contextlib
from collections import Counter
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time

LOCKS = (".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock")
MARKERS = {*LOCKS, ".metadata_never_index", ".storage-last-used"}
PINS = (".keep", ".retain", ".storage-keep")
SOURCE = re.compile(r"\.(blend\d*|fbx|gltf|glb|psd|psb|ai|kra|xcf|aep|c4d|ma|mb|usd|usdz)$", re.I)
GIB = 1024 ** 3
DAY = 86400


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], stderr=subprocess.PIPE,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})


def within(parent, child):
    return child == parent or str(child).startswith(str(parent) + os.sep)


def pinned(path, root):
    while within(root, path):
        if any((path / pin).exists() for pin in PINS):
            return True
        if path == root:
            break
        path = path.parent
    return False


def inspect(paths):
    pending = list(paths)
    digest = hashlib.sha256()
    size = newest = count = 0
    blocked = ""
    files = {}
    while pending:
        path = pending.pop()
        info = path.lstat()
        count += 1
        if count > 250000:
            raise RuntimeError("Rust output scan limit exceeded; retained")
        digest.update(str((str(path), info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns)).encode())
        newest = max(newest, info.st_mtime)
        if stat.S_ISLNK(info.st_mode):
            blocked = blocked or "symlink"
        elif stat.S_ISDIR(info.st_mode):
            if not info.st_mode & 0o222:
                blocked = blocked or "read-only-directory"
            pending.extend(sorted(path.iterdir()))
        elif stat.S_ISREG(info.st_mode):
            key = f"{info.st_dev}:{info.st_ino}"
            if key not in files:
                files[key] = [info.st_size, 0]
                size += info.st_size
            files[key][1] += 1
        else:
            blocked = blocked or "special-file"
        if path.name in {*PINS, ".git", ".env"} or path.name.startswith(".env.") or SOURCE.search(path.name):
            blocked = blocked or "pinned-or-source"
    return {"bytes": size, "newest": newest, "fingerprint": digest.hexdigest(), "blocked": blocked, "_files": files}


def remaining_bytes(files, removed):
    return sum(size for key, (size, count) in files.items() if removed[key] < count)


def references(entry):
    return {key: value[1] for key, value in entry["_files"].items()}


def snapshot(request):
    if "activity" in request:
        result = request["activity"]
    else:
        script = "import {activitySnapshot} from " + json.dumps(request["activityModule"]) + ";console.log(JSON.stringify(activitySnapshot()));"
        result = json.loads(subprocess.check_output([request["node"], "--input-type=module", "-e", script]))
    return {**result, **{key: [str(Path(p).resolve()) for p in result.get(key, [])] for key in ("open", "working")}}


def activity_reason(activity, root, target, other_worktrees):
    if not activity.get("available"):
        return "process-inspection-unavailable"
    # Our helper also appears in lsof while holding these locks. Contention is
    # checked with native nonblocking flock, not by the existence of an open lock.
    if any(within(target, Path(path)) and Path(path).name not in LOCKS for path in activity["open"]):
        return "open-target-file"
    for directory in activity["working"]:
        cwd = Path(directory)
        if within(root, cwd) and not any(within(other, cwd) for other in other_worktrees):
            return "active-checkout"
    return ""


def profiles_in(target):
    profiles = []
    for path in sorted(target.iterdir()):
        if path.is_symlink() or not path.is_dir() or path.name.startswith("."):
            continue
        if any((path / lock).exists() for lock in LOCKS):
            profiles.append(path)
        elif re.fullmatch(r"[a-zA-Z0-9_]+-[a-zA-Z0-9_-]+", path.name):
            for child in sorted(path.iterdir()):
                if child.is_dir() and not child.is_symlink() and any((child / lock).exists() for lock in LOCKS):
                    profiles.append(child)
    return profiles


def profile_paths(profile):
    return [p for p in sorted(profile.iterdir()) if p.name not in MARKERS]


def lock_profile(stack, profile, apply):
    # Hold all generations of Cargo's native locks. Never remove/replace these files.
    for name in LOCKS:
        path = profile / name
        if not path.exists() and not apply:
            continue
        flags = os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if apply else 0)
        fd = os.open(path, flags, 0o600)
        stream = stack.enter_context(os.fdopen(fd, "r+b"))
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError("invalid Cargo lock file")
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.fstat(fd).st_ino != path.lstat().st_ino:
            raise RuntimeError("Cargo lock inode changed")


def run(request):
    root = Path(request["root"]).resolve()
    if Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel")).strip()).resolve() != root:
        raise ValueError("Rust retention must start at the checkout root")
    policy = request["policy"]
    if policy.get("version") != 1 or any(
        not isinstance(policy.get(k), (int, float)) or not math.isfinite(policy[k]) or policy[k] < 0
        for k in ("maxGiB", "maxAgeDays", "incrementalMaxGiB", "incrementalMaxAgeDays", "quietHours")
    ):
        raise ValueError("Invalid Rust retention policy")
    target = root / "target"
    apply = bool(request.get("apply"))
    result = {"root": str(root), "apply": apply, "removedBytes": 0, "plannedBytes": 0, "entries": [], "errors": []}
    if not target.exists():
        return {**result, "skipped": "target absent"}
    if apply and not shutil.rmtree.avoids_symlink_attacks:
        return {**result, "skipped": "safe directory removal unavailable; retained"}
    if target.is_symlink() or not target.is_dir() or target.resolve() != target:
        return {**result, "skipped": "target is not a local directory"}
    if not (root / "Cargo.toml").is_file() or not (target / ".rustc_info.json").is_file():
        return {**result, "skipped": "unrecognized Cargo target; retained"}
    if git(root, "ls-files", "-z", "--", "target"):
        return {**result, "skipped": "tracked target content; retained"}
    git(root, "check-ignore", "-q", "--", "target")
    if pinned(target, root):
        return {**result, "skipped": "target pinned"}
    now = request.get("now", time.time())
    worktrees = [Path(line[9:]).resolve() for line in os.fsdecode(git(root, "worktree", "list", "--porcelain")).splitlines() if line.startswith("worktree ")]
    others = [p for p in worktrees if p != root and within(root, p)]
    activity = snapshot(request)
    blocked_activity = activity_reason(activity, root, target, others)
    guard_path = Path(os.fsdecode(git(root, "rev-parse", "--git-path", "rust-storage-retention.lock")).strip())
    if not guard_path.is_absolute():
        guard_path = root / guard_path
    with contextlib.ExitStack() as stack:
        if apply:
            try:
                guard_path.mkdir()
            except FileExistsError:
                return {**result, "skipped": "another cleaner or stale cleanup lock; retained"}
            stack.callback(guard_path.rmdir)
        profiles = []
        for profile in profiles_in(target):
            blocked = blocked_activity
            if not blocked:
                locks = contextlib.ExitStack()
                try:
                    lock_profile(locks, profile, apply)
                    stack.enter_context(locks)
                except (OSError, RuntimeError):
                    locks.close()
                    blocked = "cargo-locked-or-unavailable"
            paths = profile_paths(profile)
            stats = inspect(paths)
            blocked = blocked or stats["blocked"]
            if pinned(profile, root):
                blocked = "pinned"
            used = profile / ".storage-last-used"
            last_used = 0
            if used.exists():
                if used.is_symlink() or not used.is_file():
                    blocked = "invalid-usage-marker"
                else:
                    last_used = used.stat().st_mtime
                    stats["newest"] = max(stats["newest"], last_used)
            entry = {"path": str(profile), "kind": "profile", "paths": [str(p) for p in paths], **stats, "lastUsed": last_used, "blocked": blocked, "reason": ""}
            profiles.append(entry)
        # Lock acquisition closes the Cargo-start race; refresh process evidence while holding locks.
        if apply and not blocked_activity:
            blocked_activity = activity_reason(snapshot(request), root, target, others)
            for entry in profiles:
                entry["blocked"] = entry["blocked"] or blocked_activity
        incremental = []
        for profile in profiles:
            directory = Path(profile["path"]) / "incremental"
            if directory.is_dir() and not directory.is_symlink():
                for child in sorted(directory.iterdir()):
                    if child.name.startswith(".") or not child.is_dir():
                        continue
                    stats = inspect([child])
                    incremental.append({"path": str(child), "kind": "incremental", "paths": [str(child)], **stats,
                                        "blocked": profile["blocked"] or stats["blocked"], "reason": ""})
        target_stats = inspect([target])
        total = target_stats["bytes"]
        incremental_files = {}
        for entry in incremental:
            for key, (size, count) in entry["_files"].items():
                incremental_files.setdefault(key, [size, 0])[1] += count
        removed_refs = Counter()
        retained = total
        incremental_retained = remaining_bytes(incremental_files, removed_refs)
        for entry in sorted(incremental, key=lambda e: e["newest"]):
            if entry["blocked"] or entry["newest"] > now - policy["quietHours"] * 3600:
                entry["blocked"] = entry["blocked"] or "recent"
                continue
            if entry["newest"] < now - policy["incrementalMaxAgeDays"] * DAY:
                entry["reason"] = "expired-incremental"
            elif incremental_retained > policy["incrementalMaxGiB"] * GIB or retained > policy["maxGiB"] * GIB:
                entry["reason"] = "incremental-budget"
            if entry["reason"]:
                removed_refs.update(references(entry))
                retained = remaining_bytes(target_stats["_files"], removed_refs)
                incremental_retained = remaining_bytes(incremental_files, removed_refs)
        for profile in sorted(profiles, key=lambda e: e["newest"]):
            if profile["blocked"] or profile["newest"] > now - policy["quietHours"] * 3600:
                profile["blocked"] = profile["blocked"] or "recent"
                continue
            if profile["newest"] < now - policy["maxAgeDays"] * DAY:
                profile["reason"] = "expired-profile"
            elif retained > policy["maxGiB"] * GIB:
                profile["reason"] = "profile-budget"
            if profile["reason"]:
                for entry in incremental:
                    if within(Path(profile["path"]), Path(entry["path"])) and entry["reason"]:
                        removed_refs.subtract(references(entry))
                        entry["reason"] = ""
                removed_refs.update(references(profile))
                retained = remaining_bytes(target_stats["_files"], removed_refs)
        entries = incremental + profiles
        result.update({"entries": entries, "totalBytes": total, "budgetBytes": policy["maxGiB"] * GIB,
                       "plannedBytes": total - retained, "retainedBytes": retained,
                       "overBudget": retained > policy["maxGiB"] * GIB})
        result["incrementalBudgetBytes"] = policy["incrementalMaxGiB"] * GIB
        result["incrementalRetainedBytes"] = remaining_bytes(incremental_files, removed_refs)
        if apply:
            for entry in (e for e in entries if e["reason"]):
                try:
                    paths = [Path(p) for p in entry["paths"]]
                    profile = next(p for p in profiles if within(Path(p["path"]), Path(entry["path"])))
                    used = Path(profile["path"]) / ".storage-last-used"
                    if (used.stat().st_mtime if used.exists() else 0) != profile["lastUsed"]:
                        raise RuntimeError("profile used after planning")
                    if any(p.resolve() != p or not within(target, p) for p in paths):
                        raise RuntimeError("path changed or escapes target")
                    if pinned(Path(entry["path"]), root) or git(root, "ls-files", "-z", "--", "target"):
                        raise RuntimeError("new pin or tracked content")
                    git(root, "check-ignore", "-q", "--", str(Path(entry["path"]).relative_to(root)))
                    current = inspect(paths)
                    if current["blocked"] or current["fingerprint"] != entry["fingerprint"]:
                        raise RuntimeError("output changed during scan")
                    if entry["kind"] == "profile" and [str(p) for p in profile_paths(Path(profile["path"]))] != entry["paths"]:
                        raise RuntimeError("profile gained new files")
                    for path in paths:
                        if path.is_dir():
                            shutil.rmtree(path)
                        else:
                            path.unlink()
                    entry["removed"] = True
                    result["removedBytes"] += entry["bytes"]
                except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
                    entry["blocked"] = "changed-or-deletion-error"
                    result["errors"].append({"path": entry["path"], "message": str(error)})
            result["retainedBytes"] = inspect([target])["bytes"]
            result["removedBytes"] = max(0, total - result["retainedBytes"])
            result["overBudget"] = result["retainedBytes"] > policy["maxGiB"] * GIB
            incremental_paths = [Path(p["path"]) / "incremental" for p in profiles]
            result["incrementalRetainedBytes"] = inspect([p for p in incremental_paths if p.is_dir() and not p.is_symlink()])["bytes"]
            mark = request.get("markProfile")
            if mark in ("debug", "release"):
                profile = target / mark
                marker = profile / ".storage-last-used"
                if profile.is_dir() and not profile.is_symlink() and not marker.is_symlink():
                    marker.touch(exist_ok=True)
    result["incrementalOverBudget"] = result["incrementalRetainedBytes"] > result["incrementalBudgetBytes"]
    for entry in result["entries"]:
        entry.pop("_files", None)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
