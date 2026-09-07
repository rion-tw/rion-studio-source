/**
 * Observe native shutdown independently of the journey verdict.
 * A failed journey never becomes successful because its application flushed.
 */
export async function observeElectronPhaseShutdown({
  driver, forcedTermination, exitCode, readFinalFlush, waitForProcessExit
}) {
  if (driver !== "electron" || forcedTermination) return {};
  let finalFlush;
  try {
    finalFlush = await readFinalFlush();
    // Existing external process-exit boundary; no retry or new deadline.
    await waitForProcessExit(finalFlush);
    return { finalFlush, processExited: true };
  } catch (error) {
    if (exitCode === 0) throw error;
    return {
      finalFlush,
      processExited: false,
      shutdownError: error instanceof Error ? error.message : String(error)
    };
  }
}
