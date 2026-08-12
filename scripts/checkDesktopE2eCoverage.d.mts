export interface DesktopE2eCoverageValidation {
  failures: string[];
  manifest: {
    journeys: Array<{
      priority: string;
      status: string;
    }>;
  };
}

export function validateDesktopE2eCoverage(
  rootDirectory: string
): Promise<DesktopE2eCoverageValidation>;
