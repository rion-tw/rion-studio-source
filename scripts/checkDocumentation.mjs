import { resolve } from "node:path";

import { validateDocumentation } from "./documentationPolicy.mjs";

const failures = await validateDocumentation(resolve(process.cwd()));
if (failures.length > 0) {
  console.error(`Documentation validation found ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Documentation validation passed.");
}
