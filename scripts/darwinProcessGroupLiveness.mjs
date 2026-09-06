import { execFileSync } from "node:child_process";
import process from "node:process";

/** Darwin can report EPERM when its group iterator excludes every zombie. */
export function isDarwinProcessGroupAlive(processGroupId, operations = {}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error("Darwin group inspection requires an exact detached process group.");
  }
  const kill = operations.kill ?? process.kill.bind(process);
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code !== "EPERM") throw error;
    const source = (operations.readGroupSnapshot ?? readGroupSnapshot)(processGroupId);
    const rows = source.trim() ? source.trim().split(/\r?\n/u) : [];
    for (const row of rows) {
      const fields = row.trim().split(/\s+/u);
      const [pid, group, uid] = fields.slice(0, 3).map(Number);
      if (fields.length !== 4 || !Number.isSafeInteger(pid) || pid <= 1 ||
          group !== processGroupId || !Number.isSafeInteger(uid) || uid < 0 ||
          !/^[A-Z][A-Za-z+<>-]*$/u.test(fields[3])) {
        throw new Error("Darwin returned malformed process-group state.", { cause: error });
      }
      // A live or unreadable member never turns a permission failure into success.
      if (!fields[3].startsWith("Z")) throw error;
    }
    return false;
  }
}

function readGroupSnapshot(processGroupId) {
  try {
    return execFileSync("/bin/ps", [
      "-g", String(processGroupId), "-o", "pid=,pgid=,uid=,stat="
    ], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 5_000
    });
  } catch (error) {
    // ps reports an empty selection with exit 1 if the group was reaped meanwhile.
    if (error?.status === 1 && String(error.stdout ?? "").trim() === "" &&
        String(error.stderr ?? "").trim() === "") return "";
    throw error;
  }
}
