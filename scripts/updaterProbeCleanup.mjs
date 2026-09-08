/** Preserve the probe's primary failure when mandatory cleanup also fails. */
export async function withUpdaterProbeCleanup(probe, cleanup) {
  let primaryError;
  let probeFailed = false;
  let result;
  try {
    result = await probe();
  } catch (error) {
    probeFailed = true;
    primaryError = error;
  }
  let cleanupError;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (probeFailed && cleanupFailed) {
    throw new AggregateError([primaryError, cleanupError],
      "The updater probe and its required cleanup failed.", { cause: primaryError });
  }
  if (probeFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result;
}
