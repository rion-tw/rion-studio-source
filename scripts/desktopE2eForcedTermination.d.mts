export interface DesktopE2eForcedTerminationMarker {
  pid: number;
  requestedAt?: string;
  sessionId?: string;
}

export function isExpectedDesktopE2eForcedTermination(phase: string): boolean;
export function desktopE2eForcedTerminationEnvironment(
  phase: string
): Readonly<Record<string, string>>;
export function acceptedDesktopE2eForcedTermination(
  phaseDirectory: string
): Promise<DesktopE2eForcedTerminationMarker | undefined>;
