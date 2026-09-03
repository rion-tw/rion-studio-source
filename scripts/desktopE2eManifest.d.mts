export interface DesktopE2eProfile {
  extends?: string;
  phases?: string[];
  specs?: string[];
}

export interface DesktopE2eJourney {
  id: string;
  phases?: string[];
  profile: string;
  status: string;
}

export interface DesktopE2eManifest {
  journeys?: DesktopE2eJourney[];
  profiles?: Record<string, DesktopE2eProfile>;
}

export interface ResolvedDesktopE2eProfile {
  names: string[];
  phases: string[];
  specs: string[];
}

export type DesktopE2ePhaseStatus =
  | "BLOCKED"
  | "EXPECTED_FORCE_TERMINATION"
  | "FAIL"
  | "PASS";

export interface DesktopE2ePhaseResult {
  phase: string;
  status: DesktopE2ePhaseStatus;
}

export interface DesktopE2eJourneyVerdict {
  id: string;
  phases: string[];
  status: "BLOCKED" | "FAIL" | "NOT_RUN" | "PASS";
}

export function resolveDesktopE2eProfile(
  manifest: DesktopE2eManifest,
  profileName: string
): ResolvedDesktopE2eProfile;

export function journeysForDesktopE2eProfile(
  manifest: DesktopE2eManifest,
  profileName: string
): DesktopE2eJourney[];

export function aggregateDesktopE2eJourneyVerdicts(
  manifest: DesktopE2eManifest,
  profileName: string,
  phaseResults: DesktopE2ePhaseResult[]
): DesktopE2eJourneyVerdict[];
