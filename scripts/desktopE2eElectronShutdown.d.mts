export function observeElectronPhaseShutdown<T>(input: {
  driver: string;
  forcedTermination: boolean;
  exitCode: number;
  readFinalFlush: () => Promise<T>;
  waitForProcessExit: (marker: T) => Promise<void>;
}): Promise<{ finalFlush?: T; processExited?: boolean; shutdownError?: string }>;
