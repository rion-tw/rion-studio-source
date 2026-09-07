/** Resolve the complete prerequisite chain before starting an isolated phase. */
export function resolveDesktopE2eFocusedPhases({ configuredPhases, dependencies, phase }) {
  const available = new Set(configuredPhases);
  const complete = new Set();
  const visiting = new Set();
  const result = [];
  function visit(candidate) {
    if (!available.has(candidate)) {
      throw new Error(`Desktop E2E prerequisite ${candidate} is not part of the selected profile.`);
    }
    if (visiting.has(candidate)) {
      throw new Error(`Desktop E2E prerequisite cycle at ${candidate}.`);
    }
    if (complete.has(candidate)) return;
    visiting.add(candidate);
    for (const dependency of dependencies.get(candidate) ?? []) visit(dependency);
    visiting.delete(candidate);
    complete.add(candidate);
    result.push(candidate);
  }
  visit(phase);
  return result;
}
