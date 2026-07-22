import { isAbsolute, resolve } from "node:path";

export function resolveTestUserDataPath(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const requestedPath = environment.RION_STUDIO_TEST_USER_DATA_DIR?.trim();
  if (!requestedPath) return undefined;
  if (environment.RION_STUDIO_TEST_MODE !== "1") {
    throw new Error(
      "RION_STUDIO_TEST_USER_DATA_DIR requires RION_STUDIO_TEST_MODE=1."
    );
  }
  if (!isAbsolute(requestedPath)) {
    throw new Error("RION_STUDIO_TEST_USER_DATA_DIR must be an absolute path.");
  }
  return resolve(requestedPath);
}
