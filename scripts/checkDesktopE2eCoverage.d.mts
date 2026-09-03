export interface DesktopE2eCoverageValidation {
  cutoverParity: Record<string, {
    covered: number;
    required: number;
    missingJourneyIds: string[];
  }>;
  failures: string[];
  manifest: {
    journeys: Array<{
      coverageGroup?: string;
      priority: string;
      replaces?: string[];
      status: string;
    }>;
    runtimeTargets: Record<string, {
      cutoverRequired: boolean;
      driver: string;
      platforms: string[];
      shell: string;
      status: string;
    }>;
  };
}

export function validateDesktopE2eCoverage(
  rootDirectory: string
): Promise<DesktopE2eCoverageValidation>;
