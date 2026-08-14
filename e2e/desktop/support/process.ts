import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export async function forceTerminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Refusing to terminate invalid desktop E2E PID: ${pid}`);
  }
  if (process.platform === "win32") {
    try {
      await executeFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    } catch (error) {
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      throw error;
    }
    return;
  }
  await executeFile("/bin/kill", ["-KILL", String(pid)]);
}
