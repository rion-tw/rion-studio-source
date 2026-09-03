import { isChromeProfileImportHelperInvocation } from
  "../main/chromeProfileImportHelperMode";

// The native addon relaunches the current executable for fixed-mode helper
// work. Keep this decision ahead of the E2E module import: that module seeds
// retained-v22 state and installs process-wide observers at evaluation time.
if (isChromeProfileImportHelperInvocation(process.argv)) {
  await import("../main/index");
} else {
  await import("./index");
}
